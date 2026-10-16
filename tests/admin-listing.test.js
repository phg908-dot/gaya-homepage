// 매물 편집기(public/admin/listing.html) 브라우저 테스트
//
//   NODE_PATH=$(npm root -g) node tests/admin-listing.test.js      (저장소 맨 위에서)
//
// - public/ 을 python3 -m http.server (포트 8800~8999 중 무작위)로 띄우고 Playwright(chromium)로 실제 화면을 조작합니다.
//   외부 네트워크(유튜브 썸네일)는 page.route 로 가짜 응답을 줍니다.
// - data/videos.json 은 매시간 자동으로 바뀌므로, 테스트에서는 고정된 가짜 목록(기본: 영상 없음)을 줍니다.
// - 테스트마다 새 브라우저 컨텍스트(빈 localStorage)에서 시작하므로 한 테스트가 실패해도 다음 테스트에 번지지 않습니다.
// - rules.js 판정을 tests/rules_crosscheck.py(= scripts/build.py)와 같은 자료로 돌려 글자까지 같은지 비교합니다.
"use strict";
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("child_process");
const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const SITE = path.resolve(__dirname, "..");
const PUB = path.join(SITE, "public");
const CHROME = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const ORIGINAL = JSON.parse(fs.readFileSync(path.join(PUB, "data/listings.json"), "utf-8"));
const SITE_JSON = JSON.parse(fs.readFileSync(path.join(PUB, "data/site.json"), "utf-8"));
const RULES = require(path.join(PUB, "assets/js/rules.js"));
const CROSSCHECK = path.join(__dirname, "rules_crosscheck.py");
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const ORDER = ["no", "status", "featured", "urgent", "sample", "title", "type", "deal", "price", "deposit", "monthly",
  "region", "land", "building", "recommendedUse", "summary", "description", "features", "videoIds", "photos", "lat", "lng", "updated"];
const REGION_ORDER = ["sido", "sigungu", "eupmyeon", "ri", "jibun", "showJibun"];
const LAND_ORDER = ["area", "jimok", "zoning", "currentUse", "road"];
const BUILDING_ORDER = ["use", "area", "totalFloors", "floor", "approvalDate", "direction", "rooms", "baths", "parking", "moveIn", "maintenance", "violation"];
const P = RULES.P;
const today = (() => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
const MAX_NO = Math.max(1000, ...ORIGINAL.map((l) => l.no));
const sp = (s) => String(s).replace(/\s/g, " "); // money() 는 억과 만원 사이에 줄바꿈 없는 공백(U+00A0)을 씀
const NO_VIDEOS = { channelId: "", updated: "2026-10-16T00:00:00+09:00", videos: [] };
const video = (id, title, description = "") => ({ id, title, description, published: "2026-10-01", isShort: false });
const STORE_KEY = "gaya.listingEditor.v1";
const BAK_KEY = STORE_KEY + ".bak";
const jsonRoute = (body) => (r) => r.fulfill({ status: 200, contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });

function pickPort() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    (function attempt() {
      const port = 8800 + Math.floor(Math.random() * 200);
      const s = net.createServer();
      s.once("error", () => (++tries > 40 ? reject(new Error("빈 포트 없음")) : attempt()));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(port)));
    })();
  });
}
function waitHttp(url, ms = 10000) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function tryOnce() {
      http.get(url, (res) => { res.resume(); resolve(); }).on("error", () => {
        if (Date.now() > until) reject(new Error("server did not start: " + url));
        else setTimeout(tryOnce, 100);
      });
    })();
  });
}
// build.py 판정 (rules_crosscheck.py --detail): 묶음마다 매물별 결과
function pyJudge(groups) {
  const r = spawnSync("python3", ["-B", CROSSCHECK, "--detail"], { input: JSON.stringify({ groups }), encoding: "utf-8", maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
// rules.js 로 같은 항목을 계산 (파이썬 결과 모양과 같게)
function jsJudge(R, l, group, py) {
  const n = R.normalize(l);
  const b = n.building || {};
  return {
    problems: R.problems(l, group), publishable: R.publishable(l, group),
    residential: R.isResidential(l), apartment: R.isApartment(l), dandok: R.isDandok(l),
    maintenanceWon: R.maintenanceWon(b.maintenance), moveInOk: R.truthy(b.moveIn) ? R.moveInOk(b.moveIn) : null,
    direction: R.directionText(b.direction),
    warnings: py && py.warnings && py.warnings.error ? py.warnings : R.checkWarnings(l, group),
    region: py && py.region && py.region.error ? py.region : R.regionText(l.region),
  };
}

// ── 간단한 테스트 러너
const results = [];
let only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
async function test(name, fn) {
  if (only && !only.test(name)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, e });
    console.log(`  ✗ ${name}\n      ${String(e && e.stack || e).split("\n").slice(0, 8).join("\n      ")}`);
  }
}

let browser, BASE;

// 새 컨텍스트(빈 저장소)로 편집기 열기
async function openEditor(opts = {}) {
  const context = opts.context || await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, acceptDownloads: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [], dialogs = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", (d) => { dialogs.push(d.message()); (opts.onDialog ? opts.onDialog(d) : d.accept()).catch(() => {}); });
  await page.route("https://i.ytimg.com/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX }));
  await page.route("**/data/videos.json", jsonRoute(opts.videos || NO_VIDEOS));
  if (opts.siteJson) await page.route("**/data/site.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opts.siteJson) }));
  if (opts.listings !== undefined) {
    await page.route("**/data/listings.json", (r) => (typeof opts.listings === "function" ? opts.listings(r)
      : r.fulfill({ status: 200, contentType: "application/json", body: typeof opts.listings === "string" ? opts.listings : JSON.stringify(opts.listings) })));
  }
  await page.goto(BASE + "/admin/listing.html" + (opts.query || ""));
  await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });
  return { page, context, errors, dialogs, close: () => (opts.context ? page.close() : context.close()) };
}
// 한 테스트 = 새 편집기 하나 (끝나면 콘솔 오류 없음까지 확인)
async function withEditor(opts, fn) {
  const ed = await openEditor(opts);
  try {
    await fn(ed.page, ed);
    assert.deepEqual(ed.errors, [], "콘솔 오류 없음");
  } finally { await ed.close(); }
}

const until = async (page, fn, arg, what) => {
  try { await page.waitForFunction(fn, arg, { timeout: 5000 }); } catch (_) {
    throw new Error("시간 초과: " + what + " / 점검칸: " + await page.textContent("#checkState").catch(() => "?"));
  }
};
const problems = (page) => page.$$eval("#checkProblems [data-problem]", (b) => b.map((x) => x.dataset.problem));
const warnings = (page) => page.$$eval("#checkWarnings li", (b) => b.map((x) => x.textContent));
const stateOf = (page) => page.$eval("#checkState", (s) => ({ cls: s.className, text: s.textContent }));
const listNos = (page) => page.$$eval("#list > li", (x) => x.map((li) => li.dataset.no));
const working = (page) => page.evaluate(() => window.GAYA_LISTING_EDITOR.state.working.map(window.GAYA_LISTING_EDITOR.canonical));
const sel = (page) => page.evaluate(() => window.GAYA_LISTING_EDITOR.canonical(window.GAYA_LISTING_EDITOR.state.sel));
const moneyIn = (page, n) => page.evaluate((v) => window.GAYA.money(v), n);
async function setVal(page, selector, v) {
  await page.fill(selector, String(v));
  await page.dispatchEvent(selector, "change");
}
async function newListing(page) {
  await page.click("#btnNew");
  await page.waitForSelector("#form:not([hidden])");
  return Number(await page.textContent("#fhNo"));
}
async function expectPublishable(page, what) {
  await until(page, () => document.getElementById("checkState").classList.contains("is-ok"), null, what + " → 게시 가능");
  assert.match((await stateOf(page)).text, /게시 가능/);
  assert.deepEqual(await problems(page), []);
}
async function exportNow(page) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btnDownload")]);
  assert.equal(dl.suggestedFilename(), "listings.json");
  return fs.readFileSync(await dl.path(), "utf-8");
}
async function edit(page, no) {
  await page.click(`#list > li[data-no="${no}"] [data-act="edit"]`);
  await until(page, (n) => document.getElementById("fhNo").textContent === String(n), no, `No.${no} 편집`);
}

async function fillCompleteLand(page) {
  const no = await newListing(page);
  await page.fill("#f-title", "테스트 지평면 계획관리 토지 465평");
  await page.selectOption("#f-type", "토지");
  await page.check('input[name="deal"][value="매매"]');
  await setVal(page, "#f-price", "3억 2천");
  assert.equal(sp(await page.textContent("#pv-price")), sp("= " + await moneyIn(page, 32000)), "한글 금액 해석·미리보기");
  assert.equal(sp(await page.textContent("#pv-price")), "= 3억 2,000만원");
  assert.equal(await page.inputValue("#f-price"), "32000", "칸을 벗어나면 숫자로 정리");
  await setVal(page, "#f-price", "18500");
  assert.equal(sp(await page.textContent("#pv-price")), "= 1억 8,500만원");
  await page.fill("#f-eupmyeon", "지평면");
  await page.fill("#f-ri", "망미리");
  assert.equal(await page.isChecked("#hasLand"), true, "새 매물은 토지 정보가 켜져 있음");
  await setVal(page, "#f-land-area", "1537.2");
  assert.match(await page.textContent("#pv-land-area"), /465\.?\d*평/);
  await page.selectOption("#f-jimok", "답");
  await page.click('#zoningChips [data-zone="계획관리지역"]');
  assert.equal(await page.inputValue("#f-zoning"), "계획관리지역");
  await page.fill("#f-currentUse", "농지(경작 중)");
  await page.fill("#f-road", "4m 포장도로 접함");
  await page.fill("#f-summary", "하천 조망, 주택 신축 가능.");
  await page.fill("#f-description", "남향 완경사.\n진입로 포장.");
  await page.fill("#tag-features", "하천 조망, 도로 접함");
  await page.press("#tag-features", "Enter");
  await page.click('#sec-desc [data-tags="recommendedUse"] [data-sugg="전원주택지"]');
  await setVal(page, "#f-lat", "37.4712, 127.6321");
  return no;
}
// 완전한 주택(전원주택) — 건물 칸 모두 채움
async function fillCompleteHouse(page, o = {}) {
  const no = await newListing(page);
  await page.fill("#f-title", o.title || "테스트 전원주택");
  await page.selectOption("#f-type", o.type || "전원주택");
  await setVal(page, "#f-price", "32000");
  await page.fill("#f-eupmyeon", o.eupmyeon || "지평면");
  await page.fill("#f-ri", o.ri === undefined ? "망미리" : o.ri);
  await setVal(page, "#f-land-area", "562");
  await page.selectOption("#f-jimok", "대");
  await page.check("#hasBuilding");
  await page.waitForSelector("#buildingBody:not([hidden])");
  await page.selectOption("#f-b-use", "단독주택");
  await setVal(page, "#f-b-area", "84.5");
  await setVal(page, "#f-b-approvalDate", "20150320");
  await setVal(page, "#f-b-totalFloors", "1");
  await page.selectOption("#f-b-dir", "남향");
  await setVal(page, "#f-b-rooms", "3");
  await setVal(page, "#f-b-baths", "2");
  await setVal(page, "#f-b-parking", "2");
  await page.click("#mi-now");
  await page.click("#mt-none");
  return no;
}

// ── rules.js ↔ build.py 교차 확인 사례 (묶음 = 매물번호 중복을 함께 세는 목록)
const REG = (eupmyeon, ri) => ({ sido: "경기도", sigungu: "양평군", eupmyeon, ri });
const LAND = { area: 562, jimok: "대", zoning: "계획관리지역", currentUse: "", road: "" };
const BLD = { use: "단독주택", area: 84.5, totalFloors: 1, floor: "", approvalDate: "2015-03-20", direction: "남향", rooms: 3, baths: 2, parking: 2, moveIn: "즉시입주", maintenance: "없음", violation: false };
let caseNo = 3000;
const L = (o = {}) => Object.assign({ no: ++caseNo, status: "거래중", title: "교차 확인", type: "전원주택", deal: "매매", price: 32000,
  region: REG("지평면", "망미리"), land: LAND, building: BLD }, o);
const B = (o) => Object.assign({}, BLD, o);
const CASES = [
  ["완전한 전원주택", [L()], []],
  ["면 지역 리 없음", [L({ region: REG("지평면", "") })], [P.RI]],
  ["읍 지역 리 없음", [L({ region: REG("양평읍", "") })], [P.RI]],
  ["동 지역은 리 없어도 됨", [L({ region: REG("강남동", "") })], []],
  ["읍면동 없음", [L({ region: REG("", "망미리") })], [P.REGION]],
  ["소재지가 객체가 아님", [L({ region: "경기도 양평군" })], [P.REGION]],
  ["월세 보증금 0 + 월세 50", [L({ deal: "월세", price: null, deposit: 0, monthly: 50 })], []],
  ["월세 보증금 0 + 월세 0", [L({ deal: "월세", price: null, deposit: 0, monthly: 0 })], [P.PRICE]],
  ["월세 보증금 없음", [L({ deal: "월세", price: null, deposit: null, monthly: 50 })], [P.PRICE]],
  ["단기임대 글자 숫자", [L({ deal: "단기임대", price: null, deposit: "0", monthly: "50" })], []],
  ["매매가 0", [L({ price: 0 })], [P.PRICE]],
  ["매매가 '32,000'", [L({ price: "32,000" })], []],
  ["매매가 '협의'", [L({ price: "협의" })], [P.priceFormat("price", "협의"), P.PRICE]],
  ["매매가 범위", [L({ price: "2~3억" })], [P.priceFormat("price", "2~3억"), P.PRICE]],
  ["매매가 전각 숫자", [L({ price: "３２０００" })], []],
  ["전세: price 만 있음 (예전 형식)", [L({ deal: "전세", price: 10000, deposit: null })], []],
  ["전세: 보증금 0", [L({ deal: "전세", price: null, deposit: 0 })], [P.PRICE]],
  ["상태 '계약 완료'", [L({ status: "계약 완료" })], []],
  ["상태 '거래완료'", [L({ status: "거래완료" })], []],
  ["상태 '보류'", [L({ status: "보류" })], [P.status("보류")]],
  ["상태 ' 판매중 '", [L({ status: " 판매중 " })], []],
  ["상태 숫자", [L({ status: 1 })], [P.status(1)]],
  ["매물번호 중복 (숫자)", [L({ no: 3900 }), L({ no: 3900 })], [P.dup(2)]],
  ["매물번호 중복 (글자 '3901' 과 숫자 3901)", [L({ no: "3901" }), L({ no: 3901 })], [P.dup(2)]],
  ["매물번호 0", [L({ no: 0 })], [P.NO]],
  ["매물번호 'abc' 두 개", [L({ no: "abc" }), L({ no: "abc" })], [P.NO, P.dup(2)]],
  ["매물번호 1.5", [L({ no: 1.5 })], [P.NO]],
  ["매물번호 없음", [L({ no: undefined })], [P.NO]],
  ["상가는 방 수·관리비 없어도 됨", [L({ type: "상가", building: B({ use: "제1종 근린생활시설", rooms: null, maintenance: "" }) })], []],
  ["전원주택 방 수 없음", [L({ building: B({ rooms: null }) })], [P.BUILDING_PREFIX + "방 수"]],
  ["상가지만 주용도 단독주택 → 주택", [L({ type: "상가", building: B({ rooms: null, maintenance: "" }) })], [P.BUILDING_PREFIX + "방 수", P.BUILDING_PREFIX + "관리비"]],
  ["아파트 해당 층 없음", [L({ type: "아파트", land: null, building: B({ use: "공동주택", floor: "" }) })], [P.BUILDING_PREFIX + "해당 층(저/중/고 가능)"]],
  ["다세대·빌라 해당 층 '저'", [L({ type: "다세대·빌라", land: null, building: B({ use: "공동주택", floor: "저" }) })], []],
  ["상가지만 주용도 공동주택 → 해당 층", [L({ type: "상가", building: B({ use: "공동주택" }) })], [P.BUILDING_PREFIX + "해당 층(저/중/고 가능)"]],
  ["입주가능일 '협의'", [L({ building: B({ moveIn: "협의" }) })], [P.MOVE_IN]],
  ["입주가능일 '11월 중순'", [L({ building: B({ moveIn: "11월 중순" }) })], []],
  ["입주가능일 '2026-11-01'", [L({ building: B({ moveIn: "2026-11-01" }) })], []],
  ["입주가능일 '즉시입주'", [L({ building: B({ moveIn: "즉시입주" }) })], []],
  ["입주가능일 '2026.11.1.'", [L({ building: B({ moveIn: "2026.11.1." }) })], []],
  ["입주가능일 '11월'", [L({ building: B({ moveIn: "11월" }) })], [P.MOVE_IN]],
  ["입주가능일 없음", [L({ building: B({ moveIn: "" }) })], [P.BUILDING_PREFIX + "입주가능일"]],
  ["관리비 '월 25만원'", [L({ building: B({ maintenance: "월 25만원" }) })], [P.MAINTENANCE]],
  ["관리비 나눠 적음", [L({ building: B({ maintenance: "월 25만원(일반관리비 15만원, 사용료 10만원)" }) })], []],
  ["관리비 '월 8만원'", [L({ building: B({ maintenance: "월 8만원" }) })], []],
  ["관리비 '월 10만원' (경계)", [L({ building: B({ maintenance: "월 10만원" }) })], [P.MAINTENANCE]],
  ["관리비 '월 9.9만원'", [L({ building: B({ maintenance: "월 9.9만원" }) })], []],
  ["관리비 '120,000원'", [L({ building: B({ maintenance: "120,000원" }) })], [P.MAINTENANCE]],
  ["주용도 없음 (경고만)", [L({ building: B({ use: "" }) })], []],
  ["주용도 '창고' (목록에 없음 — 경고만)", [L({ building: B({ use: "창고" }) })], []],
  ["주용도 '제2종 근린생활시설'", [L({ type: "상가", building: B({ use: "제2종 근린생활시설", rooms: null, maintenance: "" }) })], []],
  ["방향 없음", [L({ building: B({ direction: "" }) })], [P.BUILDING_PREFIX + "방향(기준 포함)"]],
  ["방향 '남향' (기준 없어도 됨)", [L({ building: B({ direction: "남향" }) })], []],
  ["방향 '남동향(거실 기준)'", [L({ building: B({ direction: "남동향(거실 기준)" }) })], []],
  ["토지 면적 '1,537.2'", [L({ building: null, type: "토지", land: { ...LAND, area: "1,537.2" } })], []],
  ["토지 면적 '약 500평'", [L({ building: null, type: "토지", land: { ...LAND, area: "약 500평" } })], ["토지 area '약 500평' — 숫자만 적어 주세요 (예: 562.0)", P.LAND_AREA]],
  ["건물 면적 '84.5㎡'", [L({ building: B({ area: "84.5㎡" }) })], ["건물 area '84.5㎡' — 숫자만 적어 주세요 (예: 562.0)", P.BUILDING_PREFIX + "전용면적"]],
  ["토지만 있고 지목 없음", [L({ building: null, type: "토지", land: { ...LAND, jimok: "" } })], [P.JIMOK]],
  ["토지·건물 모두 없음", [L({ building: null, land: null, type: "토지" })], [P.LAND_AREA]],
  ["빈 토지 객체 {}", [L({ building: null, land: {}, type: "토지" })], [P.LAND_AREA]],
  ["빈 칸만 있는 토지 객체", [L({ building: null, type: "토지", land: { area: null, jimok: "", zoning: "", currentUse: "", road: "" } })], [P.LAND_AREA, P.JIMOK]],
  ["제목 없음", [L({ title: "" })], [P.TITLE]],
  ["제목이 숫자", [L({ title: 5 })], [P.TITLE]],
  ["종류·거래 형태 없음", [L({ type: "", deal: "" })], [P.TYPE, P.DEAL]],
  ["지번 공개", [L({ region: { ...REG("지평면", "망미리"), jibun: "123-4", showJibun: true } })], []],
  ["지번 비공개 (기본)", [L({ region: { ...REG("지평면", "망미리"), jibun: "123-4", showJibun: false, hideJibun: true } })], []],
  ["지번 공개 '예'", [L({ region: { ...REG("지평면", "망미리"), jibun: "55", showJibun: "예" } })], []],
  ["샘플", [L({ sample: true })], []],
  ["건물 칸에 글자 숫자 '2층'", [L({ building: B({ totalFloors: "2층" }) })], ["건물 totalFloors '2층' — 숫자만 적어 주세요 (예: 562.0)", P.BUILDING_PREFIX + "총 층수"]],
  ["가격이 참/거짓", [L({ price: true })], [P.priceFormat("price", true), P.PRICE]],
  ["가격이 목록", [L({ price: ["1"] })], ["가격 항목 price '['1']' — 숫자(만원)만 적어 주세요 ('협의'·'비공개'·범위 불가)", P.PRICE]],
];

// 무작위 사례 (같은 씨앗이면 같은 사례)
function fuzzGroups(seed, count) {
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const maybe = (p, v) => (rnd() < p ? v() : undefined);
  const NUMS = [null, 0, -1, 1, 1.5, 100, 32000, "32,000", "협의", "", " ", "1e3", "inf", "nan", "1_000", "１２", true, [], [1], {}, "3억", 1e21, 1e-7, ".5", "　7　"];
  const STR = [null, "", " ", "지평면", "양평읍", "강남동", "망미리", true, 0, 1.5, ["면"], { a: "b" }, "x\n", "it's", "﻿"];
  const one = () => {
    const l = {};
    const set = (k, p, f) => { const v = maybe(p, f); if (v !== undefined) l[k] = v; };
    set("no", 0.9, () => pick([4001, 4002, "4003", 0, -1, 1.5, "abc", null, "", true, "４００１"]));
    set("status", 0.8, () => pick([null, "", "거래중", "계약 완료", "거래완료", "보류", " 판매중 ", 0, 1, true, ["거래중"], "광고중\n"]));
    set("title", 0.9, () => pick(["제목", "", " ", null, 5, "﻿", "\x1c"]));
    set("type", 0.9, () => pick(["", "토지", "아파트", "상가", "전원주택", "오피스텔", "다세대·빌라", "펜션", 5, true, "고시원"]));
    set("deal", 0.9, () => pick(["", "매매", "전세", "월세", "단기임대", " 월세 ", 1]));
    for (const k of ["price", "deposit", "monthly"]) set(k, 0.7, () => pick(NUMS));
    set("region", 0.9, () => {
      if (rnd() < 0.1) return pick([null, "x", []]);
      const r = {};
      for (const k of ["sido", "sigungu", "eupmyeon", "ri", "jibun"]) { const v = maybe(0.85, () => pick(k === "eupmyeon" ? ["지평면", "양평읍", "강남동", "", "면", true] : STR)); if (v !== undefined) r[k] = v; }
      const sj = maybe(0.4, () => pick([true, false, "true", "예", "Y", 1, 0, "no"])); if (sj !== undefined) r.showJibun = sj;
      return r;
    });
    set("land", 0.8, () => (rnd() < 0.3 ? pick([null, {}, [], "x"]) : { area: pick(NUMS), jimok: pick(["대", "전", "대지", "", null, 1]), zoning: pick(["계획관리지역", "계획관리지역, 농림지역", "계획관리", "", null]) }));
    set("building", 0.7, () => {
      if (rnd() < 0.3) return pick([null, {}, []]);
      const o = {};
      for (const k of ["area", "totalFloors", "rooms", "baths", "parking"]) { const v = maybe(0.8, () => pick(NUMS)); if (v !== undefined) o[k] = v; }
      for (const [k, vals] of [["floor", ["", "1층", "저", null, 3, false]], ["approvalDate", ["2015-03-20", "", null, 20150320]],
        ["direction", ["남향", "", null, "남향(거실 기준)", 1]], ["moveIn", ["", "즉시입주", "협의", "11월 중순", "2026-11-01", "2026-11-01\n", "１１월 초", true, 5, "11월"]],
        ["maintenance", ["", "없음", "월 25만원", "월 25만원(일반관리비 15만원, 사용료 10만원)", "월 8만원", "120,000원", "１０만원", true, 100000]],
        ["use", ["", "단독주택", "공동주택", "제1종 근린생활시설", "창고", 3]]]) {
        const v = maybe(0.75, () => pick(vals)); if (v !== undefined) o[k] = v;
      }
      return o;
    });
    set("sample", 0.3, () => pick([true, false, 1, 0, "yes", ""]));
    return l;
  };
  return Array.from({ length: count }, () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, one));
}

(async function main() {
  const port = await pickPort();
  const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", PUB], { stdio: "ignore" });
  BASE = `http://127.0.0.1:${port}`;
  const tmps = [];
  try {
    await waitHttp(BASE + "/admin/listing.html");
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    console.log(`매물 편집기 테스트 (${BASE}, 원본 매물 ${ORIGINAL.length}개)`);

    // ───────────────────────── 규칙 (Node + 파이썬)
    await test(`rules.js problems() 가 build.py 와 글자·순서까지 같다 (지정 사례 ${CASES.length}개)`, async () => {
      assert.ok(CASES.length >= 40, "사례 40개 이상");
      const groups = CASES.map((c) => c[1]);
      const py = pyJudge(groups);
      CASES.forEach(([name, group, expectFirst], gi) => {
        group.forEach((l, i) => {
          const js = jsJudge(RULES, l, group, py[gi][i]);
          assert.deepEqual(js, py[gi][i], `${name} (매물 ${i + 1})`);
        });
        // 사례가 노린 판정이 실제로 나오는지 (첫 매물 기준)
        assert.deepEqual(py[gi][0].problems, expectFirst, `${name}: 기대한 판정`);
      });
      // 상태값 사례: 계약완료는 문제는 없지만 게시 불가
      const doneIdx = CASES.findIndex((c) => c[0] === "상태 '계약 완료'");
      assert.equal(py[doneIdx][0].publishable, false);
      const sampleIdx = CASES.findIndex((c) => c[0] === "샘플");
      assert.equal(py[sampleIdx][0].publishable, false);
      // 지번은 showJibun 일 때만 소재지에 나옴
      assert.equal(py[CASES.findIndex((c) => c[0] === "지번 공개")][0].region, "경기도 양평군 지평면 망미리 123-4");
      assert.equal(py[CASES.findIndex((c) => c[0] === "지번 비공개 (기본)")][0].region, "경기도 양평군 지평면 망미리");
      // 방향 표시는 기준이 없으면 '(건물 정면 기준)'
      assert.equal(py[0][0].direction, "남향(건물 정면 기준)");
    });

    await test("rules.js 와 build.py 무작위 사례 900묶음 비교 (손으로 고친 이상한 값 포함)", async () => {
      const groups = fuzzGroups(20261016, 900);
      const py = pyJudge(groups);
      let n = 0;
      groups.forEach((g, gi) => g.forEach((l, i) => {
        n++;
        assert.deepEqual(jsJudge(RULES, l, g, py[gi][i]), py[gi][i], `무작위 ${gi}-${i}: ${JSON.stringify(l).slice(0, 160)}`);
      }));
      assert.ok(n > 1500);
    });

    await test("지목·용도지역·주용도·주택/공동주택/단독 판정 단어·필수 항목·상태 단어가 build.py 와 같다", async () => {
      const code = "import json, sys\nsys.path.insert(0, 'scripts')\nimport build\n" +
        "print(json.dumps({'jimok': sorted(build.JIMOK), 'zoning': sorted(build.ZONING), 'uses': sorted(build.BUILDING_USES), " +
        "'res': list(build.RESIDENTIAL_WORDS), 'apt': list(build.APT_WORDS), 'dandok': list(build.DANDOK_WORDS), " +
        "'done': sorted(build.DONE_WORDS), 'live': sorted(build.LIVE_WORDS), 'basis': build.DIRECTION_BASIS, " +
        "'building': list(build.BUILDING_REQUIRED.items())}, ensure_ascii=False))";
      const r = spawnSync("python3", ["-B", "-c", code], { cwd: SITE, encoding: "utf-8" });
      assert.equal(r.status, 0, r.stderr);
      const py = JSON.parse(r.stdout);
      assert.equal(RULES.JIMOK.length, 28);
      assert.equal(RULES.ZONING.length, 21);
      assert.equal(RULES.BUILDING_USES.length, 30);
      assert.deepEqual([...RULES.JIMOK].sort(), py.jimok);
      assert.deepEqual([...RULES.ZONING].sort(), py.zoning);
      assert.deepEqual([...RULES.BUILDING_USES].sort(), py.uses);
      assert.deepEqual(RULES.RESIDENTIAL_WORDS, py.res);
      assert.deepEqual(RULES.APT_WORDS, py.apt);
      assert.deepEqual(RULES.DANDOK_WORDS, py.dandok);
      assert.deepEqual([...RULES.DONE_WORDS].sort(), py.done);
      assert.deepEqual([...RULES.LIVE_WORDS].sort(), py.live);
      assert.deepEqual(RULES.BUILDING_REQUIRED, py.building);
      assert.equal(RULES.DIRECTION_BASIS, py.basis);
      assert.equal(RULES.DIRECTION_BASIS, SITE_JSON.policy.directionBasis);
      assert.deepEqual(RULES.DIRECTIONS, ["동향", "서향", "남향", "북향", "남동향", "남서향", "북동향", "북서향"]);
    });

    // ───────────────────────── 편집기 화면
    await test("처음 화면: 원본 매물(계약완료·샘플 포함)을 모두 보여주고 배지가 build.py 판정과 같다", async () => {
      await withEditor({}, async (page) => {
        assert.deepEqual(await listNos(page), ORIGINAL.map((l) => String(l.no)));
        assert.equal(await page.getAttribute('meta[name="robots"]', "content"), "noindex, nofollow");
        assert.equal(await page.textContent("#dirtyPill"), "변경 없음");
        assert.equal(await page.$$eval("#list .ed-tag-done", (x) => x.length), ORIGINAL.filter((l) => l.status === "계약완료").length);
        assert.equal(await page.$$eval("#list .ed-tag-sample", (x) => x.length), ORIGINAL.filter((l) => l.sample).length);
        const py = pyJudge([ORIGINAL])[0];
        const badges = await page.$$eval("#list > li", (lis) => lis.map((li) => li.querySelector(".ed-badge").textContent));
        ORIGINAL.forEach((l, i) => {
          const n = py[i].problems.length;
          const want = l.status === "계약완료" ? "계약완료 · 미게시" : l.sample ? "샘플 · 미게시" : n ? `누락 ${n}개` : "게시 가능 ✓";
          assert.equal(badges[i], want, `No.${l.no} 배지`);
        });
        // GitHub 설정 안내는 접힌 '설정 담당자용' 안내로만 (JSON 글자가 바로 보이지 않음)
        const gh = SITE_JSON.admin && SITE_JSON.admin.repoEditUrl;
        assert.equal(await page.isVisible("#btnGithub"), !!gh);
        if (!gh) {
          assert.equal(await page.$eval("#githubHint", (d) => d.tagName === "DETAILS" && !d.open), true);
          assert.equal(await page.isVisible("#githubHint code"), false);
        }
        assert.equal(await page.getAttribute("#checkState", "aria-live"), null, "점검 글은 입력마다 읽히지 않음");
        assert.equal(await page.getAttribute("#srLive", "role"), "status");
      });
    });

    await test("완전한 토지 매매를 입력하면 '게시 가능' + 내보낸 매물이 정확한 모양", async () => {
      await withEditor({}, async (page) => {
        const no = await fillCompleteLand(page);
        assert.equal(no, MAX_NO + 1, "새 번호 = 최대 번호 + 1");
        await expectPublishable(page, "토지 매매");
        await until(page, (n) => { const b = document.querySelector(`#list > li[data-no="${n}"] .ed-badge`); return b && b.textContent === "게시 가능 ✓"; }, no, "목록 배지");
        assert.equal(await page.inputValue("#f-lat"), "37.4712", "좌표 한 번에 넣기 → 위도");
        assert.equal(await page.inputValue("#f-lng"), "127.6321", "좌표 한 번에 넣기 → 경도");
        assert.ok((await warnings(page)).some((w) => w.includes("좌표가 너무 정확")));
        await page.click("#btnRound");
        assert.equal(await page.inputValue("#f-lat"), "37.471");
        assert.ok(!(await warnings(page)).some((w) => w.includes("좌표가 너무 정확")));
        assert.equal(await page.inputValue("#f-updated"), today);
        await until(page, () => document.getElementById("dirtyPill").textContent === "GitHub에 안 올린 변경 있음", null, "변경 표시");
        const data = JSON.parse(await exportNow(page));
        assert.equal(data.length, ORIGINAL.length + 1);
        assert.deepEqual(data[0], {
          no, status: "거래중", featured: false, urgent: false, title: "테스트 지평면 계획관리 토지 465평",
          type: "토지", deal: "매매", price: 18500, deposit: null, monthly: null,
          region: { sido: "경기도", sigungu: "양평군", eupmyeon: "지평면", ri: "망미리", jibun: "", showJibun: false },
          land: { area: 1537.2, jimok: "답", zoning: "계획관리지역", currentUse: "농지(경작 중)", road: "4m 포장도로 접함" },
          building: null, recommendedUse: ["전원주택지"], summary: "하천 조망, 주택 신축 가능.", description: "남향 완경사.\n진입로 포장.",
          features: ["하천 조망", "도로 접함"], videoIds: [], photos: [], lat: 37.471, lng: 127.632, updated: today,
        });
        assert.deepEqual(pyJudge([data])[0][0].problems, [], "build.py 도 게시 가능");
      });
    });

    await test("평 → ㎡ 도우미와 ㎡ → 평 미리보기", async () => {
      await withEditor({}, async (page) => {
        await newListing(page);
        await page.fill("#py-land", "100");
        await page.click('[data-py="f-land-area"]');
        assert.equal(await page.inputValue("#f-land-area"), "330.58");
        assert.equal(await page.textContent("#pv-land-area"), "= 약 100평");
        await setVal(page, "#f-land-area", "1537.2");
        assert.equal(await page.textContent("#pv-land-area"), "= 약 465평");
        await setVal(page, "#f-land-area", "200평");
        assert.equal(await page.inputValue("#f-land-area"), "661.16", "'200평' 이라고 쓰면 ㎡로");
      });
    });

    await test("가격: 비우면 누락, '협의'·범위 거부, 원 단위('1,500,000원')는 만원으로 바꾸고 1만 배로 저장하지 않음", async () => {
      await withEditor({}, async (page) => {
        await fillCompleteLand(page);
        await expectPublishable(page, "시작");
        await setVal(page, "#f-price", "");
        await until(page, () => document.getElementById("checkState").classList.contains("is-bad"), null, "가격 누락");
        assert.deepEqual(await problems(page), [P.PRICE]);
        await page.click("#checkProblems [data-problem]");
        assert.equal(await page.evaluate(() => document.activeElement.id), "f-price", "문제를 누르면 해당 칸으로 이동");
        await page.fill("#f-price", "협의");
        assert.equal(await page.getAttribute("#f-price", "aria-invalid"), "true");
        assert.match(await page.textContent("#err-f-price"), /협의/);
        assert.match(await page.getAttribute("#f-price", "aria-describedby"), /^err-f-price\b.*pv-price/, "오류·미리보기가 칸에 연결됨");
        assert.equal((await sel(page)).price, null);
        await page.fill("#f-price", "2~3억");
        assert.equal(await page.getAttribute("#f-price", "aria-invalid"), "true");
        // 원 단위
        await setVal(page, "#f-price", "1,500,000원");
        assert.equal((await sel(page)).price, 150, "1,500,000원 = 150만원");
        assert.equal(await page.inputValue("#f-price"), "150");
        assert.equal(sp(await page.textContent("#pv-price")), "= 150만원");
        await page.fill("#f-price", "300,000원");
        assert.match(await page.textContent("#note-f-price"), /300,000원 → 30만원/);
        assert.equal((await sel(page)).price, 30);
        await page.fill("#f-price", "5,000원");
        assert.equal(await page.getAttribute("#f-price", "aria-invalid"), "true", "만원 미만은 거부");
        assert.equal((await sel(page)).price, null);
        await page.fill("#f-price", "1500.5");
        assert.equal(await page.getAttribute("#f-price", "aria-invalid"), "true", "만원 단위 소수는 거부");
        await setVal(page, "#f-price", "18500");
        assert.equal(await page.getAttribute("#f-price", "aria-invalid"), null);
        await expectPublishable(page, "가격 복원");
        const parsed = await page.evaluate(() => ["300,000원", "1,500,000원", "30만원", "3.2억", "3억 2,500만원", "1억5천5백", "５００", "5,000원", "150원", "1,500,000"]
          .map((s) => window.GAYA_LISTING_EDITOR.parseManwon(s).value));
        assert.deepEqual(parsed, [30, 150, 30, 32000, 32500, 15500, 500, null, null, 1500000]);
        await setVal(page, "#f-price", "1500000");
        assert.match(await page.textContent("#pv-price"), /금액이 매우 큽니다/, "만원 단위로 1,500,000 은 150억 — 경고");
      });
    });

    await test("주택 건물: 주용도·방향(8방향+직접 입력, 기준 자동 표시)·입주가능일·관리비 판정이 build.py 와 같다", async () => {
      await withEditor({}, async (page) => {
        await fillCompleteHouse(page);
        await expectPublishable(page, "완전한 전원주택");
        // 주용도 목록 = build.py BUILDING_USES 30종 + 빈칸
        assert.deepEqual(await page.$$eval("#f-b-use option", (o) => o.map((x) => x.value)), [""].concat(RULES.BUILDING_USES));
        // 방향: 8방향 + 직접 입력, 미리보기에 '(건물 정면 기준)'
        assert.deepEqual(await page.$$eval("#f-b-dir option", (o) => o.map((x) => x.value)), ["", "동향", "서향", "남향", "북향", "남동향", "남서향", "북동향", "북서향", "__custom"]);
        assert.equal((await sel(page)).building.direction, "남향");
        assert.equal(await page.textContent("#pv-direction"), "홈페이지 표시: 남향(건물 정면 기준)");
        assert.ok(!(await warnings(page)).some((w) => /기준/.test(w)), "방향에 '기준'을 쓰라는 경고 없음");
        await page.selectOption("#f-b-dir", "__custom");
        assert.equal(await page.isVisible("#f-b-direction"), true);
        await page.fill("#f-b-direction", "남동향(거실 기준)");
        assert.equal(await page.inputValue("#f-b-dir"), "__custom", "직접 입력 중 칸이 닫히지 않음");
        assert.equal(await page.textContent("#pv-direction"), "홈페이지 표시: 남동향(거실 기준)");
        await page.fill("#f-b-direction", "남향");
        assert.equal(await page.isVisible("#f-b-direction"), true, "글자가 8방향과 같아져도 입력 중에는 그대로");
        await expectPublishable(page, "방향 직접 입력");
        await page.selectOption("#f-b-dir", "");
        assert.ok((await problems(page)).includes(P.BUILDING_PREFIX + "방향(기준 포함)"));
        await page.click(`#checkProblems [data-problem="${P.BUILDING_PREFIX}방향(기준 포함)"]`);
        assert.equal(await page.evaluate(() => document.activeElement.id), "f-b-dir");
        await page.selectOption("#f-b-dir", "서향");
        // 입주가능일
        for (const [v, ok] of [["협의", false], ["11월 중순", true], ["2026-11-01", true], ["즉시입주", true], ["11월", false]]) {
          await setVal(page, "#f-b-moveIn", v);
          assert.equal((await problems(page)).includes(P.MOVE_IN), !ok, `입주가능일 '${v}'`);
        }
        await page.click("#mi-now");
        // 관리비
        for (const [v, ok] of [["월 25만원", false], ["월 25만원(일반관리비 15만원, 사용료 10만원)", true], ["월 8만원", true], ["120,000원", false]]) {
          await setVal(page, "#f-b-maintenance", v);
          assert.equal((await problems(page)).includes(P.MAINTENANCE), !ok, `관리비 '${v}'`);
        }
        await page.click("#mt-none");
        // 방 수·관리비 누락 순서 (build.py 와 같음)
        await setVal(page, "#f-b-rooms", "");
        await setVal(page, "#f-b-maintenance", "");
        assert.deepEqual(await problems(page), [P.BUILDING_PREFIX + "방 수", P.BUILDING_PREFIX + "관리비"]);
        await page.click(`#checkProblems [data-problem="${P.BUILDING_PREFIX}방 수"]`);
        assert.equal(await page.evaluate(() => document.activeElement.id), "f-b-rooms");
        await setVal(page, "#f-b-rooms", "3");
        await page.click("#mt-none");
        // 주용도 비우면 경고만 (게시 가능)
        await page.selectOption("#f-b-use", "");
        await expectPublishable(page, "주용도 없음");
        assert.ok((await warnings(page)).some((w) => w.startsWith("건축물대장 주용도")), "주용도 경고");
        await page.selectOption("#f-b-use", "단독주택");
        assert.ok(!(await warnings(page)).some((w) => w.startsWith("건축물대장 주용도")));
        // 화면의 판정 = 파이썬 판정
        const c = await sel(page);
        const all = await working(page);
        assert.deepEqual(await problems(page), pyJudge([all])[0][all.findIndex((x) => x.no === c.no)].problems);
      });
    });

    await test("읍·면은 리가 필수, 동은 아님 (필수 표시도 따라 바뀜)", async () => {
      await withEditor({}, async (page) => {
        await fillCompleteHouse(page, { ri: "" });
        assert.deepEqual(await problems(page), [P.RI]);
        assert.equal(await page.isVisible("#req-ri"), true);
        await page.click(`#checkProblems [data-problem="${P.RI}"]`);
        assert.equal(await page.evaluate(() => document.activeElement.id), "f-ri");
        await page.fill("#f-eupmyeon", "양평읍");
        assert.deepEqual(await problems(page), [P.RI]);
        await page.fill("#f-eupmyeon", "강남동");
        assert.deepEqual(await problems(page), []);
        assert.equal(await page.isVisible("#req-ri"), false);
      });
    });

    await test("상가 월세: 방 수·관리비 없이 게시 가능, 월세→매매→월세 복원, 월세→전세는 보증금을 전세금으로 옮기지 않음", async () => {
      await withEditor({}, async (page) => {
        await newListing(page);
        await page.fill("#f-title", "테스트 양평읍 1층 상가");
        await page.selectOption("#f-type", "상가");
        await page.check('input[name="deal"][value="월세"]');
        assert.equal(await page.isHidden("#fld-price"), true, "월세는 매매가 칸 숨김");
        assert.equal(await page.textContent("#lbl-deposit"), "보증금");
        await setVal(page, "#f-deposit", "3000");
        await setVal(page, "#f-monthly", "150");
        assert.equal(sp(await page.textContent("#pv-monthly")), "= 150만원");
        await page.fill("#f-eupmyeon", "양평읍");
        await page.fill("#f-ri", "백안리");
        await page.uncheck("#hasLand");
        assert.ok((await problems(page)).includes(P.LAND_AREA), "건물도 토지도 없으면 토지 면적 필요");
        await page.check("#hasBuilding");
        assert.equal(await page.isHidden("#req-rooms"), true, "비주택이면 방 수 필수 표시 없음");
        await page.selectOption("#f-b-use", "제1종 근린생활시설");
        await setVal(page, "#f-b-area", "59.3");
        await setVal(page, "#f-b-totalFloors", "4층");
        assert.equal(await page.inputValue("#f-b-totalFloors"), "4");
        await page.fill("#f-b-floor", "1층");
        await setVal(page, "#f-b-approvalDate", "2009.11.2");
        assert.equal(await page.inputValue("#f-b-approvalDate"), "2009-11-02");
        await page.selectOption("#f-b-dir", "동향");
        await setVal(page, "#f-b-baths", "1");
        await setVal(page, "#f-b-parking", "0");
        await page.selectOption("#mi-month", "11");
        await page.selectOption("#mi-part", "중순");
        await page.click("#mi-apply");
        assert.equal(await page.inputValue("#f-b-moveIn"), "11월 중순");
        await expectPublishable(page, "상가 월세");
        await page.check('input[name="deal"][value="매매"]');
        assert.deepEqual(await problems(page), [P.PRICE]);
        assert.equal(await page.isVisible("#priceNote"), true, "가격을 비웠다는 안내");
        await page.check('input[name="deal"][value="월세"]');
        assert.equal(await page.inputValue("#f-deposit"), "3000");
        assert.equal(await page.inputValue("#f-monthly"), "150");
        await expectPublishable(page, "월세 복원");
        // 월세 → 전세: 보증금 3000 이 전세금이 되어 게시되면 안 됨
        await page.check('input[name="deal"][value="전세"]');
        assert.equal(await page.textContent("#lbl-deposit"), "전세금");
        assert.equal(await page.inputValue("#f-deposit"), "", "전세금 칸은 비어 있음");
        const c = await sel(page);
        assert.equal(c.deposit, null);
        assert.equal(c.monthly, null);
        assert.deepEqual(await problems(page), [P.PRICE]);
        assert.match(await page.textContent("#priceNote"), /전세/);
        await setVal(page, "#f-deposit", "9000");
        await expectPublishable(page, "전세금 입력");
        await page.check('input[name="deal"][value="월세"]');
        assert.equal(await page.inputValue("#f-deposit"), "3000", "월세로 돌아오면 월세 보증금");
        await page.check('input[name="deal"][value="전세"]');
        assert.equal(await page.inputValue("#f-deposit"), "9000", "전세로 돌아오면 전세금");
      });
    });

    await test("아파트: 해당 층 필수, 비워 둔 토지 칸은 null 로 내보냄 (빈 '토지' 표 방지)", async () => {
      await withEditor({}, async (page) => {
        const no = await newListing(page);
        await page.fill("#f-title", "테스트 아파트");
        await page.selectOption("#f-type", "아파트");
        await setVal(page, "#f-price", "25000");
        await page.fill("#f-eupmyeon", "양평읍");
        await page.fill("#f-ri", "양근리");
        assert.equal(await page.isChecked("#hasLand"), true, "토지 칸은 켜진 채로 둠");
        await page.check("#hasBuilding");
        await page.selectOption("#f-b-use", "공동주택");
        assert.equal(await page.isVisible("#req-floor"), true);
        for (const [s, v] of [["#f-b-area", "84.9"], ["#f-b-totalFloors", "15"], ["#f-b-approvalDate", "2010-05-01"], ["#f-b-rooms", "3"], ["#f-b-baths", "2"], ["#f-b-parking", "1"]]) await setVal(page, s, v);
        await page.selectOption("#f-b-dir", "남향");
        await page.click("#mi-now");
        await setVal(page, "#f-b-maintenance", "월 25만원(일반관리비 15만원, 사용료 10만원)");
        assert.deepEqual(await problems(page), [P.BUILDING_PREFIX + "해당 층(저/중/고 가능)"]);
        await page.fill("#f-b-floor", "중층");
        await expectPublishable(page, "아파트");
        assert.equal(await page.isVisible("#landEmptyNote"), true, "빈 토지 칸 안내");
        const data = JSON.parse(await exportNow(page));
        const apt = data.find((l) => l.no === no);
        assert.equal(apt.land, null, "빈 토지 = null");
        assert.equal(apt.building.use, "공동주택");
        assert.deepEqual(pyJudge([data])[0][data.indexOf(apt)].problems, []);
        // build.py 로 상세 페이지를 만들면 빈 '토지' 표가 없음
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gaya-site-"));
        tmps.push(tmp);
        fs.cpSync(SITE, tmp, { recursive: true, filter: (src) => !/[\\/](dist|__pycache__|node_modules|listing|tests|images)$/.test(src) });
        fs.writeFileSync(path.join(tmp, "public/data/listings.json"), JSON.stringify(data, null, 2), "utf-8");
        const r = spawnSync("python3", ["-B", "scripts/build.py"], { cwd: tmp, encoding: "utf-8" });
        assert.equal(r.status, 0, r.stderr + r.stdout);
        const html = fs.readFileSync(path.join(tmp, `public/listing/${no}.html`), "utf-8");
        assert.ok(!html.includes('scope="colgroup">토지</th>'), "상세 페이지에 빈 토지 칸 없음");
        assert.ok(html.includes('scope="colgroup">건물</th>'));
      });
    });

    await test("지번: 사무소 기록용(기본 비공개), '이 매물은 지번 공개'일 때만 표시, 예전 hideJibun 은 없앰", async () => {
      const src = JSON.parse(JSON.stringify(ORIGINAL));
      src[0].region = { ...src[0].region, jibun: "123-4", hideJibun: true };
      delete src[0].region.showJibun;
      await withEditor({ listings: src }, async (page) => {
        assert.equal((await page.textContent('label[for="f-jibun"]')).trim(), "지번 (사무소 기록용 · 홈페이지에는 표시 안 함)");
        assert.equal((await page.textContent('label:has(#f-showJibun)')).trim(), "이 매물은 지번 공개");
        assert.equal(await page.$$eval("[id*=hideJibun], [data-f*=hideJibun]", (x) => x.length), 0, "hideJibun 입력칸 없음");
        await edit(page, src[0].no);
        assert.equal(await page.inputValue("#f-jibun"), "123-4");
        assert.equal(await page.isChecked("#f-showJibun"), false, "기본은 비공개");
        assert.equal(await page.textContent("#pv-region"), "홈페이지 표시: 경기도 양평군 지평면 망미리 — 지번은 비공개");
        assert.ok(!(await problems(page)).some((p) => /지번/.test(p)), "지번은 필수가 아님");
        await page.check("#f-showJibun");
        assert.equal(await page.textContent("#pv-region"), "홈페이지 표시: 경기도 양평군 지평면 망미리 123-4");
        assert.ok((await warnings(page)).some((w) => w.startsWith("지번을 홈페이지에 공개합니다")));
        await page.uncheck("#f-showJibun");
        await page.fill("#f-jibun", "");
        assert.equal(await page.textContent("#pv-region"), "홈페이지 표시: 경기도 양평군 지평면 망미리");
        const data = JSON.parse(await exportNow(page));
        for (const l of data) {
          assert.deepEqual(Object.keys(l.region), REGION_ORDER, `No.${l.no} 소재지 항목`);
          assert.equal(typeof l.region.showJibun, "boolean");
        }
        assert.ok(!JSON.stringify(data).includes("hideJibun"), "hideJibun 은 내보내지 않음");
      });
    });

    await test("유튜브 주소 → 영상 ID (watch?v=, youtu.be/, /shorts/, /embed/), 재생목록·videoseries 는 거부", async () => {
      await withEditor({}, async (page) => {
        await newListing(page);
        const cases = [
          ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "dQw4w9WgXcQ"],
          ["https://youtu.be/9bZkp7q19f0?si=AbCdEf", "9bZkp7q19f0"],
          ["https://youtube.com/shorts/aqz-KE-bpKQ?feature=share", "aqz-KE-bpKQ"],
          ["https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?rel=0", "M7lc1UVf-VE"],
        ];
        for (const [url] of cases) { await page.fill("#f-video-in", url); await page.click("#btnAddVideo"); }
        await page.fill("#f-video-in", "kJQP7kiw5Fk m.youtube.com/watch?v=dQw4w9WgXcQ https://example.com/watch?v=nope");
        await page.click("#btnAddVideo");
        const ids = await page.$$eval("#videoList [data-id]", (x) => x.map((li) => li.dataset.id));
        assert.deepEqual(ids, cases.map((c) => c[1]).concat("kJQP7kiw5Fk"));
        assert.deepEqual(await page.$$eval("#videoList img", (x) => x.map((i) => i.getAttribute("src"))), ids.map((id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`));
        const err = await page.textContent("#videoErr");
        assert.match(err, /example\.com/);
        assert.match(err, /이미 들어 있는 영상/);
        assert.equal(await page.inputValue("#f-video-in"), "https://example.com/watch?v=nope", "알아볼 수 없는 주소는 칸에 남김");
        // 재생목록
        await page.fill("#f-video-in", "https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG");
        await page.click("#btnAddVideo");
        assert.match(await page.textContent("#videoErr"), /재생목록 주소입니다/);
        assert.equal(await page.$$eval("#videoList [data-id]", (x) => x.length), 5, "videoseries 는 들어가지 않음");
        const more = await page.evaluate(() => ["https://www.youtube.com/live/dQw4w9WgXcQ?si=1", "www.youtube.com/watch?feature=x&v=dQw4w9WgXcQ",
          "https://youtube.com/embed/short", "dQw4w9WgXc", "javascript:alert(1)", "videoseries",
          "https://www.youtube.com/embed/videoseries?list=PL123", "https://www.youtube.com/playlist?list=PL123", "https://youtube.com/watch?v=dQw4w9WgXcQabc"]
          .map(window.GAYA_LISTING_EDITOR.ytId));
        assert.deepEqual(more, ["dQw4w9WgXcQ", "dQw4w9WgXcQ", null, null, null, null, null, null, null]);
        // 편집기가 받아들인 ID 는 공용 GAYA.ytId 도 그대로 받아들임
        assert.deepEqual(await page.evaluate((list) => list.map(window.GAYA.ytId), ids), ids);
        await page.click('#videoList [aria-label="영상 kJQP7kiw5Fk 빼기"]');
        assert.deepEqual(await page.$$eval("#videoList [data-id]", (x) => x.map((li) => li.dataset.id)), ids.slice(0, 4));
      });
    });

    await test("사진: 띄어쓰기 있는 파일 이름은 한 장, 사진이 아닌 이름은 목록에 넣지 않고 칸에 남김", async () => {
      await withEditor({}, async (page) => {
        await newListing(page);
        await page.fill("#f-photo-in", "현장 사진 1.jpg");
        await page.click("#btnAddPhoto");
        assert.deepEqual((await sel(page)).photos, ["images/현장 사진 1.jpg"]);
        assert.equal(await page.isHidden("#photoErr"), true);
        await page.fill("#f-photo-in", "1006-2.png, 1006-3.webp");
        await page.press("#f-photo-in", "Enter");
        assert.deepEqual((await sel(page)).photos, ["images/현장 사진 1.jpg", "images/1006-2.png", "images/1006-3.webp"]);
        await page.fill("#f-photo-in", "메모.txt, IMG_0001.HEIC, 1006-4.jpg");
        await page.click("#btnAddPhoto");
        assert.deepEqual((await sel(page)).photos, ["images/현장 사진 1.jpg", "images/1006-2.png", "images/1006-3.webp", "images/1006-4.jpg"]);
        assert.equal(await page.inputValue("#f-photo-in"), "메모.txt, IMG_0001.HEIC", "잘못된 이름은 고칠 수 있게 남김");
        assert.match(await page.textContent("#photoErr"), /HEIC/);
        assert.equal(await page.getAttribute("#f-photo-in", "aria-invalid"), "true");
        // 모두 build.py 가 받아들이는 경로
        for (const p of (await sel(page)).photos) assert.match(p, RULES.PHOTO_OK);
      });
    });

    await test("복제(샘플은 샘플 그대로·새 번호), 계약완료 안내, 삭제 확인, 되돌리기는 한 번만", async () => {
      await withEditor({}, async (page, ed) => {
        const sample = ORIGINAL.find((l) => l.sample);
        // 샘플 복제 → 샘플 표시 유지 (게시 가능으로 바뀌지 않음)
        await page.click(`#list > li[data-no="${sample.no}"] [data-act="dup"]`);
        const dupNo = Number(await page.textContent("#fhNo"));
        assert.equal(dupNo, MAX_NO + 1, "복제 = 새 번호");
        let c = await sel(page);
        assert.equal(c.sample, true, "샘플의 복사본은 샘플");
        assert.match(c.title, /\(복사\)$/);
        assert.deepEqual(c.videoIds, []);
        assert.equal(await page.isVisible("#sampleLine"), true);
        assert.match((await stateOf(page)).text, /샘플/);
        await page.click("#btnUnsample");
        assert.ok((await warnings(page)).some((w) => w.includes("'샘플'이라는 말이 남아")), "실제 매물로 바꿔도 샘플 글이 남으면 경고");
        // 계약완료
        assert.equal(await page.isHidden("#doneNote"), true);
        await page.check('input[name="status"][value="계약완료"]');
        assert.equal(await page.isVisible("#doneNote"), true);
        assert.match(await page.textContent("#doneNote"), /계약 통보 후 3일 안에 광고 삭제 의무 — 유튜브 영상도 비공개로 돌리세요/);
        assert.match((await stateOf(page)).text, /계약완료/);
        // 삭제: 취소하면 그대로
        const count = () => page.$$eval("#list > li", (x) => x.length);
        const before = await count();
        page.removeAllListeners("dialog");
        page.once("dialog", (d) => { ed.dialogs.push(d.message()); d.dismiss(); });
        await page.click("#btnDelSel");
        assert.equal(await count(), before);
        page.on("dialog", (d) => { ed.dialogs.push(d.message()); d.accept(); });
        await page.click("#btnDelSel");
        await until(page, (n) => document.querySelectorAll("#list > li").length === n, before - 1, "삭제");
        assert.equal(await page.isVisible("#emptyState"), true);
        // 되돌리기 단추를 키보드로 두 번 눌러도 한 번만 되살림
        await page.focus("#toast button");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await until(page, (n) => document.querySelectorAll("#list > li").length === n, before, "되돌리기");
        await page.waitForTimeout(100);
        assert.equal(await count(), before);
        assert.equal(await page.$$eval("#toast button", (x) => x.length), 0, "되돌리기 단추가 사라짐");
        const nos = (await working(page)).map((l) => l.no);
        assert.equal(new Set(nos).size, nos.length, "번호가 겹치지 않음");
        // 지운 번호는 새 매물에 다시 주지 않음 → 되돌려도 번호가 겹치지 않음
        const a = await newListing(page);
        await page.fill("#f-title", "A");
        await page.click("#btnDelSel");
        const b = await newListing(page);
        assert.equal(b, a + 1, "지운 번호를 다시 쓰지 않음");
        await page.fill("#f-title", "B");
        await page.evaluate(() => { const t = document.querySelector("#toast button"); if (t) t.click(); });
        const nos2 = (await working(page)).map((l) => l.no);
        assert.equal(new Set(nos2).size, nos2.length, "되돌려도 번호 중복 없음");
        assert.equal(await page.$$eval("#list .ed-tag-sample", (x) => x.filter((t) => t.textContent === "번호 중복").length), 0);
        assert.ok(ed.dialogs.filter((m) => /삭제할까요/.test(m)).length >= 3, "삭제는 매번 확인");
      });
    });

    await test("데이터는 글자로만 표시된다 (HTML 삽입 안 됨)", async () => {
      await withEditor({}, async (page) => {
        const no = await newListing(page);
        const evil = '<img src=x onerror="window.__xss=1"><b>굵게</b>';
        await page.fill("#f-title", evil);
        await until(page, (n) => document.querySelector(`#list > li[data-no="${n}"] .ed-li-title`).textContent.includes("<img"), no, "목록 제목 갱신");
        await page.fill("#tag-features", evil);
        await page.press("#tag-features", "Enter");
        assert.equal(await page.$$eval("#list img, #formTitle img, #list b b, .ed-taglist img", (x) => x.length), 0);
        assert.equal(await page.textContent("#fhTitle"), evil);
        assert.equal(await page.evaluate(() => window.__xss), undefined);
        const src = fs.readFileSync(path.join(PUB, "assets/js/admin-listing.js"), "utf-8");
        assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/.test(src), "innerHTML 을 쓰지 않음");
      });
    });

    await test("내보내기: 항목 순서·자료형·2칸 들여쓰기·한글 그대로·마지막 줄바꿈, 모르는 항목 보존, 손으로 고친 값 정리", async () => {
      const src = JSON.parse(JSON.stringify(ORIGINAL));
      Object.assign(src[0], { memo: "사무소 메모", _internal: 1 });
      src[0].region.extraNote = "마을회관 옆";
      src[0].land.extraLand = { a: 1 };
      src[0].building.extraBuilding = [1, 2];
      Object.assign(src[1], { price: "18,500", status: "계약 완료", videoIds: ["https://youtu.be/9bZkp7q19f0"], featured: 1, sample: false });
      src[1].land.area = "1,537.2";
      await withEditor({ listings: src }, async (page) => {
        const text = await exportNow(page);
        assert.ok(text.endsWith("}\n]\n"), "마지막 줄바꿈");
        assert.ok(text.startsWith('[\n  {\n    "no": '), "2칸 들여쓰기");
        assert.ok(text.includes("지평면") && !/\\u[0-9a-f]{4}/i.test(text), "한글 그대로");
        const data = JSON.parse(text);
        assert.equal(data.length, src.length);
        for (const l of data) {
          const known = Object.keys(l).filter((k) => ORDER.includes(k));
          assert.deepEqual(known, ORDER.filter((k) => k !== "sample" || l.sample === true), `No.${l.no} 항목 순서`);
          assert.deepEqual(Object.keys(l).slice(0, known.length), known, "모르는 항목은 맨 뒤");
          assert.deepEqual(Object.keys(l.region).slice(0, 6), REGION_ORDER);
          if (l.land) assert.deepEqual(Object.keys(l.land).slice(0, 5), LAND_ORDER);
          if (l.building) assert.deepEqual(Object.keys(l.building).slice(0, 12), BUILDING_ORDER);
          assert.equal(typeof l.no, "number");
          assert.equal(typeof l.featured, "boolean");
          assert.equal(typeof l.urgent, "boolean");
          assert.ok(!("sample" in l) || l.sample === true, "sample 은 샘플에만");
          for (const k of ["price", "deposit", "monthly", "lat", "lng"]) assert.ok(l[k] === null || typeof l[k] === "number", `No.${l.no} ${k} 숫자`);
        }
        const a = data[0], b = data[1];
        assert.deepEqual(Object.keys(a).slice(-2), ["memo", "_internal"], "모르는 항목 보존(맨 뒤)");
        assert.equal(a.memo, "사무소 메모");
        assert.equal(a.region.extraNote, "마을회관 옆");
        assert.deepEqual(a.land.extraLand, { a: 1 });
        assert.deepEqual(a.building.extraBuilding, [1, 2]);
        assert.equal(b.price, 18500, "'18,500' → 18500");
        assert.equal(b.land.area, 1537.2);
        assert.equal(b.status, "계약완료", "'계약 완료' → 계약완료");
        assert.equal(b.featured, true);
        assert.ok(!("sample" in b));
        assert.deepEqual(b.videoIds, ["9bZkp7q19f0"], "영상 주소 → ID");
        // 원본 매물 내용은 그대로
        for (const o of ORIGINAL.slice(2)) {
          const l = data.find((x) => x.no === o.no);
          assert.equal(l.title, o.title);
          assert.equal(l.price, o.price ?? null);
          assert.equal(!!l.sample, !!o.sample);
          if (o.land) assert.equal(l.land.area, o.land.area);
          assert.deepEqual(l.region, { ...o.region, jibun: o.region.jibun || "", showJibun: !!o.region.showJibun });
        }
        // 내보낸 파일을 다시 정리해도 같음 (멱등)
        assert.equal(await page.evaluate((t) => { const E = window.GAYA_LISTING_EDITOR; return E.serialize(JSON.parse(t).map(E.canonical)); }, text), text);
        // 내보낸 파일의 판정 = 편집기 화면의 판정 = build.py
        const py = pyJudge([data])[0];
        const inPage = await page.evaluate((list) => list.map((l) => window.GAYA_RULES.problems(l, list)), data);
        data.forEach((l, i) => assert.deepEqual(inPage[i], py[i].problems, `No.${l.no}`));
      });
    });

    await test("'JSON 복사'는 내려받기와 같은 내용을 클립보드에 넣는다", async () => {
      await withEditor({}, async (page, ed) => {
        await fillCompleteLand(page);
        const text = await exportNow(page);
        await ed.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
        await page.click("#btnCopy");
        await until(page, () => document.getElementById("toast").textContent.includes("복사했습니다"), null, "복사 알림");
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
      });
    });

    await test("내보낸 파일을 build.py --check 로 돌리면 편집기와 같은 결과 (게시 가능 ↔ 명시사항 누락 없음)", async () => {
      await withEditor({}, async (page) => {
        const land = await fillCompleteLand(page);
        const house = await fillCompleteHouse(page);
        await setVal(page, "#f-b-rooms", "");
        const shopLike = await fillCompleteHouse(page, { title: "리 없는 주택", ri: "" });
        const data = JSON.parse(await exportNow(page));
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gaya-site-"));
        tmps.push(tmp);
        fs.cpSync(SITE, tmp, { recursive: true, filter: (src) => !/[\\/](dist|__pycache__|node_modules|listing|tests|images)$/.test(src) });
        fs.writeFileSync(path.join(tmp, "public/data/listings.json"), JSON.stringify(data, null, 2), "utf-8");
        const r = spawnSync("python3", ["-B", "scripts/build.py", "--check"], { cwd: tmp, encoding: "utf-8" });
        assert.equal(r.status, 0, r.stderr);
        const lineOf = (no) => r.stdout.split("\n").filter((x) => x.includes(`No.${no}:`) && x.includes("명시사항 누락")).join("\n");
        const badges = await page.$$eval("#list > li", (lis) => Object.fromEntries(lis.map((li) => [li.dataset.no, li.querySelector(".ed-badge").textContent])));
        assert.equal(badges[land], "게시 가능 ✓");
        assert.equal(lineOf(land), "", "토지: 파이썬도 누락 없음");
        assert.equal(badges[house], "누락 1개");
        assert.match(lineOf(house), /건축물 방 수$/);
        assert.match(lineOf(shopLike), new RegExp(P.RI.replace(/[()]/g, "\\$&")));
        // 편집기 판정 = build.py (모든 매물)
        const inPage = await page.evaluate((list) => list.map((l) => window.GAYA_RULES.problems(l, list)), data);
        const py = pyJudge([data])[0];
        data.forEach((l, i) => assert.deepEqual(inPage[i], py[i].problems, `No.${l.no}`));
      });
    });

    await test("브라우저 안의 GAYA_RULES 도 지정 사례에서 build.py 와 같다", async () => {
      await withEditor({}, async (page) => {
        const groups = CASES.map((c) => c[1]).concat(fuzzGroups(7, 150));
        const py = pyJudge(groups);
        const inPage = await page.evaluate((gs) => gs.map((g) => g.map((l) => [window.GAYA_RULES.problems(l, g), window.GAYA_RULES.publishable(l, g)])), groups);
        groups.forEach((g, gi) => g.forEach((l, i) => {
          assert.deepEqual(inPage[gi][i], [py[gi][i].problems, py[gi][i].publishable], `묶음 ${gi}-${i}`);
        }));
      });
    });

    // ───────────────────────── 저장·불러오기
    await test("자동 보관: 새로고침해도 작업 내용이 남고, '처음 상태로 되돌리기'로 원본 복귀", async () => {
      await withEditor({}, async (page) => {
        await fillCompleteLand(page);
        await page.waitForTimeout(500);
        await page.reload();
        await page.waitForSelector('body[data-ready="1"]');
        assert.equal(await page.$$eval("#list > li", (x) => x.length), ORIGINAL.length + 1);
        assert.equal(await page.textContent("#dirtyPill"), "GitHub에 안 올린 변경 있음");
        assert.equal(await page.isVisible("#loadNotice"), true);
        assert.match(await page.textContent("#saveState"), /추가 1/);
        await page.click("#btnReset");
        await until(page, (n) => document.querySelectorAll("#list > li").length === n, ORIGINAL.length, "되돌리기");
        await until(page, () => document.getElementById("dirtyPill").textContent === "변경 없음", null, "변경 없음 표시");
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => localStorage.getItem("gaya.listingEditor.v1")), null);
        await page.reload();
        await page.waitForSelector('body[data-ready="1"]');
        assert.equal(await page.$$eval("#list > li", (x) => x.length), ORIGINAL.length);
        assert.equal(await page.isHidden("#loadNotice"), true);
      });
    });

    await test("탭을 닫거나 다른 화면으로 가기 직전(0.3초 안)의 입력도 보관된다 (pagehide·visibilitychange)", async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const target = ORIGINAL[1];
        let ed = await openEditor({ context, query: `?no=${target.no}` });
        await ed.page.fill("#f-title", "닫기 직전에 고친 제목");
        await ed.page.waitForTimeout(80);
        await ed.page.close({ runBeforeUnload: true });
        ed = await openEditor({ context, query: `?no=${target.no}` });
        assert.equal(await ed.page.inputValue("#f-title"), "닫기 직전에 고친 제목", "탭 닫기");
        // 유튜브 설명란 링크로 바로 이동
        await ed.page.fill("#f-title", "링크 누르기 직전에 고친 제목");
        await ed.page.click("#ytLink");
        await ed.page.waitForURL(/youtube\.html/);
        // 유튜브 설명란 화면이 자료를 다 받은 뒤에 돌아감 (받는 도중에 떠나면 그 화면의 fetch 가 취소되어 콘솔 오류가 남)
        await ed.page.waitForFunction(() => { const o = document.getElementById("out"); return !!(o && o.value); }, null, { timeout: 10000 });
        await ed.page.waitForLoadState("networkidle");
        await ed.page.goBack();
        await ed.page.waitForSelector('body[data-ready="1"]');
        assert.equal(await ed.page.inputValue("#f-title"), "링크 누르기 직전에 고친 제목", "링크 이동");
        // 다른 앱으로 전환 (화면이 가려짐)
        await ed.page.fill("#f-title", "앱 전환 직전에 고친 제목");
        await ed.page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        const saved = await ed.page.evaluate(() => JSON.parse(localStorage.getItem("gaya.listingEditor.v1")).listings);
        assert.equal(saved.find((l) => l.no === target.no).title, "앱 전환 직전에 고친 제목");
        assert.deepEqual(ed.errors, []);
      } finally { await context.close(); }
    });

    await test("오래된 임시 저장본은 새 listings.json 을 덮어쓰지 않는다 ('불러온 원본 사용' / '임시 저장본 사용' = 고친 매물만 다시 적용)", async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
      try {
        const [a, b] = ORIGINAL;
        // 1) 이 브라우저에서 No.a 제목을 고쳐 둠 (자동 보관)
        let ed = await openEditor({ context, query: `?no=${a.no}` });
        await ed.page.fill("#f-title", "폰에서 고친 제목");
        await ed.page.waitForTimeout(500);
        await ed.page.close();
        // 2) 그 사이 다른 기기에서 홈페이지 파일이 바뀜: No.b 가격 99999, 새 매물 1099
        const server = JSON.parse(JSON.stringify(ORIGINAL));
        server[1].price = 99999;
        server.push({ ...JSON.parse(JSON.stringify(ORIGINAL[2])), no: 1099, title: "PC에서 추가한 매물" });
        ed = await openEditor({ context, listings: server });
        const page = ed.page;
        assert.equal(await page.isVisible("#draftChoice"), true, "고르기 안내");
        assert.match(await page.textContent("#draftChoiceList"), new RegExp(`No\\.${a.no}\\(수정\\)`));
        assert.match(await page.textContent("#draftChoiceList"), new RegExp(`No\\.${b.no}\\(수정\\).*No\\.1099\\(추가\\)|No\\.1099\\(추가\\).*No\\.${b.no}\\(수정\\)`));
        assert.equal(await page.evaluate(() => document.getElementById("ed").inert), true, "고르기 전에는 편집 멈춤");
        let w = await working(page);
        assert.equal(w.find((l) => l.no === b.no).price, 99999, "기본은 최신 홈페이지 파일");
        assert.ok(w.some((l) => l.no === 1099));
        assert.equal(w.find((l) => l.no === a.no).title, a.title);
        // 고르기 전에는 '변경 없음'이라고 하지 않고, 내려받기 막힘
        assert.equal(await page.textContent("#dirtyPill"), "작업 내용 선택 필요");
        assert.match(await page.textContent("#saveState"), /먼저 고르세요/);
        assert.equal(await page.isDisabled("#btnDownload"), true);
        assert.equal(await page.isDisabled("#btnCopy"), true);
        await page.evaluate(() => { const b = document.getElementById("btnDownload"); b.disabled = false; b.click(); });
        assert.ok(ed.dialogs.some((m) => /먼저 화면 위쪽에서/.test(m)));
        // 임시 저장본 사용 → 고친 매물(a)만 최신 파일 위에 적용
        await page.click("#btnUseDraft");
        assert.equal(await page.isHidden("#draftChoice"), true);
        assert.equal(await page.isDisabled("#btnDownload"), false);
        w = await working(page);
        assert.equal(w.find((l) => l.no === a.no).title, "폰에서 고친 제목");
        assert.equal(w.find((l) => l.no === b.no).price, 99999, "다른 기기의 변경 유지");
        assert.ok(w.some((l) => l.no === 1099), "다른 기기에서 추가한 매물 유지");
        const data = JSON.parse(await exportNow(page));
        assert.equal(data.find((l) => l.no === b.no).price, 99999);
        assert.equal(data.length, server.length);
        assert.deepEqual(ed.errors, []);
        await ed.page.close();
        // 3) 다시 바뀐 파일 + '불러온 원본 사용'
        const server2 = JSON.parse(JSON.stringify(server));
        server2[0].title = "PC에서도 고친 제목";
        ed = await openEditor({ context, listings: server2 });
        assert.equal(await ed.page.isVisible("#draftChoice"), true);
        await ed.page.click("#btnUseServer");
        assert.ok(ed.dialogs.some((m) => /임시 저장본은 백업으로 옮깁니다/.test(m)));
        w = await working(ed.page);
        assert.equal(w.find((l) => l.no === a.no).title, "PC에서도 고친 제목");
        assert.equal(await ed.page.evaluate((k) => localStorage.getItem(k), STORE_KEY), null, "임시 저장본 비움");
        assert.equal(await ed.page.textContent("#dirtyPill"), "변경 없음");
        // 버린 임시 저장본은 백업에 남아 되살릴 수 있음 (양쪽에서 고친 매물은 백업 쪽 내용, 확인할 점 안내)
        assert.equal(await ed.page.isVisible("#btnRestoreBak"), true, "백업 되살리기 단추");
        await ed.page.click("#btnRestoreBak");
        assert.ok(ed.dialogs.some((m) => /백업해 둔 작업 내용\(.*매물 6개\)을 되살릴까요/.test(m)));
        w = await working(ed.page);
        assert.equal(w.find((l) => l.no === a.no).title, "폰에서 고친 제목", "백업 내용 되살림");
        assert.equal(w.find((l) => l.no === b.no).price, 99999);
        assert.match(await ed.page.textContent("#loadNotice"), /양쪽에서 모두 바뀌어/);
        assert.equal(await ed.page.isHidden("#btnRestoreBak"), true, "바꿔 넣을 작업 내용이 없었으므로 백업은 비움");
        await ed.page.waitForTimeout(400);
        const stored = await ed.page.evaluate((k) => JSON.parse(localStorage.getItem(k)).listings, STORE_KEY);
        assert.equal(stored.find((l) => l.no === a.no).title, "폰에서 고친 제목", "되살린 내용도 자동 보관");
        assert.deepEqual(ed.errors, []);
      } finally { await context.close(); }
    });

    await test("세 갈래 합치기: 양쪽에서 고친 매물·지운 매물·같은 번호 추가를 안전하게 처리", async () => {
      await withEditor({}, async (page) => {
        const r = await page.evaluate(() => {
          const E = window.GAYA_LISTING_EDITOR;
          const mk = (no, title) => E.canonical({ no, title, status: "거래중" });
          const base = [mk(1, "a"), mk(2, "b"), mk(3, "c"), mk(4, "d")];
          const mine = [mk(9000, "내가 추가"), mk(1, "a 내가"), mk(2, "b 내가"), mk(4, "d")]; // 3 지움
          const theirs = [mk(1, "a"), mk(2, "b 저쪽"), mk(3, "c 저쪽"), mk(4, "d"), mk(9000, "저쪽 추가")];
          const m = E.merge3(base, mine, theirs);
          return { list: m.list.map((l) => [l.no, l.title]), notes: m.notes };
        });
        const titles = Object.fromEntries(r.list.map(([no, t]) => [`${no}:${t}`, true]));
        assert.ok(titles["1:a 내가"], "내 쪽만 고친 매물 적용");
        assert.ok(titles["2:b 내가"], "양쪽이 고치면 임시 저장본(사용자가 고른 쪽)");
        assert.ok(titles["3:c 저쪽"], "내가 지웠지만 저쪽에서 고친 매물은 남김");
        assert.ok(titles["9000:저쪽 추가"], "저쪽에서 추가한 매물 유지");
        assert.ok(r.list.some(([no, t]) => t === "내가 추가" && no !== 9000), "같은 번호로 추가한 내 매물은 새 번호");
        assert.equal(r.notes.length, 3, r.notes.join("\n"));
      });
    });

    await test("listings.json 을 못 불러오면(500·형식 오류) 편집·내려받기를 막고, 파일 불러오기로만 이어서 작업", async () => {
      for (const [what, handler, re] of [
        ["HTTP 500", (r) => r.fulfill({ status: 500, body: "err" }), /불러오지 못했습니다.*HTTP 500/],
        ["형식 오류", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '[{"no": 1001, "title": "x",}]' }), /형식이 잘못되어/],
        ["목록이 아님", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"no": 1}' }), /\[ \] 로 감싼 목록/],
      ]) {
        await withEditor({ listings: handler }, async (page, ed) => {
          assert.equal(await page.isVisible("#loadError"), true, what);
          assert.match(await page.textContent("#loadErrorText"), re);
          assert.equal(await page.isVisible("#ed"), false, "편집 화면 숨김");
          assert.equal(await page.isVisible("#btnNew"), false);
          assert.equal(await page.isDisabled("#btnDownload"), true);
          assert.equal(await page.isDisabled("#btnCopy"), true);
          assert.equal(await page.textContent("#dirtyPill"), "불러오기 실패");
          assert.equal(await page.isHidden("#loadDraft"), true, "보관된 작업 내용이 없으면 이어서 하기 안내 없음");
          // 숨겨진 단추를 억지로 눌러도 내보내지 않음
          let downloaded = false;
          page.on("download", () => { downloaded = true; });
          await page.evaluate(() => { const b = document.getElementById("btnDownload"); b.disabled = false; b.click(); });
          await page.waitForTimeout(200);
          assert.equal(downloaded, false, "빈 목록을 내보내지 않음");
          assert.ok(ed.dialogs.some((m) => /빈 목록이 실제 매물을 덮어쓰지 않도록/.test(m)));
          if (what === "HTTP 500") {
            // 전에 내려받은 파일로 복구
            const file = path.join(os.tmpdir(), `gaya-import-${process.pid}.json`);
            fs.writeFileSync(file, JSON.stringify(ORIGINAL), "utf-8");
            await page.setInputFiles("#importFile", file);
            await until(page, () => !document.getElementById("ed").hidden, null, "불러온 뒤 편집 화면");
            fs.rmSync(file);
            assert.equal(await page.$$eval("#list > li", (x) => x.length), ORIGINAL.length);
            assert.equal(await page.isHidden("#loadError"), true);
            assert.match(await page.textContent("#saveState"), /불러온 파일\(gaya-import-\d+\.json\)과 같습니다 \(홈페이지 파일은 읽지 못했습니다\)/,
              "홈페이지 파일과 같다고 하지 않음");
            assert.equal(await newListing(page), MAX_NO + 1, "번호가 기존 번호와 겹치지 않음");
            await page.fill("#f-title", "복구 후 새 매물");
            const data = JSON.parse(await exportNow(page));
            assert.equal(data.length, ORIGINAL.length + 1);
          }
        });
      }
    });

    await test("listings.json 을 못 불러와도 이 브라우저에 보관된 작업 내용을 알려 주고 이어서 할 수 있다 (파일 불러오기는 보관본을 백업)", async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
      const file = path.join(os.tmpdir(), `gaya-older-${process.pid}.json`);
      try {
        const target = ORIGINAL[1];
        // 1) 고친 제목이 이 브라우저에만 보관됨 (아직 내려받지 않음)
        let ed = await openEditor({ context, query: `?no=${target.no}` });
        await ed.page.fill("#f-title", "올리지 않은 고친 제목");
        await ed.page.waitForTimeout(500);
        await ed.page.close();
        // 2) 다음에 열었더니 홈페이지 파일 형식 오류 → 보관된 작업 내용이 있다고 알림
        const broken = jsonRoute("[{,}]");
        ed = await openEditor({ context, listings: broken, onDialog: (d) => d.dismiss() });
        let page = ed.page;
        assert.equal(await page.isVisible("#loadError"), true);
        assert.equal(await page.isVisible("#loadDraft"), true, "보관된 작업 내용 안내");
        assert.match(await page.textContent("#loadDraftText"), new RegExp(`자동 보관된 작업 내용이 있습니다 \\(.*매물 ${ORIGINAL.length}개\\)`));
        // 2-a) 예전 파일 불러오기: 확인 창이 보관된 작업 내용을 알려 줌 → 취소하면 그대로
        fs.writeFileSync(file, JSON.stringify(ORIGINAL), "utf-8");
        await page.setInputFiles("#importFile", file);
        for (let i = 0; i < 100 && !ed.dialogs.some((m) => /작업을 시작할까요/.test(m)); i++) await page.waitForTimeout(50);
        await page.waitForTimeout(100);
        assert.ok(ed.dialogs.some((m) => /자동 보관된 작업 내용\(.*\)이 있습니다/.test(m) && /백업으로 옮겨 둡니다/.test(m)), ed.dialogs.join("\n"));
        assert.equal(await page.isVisible("#loadError"), true, "취소하면 그대로");
        const draftTitle = (k) => page.evaluate(([key, no]) => { const d = JSON.parse(localStorage.getItem(key) || "null"); return d && d.listings.find((l) => l.no === no).title; }, [k, target.no]);
        assert.equal(await draftTitle(STORE_KEY), "올리지 않은 고친 제목", "보관본 그대로");
        await page.close();
        // 2-b) 이번에는 불러오기를 받아들임 → 보관본은 백업으로, 저장 상태는 '불러온 파일 기준'
        ed = await openEditor({ context, listings: broken });
        page = ed.page;
        await page.setInputFiles("#importFile", file);
        await until(page, () => !document.getElementById("ed").hidden, null, "불러온 뒤 편집 화면");
        assert.match(await page.textContent("#saveState"), /불러온 파일\(gaya-older-\d+\.json\)과 같습니다 \(홈페이지 파일은 읽지 못했습니다\)/);
        assert.equal(await draftTitle(BAK_KEY), "올리지 않은 고친 제목", "보관본은 백업에 남음");
        assert.equal(await page.isVisible("#btnRestoreBak"), true);
        await page.click("#btnRestoreBak");
        assert.equal((await working(page)).find((l) => l.no === target.no).title, "올리지 않은 고친 제목", "백업 되살리기");
        await page.waitForTimeout(400);
        await page.close();
        // 3) '보관된 작업 내용으로 이어서 하기' → 고친 내용 그대로 편집·내려받기 가능
        ed = await openEditor({ context, listings: broken });
        page = ed.page;
        assert.equal(await page.isVisible("#loadDraft"), true);
        await page.click("#btnContinueDraft");
        assert.equal(await page.isHidden("#loadError"), true);
        assert.equal(await page.isVisible("#ed"), true);
        assert.match(await page.textContent("#loadNotice"), /보관된 작업 내용.*으로 이어서 작업합니다/);
        assert.equal(await page.textContent("#dirtyPill"), "GitHub에 안 올린 변경 있음");
        assert.match(await page.textContent("#saveState"), /수정 1 · 보관된 작업을 시작할 때의 파일 기준/, "무엇과 비교했는지 밝힘");
        const data = JSON.parse(await exportNow(page));
        assert.equal(data.length, ORIGINAL.length);
        assert.equal(data.find((l) => l.no === target.no).title, "올리지 않은 고친 제목");
        assert.deepEqual(ed.errors, []);
      } finally {
        await context.close();
        fs.rmSync(file, { force: true });
      }
    });

    await test("새 번호는 지운 매물 번호·closedListingNos·유튜브 영상이 적은 번호를 다시 쓰지 않는다 (다음에 열어도)", async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
      try {
        let server = JSON.parse(JSON.stringify(ORIGINAL));
        const serve = (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(server) });
        // 1) 새 매물을 만들어 내려받고 GitHub에 올림
        let ed = await openEditor({ context, listings: serve });
        const a = await newListing(ed.page);
        assert.equal(a, MAX_NO + 1);
        await ed.page.fill("#f-title", "곧 지울 매물");
        server = JSON.parse(await exportNow(ed.page));
        await ed.page.waitForTimeout(400);
        await ed.page.close();
        // 2) 다음에 열어 그 매물을 지움 → 확인 창이 closedListingNos 를 안내 → 내려받아 올림
        ed = await openEditor({ context, listings: serve, query: `?no=${a}` });
        await ed.page.click("#btnDelSel");
        assert.ok(ed.dialogs.some((m) => new RegExp(`No\\.${a}은\\(는\\) 새 매물에 다시 쓰지 않습니다.*closedListingNos 에 ${a}`, "s").test(m)), ed.dialogs.join("\n"));
        server = JSON.parse(await exportNow(ed.page));
        assert.ok(!server.some((l) => l.no === a));
        await ed.page.waitForTimeout(400);
        await ed.page.close();
        // 3) 같은 브라우저에서 다시 열면: 지운 번호를 주지 않음
        ed = await openEditor({ context, listings: serve });
        assert.equal(await newListing(ed.page), a + 1, "같은 브라우저: 지운 번호 다음");
        await ed.close();
        // 4) 다른 기기(빈 저장소): site.json closedListingNos 의 번호는 피함
        await withEditor({ listings: server, siteJson: { ...SITE_JSON, closedListingNos: [a] } }, async (page) => {
          assert.equal(await newListing(page), a + 1, "closedListingNos 다음 번호");
          await page.fill("#f-no", String(a));
          assert.match(await page.textContent("#noWarn"), /closedListingNos/, "지운 번호를 직접 넣으면 안내");
        });
        // 5) 다른 기기: 유튜브 영상이 적은 번호(예전 매물·계약완료 영상)는 건너뜀 + 직접 넣으면 안내
        const videos = { ...NO_VIDEOS, videos: [
          video("AAAAAAAAAA1", "양평 토지 매매", `◑ 매물번호: ${a}`),
          video("AAAAAAAAAA2", `No.${a + 1} 전원주택 (매매완료)`),
          video("AAAAAAAAAA3", `양평 전원주택 매물번호 ${ORIGINAL[0].no}`),
        ] };
        await withEditor({ listings: server, videos }, async (page, ed2) => {
          assert.equal(await newListing(page), a + 2, "영상이 적은 번호 건너뜀");
          await page.fill("#f-no", String(a + 1));
          assert.equal(await page.isVisible("#noWarn"), true);
          assert.match(await page.textContent("#noWarn"), /유튜브 영상 1개의 설명란·제목에 '매물번호 \d+'가 적혀 있습니다/);
          assert.match(await page.getAttribute("#f-no", "aria-describedby"), /noWarn/);
          await page.fill("#f-no", String(a + 40));
          assert.equal(await page.isHidden("#noWarn"), true);
          // 기존 매물을 지울 때: 그 번호를 적은 영상 수를 알려 줌
          ed2.page.removeAllListeners("dialog");
          ed2.page.on("dialog", (d) => { ed2.dialogs.push(d.message()); d.dismiss(); });
          await page.click(`#list > li[data-no="${ORIGINAL[0].no}"] [data-act="del"]`);
          assert.ok(ed2.dialogs.some((m) => /이 번호를 적은 유튜브 영상이 1개 있으니/.test(m)), ed2.dialogs.join("\n"));
        });
      } finally { await context.close(); }
    });

    await test("매물이 많아도 입력할 때 목록 전체를 다시 그리지 않는다 (고치는 매물 한 줄만 바뀜)", async () => {
      const many = Array.from({ length: 150 }, (_, i) => ({ ...JSON.parse(JSON.stringify(ORIGINAL[i % ORIGINAL.length])), no: 5001 + i, title: `매물 ${i}` }));
      await withEditor({ listings: many, query: "?no=5003" }, async (page) => {
        await page.evaluate(() => document.querySelectorAll("#list > li").forEach((li) => { li.dataset.mark = "1"; }));
        await page.click("#f-title");
        await page.keyboard.type("가나다", { delay: 10 });
        await until(page, () => /가나다$/.test(document.querySelector('#list > li[data-no="5003"] .ed-li-title').textContent), null, "고친 줄 갱신");
        const kept = await page.$$eval("#list > li", (lis) => lis.filter((li) => li.dataset.mark).map((li) => li.dataset.no));
        assert.equal(kept.length, many.length - 1, "다른 줄은 그대로");
        assert.ok(!kept.includes("5003"), "고친 줄만 새로 그림");
        assert.deepEqual(await listNos(page), many.map((l) => String(l.no)), "순서 그대로");
      });
    });

    await test("'게시 가능'으로 거른 목록에서도 지금 고치는 매물은 사라지지 않는다", async () => {
      await withEditor({}, async (page) => {
        const no = await fillCompleteLand(page);
        await expectPublishable(page, "토지");
        await page.click('[data-filter="ok"]');
        assert.deepEqual(await listNos(page), [String(no)]);
        await setVal(page, "#f-price", "");
        await until(page, () => document.getElementById("checkState").classList.contains("is-bad"), null, "가격 누락");
        await page.waitForTimeout(50);
        assert.deepEqual(await listNos(page), [String(no)], "고치는 중인 매물은 계속 보임");
        assert.equal(await page.isHidden("#listEmpty"), true);
        await page.click('[data-filter="bad"]');
        assert.ok((await listNos(page)).includes(String(no)));
      });
    });

    await test("매물번호 0·글자는 저장하지 않고 내보내기도 막는다", async () => {
      await withEditor({}, async (page, ed) => {
        await fillCompleteLand(page);
        for (const v of ["0", "abc", "-3", "1.5"]) {
          await page.fill("#f-no", v);
          assert.equal(await page.getAttribute("#f-no", "aria-invalid"), "true", `'${v}' 오류`);
          assert.equal((await sel(page)).no, null, `'${v}' 는 저장 안 함`);
        }
        assert.deepEqual(await problems(page), [P.NO]);
        let downloaded = false;
        page.on("download", () => { downloaded = true; });
        await page.click("#btnDownload");
        await page.waitForTimeout(200);
        assert.equal(downloaded, false);
        assert.ok(ed.dialogs.some((m) => /매물번호가 비어 있거나 잘못된 매물/.test(m)));
        assert.equal(await page.evaluate(() => document.activeElement.id), "f-no");
        await page.fill("#f-no", String(MAX_NO + 50));
        assert.equal(await page.getAttribute("#f-no", "aria-invalid"), null);
        const data = JSON.parse(await exportNow(page));
        assert.ok(data.some((l) => l.no === MAX_NO + 50));
        // 다른 매물과 같은 번호 → 양쪽 모두 중복 문제 (build.py 와 같음)
        await page.fill("#f-no", String(ORIGINAL[0].no));
        assert.ok((await problems(page)).includes(P.dup(2)));
      });
    });

    await test("'+ 새 매물'을 잘못 눌러도 빈 매물이 남지 않는다 (손대지 않은 새 매물은 내보내지 않음)", async () => {
      await withEditor({}, async (page) => {
        const a = await newListing(page);
        const b = await newListing(page);
        assert.equal(b, a, "두 번 눌러도 새 매물은 하나, 번호도 그대로");
        assert.equal(await page.$$eval("#list > li", (x) => x.length), ORIGINAL.length + 1);
        await page.waitForTimeout(100);
        assert.equal(await page.textContent("#dirtyPill"), "변경 없음", "빈 새 매물은 변경이 아님");
        const text = await exportNow(page);
        assert.equal(JSON.parse(text).length, ORIGINAL.length, "빈 새 매물은 내보내지 않음");
        await edit(page, ORIGINAL[0].no);
        assert.equal(await page.$$eval("#list > li", (x) => x.length), ORIGINAL.length, "다른 매물로 가면 빈 새 매물은 사라짐");
        const c = await newListing(page);
        assert.equal(c, a, "돌려받은 번호를 다시 씀");
      });
    });

    await test("내려받은 뒤에는 '내려받음 — GitHub에 올리세요'로 바뀌고, 또 고치면 다시 '안 올린 변경'", async () => {
      await withEditor({ viewport: { width: 390, height: 844 } }, async (page) => {
        await fillCompleteLand(page);
        await until(page, () => document.getElementById("barSave").classList.contains("is-dirty"), null, "하단 바 저장 표시");
        assert.equal(await page.isVisible("#barSave .ed-dot"), true, "휴대폰에서도 저장 안 됨 표시");
        await exportNow(page);
        await until(page, () => /내려받음/.test(document.getElementById("saveState").textContent), null, "내려받음");
        assert.match(await page.textContent("#saveState"), /이제 GitHub에 올리면 홈페이지에 반영됩니다/);
        assert.match(await page.textContent("#dirtyPill"), /내려받음 · GitHub에 올리세요/);
        assert.equal(await page.getAttribute("#barSave", "class"), "ed-bar-save is-done");
        await page.waitForTimeout(400);
        await page.reload();
        await page.waitForSelector('body[data-ready="1"]');
        assert.match(await page.textContent("#saveState"), /내려받음/, "새로고침해도 기억");
        await edit(page, ORIGINAL[0].no);
        await page.fill("#f-title", "또 고침");
        await until(page, () => /아직 안 올린 변경/.test(document.getElementById("saveState").textContent), null, "다시 변경 있음");
        assert.equal(await page.getAttribute("#barSave", "class"), "ed-bar-save is-dirty");
      });
    });

    await test("다른 매물로 옮기면 '추가'를 누르지 않은 특징·영상 입력칸을 비우고, 원래 매물에 넣는다", async () => {
      await withEditor({}, async (page) => {
        const [a, b] = ORIGINAL;
        await edit(page, a.no);
        await page.fill("#tag-features", "A매물전용특징");
        await page.fill("#tag-recommendedUse", "A추천");
        await page.fill("#f-video-in", "https://youtu.be/9bZkp7q19f0");
        await edit(page, b.no);
        assert.equal(await page.inputValue("#tag-features"), "", "입력칸 비움");
        assert.equal(await page.inputValue("#tag-recommendedUse"), "");
        assert.equal(await page.inputValue("#f-video-in"), "");
        await page.press("#tag-features", "Enter");
        const w = await working(page);
        assert.ok(!w.find((l) => l.no === b.no).features.includes("A매물전용특징"), "다른 매물에 들어가지 않음");
        const wa = w.find((l) => l.no === a.no);
        assert.ok(wa.features.includes("A매물전용특징"), "원래 매물에 들어감");
        assert.ok(wa.recommendedUse.includes("A추천"));
        assert.deepEqual(wa.videoIds, ["9bZkp7q19f0"]);
        assert.match(await page.textContent("#toast"), /입력 중이던/);
      });
    });

    await test("좌표: 한 글자씩 칠 때는 칸을 벗어날 때 나누고, 붙여넣으면 바로 나눈다", async () => {
      await withEditor({}, async (page) => {
        await newListing(page);
        await page.click("#f-lat");
        await page.keyboard.type("37.4712, 127.6321", { delay: 5 });
        assert.equal(await page.inputValue("#f-lat"), "37.4712, 127.6321", "치는 동안 나누지 않음");
        assert.equal(await page.inputValue("#f-lng"), "");
        assert.equal(await page.getAttribute("#f-lat", "aria-invalid"), null, "오류 표시 없음");
        await page.keyboard.press("Tab");
        assert.equal(await page.inputValue("#f-lat"), "37.4712");
        assert.equal(await page.inputValue("#f-lng"), "127.6321");
        let c = await sel(page);
        assert.deepEqual([c.lat, c.lng], [37.4712, 127.6321]);
        await page.click("#btnClearCoord");
        // 붙여넣기 (경도·위도 순서가 바뀌어도 바로잡음)
        await page.focus("#f-lat");
        await page.evaluate(() => {
          const dt = new DataTransfer();
          dt.setData("text/plain", "127.6321, 37.4712");
          document.getElementById("f-lat").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        });
        c = await sel(page);
        assert.deepEqual([c.lat, c.lng], [37.4712, 127.6321]);
        assert.equal(await page.inputValue("#f-lng"), "127.6321");
        // 한 숫자만 치면 그대로
        await page.fill("#f-lat", "37.5");
        assert.equal((await sel(page)).lat, 37.5);
      });
    });

    await test("접근성: 설명·오류 연결(aria-describedby), 토지·건물 스위치 aria-expanded, 입력칸 테두리 대비 3:1 이상", async () => {
      await withEditor({}, async (page) => {
        await newListing(page);
        assert.match(await page.getAttribute("#f-price", "aria-describedby"), /pv-price/);
        assert.match(await page.getAttribute("#f-b-dir", "aria-describedby"), /pv-direction/);
        assert.equal(await page.getAttribute("#hasLand", "aria-controls"), "landBody");
        assert.equal(await page.getAttribute("#hasLand", "aria-expanded"), "true");
        assert.equal(await page.getAttribute("#hasBuilding", "aria-expanded"), "false");
        await page.check("#hasBuilding");
        assert.equal(await page.getAttribute("#hasBuilding", "aria-expanded"), "true");
        await page.fill("#f-b-baths", "두개");
        const desc = await page.getAttribute("#f-b-baths", "aria-describedby");
        assert.equal(desc, "err-f-b-baths");
        assert.equal(await page.textContent("#err-f-b-baths"), "0 이상의 정수(숫자)만 입력하세요");
        // 테두리 = style.css --field-line (#7d8a9b, 흰 바탕 대비 약 3.5:1)
        const borders = await page.evaluate(() => ["#f-title", "#f-type", "#f-description", '#seg-deal input[value="전세"] + span'].map((s) => getComputedStyle(document.querySelector(s)).borderTopColor));
        assert.deepEqual(borders, Array(4).fill("rgb(125, 138, 155)"));
        const lum = (hex) => { const c = hex.match(/\w\w/g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        assert.ok(ratio("7d8a9b", "ffffff") >= 3, "테두리 3:1");
        const after = await page.evaluate(() => getComputedStyle(document.querySelector("#checkProblems button"), "::after").color);
        const hex = after.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
        assert.ok(ratio(hex, "fff6f6") >= 4.5, `'→ 입력' 글자 대비 ${ratio(hex, "fff6f6").toFixed(2)}`);
        // 판정이 바뀔 때만 화면 읽기 프로그램에 알림
        await page.fill("#f-title", "제목");
        await page.waitForTimeout(100);
        const before = await page.textContent("#srLive");
        await page.fill("#f-title", "제목 바꿈");
        await page.waitForTimeout(100);
        assert.equal(await page.textContent("#srLive"), before, "판정이 그대로면 다시 읽지 않음");
      });
    });

    await test("샘플 매물 표시와 일괄 삭제", async () => {
      await withEditor({}, async (page) => {
        const samples = ORIGINAL.filter((l) => l.sample);
        if (!samples.length) { assert.equal(await page.isHidden("#sampleBox"), true); return; }
        await edit(page, samples[0].no);
        assert.equal(await page.isVisible("#sampleLine"), true);
        assert.match((await stateOf(page)).text, /샘플/);
        await page.click("#btnDelSamples");
        await until(page, (n) => document.querySelectorAll("#list > li").length === n, ORIGINAL.length - samples.length, "샘플 삭제");
        assert.equal(await page.isHidden("#sampleBox"), true);
        assert.equal(await page.isVisible("#emptyState"), true);
        await page.click("#btnReset");
        await until(page, (n) => document.querySelectorAll("#list > li").length === n, ORIGINAL.length, "되돌리기");
      });
    });

    await test("?no= 로 바로 열기 + 유튜브 설명란 링크", async () => {
      const target = ORIGINAL[ORIGINAL.length - 1];
      await withEditor({ query: `?no=${target.no}` }, async (page) => {
        assert.equal(Number(await page.textContent("#fhNo")), target.no);
        assert.equal(await page.getAttribute("#ytLink", "href"), `youtube.html?no=${target.no}`);
      });
    });

    await test("site.json 의 admin.repoEditUrl 이 있으면 GitHub 버튼 표시 (https 만 허용)", async () => {
      const url = "https://github.com/owner/gaya-homepage/edit/main/public/data/listings.json";
      await withEditor({ siteJson: { ...SITE_JSON, admin: { repoEditUrl: url } } }, async (page) => {
        assert.equal(await page.isVisible("#btnGithub"), true);
        assert.equal(await page.getAttribute("#btnGithub", "href"), url);
        assert.equal(await page.isHidden("#githubHint"), true);
      });
      await withEditor({ siteJson: { ...SITE_JSON, admin: { repoEditUrl: "javascript:alert(1)" } } }, async (page) => {
        assert.equal(await page.isHidden("#btnGithub"), true);
      });
      // 방향 기준 문구도 site.json policy 를 따름
      await withEditor({ siteJson: { ...SITE_JSON, policy: { directionBasis: "주출입구 기준" } } }, async (page) => {
        await newListing(page);
        await page.check("#hasBuilding");
        await page.selectOption("#f-b-dir", "북동향");
        assert.equal(await page.textContent("#pv-direction"), "홈페이지 표시: 북동향(주출입구 기준)");
      });
    });

    for (const width of [360, 390, 768, 820, 1280]) {
      await test(`${width}px 화면: 가로 스크롤 없음, 하단 바 글자가 잘리지 않음`, async () => {
        await withEditor({ viewport: { width, height: 780 } }, async (p) => {
          const noScroll = async (where) => {
            const [sw, cw] = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
            assert.ok(sw <= cw, `${where}: scrollWidth ${sw} > ${cw}`);
          };
          await noScroll("처음 화면");
          await newListing(p);
          await p.fill("#f-title", "아주 긴 제목 ".repeat(12));
          await p.check("#hasBuilding");
          await p.selectOption("#f-b-dir", "__custom");
          await p.fill("#f-video-in", "https://www.youtube.com/watch?v=dQw4w9WgXcQ https://youtu.be/9bZkp7q19f0");
          await p.click("#btnAddVideo");
          await p.fill("#tag-features", "엄청나게긴특징태그엄청나게긴특징태그엄청나게긴특징태그");
          await p.press("#tag-features", "Enter");
          await p.fill("#f-photo-in", "아주아주아주아주아주아주아주아주긴파일이름의현장사진.jpg");
          await p.click("#btnAddPhoto");
          await noScroll("입력 화면(건물·영상·태그·사진 포함)");
          if (width < 1100) {
            assert.equal(await p.isVisible("#edBar"), true, "모바일 하단 바");
            const cut = await p.$$eval("#edBar a", (as) => as.filter((a) => a.scrollWidth > a.clientWidth + 1).map((a) => a.textContent));
            assert.deepEqual(cut, [], "하단 바 글자 잘림 없음");
          } else assert.equal(await p.isVisible("#edBar"), false);
          if (width >= 760 && width < 900) {
            assert.equal(await p.$eval("#listPane", (e) => getComputedStyle(e).top), "16px", "머리글이 따라오지 않는 폭에서는 위쪽 빈 띠 없음");
          }
          if (process.env.SCREENSHOT_DIR) await p.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `admin-listing-${width}.png`), fullPage: true });
        });
      });
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
    for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 통과`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
