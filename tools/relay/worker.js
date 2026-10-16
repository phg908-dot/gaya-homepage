// 가야공인중개사사무소 홈페이지 '매물 접수' → 대표 휴대폰 문자(SOLAPI) 중계 Worker
//
//   POST /intake          손님이 '보내기'를 누르면 홈페이지가 호출 → 대표 번호(SMS_TO)로 문자 1통
//   GET  /health          {ok:true, configured:boolean}  (개인정보 없음)
//   POST /selftest        배포 직후 GitHub Actions 가 호출 (Bearer SELFTEST_TOKEN) → 시험 문자 1통
//   GET  /selftest/status?id=<messageId>   시험 문자의 통신사 처리 결과 코드
//
// 원칙
//  - 받는 번호는 비밀값 SMS_TO 하나로 고정. 손님이 받는 사람을 고를 수 없으므로 스팸 발송기로 악용 불가.
//  - 개인정보는 어디에도 저장·기록하지 않는다. 로그에는 결과 코드만 남긴다.
//  - IP 는 '하루 동안만 의미 있는 해시'로만 다루고, 그 해시도 한국 시간 자정에 지운다(Durable Object 알람).
//  - 하루 전체 발송 한도(DAILY_CAP)와 IP별 한도로 문자 충전금이 새지 않게 한다. 한도 저장소가 없으면 보내지 않는다(fail closed).
//
// 비밀값(wrangler secret / --secrets-file): SOLAPI_API_KEY, SOLAPI_API_SECRET, SMS_FROM, SMS_TO,
//   SELFTEST_TOKEN(배포 때마다 자동 생성), TURNSTILE_SECRET(선택)
// 일반 변수(wrangler.toml [vars]): ALLOWED_ORIGINS, DAILY_CAP, IP_DAILY_LIMIT, IP_GAP_SECONDS

const SOLAPI_BASE = "https://api.solapi.com";
const MAX_BODY_BYTES = 8 * 1024;
const SMS_MAX_BYTES = 90; // 단문(SMS) 한도, EUC-KR 기준
const LMS_MAX_BYTES = 2000; // 장문(LMS) 한도, EUC-KR 기준
const LMS_SUBJECT = "홈페이지 매물 접수";
const SELFTEST_TEXT = "[가야 홈페이지] 문자 연결 시험 문자입니다.";
const DEFAULT_ORIGINS = ["https://phg908-dot.github.io"];
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const KST_OFFSET_MS = 9 * 3600 * 1000;

// 입력 항목별 최대 글자 수 (홈페이지 입력칸의 maxlength 와 같게 맞춘다)
export const LIMITS = {
  name: 20,
  phone: 20,
  region: 60,
  type: 20,
  deal: 12,
  area: 60,
  price: 40,
  memo: 600,
  from: 60,
};
const MEMO_MAX_LINES = 15;
const MAX_KEYS = 24;

// ───────────────────────── 공통 도우미 ─────────────────────────

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const INVISIBLE_RE = /[­​-‏‪-‮⁠-⁩﻿]/g;
const ASTRAL_RE = /[\uD800-\uDFFF]/g; // 이모지 등 BMP 밖 문자: 문자메시지(EUC-KR)로 못 보냄
// 대표님 휴대폰으로 낚시 링크가 전달되지 않도록, 그리고 통신사 스팸 필터에 걸리지 않도록 주소 형태를 지운다
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const DOMAIN_RE = /(?<![@\w.-])[a-z0-9][a-z0-9-]{0,62}\.(?:com|net|org|kr|co|io|me|ly|gl|xyz|top|site|link|info|biz|app|shop|click|to|cc)(?:\/\S*)?\b/gi;

export function cleanText(value, { multiline = false } = {}) {
  let s = String(value).normalize("NFC");
  s = s.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  s = s.replace(CONTROL_RE, "").replace(INVISIBLE_RE, "").replace(ASTRAL_RE, "");
  s = s.replace(URL_RE, "[링크 삭제]").replace(DOMAIN_RE, "[링크 삭제]");
  if (multiline) {
    s = s
      .split("\n")
      .map((line) => line.replace(/ {2,}/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  } else {
    s = s.replace(/\n+/g, " ").replace(/ {2,}/g, " ");
  }
  return s.trim();
}

// EUC-KR(완성형) 기준 바이트 수. 한글·한자·특수문자 2, 영문·숫자 1, 줄바꿈은 넉넉히 2로 센다.
export function smsBytes(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += c === 10 ? 2 : c < 0x80 ? 1 : 2;
  }
  return n;
}

export function cutToBytes(s, maxBytes, ellipsis = "…(이하 생략)") {
  if (smsBytes(s) <= maxBytes) return s;
  const room = maxBytes - smsBytes(ellipsis);
  let out = "";
  let n = 0;
  for (const ch of s) {
    const b = smsBytes(ch);
    if (n + b > room) break;
    out += ch;
    n += b;
  }
  return out.trimEnd() + ellipsis;
}

// 전화번호: 숫자만 남겨 0으로 시작하는 9~12자리만 허용(0504 안심번호 포함) (+82 는 0 으로 바꿈)
export function normalizePhone(raw) {
  let d = String(raw).replace(/[\s\-().]/g, "");
  if (d.startsWith("+82")) d = "0" + d.slice(3).replace(/^0/, "");
  if (!/^\d+$/.test(d)) return null;
  if (!/^0\d{8,11}$/.test(d)) return null;
  if (/^(\d)\1+$/.test(d.slice(1))) return null; // 0000000000 같은 장난 입력
  return d;
}

export function formatPhone(d) {
  if (/^02\d{7,8}$/.test(d)) return d.replace(/^(02)(\d{3,4})(\d{4})$/, "$1-$2-$3");
  if (/^0\d{9,10}$/.test(d)) return d.replace(/^(0\d{2})(\d{3,4})(\d{4})$/, "$1-$2-$3");
  if (/^0\d{11}$/.test(d)) return d.replace(/^(0\d{3})(\d{4})(\d{4})$/, "$1-$2-$3");
  return d;
}

export function kstDay(nowMs) {
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function nextKstMidnight(nowMs) {
  const kst = new Date(nowMs + KST_OFFSET_MS);
  const midnightKst = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1);
  return midnightKst - KST_OFFSET_MS;
}

function intVar(v, fallback, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function settings(env) {
  return {
    dailyCap: intVar(env.DAILY_CAP, 20, 1, 500),
    ipDailyLimit: intVar(env.IP_DAILY_LIMIT, 3, 1, 50),
    ipGapMs: intVar(env.IP_GAP_SECONDS, 30, 0, 3600) * 1000,
  };
}

export function isConfigured(env) {
  return Boolean(
    env.SOLAPI_API_KEY && env.SOLAPI_API_SECRET && normalizePhone(env.SMS_FROM || "") && normalizePhone(env.SMS_TO || "")
  );
}

// ───────────────────────── 입력 검사 ─────────────────────────

const NAME_RE = /^[\p{L}\p{M} .·'-]*$/u;

// 반환: {ok:true, data} | {ok:false, reason:"invalid:<항목>"}
export function validateIntake(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "bad_json" };
  if (Object.keys(body).length > MAX_KEYS) return { ok: false, reason: "bad_json" };

  const data = {};
  for (const key of Object.keys(LIMITS)) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") {
      data[key] = "";
      continue;
    }
    if (typeof raw !== "string") return { ok: false, reason: `invalid:${key}` };
    if (raw.length > LIMITS[key] * 2 + 20) return { ok: false, reason: `invalid:${key}` }; // 정리 전 과도한 길이
    const v = cleanText(raw, { multiline: key === "memo" });
    if ([...v].length > LIMITS[key]) return { ok: false, reason: `invalid:${key}` };
    data[key] = v;
  }

  if (data.name && !NAME_RE.test(data.name)) return { ok: false, reason: "invalid:name" };
  const phone = normalizePhone(data.phone);
  if (!phone) return { ok: false, reason: "invalid:phone" };
  data.phone = phone;
  if ([...data.region].length < 2) return { ok: false, reason: "invalid:region" };
  if (data.memo && data.memo.split("\n").length > MEMO_MAX_LINES) return { ok: false, reason: "invalid:memo" };

  if (body.v !== undefined && body.v !== null && !/^\d{1,4}$/.test(String(body.v))) return { ok: false, reason: "invalid:v" };
  return { ok: true, data };
}

// 자동 입력 프로그램이 채우는 숨은 칸. 사람에게는 보이지 않는다.
export function isHoneypotHit(body) {
  const hp = body && body.website;
  return typeof hp === "string" ? hp.trim() !== "" : hp !== undefined && hp !== null && hp !== "";
}

// ───────────────────────── 문자 내용 ─────────────────────────

export function buildMessage(d, { capReached = false, dailyCap = 0 } = {}) {
  const lines = ["[홈페이지 매물 접수]", `성함: ${d.name || "-"}`, `연락처: ${formatPhone(d.phone)}`, `소재지: ${d.region}`];
  const kind = [d.type && `종류: ${d.type}`, d.deal && `거래: ${d.deal}`].filter(Boolean).join(" / ");
  if (kind) lines.push(kind);
  if (d.area) lines.push(`면적: ${d.area}`);
  if (d.price) lines.push(`희망가격: ${d.price}`);
  if (d.from) lines.push(`접수 위치: ${d.from}`);
  const head = lines.join("\n");
  const tail = capReached
    ? `\n※ 오늘 자동 문자 한도(${dailyCap}건)에 도달했습니다. 이후 접수는 손님 휴대폰 문자나 전화로 옵니다.`
    : "";
  let text = head;
  if (d.memo) {
    const label = "\n내용: ";
    const budget = LMS_MAX_BYTES - smsBytes(head) - smsBytes(tail) - smsBytes(label);
    if (budget > 20) text += label + cutToBytes(d.memo, budget);
  }
  text = cutToBytes(text + tail, LMS_MAX_BYTES);
  return { text, type: smsBytes(text) <= SMS_MAX_BYTES ? "SMS" : "LMS" };
}

// ───────────────────────── SOLAPI ─────────────────────────

const SALT_CHARS = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function randomSalt(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let s = "";
  for (const b of bytes) s += SALT_CHARS[b % SALT_CHARS.length];
  return s;
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

// SOLAPI API Key 인증: signature = HEX( HMAC-SHA256( key=API Secret, data=date + salt ) )
//   Authorization: HMAC-SHA256 apiKey=<KEY>, date=<ISO 8601>, salt=<12~64바이트 임의 문자열>, signature=<hex>
//   (date 는 서버 시각 ±15분 이내, 같은 서명은 15분 안에 재사용 불가)
export async function solapiAuthorization(apiKey, apiSecret, { date, salt } = {}) {
  const d = date || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const s = salt || randomSalt(32);
  const signature = await hmacHex(apiSecret, d + s);
  return `HMAC-SHA256 apiKey=${apiKey}, date=${d}, salt=${s}, signature=${signature}`;
}

// 로컬 시험(wrangler dev)에서만 가짜 SOLAPI 서버로 보낼 수 있다. 운영에서는 항상 api.solapi.com
function solapiBase(env) {
  const t = env.SOLAPI_BASE_FOR_TESTS || "";
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(t) ? t : SOLAPI_BASE;
}

async function solapiRequest(env, deps, method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await deps.fetch(`${solapiBase(env)}${path}`, {
      method,
      headers: {
        Authorization: await solapiAuthorization(env.SOLAPI_API_KEY, env.SOLAPI_API_SECRET),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    return { status: res.status, ok: res.ok, data };
  } catch (_) {
    return { status: 0, ok: false, data: null };
  } finally {
    clearTimeout(timer);
  }
}

// 반환: {ok:true, messageId} | {ok:false, code}
export async function solapiSend(env, deps, { text, type, subject }) {
  const message = { to: normalizePhone(env.SMS_TO), from: normalizePhone(env.SMS_FROM), text, type };
  if (type === "LMS" && subject) message.subject = subject;
  const r = await solapiRequest(env, deps, "POST", "/messages/v4/send-many/detail", {
    messages: [message],
    showMessageList: true,
  });
  if (!r.ok) return { ok: false, code: String((r.data && r.data.errorCode) || `HTTP_${r.status}`).slice(0, 40) };
  const failed = (r.data && r.data.failedMessageList) || [];
  if (failed.length) return { ok: false, code: String(failed[0].statusCode || "failed").slice(0, 40) };
  const list = (r.data && r.data.messageList) || [];
  return { ok: true, messageId: list[0] && list[0].messageId ? String(list[0].messageId) : "" };
}

export async function solapiStatus(env, deps, messageId) {
  const r = await solapiRequest(env, deps, "GET", `/messages/v4/list?messageId=${encodeURIComponent(messageId)}`);
  if (!r.ok) return { ok: false, code: String((r.data && r.data.errorCode) || `HTTP_${r.status}`).slice(0, 40) };
  const m = r.data && r.data.messageList && r.data.messageList[messageId];
  if (!m) return { ok: true, statusCode: "", reason: "" };
  return { ok: true, statusCode: String(m.statusCode || ""), reason: String(m.reason || "").slice(0, 80) };
}

// ───────────────────────── 발송 한도 (Durable Object) ─────────────────────────

// 하루 기록: {day, count, ips: {ipKey: [보낸 횟수, 마지막 시각]}} — 한국 시간 하루가 바뀌면 새로 시작
export function guardReserve(record, { day, ipKey, now, dailyCap, ipDailyLimit, ipGapMs }) {
  const rec = record && record.day === day ? { day, count: record.count, ips: { ...record.ips } } : { day, count: 0, ips: {} };
  if (rec.count >= dailyCap) return { result: { ok: false, reason: "daily_cap" }, record: rec };
  const [n, last] = rec.ips[ipKey] || [0, 0];
  if (n >= ipDailyLimit) return { result: { ok: false, reason: "rate_limited" }, record: rec };
  if (n > 0 && now - last < ipGapMs) return { result: { ok: false, reason: "rate_limited" }, record: rec };
  rec.count += 1;
  rec.ips[ipKey] = [n + 1, now];
  return { result: { ok: true, count: rec.count, capReached: rec.count >= dailyCap }, record: rec };
}

export function guardRelease(record, { day, ipKey }) {
  if (!record || record.day !== day) return { result: { ok: true }, record };
  const rec = { day, count: Math.max(0, record.count - 1), ips: { ...record.ips } };
  const cur = rec.ips[ipKey];
  if (cur) {
    if (cur[0] <= 1) delete rec.ips[ipKey];
    else rec.ips[ipKey] = [cur[0] - 1, cur[1]];
  }
  return { result: { ok: true }, record: rec };
}

export class IntakeGuard {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    let msg;
    try {
      msg = await request.json();
    } catch (_) {
      return Response.json({ ok: false, reason: "bad_request" }, { status: 400 });
    }
    const storage = this.state.storage;
    const record = (await storage.get("rec")) || null;
    const step = msg.op === "release" ? guardRelease(record, msg) : guardReserve(record, msg);
    if (step.record !== record) await storage.put("rec", step.record);
    if (msg.op !== "release" && step.result.ok && storage.getAlarm && !(await storage.getAlarm())) {
      await storage.setAlarm(nextKstMidnight(msg.now) + 60 * 1000);
    }
    return Response.json(step.result);
  }

  // 한국 시간 자정이 지나면 그날의 IP 해시·건수를 모두 지운다
  async alarm() {
    await this.state.storage.deleteAll();
  }
}

function durableGuard(env) {
  if (!env.GUARD) return null;
  const stub = () => env.GUARD.get(env.GUARD.idFromName("global"));
  const call = async (payload) => {
    const res = await stub().fetch("https://guard.internal/", { method: "POST", body: JSON.stringify(payload) });
    return res.json();
  };
  return {
    reserve: (p) => call({ op: "reserve", ...p }),
    release: (p) => call({ op: "release", ...p }),
  };
}

// ───────────────────────── HTTP ─────────────────────────

export function allowedOrigin(origin, env) {
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const allow = list.length ? list : DEFAULT_ORIGINS;
  if (allow.includes(origin)) return origin;
  if (LOCAL_ORIGIN_RE.test(origin)) return origin;
  return null;
}

function corsHeaders(origin) {
  const h = { Vary: "Origin" };
  if (origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(origin),
    },
  });
}

// 개인정보 없이 결과 코드만 남긴다
function logResult(result) {
  console.log(JSON.stringify({ evt: "intake", result }));
}

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function bearerOk(request, env) {
  const token = env.SELFTEST_TOKEN || "";
  const auth = request.headers.get("Authorization") || "";
  return token.length >= 24 && timingSafeEqual(auth, `Bearer ${token}`);
}

async function readJsonBody(request) {
  const len = Number(request.headers.get("Content-Length") || "0");
  if (len > MAX_BODY_BYTES) return { error: "too_large" };
  let text;
  try {
    text = await request.text();
  } catch (_) {
    return { error: "bad_json" };
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { error: "too_large" };
  try {
    return { body: JSON.parse(text) };
  } catch (_) {
    return { error: "bad_json" };
  }
}

async function verifyTurnstile(env, deps, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const res = await deps.fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const data = await res.json();
    return Boolean(data && data.success);
  } catch (_) {
    return false;
  }
}

async function handleIntake(request, env, deps, origin) {
  if (!origin) return json({ ok: false, reason: "origin" }, 403, null);

  const { body, error } = await readJsonBody(request);
  if (error) return json({ ok: false, reason: error }, error === "too_large" ? 413 : 400, origin);

  if (isHoneypotHit(body)) {
    logResult("honeypot");
    return json({ ok: true }, 200, origin); // 자동 프로그램에는 성공한 것처럼 보이게
  }

  const v = validateIntake(body);
  if (!v.ok) {
    logResult(v.reason);
    return json({ ok: false, reason: v.reason }, 400, origin);
  }

  if (!isConfigured(env)) {
    logResult("not_configured");
    return json({ ok: false, reason: "not_configured" }, 503, origin);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!(await verifyTurnstile(env, deps, body.ts, ip))) {
    logResult("turnstile");
    return json({ ok: false, reason: "turnstile" }, 403, origin);
  }

  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function") {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: `ip:${ip}` });
      if (!success) {
        logResult("rate_limited");
        return json({ ok: false, reason: "rate_limited" }, 429, origin);
      }
    } catch (_) {
      /* 보조 장치일 뿐이므로 오류는 무시하고 Durable Object 한도로 판단 */
    }
  }

  const guard = deps.guard;
  if (!guard) {
    logResult("no_guard");
    return json({ ok: false, reason: "not_configured" }, 503, origin);
  }
  const now = deps.now();
  const day = kstDay(now);
  const ipKey = (await hmacHex(env.SOLAPI_API_SECRET, `ip:${day}:${ip}`)).slice(0, 20);
  const limits = settings(env);
  let reserved;
  try {
    reserved = await guard.reserve({ day, ipKey, now, ...limits });
  } catch (_) {
    logResult("guard_error");
    return json({ ok: false, reason: "send_failed" }, 503, origin);
  }
  if (!reserved || !reserved.ok) {
    const reason = (reserved && reserved.reason) || "rate_limited";
    logResult(reason);
    return json({ ok: false, reason }, 429, origin);
  }

  const msg = buildMessage(v.data, { capReached: reserved.capReached, dailyCap: limits.dailyCap });
  const sent = await solapiSend(env, deps, { text: msg.text, type: msg.type, subject: LMS_SUBJECT });
  if (!sent.ok) {
    try {
      await guard.release({ day, ipKey });
    } catch (_) {
      /* 한도 복구 실패는 무시 (보수적으로 1건 덜 보내게 될 뿐) */
    }
    logResult(`send_failed:${sent.code}`);
    return json({ ok: false, reason: "send_failed" }, 502, origin);
  }
  logResult("sent");
  return json({ ok: true }, 200, origin);
}

async function handleSelftest(request, env, deps, url) {
  if (!bearerOk(request, env)) return json({ ok: false, reason: "unauthorized" }, 401, null);
  if (!isConfigured(env)) return json({ ok: false, reason: "not_configured" }, 503, null);
  if (request.method === "POST" && url.pathname === "/selftest") {
    const sent = await solapiSend(env, deps, { text: SELFTEST_TEXT, type: "SMS" });
    return json(sent.ok ? { ok: true, messageId: sent.messageId } : { ok: false, reason: "send_failed", code: sent.code }, sent.ok ? 200 : 502, null);
  }
  if (request.method === "GET" && url.pathname === "/selftest/status") {
    const id = url.searchParams.get("id") || "";
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return json({ ok: false, reason: "invalid:id" }, 400, null);
    const st = await solapiStatus(env, deps, id);
    return json(st, st.ok ? 200 : 502, null);
  }
  return json({ ok: false, reason: "not_found" }, 404, null);
}

export async function handle(request, env, deps) {
  const url = new URL(request.url);
  const origin = allowedOrigin(request.headers.get("Origin"), env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: origin ? 204 : 403, headers: corsHeaders(origin) });
  }
  if (url.pathname === "/health" && request.method === "GET") {
    return json({ ok: true, configured: isConfigured(env) && Boolean(deps.guard) }, 200, origin);
  }
  if (url.pathname === "/selftest" || url.pathname === "/selftest/status") {
    return handleSelftest(request, env, deps, url);
  }
  if (url.pathname === "/intake") {
    if (request.method !== "POST") return json({ ok: false, reason: "method" }, 405, origin);
    return handleIntake(request, env, deps, origin);
  }
  return json({ ok: false, reason: "not_found" }, 404, origin);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env, {
        fetch: (...args) => fetch(...args),
        now: () => Date.now(),
        guard: durableGuard(env),
      });
    } catch (_) {
      logResult("error");
      return json({ ok: false, reason: "error" }, 500, null);
    }
  },
};
