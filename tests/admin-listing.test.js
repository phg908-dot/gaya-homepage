// 매물 편집기(public/admin/listing.html) 브라우저 테스트
//
//   NODE_PATH=$(npm root -g) node site/tests/admin-listing.test.js
//
// - public/ 을 python3 -m http.server 로 띄우고 Playwright(chromium)로 실제 화면을 조작합니다.
// - 내보낸 listings.json 을 site/ 임시 복사본에 넣고 scripts/build.py --check 로
//   자바스크립트(rules.js)와 파이썬(build.py) 점검 결과가 같은지 교차 확인합니다.
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
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const ORDER = ["no", "status", "featured", "urgent", "sample", "title", "type", "deal", "price", "deposit", "monthly",
  "region", "land", "building", "recommendedUse", "summary", "description", "features", "videoIds", "photos", "lat", "lng", "updated"];
const today = (() => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
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

// ── 간단한 테스트 러너
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, e });
    console.log(`  ✗ ${name}\n      ${String(e && e.stack || e).split("\n").slice(0, 6).join("\n      ")}`);
  }
}

let browser, BASE;
const shared = {}; // 테스트 간 공유 (만든 매물 번호, 내보낸 JSON)

async function openEditor(opts = {}) {
  const context = opts.context || await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 }, acceptDownloads: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", (d) => (opts.onDialog ? opts.onDialog(d) : d.accept()));
  await page.route("https://i.ytimg.com/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX }));
  if (opts.siteJson) {
    await page.route("**/data/site.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opts.siteJson) }));
  }
  await page.goto(BASE + "/admin/listing.html" + (opts.query || ""));
  await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });
  return { page, context, errors, close: () => (opts.context ? page.close() : context.close()) };
}

const until = async (page, fn, arg, what) => {
  try { await page.waitForFunction(fn, arg, { timeout: 5000 }); } catch (_) {
    throw new Error("시간 초과: " + what + " / 점검칸: " + await page.textContent("#checkState").catch(() => "?"));
  }
};
const problems = (page) => page.$$eval("#checkProblems [data-problem]", (b) => b.map((x) => x.dataset.problem));
const warnings = (page) => page.$$eval("#checkWarnings li", (b) => b.map((x) => x.textContent));
const stateOf = (page) => page.$eval("#checkState", (s) => ({ cls: s.className, text: s.textContent }));
async function setVal(page, sel, v) {
  await page.fill(sel, String(v));
  await page.dispatchEvent(sel, "change");
}
async function newListing(page) {
  await page.click("#btnNew");
  await page.waitForSelector("#form:not([hidden])");
  return Number(await page.textContent("#fhNo"));
}
async function expectPublishable(page, what) {
  await until(page, () => document.getElementById("checkState").classList.contains("is-ok"), null, what + " → 게시 가능");
  const s = await stateOf(page);
  assert.match(s.text, /게시 가능/);
  assert.deepEqual(await problems(page), []);
}

async function fillCompleteLand(page) {
  const no = await newListing(page);
  await page.fill("#f-title", "테스트 지평면 계획관리 토지 465평");
  await page.selectOption("#f-type", "토지");
  await page.check('input[name="deal"][value="매매"]');
  await setVal(page, "#f-price", "3억 2천");
  assert.equal(await page.textContent("#pv-price"), "= 3억 2,000만원", "한글 금액 해석·미리보기");
  assert.equal(await page.inputValue("#f-price"), "32000", "칸을 벗어나면 숫자로 정리");
  await setVal(page, "#f-price", "18500");
  assert.equal(await page.textContent("#pv-price"), "= 1억 8,500만원");
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

(async function main() {
  const port = await freePort();
  const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "-d", PUB], { stdio: "ignore" });
  BASE = `http://127.0.0.1:${port}`;
  let tmp = null;
  try {
    await waitHttp(BASE + "/admin/listing.html");
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    console.log(`매물 편집기 테스트 (${BASE}, 원본 매물 ${ORIGINAL.length}개)`);

    // 하나의 브라우저 탭에서 이어서 작업 (실제 사용 흐름)
    const main = await openEditor();
    const { page } = main;

    await test("페이지가 콘솔 오류 없이 열리고 원본 매물(계약완료 포함)을 모두 보여준다", async () => {
      assert.equal(await page.$$eval("#list > li", (x) => x.length), ORIGINAL.length);
      assert.equal(await page.getAttribute('meta[name="robots"]', "content"), "noindex, nofollow");
      assert.equal(await page.getAttribute("body", "data-root"), "../");
      assert.equal(await page.textContent("#dirtyPill"), "변경 없음");
      const done = ORIGINAL.filter((l) => l.status === "계약완료").length;
      assert.equal(await page.$$eval("#list .ed-tag-done", (x) => x.length), done, "계약완료 매물도 목록에 나옴");
      const samples = ORIGINAL.filter((l) => l.sample).length;
      assert.equal(await page.$$eval("#list .ed-tag-sample", (x) => x.length), samples, "샘플 태그");
      assert.equal(await page.isHidden("#sampleBox"), samples === 0);
      const gh = SITE_JSON.admin && SITE_JSON.admin.repoEditUrl;
      assert.equal(await page.isVisible("#btnGithub"), !!gh, "repoEditUrl 이 없으면 GitHub 버튼 숨김");
      // 각 매물의 게시 가능/누락 배지가 rules.js 판정과 같은지
      const badges = await page.$$eval("#list > li", (lis) => lis.map((li) => [Number(li.dataset.no), li.querySelector(".ed-badge").textContent]));
      for (const [no, text] of badges) {
        const l = ORIGINAL.find((x) => x.no === no);
        const n = RULES.problems(l).length;
        if (l.status === "계약완료") assert.match(text, /계약완료/);
        else if (l.sample) assert.match(text, /샘플/);
        else assert.equal(text, n ? `누락 ${n}개` : "게시 가능 ✓", `No.${no} 배지`);
      }
      assert.deepEqual(main.errors, []);
    });

    await test("완전한 토지 매매 매물을 입력하면 '게시 가능'이 된다", async () => {
      shared.landNo = await fillCompleteLand(page);
      assert.equal(shared.landNo, Math.max(1000, ...ORIGINAL.map((l) => l.no)) + 1, "새 번호 = 최대 번호 + 1");
      await expectPublishable(page, "토지 매매");
      await until(page, (no) => {
        const li = document.querySelector(`#list > li[data-no="${no}"] .ed-badge`);
        return li && li.textContent === "게시 가능 ✓";
      }, shared.landNo, "목록 배지 게시 가능");
      assert.equal(await page.inputValue("#f-lat"), "37.4712", "좌표 한 번에 붙여넣기 → 위도");
      assert.equal(await page.inputValue("#f-lng"), "127.6321", "좌표 한 번에 붙여넣기 → 경도");
      assert.ok((await warnings(page)).some((w) => w.includes("좌표가 너무 정확")), "정밀 좌표 경고");
      await page.click("#btnRound");
      assert.equal(await page.inputValue("#f-lat"), "37.471");
      assert.ok(!(await warnings(page)).some((w) => w.includes("좌표가 너무 정확")));
      assert.equal(await page.inputValue("#f-updated"), today);
      await until(page, () => document.getElementById("dirtyPill").textContent === "저장 안 된 변경 있음", null, "변경 표시");
    });

    await test("평 → ㎡ 도우미와 ㎡ → 평 미리보기", async () => {
      await page.fill("#py-land", "100");
      await page.click('[data-py="f-land-area"]');
      assert.equal(await page.inputValue("#f-land-area"), "330.58");
      assert.equal(await page.textContent("#pv-land-area"), "= 약 100평");
      await setVal(page, "#f-land-area", "1537.2");
      assert.equal(await page.textContent("#pv-land-area"), "= 약 465평");
    });

    await test("가격을 지우면 가격 누락 문제가 뜨고, '협의'는 거부된다", async () => {
      await setVal(page, "#f-price", "");
      await until(page, () => document.getElementById("checkState").classList.contains("is-bad"), null, "가격 누락");
      assert.deepEqual(await problems(page), ["가격(단일가격 — '비공개'·'협의' 불가)"]);
      assert.match((await stateOf(page)).text, /누락 1개/);
      await page.click("#checkProblems [data-problem]");
      assert.equal(await page.evaluate(() => document.activeElement.id), "f-price", "문제를 누르면 해당 칸으로 이동");
      await page.fill("#f-price", "협의");
      assert.equal(await page.getAttribute("#f-price", "aria-invalid"), "true");
      assert.match(await page.textContent("#err-f-price"), /협의/);
      assert.deepEqual(await problems(page), ["가격(단일가격 — '비공개'·'협의' 불가)"]);
      await setVal(page, "#f-price", "18500");
      assert.equal(await page.getAttribute("#f-price", "aria-invalid"), null);
      await expectPublishable(page, "가격 복원");
    });

    await test("주택(전원주택) 건물에 방 수가 없으면 '건축물 방 수' 문제", async () => {
      shared.houseNo = await newListing(page);
      await page.fill("#f-title", "테스트 전원주택 방 수 누락");
      await page.selectOption("#f-type", "전원주택");
      await setVal(page, "#f-price", "32000");
      await page.fill("#f-eupmyeon", "지평면");
      await setVal(page, "#f-land-area", "562");
      await page.selectOption("#f-jimok", "대");
      await page.check("#hasBuilding");
      await page.waitForSelector("#buildingBody:not([hidden])");
      assert.equal(await page.isVisible("#req-rooms"), true, "주택이면 방 수 필수 표시");
      await setVal(page, "#f-b-area", "84.5");
      await setVal(page, "#f-b-approvalDate", "20150320");
      assert.equal(await page.inputValue("#f-b-approvalDate"), "2015-03-20", "날짜 자동 정리");
      await setVal(page, "#f-b-totalFloors", "1");
      await page.selectOption("#dir-face", "남향");
      assert.equal(await page.inputValue("#f-b-direction"), "남향(거실 기준)");
      await setVal(page, "#f-b-baths", "2");
      await setVal(page, "#f-b-parking", "2");
      await page.click("#mi-now");
      assert.equal(await page.inputValue("#f-b-moveIn"), "즉시입주");
      await page.click("#mt-none");
      assert.equal(await page.inputValue("#f-b-maintenance"), "없음");
      await until(page, () => document.querySelectorAll("#checkProblems [data-problem]").length === 1, null, "방 수만 남음");
      assert.deepEqual(await problems(page), ["건축물 방 수"]);
      await page.click('#checkProblems [data-problem="건축물 방 수"]');
      assert.equal(await page.evaluate(() => document.activeElement.id), "f-b-rooms");
      // 관리비도 지우면 둘 다 (build.py 와 같은 순서)
      await setVal(page, "#f-b-maintenance", "");
      assert.deepEqual(await problems(page), ["건축물 방 수", "건축물 관리비"]);
      await page.click("#mt-none");
      // 정액 관리비 10만원 이상 경고
      await setVal(page, "#f-b-maintenance", "월 12만원");
      assert.ok((await warnings(page)).includes("정액 관리비가 월 10만원 이상이면 일반관리비·사용료·기타관리비로 나눠 적으세요"));
      await setVal(page, "#f-b-maintenance", "일반관리비 7만원, 사용료 5만원");
      assert.ok(!(await warnings(page)).some((w) => w.startsWith("정액 관리비")));
      // 이 매물은 방 수 누락 상태로 남겨 파이썬 교차 확인에 씀
      assert.deepEqual(await problems(page), ["건축물 방 수"]);
    });

    await test("비주택(상가) 건물은 방 수·관리비가 없어도 게시 가능 + 월세 가격 칸", async () => {
      shared.shopNo = await newListing(page);
      await page.fill("#f-title", "테스트 양평읍 1층 상가");
      await page.selectOption("#f-type", "상가");
      await page.check('input[name="deal"][value="월세"]');
      assert.equal(await page.isHidden("#fld-price"), true, "월세는 매매가 칸 숨김");
      assert.equal(await page.isVisible("#fld-deposit"), true);
      assert.equal(await page.isVisible("#fld-monthly"), true);
      assert.equal(await page.textContent("#lbl-deposit"), "보증금");
      await setVal(page, "#f-deposit", "3000");
      await setVal(page, "#f-monthly", "150");
      assert.equal(await page.textContent("#pv-monthly"), "= 150만원");
      await page.fill("#f-eupmyeon", "양평읍");
      await page.uncheck("#hasLand");
      assert.ok((await problems(page)).includes("토지 면적"), "건물도 토지도 없으면 토지 면적 필요");
      await page.check("#hasBuilding");
      assert.equal(await page.isHidden("#req-rooms"), true, "비주택이면 방 수 필수 표시 없음");
      await setVal(page, "#f-b-area", "59.3");
      await setVal(page, "#f-b-totalFloors", "4");
      await page.fill("#f-b-floor", "1층");
      await setVal(page, "#f-b-approvalDate", "2009.11.2");
      assert.equal(await page.inputValue("#f-b-approvalDate"), "2009-11-02");
      await page.fill("#f-b-direction", "동향(주출입구 기준)");
      await setVal(page, "#f-b-baths", "1");
      await setVal(page, "#f-b-parking", "0");
      await page.selectOption("#mi-month", "11");
      await page.selectOption("#mi-part", "중순");
      await page.click("#mi-apply");
      assert.equal(await page.inputValue("#f-b-moveIn"), "11월 중순");
      await expectPublishable(page, "상가 월세");
      // 거래 형태를 매매로 바꾸면 보증금·월세는 비우고, 다시 월세로 오면 복원
      await page.check('input[name="deal"][value="매매"]');
      assert.deepEqual(await problems(page), ["가격(단일가격 — '비공개'·'협의' 불가)"]);
      await page.check('input[name="deal"][value="월세"]');
      assert.equal(await page.inputValue("#f-deposit"), "3000");
      assert.equal(await page.inputValue("#f-monthly"), "150");
      await expectPublishable(page, "월세 복원");
    });

    await test("유튜브 주소 4가지(watch?v=, youtu.be/, /shorts/, /embed/)를 영상 ID로 바꾸고 썸네일을 보여준다", async () => {
      const cases = [
        ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "dQw4w9WgXcQ"],
        ["https://youtu.be/9bZkp7q19f0?si=AbCdEf", "9bZkp7q19f0"],
        ["https://youtube.com/shorts/aqz-KE-bpKQ?feature=share", "aqz-KE-bpKQ"],
        ["https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?rel=0", "M7lc1UVf-VE"],
      ];
      for (const [url] of cases) {
        await page.fill("#f-video-in", url);
        await page.click("#btnAddVideo");
      }
      // 여러 개를 한 번에 + ID 그대로 + 중복 + 잘못된 주소
      await page.fill("#f-video-in", "kJQP7kiw5Fk m.youtube.com/watch?v=dQw4w9WgXcQ https://example.com/watch?v=nope");
      await page.click("#btnAddVideo");
      const ids = await page.$$eval("#videoList [data-id]", (x) => x.map((li) => li.dataset.id));
      assert.deepEqual(ids, cases.map((c) => c[1]).concat("kJQP7kiw5Fk"));
      const srcs = await page.$$eval("#videoList img", (x) => x.map((i) => i.getAttribute("src")));
      assert.deepEqual(srcs, ids.map((id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`));
      const err = await page.textContent("#videoErr");
      assert.match(err, /example\.com/);
      assert.match(err, /이미 들어 있는 영상/);
      // 순수 함수도 확인
      const more = await page.evaluate(() => ["https://www.youtube.com/live/dQw4w9WgXcQ?si=1", "www.youtube.com/watch?feature=x&v=dQw4w9WgXcQ",
        "https://youtube.com/embed/short", "dQw4w9WgXc", "javascript:alert(1)"].map(window.GAYA_LISTING_EDITOR.ytId));
      assert.deepEqual(more, ["dQw4w9WgXcQ", "dQw4w9WgXcQ", null, null, null]);
      shared.shopVideos = ids;
      // 빼기
      await page.click('#videoList [aria-label="영상 kJQP7kiw5Fk 빼기"]');
      shared.shopVideos = ids.slice(0, 4);
      assert.deepEqual(await page.$$eval("#videoList [data-id]", (x) => x.map((li) => li.dataset.id)), shared.shopVideos);
    });

    await test("계약완료로 바꾸면 3일 내 광고 삭제 의무 안내가 뜨고 게시 대상에서 빠진다", async () => {
      await page.click(`#list > li[data-no="${shared.shopNo}"] [data-act="dup"]`);
      const dupNo = Number(await page.textContent("#fhNo"));
      assert.equal(dupNo, shared.shopNo + 1, "복제 = 새 번호");
      assert.match(await page.inputValue("#f-title"), /\(복사\)$/);
      assert.equal(await page.$$eval("#videoList [data-id]", (x) => x.length), 0, "영상은 복사하지 않음");
      assert.equal(await page.isHidden("#doneNote"), true);
      await page.check('input[name="status"][value="계약완료"]');
      assert.equal(await page.isVisible("#doneNote"), true);
      assert.match(await page.textContent("#doneNote"), /계약 통보 후 3일 안에 광고 삭제 의무 — 유튜브 영상도 비공개로 돌리세요/);
      assert.match((await stateOf(page)).text, /계약완료/);
      // 삭제: 취소하면 그대로, 확인하면 삭제
      const count = () => page.$$eval("#list > li", (x) => x.length);
      const before = await count();
      main.page.removeAllListeners("dialog");
      page.once("dialog", (d) => d.dismiss());
      await page.click("#btnDelSel");
      assert.equal(await count(), before);
      page.once("dialog", (d) => { assert.match(d.message(), new RegExp(`No\\.${dupNo}`)); d.accept(); });
      await page.click("#btnDelSel");
      await until(page, (n) => document.querySelectorAll("#list > li").length === n, before - 1, "삭제");
      assert.equal(await page.isVisible("#emptyState"), true);
      page.on("dialog", (d) => d.accept());
    });

    await test("데이터는 글자로만 표시된다 (HTML 삽입 안 됨)", async () => {
      const evil = '<img src=x onerror="window.__xss=1"><b>굵게</b>';
      await page.click(`#list > li[data-no="${shared.houseNo}"] [data-act="edit"]`);
      const prev = await page.inputValue("#f-title");
      await page.fill("#f-title", evil);
      await until(page, (no) => document.querySelector(`#list > li[data-no="${no}"] .ed-li-title`).textContent.includes("<img"), shared.houseNo, "목록 제목 갱신");
      assert.equal(await page.$$eval("#list img, #formTitle img, #list b b", (x) => x.length), 0);
      assert.equal(await page.textContent("#fhTitle"), evil);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      await page.fill("#f-title", prev);
    });

    await test("내보낸 listings.json: 올바른 자료형·스키마 순서·2칸 들여쓰기·한글 그대로", async () => {
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btnDownload")]);
      assert.equal(dl.suggestedFilename(), "listings.json");
      const text = fs.readFileSync(await dl.path(), "utf-8");
      shared.exportText = text;
      assert.ok(text.endsWith("}\n]\n"), "마지막 줄바꿈");
      assert.ok(text.startsWith('[\n  {\n    "no": '), "2칸 들여쓰기");
      assert.ok(text.includes("지평면") && !/\\u[0-9a-f]{4}/i.test(text), "한글 그대로 (ensure_ascii=False)");
      const data = JSON.parse(text);
      assert.equal(data.length, ORIGINAL.length + 3);
      for (const l of data) {
        const keys = Object.keys(l).filter((k) => ORDER.includes(k));
        assert.deepEqual(keys, ORDER.filter((k) => keys.includes(k)), `No.${l.no} 항목 순서`);
        assert.deepEqual(Object.keys(l.region).slice(0, 4), ["sido", "sigungu", "eupmyeon", "ri"]);
        if (l.building) assert.deepEqual(Object.keys(l.building).slice(0, 11), ["area", "totalFloors", "floor", "approvalDate", "direction", "rooms", "baths", "parking", "moveIn", "maintenance", "violation"]);
        if (l.land) assert.deepEqual(Object.keys(l.land).slice(0, 5), ["area", "jimok", "zoning", "currentUse", "road"]);
        assert.equal(typeof l.no, "number");
        assert.equal(typeof l.featured, "boolean");
        assert.equal(typeof l.urgent, "boolean");
        assert.ok(!("sample" in l) || l.sample === true, "sample 은 샘플에만");
      }
      // 원본 매물은 내용이 그대로 (번호·가격·면적 등)
      for (const o of ORIGINAL) {
        const l = data.find((x) => x.no === o.no);
        assert.ok(l, `원본 No.${o.no} 유지`);
        assert.equal(l.title, o.title);
        assert.equal(l.price, o.price ?? null);
        assert.equal(l.status, o.status);
        assert.equal(!!l.sample, !!o.sample);
        if (o.land) assert.equal(l.land.area, o.land.area);
      }
      const land = data.find((x) => x.no === shared.landNo);
      assert.deepEqual(land, {
        no: shared.landNo, status: "거래중", featured: false, urgent: false, title: "테스트 지평면 계획관리 토지 465평",
        type: "토지", deal: "매매", price: 18500, deposit: null, monthly: null,
        region: { sido: "경기도", sigungu: "양평군", eupmyeon: "지평면", ri: "망미리" },
        land: { area: 1537.2, jimok: "답", zoning: "계획관리지역", currentUse: "농지(경작 중)", road: "4m 포장도로 접함" },
        building: null, recommendedUse: ["전원주택지"], summary: "하천 조망, 주택 신축 가능.", description: "남향 완경사.\n진입로 포장.",
        features: ["하천 조망", "도로 접함"], videoIds: [], photos: [], lat: 37.471, lng: 127.632, updated: today,
      });
      const shop = data.find((x) => x.no === shared.shopNo);
      assert.equal(shop.deal, "월세");
      assert.equal(shop.price, null);
      assert.equal(shop.deposit, 3000);
      assert.equal(shop.monthly, 150);
      assert.equal(shop.land, null);
      assert.deepEqual(shop.building, { area: 59.3, totalFloors: 4, floor: "1층", approvalDate: "2009-11-02", direction: "동향(주출입구 기준)",
        rooms: null, baths: 1, parking: 0, moveIn: "11월 중순", maintenance: "", violation: false });
      assert.deepEqual(shop.videoIds, shared.shopVideos);
      const house = data.find((x) => x.no === shared.houseNo);
      assert.equal(house.building.rooms, null);
      assert.equal(house.building.area, 84.5);
      assert.equal(house.building.approvalDate, "2015-03-20");
      // 새 매물은 목록 맨 앞
      assert.equal(data[0].no, shared.shopNo);
    });

    await test("'JSON 복사'는 다운로드와 같은 내용을 클립보드에 넣는다", async () => {
      await main.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
      await page.click("#btnCopy");
      await until(page, () => document.getElementById("toast").textContent.includes("복사했습니다"), null, "복사 알림");
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), shared.exportText);
    });

    await test("파이썬 build.py --check 와 교차 확인 (완전한 매물은 '명시사항 누락' 없음)", async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gaya-site-"));
      fs.cpSync(SITE, tmp, { recursive: true, filter: (src) => !/[\\/](dist|__pycache__|node_modules|listing|tests)$/.test(src) });
      fs.writeFileSync(path.join(tmp, "public/data/listings.json"), shared.exportText, "utf-8");
      const r = spawnSync("python3", ["-B", "scripts/build.py", "--check"], { cwd: tmp, encoding: "utf-8" });
      assert.equal(r.status, 0, r.stderr);
      const out = r.stdout;
      const lineOf = (no) => out.split("\n").filter((x) => x.includes(`No.${no}:`));
      for (const no of [shared.landNo, shared.shopNo]) {
        assert.deepEqual(lineOf(no).filter((x) => x.includes("명시사항 누락")), [], `No.${no} 는 파이썬에서도 누락 없음:\n${out}`);
      }
      const house = lineOf(shared.houseNo).join("\n");
      assert.match(house, /명시사항 누락/, "방 수 없는 주택은 파이썬도 누락으로 판정");
      assert.match(house, /건축물 방 수/);
      shared.pythonOut = out;
    });

    await test("rules.js problems()/publishable() 가 build.py 와 글자까지 같다 (내보낸 매물 + 경계 사례)", async () => {
      const R0 = { sido: "경기도", sigungu: "양평군", eupmyeon: "지평면", ri: "" };
      const B0 = { area: 50, totalFloors: 1, floor: "", approvalDate: "2020-01-01", direction: "남향(거실 기준)", rooms: 2, baths: 1, parking: 1, moveIn: "즉시입주", maintenance: "없음" };
      const edge = [
        {},
        { region: null, type: "아파트", deal: "매매", price: 1, building: B0 },
        { region: R0, type: "토지", deal: "매매", price: 0, land: { area: 0, jimok: "" } },
        { region: R0, type: "토지", deal: "매매", price: 100, land: { area: 100 } },
        { region: R0, type: "토지", deal: "매매", price: 100, land: {}, building: null },
        { region: R0, type: "주택", deal: "전세", price: 10000, deposit: null, land: {}, building: {} },
        { region: R0, type: "상가", deal: "월세", deposit: 0, monthly: null, building: { ...B0, rooms: null, maintenance: "", baths: 0, parking: 0, totalFloors: 0 } },
        { region: R0, type: "다세대·빌라", deal: "단기임대", deposit: 100, monthly: 50, building: { ...B0, rooms: 0, maintenance: "" } },
        { region: R0, type: "오피스텔", deal: "단기임대", deposit: 100, monthly: 50, building: { ...B0, rooms: null } },
        { region: R0, type: "펜션", deal: "매매", price: 1, building: { ...B0, direction: "", moveIn: null } },
        { region: { ...R0, sido: "" }, type: "", deal: "", price: 1, land: { area: 1, jimok: "대" } },
        { region: R0, type: "공장·창고", deal: "", price: null, deposit: 1, land: { area: 1, jimok: "공장용지" } },
        { region: R0, type: "토지", deal: "매매", price: 1, land: { area: 1, jimok: "전" }, status: "계약완료" },
        { region: R0, type: "토지", deal: "매매", price: 1, land: { area: 1, jimok: "전" }, sample: true },
        { region: R0, type: "토지", deal: "매매", price: 1, land: { area: 1, jimok: "전" }, status: "거래중", sample: false },
      ];
      const all = JSON.parse(shared.exportText).concat(edge);
      const code = "import json, sys\nsys.path.insert(0, 'scripts')\nimport build\n" +
        "print(json.dumps([[build.listing_problems(l), build.publishable(l)] for l in json.load(sys.stdin)], ensure_ascii=False))";
      const r = spawnSync("python3", ["-B", "-c", code], { cwd: SITE, input: JSON.stringify(all), encoding: "utf-8" });
      assert.equal(r.status, 0, r.stderr);
      const py = JSON.parse(r.stdout);
      // Node 에서 rules.js 를 직접 + 브라우저 안의 GAYA_RULES 둘 다 비교
      const inPage = await page.evaluate((list) => list.map((l) => [window.GAYA_RULES.problems(l), window.GAYA_RULES.publishable(l)]), all);
      all.forEach((l, i) => {
        const js = [RULES.problems(l), RULES.publishable(l)];
        assert.deepEqual(js, py[i], `사례 ${i} (${JSON.stringify(l).slice(0, 90)})`);
        assert.deepEqual(inPage[i], py[i], `브라우저 사례 ${i}`);
      });
    });

    await test("지목 28종·용도지역 21종·주택 판정 단어·건축물 필수 항목이 build.py 와 같다", async () => {
      const code = "import json, sys\nsys.path.insert(0, 'scripts')\nimport build\n" +
        "print(json.dumps({'jimok': sorted(build.JIMOK), 'zoning': sorted(build.ZONING), 'res': list(build.RESIDENTIAL_WORDS), " +
        "'building': list(build.BUILDING_REQUIRED.items())}, ensure_ascii=False))";
      const r = spawnSync("python3", ["-B", "-c", code], { cwd: SITE, encoding: "utf-8" });
      assert.equal(r.status, 0, r.stderr);
      const py = JSON.parse(r.stdout);
      assert.equal(RULES.JIMOK.length, 28);
      assert.equal(RULES.ZONING.length, 21);
      assert.deepEqual([...RULES.JIMOK].sort(), py.jimok);
      assert.deepEqual([...RULES.ZONING].sort(), py.zoning);
      assert.deepEqual(RULES.RESIDENTIAL_WORDS, py.res);
      assert.deepEqual(RULES.BUILDING_REQUIRED, py.building);
      // 경고 판정도 같은 값을 문제로 본다 (문구는 달라도 됨)
      const l = { land: { jimok: "대지", zoning: "계획관리지역, 계획관리" } };
      const w = RULES.warnings(l).join("\n");
      assert.match(w, /지목 '대지'/);
      assert.match(w, /'계획관리'/);
      assert.doesNotMatch(w, /'계획관리지역'/);
    });

    await test("자동 보관: 새로고침해도 작업 내용이 남고, '처음 상태로 되돌리기'로 원본 복귀", async () => {
      await page.waitForTimeout(500); // 자동 보관(0.3초 지연)
      await page.reload();
      await page.waitForSelector('body[data-ready="1"]');
      assert.equal(await page.$$eval("#list > li", (x) => x.length), ORIGINAL.length + 3);
      assert.equal(await page.textContent("#dirtyPill"), "저장 안 된 변경 있음");
      assert.equal(await page.isVisible("#loadNotice"), true);
      assert.match(await page.textContent("#saveState"), /추가 3/);
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

    await test("샘플 매물 표시와 일괄 삭제", async () => {
      const samples = ORIGINAL.filter((l) => l.sample);
      if (!samples.length) { assert.equal(await page.isHidden("#sampleBox"), true); return; }
      await page.click(`#list > li[data-no="${samples[0].no}"] [data-act="edit"]`);
      assert.equal(await page.isVisible("#sampleLine"), true, "편집 화면의 샘플 표시");
      assert.match((await stateOf(page)).text, /샘플/);
      await page.click("#btnDelSamples");
      await until(page, (n) => document.querySelectorAll("#list > li").length === n, ORIGINAL.length - samples.length, "샘플 삭제");
      assert.equal(await page.isHidden("#sampleBox"), true);
      assert.equal(await page.isVisible("#emptyState"), true);
      await page.click("#btnReset");
      await until(page, (n) => document.querySelectorAll("#list > li").length === n, ORIGINAL.length, "되돌리기");
    });

    await test("?no= 로 바로 열기 + 유튜브 설명란 링크", async () => {
      const target = ORIGINAL[ORIGINAL.length - 1];
      await page.goto(BASE + `/admin/listing.html?no=${target.no}`);
      await page.waitForSelector('body[data-ready="1"]');
      assert.equal(Number(await page.textContent("#fhNo")), target.no);
      assert.equal(await page.getAttribute("#ytLink", "href"), `youtube.html?no=${target.no}`);
    });

    await test("위 작업 전체에서 콘솔 오류가 없다", async () => {
      assert.deepEqual(main.errors, []);
    });
    await main.close();

    await test("site.json 의 admin.repoEditUrl 이 있으면 GitHub 버튼 표시 (https 만 허용)", async () => {
      const url = "https://github.com/owner/gaya-homepage/edit/main/public/data/listings.json";
      const a = await openEditor({ siteJson: { ...SITE_JSON, admin: { repoEditUrl: url } } });
      assert.equal(await a.page.isVisible("#btnGithub"), true);
      assert.equal(await a.page.getAttribute("#btnGithub", "href"), url);
      assert.equal(await a.page.isHidden("#githubHint"), true);
      await a.close();
      const b = await openEditor({ siteJson: { ...SITE_JSON, admin: { repoEditUrl: "javascript:alert(1)" } } });
      assert.equal(await b.page.isHidden("#btnGithub"), true);
      assert.deepEqual(a.errors.concat(b.errors), []);
      await b.close();
    });

    for (const width of [360, 768, 1280]) {
      await test(`${width}px 화면에서 가로 스크롤이 생기지 않는다`, async () => {
        const v = await openEditor({ viewport: { width, height: 780 } });
        const p = v.page;
        const noScroll = async (where) => {
          const [sw, cw] = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
          assert.ok(sw <= cw, `${where}: scrollWidth ${sw} > ${cw}`);
        };
        await noScroll("처음 화면");
        await newListing(p);
        await p.fill("#f-title", "아주 긴 제목 ".repeat(12));
        await p.check("#hasBuilding");
        await p.fill("#f-video-in", "https://www.youtube.com/watch?v=dQw4w9WgXcQ https://youtu.be/9bZkp7q19f0");
        await p.click("#btnAddVideo");
        await p.fill("#tag-features", "엄청나게긴특징태그엄청나게긴특징태그엄청나게긴특징태그");
        await p.press("#tag-features", "Enter");
        await noScroll("입력 화면(건물·영상·태그 포함)");
        if (width < 1100) assert.equal(await p.isVisible("#edBar"), true, "모바일 하단 점검 바");
        else assert.equal(await p.isVisible("#edBar"), false);
        if (process.env.SCREENSHOT_DIR) await p.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `admin-listing-${width}.png`), fullPage: true });
        assert.deepEqual(v.errors, []);
        await v.close();
      });
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 통과`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
