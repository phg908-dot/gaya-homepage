// node --test relay/test/   (Node 20+; 외부 패키지 없이 실행)
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  handle,
  validateIntake,
  buildMessage,
  smsBytes,
  cutToBytes,
  normalizePhone,
  formatPhone,
  solapiAuthorization,
  guardReserve,
  guardRelease,
  kstDay,
  nextKstMidnight,
  allowedOrigin,
  IntakeGuard,
  LIMITS,
} from "../worker.js";

const ORIGIN = "https://phg908-dot.github.io";
const ENV = {
  SOLAPI_API_KEY: "NCSTESTKEY0000001",
  SOLAPI_API_SECRET: "TESTSECRET0123456789ABCDEFGHIJKLMNOP",
  SMS_FROM: "010-3406-0071",
  SMS_TO: "01034060071",
  ALLOWED_ORIGINS: ORIGIN,
  DAILY_CAP: "20",
  IP_DAILY_LIMIT: "3",
  IP_GAP_SECONDS: "30",
  SELFTEST_TOKEN: "selftest-token-0123456789abcdef",
};
const VALID = {
  name: "홍길동",
  phone: "010-1234-5678",
  region: "양평군 지평면 망미리",
  type: "토지",
  deal: "매매",
  area: "대지 200평",
  price: "2억 5천만원",
  memo: "도로 접함.\n주말 방문 가능",
  from: "매물 접수 페이지",
  v: "1",
};

// 메모리 한도 저장소 (Durable Object 와 같은 순수 함수 사용)
function memoryGuard() {
  let record = null;
  return {
    get record() {
      return record;
    },
    async reserve(p) {
      const s = guardReserve(record, p);
      record = s.record;
      return s.result;
    },
    async release(p) {
      const s = guardRelease(record, p);
      record = s.record;
      return s.result;
    },
  };
}

function solapiOk(messageId = "M4V20261016TEST0001") {
  return new Response(
    JSON.stringify({
      failedMessageList: [],
      groupInfo: { count: { total: 1, registeredFailed: 0, registeredSuccess: 1 } },
      messageList: [{ messageId, statusCode: "2000", statusMessage: "정상 접수(이통사로 접수 예정)" }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function makeDeps({ responder = () => solapiOk(), now = Date.UTC(2026, 9, 16, 3, 0, 0) } = {}) {
  const calls = [];
  const deps = {
    calls,
    clock: now,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return responder(String(url), init);
    },
    now: () => deps.clock,
    guard: memoryGuard(),
  };
  return deps;
}

function req(body, { origin = ORIGIN, ip = "203.0.113.7", path = "/intake", method = "POST", type = "text/plain;charset=UTF-8", headers = {} } = {}) {
  const h = { "Content-Type": type, "CF-Connecting-IP": ip, ...headers };
  if (origin) h.Origin = origin;
  return new Request(`https://gaya-intake.example.workers.dev${path}`, {
    method,
    headers: h,
    body: method === "GET" || method === "OPTIONS" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

// 모든 테스트 동안 console.log 를 가로채 개인정보가 기록되지 않는지 확인
const logs = [];
const origLog = console.log;
console.log = (...a) => logs.push(a.join(" "));
test.after(() => {
  console.log = origLog;
  const all = logs.join("\n");
  for (const pii of ["홍길동", "1234-5678", "12345678", "망미리", "203.0.113", "도로 접함"]) {
    assert.ok(!all.includes(pii), `log leaked: ${pii}`);
  }
});

// ───────── SOLAPI 인증 ─────────

test("SOLAPI 서명 = hex(HMAC-SHA256(secret, date+salt)) (공식 SDK 방식과 동일)", async () => {
  const date = "2019-07-01T00:41:48Z";
  const salt = "jqsba2jxjnrjor";
  const h = await solapiAuthorization("NCSAYU7YDBXYORXC", "SECRET123", { date, salt });
  const expected = createHmac("sha256", "SECRET123").update(date + salt).digest("hex");
  assert.equal(h, `HMAC-SHA256 apiKey=NCSAYU7YDBXYORXC, date=${date}, salt=${salt}, signature=${expected}`);
});

test("SOLAPI 인증 헤더: 날짜 ISO 8601(초 단위 Z), salt 32자", async () => {
  const h = await solapiAuthorization("K", "S");
  const m = h.match(/^HMAC-SHA256 apiKey=K, date=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ), salt=([0-9A-Za-z]{32}), signature=([0-9a-f]{64})$/);
  assert.ok(m, h);
  assert.equal(m[3], createHmac("sha256", "S").update(m[1] + m[2]).digest("hex"));
});

// ───────── 입력 검사 ─────────

test("정상 입력 통과 + 전화번호 정규화", () => {
  const v = validateIntake(VALID);
  assert.equal(v.ok, true);
  assert.equal(v.data.phone, "01012345678");
  assert.equal(v.data.memo, "도로 접함.\n주말 방문 가능");
});

test("필수·형식 오류", () => {
  assert.equal(validateIntake({ ...VALID, phone: "" }).reason, "invalid:phone");
  assert.equal(validateIntake({ ...VALID, phone: "12345" }).reason, "invalid:phone");
  assert.equal(validateIntake({ ...VALID, phone: "010-0000-0000" }).ok, true);
  assert.equal(validateIntake({ ...VALID, phone: "0000000000" }).reason, "invalid:phone");
  assert.equal(validateIntake({ ...VALID, region: "양" }).reason, "invalid:region");
  assert.equal(validateIntake({ ...VALID, region: undefined }).reason, "invalid:region");
  assert.equal(validateIntake({ ...VALID, name: "홍길동123" }).reason, "invalid:name");
  assert.equal(validateIntake({ ...VALID, price: 300000000 }).reason, "invalid:price");
  assert.equal(validateIntake({ ...VALID, memo: "가".repeat(LIMITS.memo + 1) }).reason, "invalid:memo");
  assert.equal(validateIntake({ ...VALID, memo: Array(20).fill("줄").join("\n") }).reason, "invalid:memo");
  assert.equal(validateIntake({ ...VALID, v: "x1" }).reason, "invalid:v");
  assert.equal(validateIntake([]).reason, "bad_json");
  assert.equal(validateIntake(null).reason, "bad_json");
});

test("정리: 이모지·제어문자 제거, 링크는 지우되 이메일은 유지", () => {
  const v = validateIntake({
    ...VALID,
    name: " 홍\u200b길동 ",
    region: "양평군\t지평면\n망미리 🏡",
    memo: "자세한 건 https://evil.example/x 와 bit.ly/abc 참고. 메일 abc@naver.com\u0007",
  });
  assert.equal(v.ok, true);
  assert.equal(v.data.name, "홍길동");
  assert.equal(v.data.region, "양평군 지평면 망미리");
  assert.ok(!/https?:|bit\.ly/.test(v.data.memo), v.data.memo);
  assert.ok(v.data.memo.includes("abc@naver.com"), v.data.memo);
  assert.ok(!v.data.memo.includes("\u0007"));
});

test("전화번호 형식", () => {
  assert.equal(normalizePhone("+82 10-1234-5678"), "01012345678");
  assert.equal(normalizePhone("(031) 771-0071"), "0317710071");
  assert.equal(normalizePhone("0504-1234-5678"), "050412345678");
  assert.equal(normalizePhone("010-1234-567a"), null);
  assert.equal(formatPhone("01012345678"), "010-1234-5678");
  assert.equal(formatPhone("0212345678"), "02-1234-5678");
  assert.equal(formatPhone("0317710071"), "031-771-0071");
  assert.equal(formatPhone("050412345678"), "0504-1234-5678");
});

// ───────── 문자 내용 ─────────

test("문자 내용: 한 통(LMS) 2,000바이트 이하, 최대 길이 입력에서도", () => {
  const max = (k) => "가".repeat(LIMITS[k]);
  const d = validateIntake({
    name: max("name"),
    phone: "010-1234-5678",
    region: max("region"),
    type: max("type"),
    deal: max("deal"),
    area: max("area"),
    price: max("price"),
    memo: Array(15).fill("나".repeat(39)).join("\n"), // 599자
    from: max("from"),
  }).data;
  const m = buildMessage(d, { capReached: true, dailyCap: 20 });
  assert.equal(m.type, "LMS");
  assert.ok(smsBytes(m.text) <= 2000, String(smsBytes(m.text)));
  assert.ok(!m.text.includes("…(이하 생략)"), "입력 한도 안에서는 잘리지 않아야 함");
  assert.ok(m.text.includes("오늘 자동 문자 한도(20건)"));
  // 검사를 거치지 않은 아주 긴 내용도 한 통 안에 잘라 넣는다
  const long = buildMessage({ ...d, memo: "다".repeat(3000) }, { capReached: true, dailyCap: 20 });
  assert.ok(smsBytes(long.text) <= 2000, String(smsBytes(long.text)));
  assert.ok(long.text.includes("…(이하 생략)"));
  assert.ok(long.text.endsWith("이후 접수는 손님 휴대폰 문자나 전화로 옵니다."));
  assert.ok(m.text.startsWith("[홈페이지 매물 접수]\n성함: "));
});

test("문자 내용 형식", () => {
  const m = buildMessage(validateIntake(VALID).data);
  assert.equal(
    m.text,
    [
      "[홈페이지 매물 접수]",
      "성함: 홍길동",
      "연락처: 010-1234-5678",
      "소재지: 양평군 지평면 망미리",
      "종류: 토지 / 거래: 매매",
      "면적: 대지 200평",
      "희망가격: 2억 5천만원",
      "접수 위치: 매물 접수 페이지",
      "내용: 도로 접함.\n주말 방문 가능",
    ].join("\n")
  );
  assert.equal(m.type, "LMS");
  const short = buildMessage({ name: "", phone: "01012345678", region: "지평", type: "", deal: "", area: "", price: "", memo: "", from: "" });
  assert.equal(short.text, "[홈페이지 매물 접수]\n성함: -\n연락처: 010-1234-5678\n소재지: 지평");
  assert.equal(short.type, "SMS");
});

test("바이트 자르기", () => {
  assert.equal(smsBytes("가a\n"), 5);
  const c = cutToBytes("가".repeat(100), 50);
  assert.ok(smsBytes(c) <= 50);
  assert.ok(c.endsWith("…(이하 생략)"));
});

// ───────── 한도 ─────────

test("한도: 하루 전체·IP별·간격·날짜 바뀜·되돌리기", () => {
  const lim = { dailyCap: 3, ipDailyLimit: 2, ipGapMs: 30000 };
  let rec = null;
  const step = (ipKey, now, day = "2026-10-16") => {
    const s = guardReserve(rec, { day, ipKey, now, ...lim });
    rec = s.record;
    return s.result;
  };
  assert.deepEqual(step("a", 0), { ok: true, count: 1, capReached: false });
  assert.equal(step("a", 10000).reason, "rate_limited"); // 30초 이내
  assert.equal(step("a", 40000).ok, true);
  assert.equal(step("a", 90000).reason, "rate_limited"); // IP 하루 2건
  const third = step("b", 90000);
  assert.deepEqual(third, { ok: true, count: 3, capReached: true });
  assert.equal(step("c", 90000).reason, "daily_cap");
  rec = guardRelease(rec, { day: "2026-10-16", ipKey: "b" }).record;
  assert.equal(rec.count, 2);
  assert.equal(rec.ips.b, undefined);
  assert.equal(step("c", 90000, "2026-10-17").count, 1); // 다음 날 새로 시작
  assert.deepEqual(Object.keys(rec.ips), ["c"]);
});

test("한국 시간 날짜·자정", () => {
  assert.equal(kstDay(Date.UTC(2026, 9, 16, 14, 59)), "2026-10-16");
  assert.equal(kstDay(Date.UTC(2026, 9, 16, 15, 0)), "2026-10-17");
  assert.equal(nextKstMidnight(Date.UTC(2026, 9, 16, 3, 0)), Date.UTC(2026, 9, 16, 15, 0));
});

test("IntakeGuard(Durable Object): 저장·알람·자정 삭제", async () => {
  const store = new Map();
  let alarm = null;
  const state = {
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => void store.set(k, structuredClone(v)),
      getAlarm: async () => alarm,
      setAlarm: async (t) => void (alarm = t),
      deleteAll: async () => void store.clear(),
    },
  };
  const g = new IntakeGuard(state, {});
  const now = Date.UTC(2026, 9, 16, 3, 0);
  const call = (p) => g.fetch(new Request("https://guard.internal/", { method: "POST", body: JSON.stringify(p) })).then((r) => r.json());
  const base = { day: "2026-10-16", ipKey: "k1", now, dailyCap: 1, ipDailyLimit: 3, ipGapMs: 0 };
  assert.equal((await call({ op: "reserve", ...base })).ok, true);
  assert.equal(alarm, Date.UTC(2026, 9, 16, 15, 1));
  assert.equal((await call({ op: "reserve", ...base, ipKey: "k2" })).reason, "daily_cap");
  await call({ op: "release", day: "2026-10-16", ipKey: "k1" });
  assert.equal(store.get("rec").count, 0);
  await g.alarm();
  assert.equal(store.size, 0);
});

// ───────── HTTP 전체 흐름 ─────────

test("출처 허용 목록", () => {
  assert.equal(allowedOrigin(ORIGIN, ENV), ORIGIN);
  assert.equal(allowedOrigin("http://localhost:8080", ENV), "http://localhost:8080");
  assert.equal(allowedOrigin("http://127.0.0.1:5500", ENV), "http://127.0.0.1:5500");
  assert.equal(allowedOrigin("https://phg908-dot.github.io.evil.com", ENV), null);
  assert.equal(allowedOrigin("https://evil.github.io", ENV), null);
  assert.equal(allowedOrigin(null, ENV), null);
  assert.equal(allowedOrigin(ORIGIN, {}), ORIGIN); // 기본값
});

test("CORS 사전 요청", async () => {
  const deps = makeDeps();
  const ok = await handle(req(null, { method: "OPTIONS" }), ENV, deps);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const bad = await handle(req(null, { method: "OPTIONS", origin: "https://evil.com" }), ENV, deps);
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("Access-Control-Allow-Origin"), null);
});

test("정상 접수 → SOLAPI 로 대표 번호에 LMS 1통", async () => {
  const deps = makeDeps();
  const res = await handle(req(VALID), ENV, deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(deps.calls.length, 1);
  const { url, init } = deps.calls[0];
  assert.equal(url, "https://api.solapi.com/messages/v4/send-many/detail");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.match(init.headers.Authorization, /^HMAC-SHA256 apiKey=NCSTESTKEY0000001, date=\S+Z, salt=\w{32}, signature=[0-9a-f]{64}$/);
  const body = JSON.parse(init.body);
  assert.equal(body.showMessageList, true);
  assert.equal(body.messages.length, 1);
  const m = body.messages[0];
  assert.equal(m.to, "01034060071");
  assert.equal(m.from, "01034060071");
  assert.equal(m.type, "LMS");
  assert.equal(m.subject, "홈페이지 매물 접수");
  assert.ok(m.text.includes("연락처: 010-1234-5678"));
  assert.equal(deps.guard.record.count, 1);
});

test("application/json 으로 보내도 동작", async () => {
  const deps = makeDeps();
  const res = await handle(req(VALID, { type: "application/json" }), ENV, deps);
  assert.equal(res.status, 200);
});

test("허용되지 않은 출처·출처 없음 → 403, 발송 안 함", async () => {
  const deps = makeDeps();
  const a = await handle(req(VALID, { origin: "https://evil.com" }), ENV, deps);
  const b = await handle(req(VALID, { origin: null }), ENV, deps);
  assert.equal(a.status, 403);
  assert.equal(b.status, 403);
  assert.equal((await a.json()).reason, "origin");
  assert.equal(deps.calls.length, 0);
});

test("숨은 칸(honeypot)이 채워지면 성공처럼 답하고 발송 안 함", async () => {
  const deps = makeDeps();
  const res = await handle(req({ ...VALID, website: "http://spam" }), ENV, deps);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(deps.calls.length, 0);
  assert.equal(deps.guard.record, null);
});

test("입력 오류 → 400 + 항목 이름", async () => {
  const deps = makeDeps();
  const res = await handle(req({ ...VALID, phone: "abc" }), ENV, deps);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, reason: "invalid:phone" });
  const bad = await handle(req("{not json"), ENV, deps);
  assert.equal((await bad.json()).reason, "bad_json");
  const big = await handle(req(JSON.stringify({ ...VALID, x: "a".repeat(9000) })), ENV, deps);
  assert.equal(big.status, 413);
  assert.equal(deps.calls.length, 0);
});

test("설정 전(비밀값 없음) → 503 not_configured", async () => {
  const deps = makeDeps();
  const res = await handle(req(VALID), { ALLOWED_ORIGINS: ORIGIN }, deps);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).reason, "not_configured");
  const noGuard = await handle(req(VALID), ENV, { ...deps, guard: null });
  assert.equal((await noGuard.json()).reason, "not_configured");
  assert.equal(deps.calls.length, 0);
});

test("하루 한도 도달 → 마지막 문자에 안내, 그다음은 429 daily_cap", async () => {
  const deps = makeDeps();
  const env = { ...ENV, DAILY_CAP: "2" };
  assert.equal((await handle(req(VALID, { ip: "198.51.100.1" }), env, deps)).status, 200);
  assert.equal((await handle(req(VALID, { ip: "198.51.100.2" }), env, deps)).status, 200);
  const third = await handle(req(VALID, { ip: "198.51.100.3" }), env, deps);
  assert.equal(third.status, 429);
  assert.equal((await third.json()).reason, "daily_cap");
  assert.equal(deps.calls.length, 2);
  assert.ok(JSON.parse(deps.calls[1].init.body).messages[0].text.includes("오늘 자동 문자 한도(2건)"));
});

test("같은 IP 연속 발송 → 429 rate_limited, 30초 뒤 허용", async () => {
  const deps = makeDeps();
  assert.equal((await handle(req(VALID), ENV, deps)).status, 200);
  const again = await handle(req(VALID), ENV, deps);
  assert.equal(again.status, 429);
  assert.equal((await again.json()).reason, "rate_limited");
  deps.clock += 31000;
  assert.equal((await handle(req(VALID), ENV, deps)).status, 200);
});

test("SOLAPI 접수 실패 → 502 send_failed, 한도 되돌림", async () => {
  const deps = makeDeps({
    responder: () =>
      new Response(
        JSON.stringify({
          failedMessageList: [{ to: "01034060071", from: "01034060071", type: "LMS", statusCode: "1062", statusMessage: "발신번호 미등록" }],
          groupInfo: { count: { total: 1, registeredFailed: 1 } },
        }),
        { status: 200 }
      ),
  });
  const res = await handle(req(VALID), ENV, deps);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).reason, "send_failed");
  assert.equal(deps.guard.record.count, 0);
  const deps2 = makeDeps({ responder: () => new Response(JSON.stringify({ errorCode: "NotEnoughBalance" }), { status: 402 }) });
  assert.equal((await handle(req(VALID), ENV, deps2)).status, 502);
  const deps3 = makeDeps({
    responder: () => {
      throw new Error("network");
    },
  });
  assert.equal((await handle(req(VALID), ENV, deps3)).status, 502);
});

test("/health, 모르는 경로, GET /intake", async () => {
  const deps = makeDeps();
  assert.deepEqual(await (await handle(req(null, { path: "/health", method: "GET" }), ENV, deps)).json(), { ok: true, configured: true });
  assert.deepEqual(await (await handle(req(null, { path: "/health", method: "GET" }), {}, deps)).json(), { ok: true, configured: false });
  assert.equal((await handle(req(null, { path: "/x", method: "GET" }), ENV, deps)).status, 404);
  assert.equal((await handle(req(null, { path: "/intake", method: "GET" }), ENV, deps)).status, 405);
});

test("시험 문자(/selftest): 토큰 필요, SMS 1통, 상태 조회", async () => {
  const deps = makeDeps({
    responder: (url) =>
      url.includes("/messages/v4/list")
        ? new Response(JSON.stringify({ messageList: { M4V20261016TEST0001: { statusCode: "4000", reason: "수신완료" } } }), { status: 200 })
        : solapiOk(),
  });
  const no = await handle(req({}, { path: "/selftest", origin: null }), ENV, deps);
  assert.equal(no.status, 401);
  const wrong = await handle(req({}, { path: "/selftest", origin: null, headers: { Authorization: "Bearer nope" } }), ENV, deps);
  assert.equal(wrong.status, 401);
  const auth = { Authorization: `Bearer ${ENV.SELFTEST_TOKEN}` };
  const ok = await handle(req({}, { path: "/selftest", origin: null, headers: auth }), ENV, deps);
  assert.deepEqual(await ok.json(), { ok: true, messageId: "M4V20261016TEST0001" });
  const sent = JSON.parse(deps.calls[0].init.body).messages[0];
  assert.equal(sent.type, "SMS");
  assert.ok(smsBytes(sent.text) <= 90);
  const st = await handle(req(null, { path: "/selftest/status?id=M4V20261016TEST0001", method: "GET", origin: null, headers: auth }), ENV, deps);
  assert.deepEqual(await st.json(), { ok: true, statusCode: "4000", reason: "수신완료" });
  assert.equal(deps.calls[1].url, "https://api.solapi.com/messages/v4/list?messageId=M4V20261016TEST0001");
  assert.equal((await handle(req({}, { path: "/selftest", origin: null, headers: auth }), { ...ENV, SELFTEST_TOKEN: "" }, deps)).status, 401);
});

test("운영에서는 SOLAPI 주소를 바꿀 수 없음(로컬 주소만 시험용 허용)", async () => {
  const deps = makeDeps();
  await handle(req(VALID), { ...ENV, SOLAPI_BASE_FOR_TESTS: "https://attacker.example" }, deps);
  assert.ok(deps.calls[0].url.startsWith("https://api.solapi.com/"));
  const deps2 = makeDeps();
  await handle(req(VALID), { ...ENV, SOLAPI_BASE_FOR_TESTS: "http://127.0.0.1:8788" }, deps2);
  assert.ok(deps2.calls[0].url.startsWith("http://127.0.0.1:8788/"));
});
