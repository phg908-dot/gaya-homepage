// 사이트 회귀 테스트 — 실행: NODE_PATH=$(npm root -g) node tests/site.test.js  (site/ 폴더에서)
// Playwright + 로컬 http.server 사용. 외부 네트워크(유튜브 썸네일·폰트·지도)는 차단/모의 처리.
const { chromium } = require("playwright");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SITE = path.resolve(__dirname, "..");
const PORT = 8700 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/`;
const VIDS = { channelId: "UCx", updated: "", videos: [
  { id: "aaaaaaaaaa1", title: "지평면 전원주택 현장 매물번호 1001", published: "2026-10-15T09:00:00+00:00", description: "", isShort: false },
  { id: "aaaaaaaaaa2", title: "토지 영상 No.1002", published: "2026-10-14T09:00:00+00:00", description: "", isShort: false },
  { id: "aaaaaaaaaa3", title: "양평 토지 체크리스트", published: "2026-10-10T09:00:00+00:00", description: "", isShort: false },
  { id: "aaaaaaaaaa4", title: "개울 옆 양평 지평 전원주택지 1,855㎡(562평) 2억3천 #양평토지", published: "2026-10-09T09:00:00+00:00", description: "", isShort: false },
  { id: "aaaaaaaaaa5", title: "양평 지평면 토지 330㎡(100평) 1억2천 #양평토지", published: "2026-10-08T09:00:00+00:00", description: "", isShort: true },
] };

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log("  ✓ " + msg); else { failed++; console.log("  ✗ " + msg); } };

async function page(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: !!opts.mobile, hasTouch: !!opts.mobile });
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.route("**/data/videos.json", (r) => r.fulfill({ json: VIDS }));
  if (opts.listings) await p.route("**/data/listings.json", (r) => r.fulfill({ json: opts.listings }));
  await p.route(/i\.ytimg\.com|cdn\.jsdelivr\.net|dapi\.kakao\.com|oapi\.map\.naver\.com/, (r) => r.abort());
  return p;
}

(async () => {
  execFileSync("python3", ["scripts/build.py"], { cwd: SITE, stdio: "ignore" });
  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", path.join(SITE, "public")], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 700));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  try {
    console.log("메인 (데스크톱)");
    let p = await page(browser);
    await p.goto(BASE);
    await p.waitForSelector("#cards .card");
    const n = () => p.locator("#cards .card").count();
    ok(await n() === 4, "거래중 매물 4건 표시 (계약완료 제외)");
    await p.click('#cats .cat[data-type="토지"]');
    ok(await n() === 1, "종류 버튼 필터");
    ok(await p.evaluate(() => document.activeElement && document.activeElement.dataset.type === "토지"), "버튼을 눌러도 포커스 유지");
    ok(p.url().includes("type="), "종류가 주소에 반영");
    const catH = await p.locator('#cats .cat[data-type="토지"]').evaluate((e) => e.getBoundingClientRect().height);
    ok(catH >= 56, "종류 버튼이 큼");
    await p.click('#cats .cat[data-type=""]');
    ok(await n() === 4, "전체 버튼");
    await p.fill("#heroQ", "No.1003"); await p.press("#heroQ", "Enter");
    ok(await n() === 1, "매물번호 검색");
    await p.click("#qClear");
    await p.fill("#heroQ", "매물번호 1002"); await p.press("#heroQ", "Enter");
    ok(await n() === 1, "'매물번호 1002' 검색");
    await p.fill("#heroQ", "1003번"); await p.press("#heroQ", "Enter");
    ok(await n() === 1, "'1003번' 검색");
    await p.click("#qClear");
    ok(await p.evaluate(() => document.activeElement.id === "heroQ"), "검색 지우기 후 검색창으로 포커스");
    ok(await n() === 4, "검색을 지우면 전체");
    ok(!(await p.textContent("#listTitle")).includes("0건"), "건수가 있을 때 0건이라고 쓰지 않음");
    ok(await p.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize) >= 18), "본문 18px 이상");
    ok(await p.locator("#blog").isVisible() && await p.locator("#about").isVisible(), "블로그 소식·사무소 소개");
    ok(await p.locator("#cards[aria-live]").count() === 0, "목록 전체를 읽어주는 aria-live 없음");
    ok((await p.textContent(".contact-panel .tel-big")).trim() === "010-3406-0071", "대표번호(휴대폰) 표시");
    ok(!(await p.content()).includes("031-772-2060"), "사무실 번호는 표시하지 않음");
    ok(p.errors.length === 0, "JS 오류 없음 " + p.errors.join(" | "));

    console.log("메인 (모바일)");
    p = await page(browser, { mobile: true });
    await p.goto(BASE);
    await p.waitForSelector("#cards .card");
    ok(await p.evaluate(() => document.documentElement.scrollWidth) <= 390, "가로 스크롤 없음");
    ok(await p.locator(".nav a").first().isVisible(), "모바일 메뉴 보임");
    ok(await p.evaluate(() => getComputedStyle(document.querySelector(".cards")).gridTemplateColumns.split(" ").length === 1), "매물 카드 한 줄");
    const bar = p.locator(".mbar");
    ok(await bar.isVisible(), "하단 연락 막대");
    const barText = await bar.innerText();
    ok(barText.includes("전화하기") && barText.includes("문자하기"), "전화하기·문자하기");
    ok(await bar.evaluate((e) => e.getBoundingClientRect().height) >= 64, "하단 막대가 큼");
    ok(p.errors.length === 0, "JS 오류 없음 " + p.errors.join(" | "));

    console.log("잘못된 링크·데이터");
    p = await page(browser);
    await p.goto(BASE + "?sort=__proto__&type=없는종류");
    await p.waitForSelector("#cards .card");
    ok(await p.locator("#cards .card").count() === 4 && p.errors.length === 0, "?sort=__proto__ 와 없는 종류는 무시");
    p = await page(browser, { listings: [{ ...JSON.parse(fs.readFileSync(path.join(SITE, "public/data/listings.json"), "utf8"))[0], no: "1001", status: "계약 완료" }, { ...JSON.parse(fs.readFileSync(path.join(SITE, "public/data/listings.json"), "utf8"))[1], no: "1002" }] });
    await p.goto(BASE);
    await p.waitForSelector("#cards .card");
    ok(await p.locator("#cards .card").count() === 1, "띄어쓴 '계약 완료'는 숨김, 문자열 번호는 보정");
    await p.goto(BASE + "videos.html");
    await p.waitForSelector(".vcard");
    ok(await p.locator('.vlink[href$="1002.html"]').count() === 1, "문자열 번호 매물에도 영상 연결");

    console.log("매물 없음 → 영상으로 채움");
    p = await page(browser, { listings: [] });
    await p.goto(BASE);
    await p.waitForSelector("#cards .card");
    ok(await p.locator("#cards .card").count() >= 1, "매물 글이 없으면 현장 영상을 매물로 보여 줌");
    ok((await p.textContent("#listTitle")).includes("매물 영상"), "제목이 매물 영상");
    ok(!(await p.textContent("#listTitle")).includes("0건"), "0건을 보여 주지 않음");
    ok(!(await p.locator("body").innerText()).includes("전체 매물 0"), "빈 목록 문구 없음");
    await p.click('#cats .cat[data-type="토지"]');
    ok(await p.locator("#cards .card").count() >= 1, "영상도 토지 버튼으로 거름");
    ok(!(await p.textContent("#stats")).includes("0 거래"), "0인 현황 숨김");
    ok(p.errors.length === 0, "JS 오류 없음 " + p.errors.join(" | "));

    console.log("더 보기 (30건)");
    const base = JSON.parse(fs.readFileSync(path.join(SITE, "public/data/listings.json"), "utf8"))[1];
    const many = Array.from({ length: 30 }, (_, i) => ({ ...base, no: 2000 + i, featured: false, urgent: false, status: "거래중" }));
    p = await page(browser, { listings: many });
    await p.goto(BASE);
    await p.waitForSelector("#cards .card");
    ok(await p.locator("#cards .card").count() === 12, "처음 12건");
    await p.click("#more");
    ok(await p.locator("#cards .card").count() === 24, "더 보기 후 24건");
    ok(p.url().includes("n=24"), "더 보기 상태가 주소에 저장");
    await p.reload();
    await p.waitForSelector("#cards .card");
    ok(await p.locator("#cards .card").count() === 24, "새로고침해도 24건 유지");

    console.log("매물 상세");
    p = await page(browser);
    await p.goto(BASE + "listing/1001.html");
    await p.waitForTimeout(300);
    ok((await p.title()).includes("양평 지평면"), "검색용 제목");
    ok(await p.isVisible(".keyfacts"), "핵심 정보 줄");
    ok((await p.textContent("#officeInfo")).includes("등록번호"), "사무소 명시사항");
    ok(await p.isVisible("#related"), "비슷한 매물");
    // 하트 기호는 aria-hidden 이므로 접근성 이름("찜하기")만 비교
    const accName = () => p.locator(".fav-inline").evaluate((e) => [...e.childNodes].filter((n) => !(n.nodeType === 1 && n.getAttribute("aria-hidden") === "true")).map((n) => n.textContent).join("").trim());
    const favName = await accName();
    await p.click(".fav-inline");
    ok(favName === "찜하기" && (await accName()) === favName && (await p.getAttribute(".fav-inline", "aria-pressed")) === "true", "찜 버튼 이름 고정, 상태만 변경");
    ok(p.errors.length === 0, "JS 오류 없음 " + p.errors.join(" | "));

    console.log("영상");
    p = await page(browser);
    await p.goto(BASE + "videos.html");
    await p.waitForSelector(".vcard");
    ok(await p.locator(".vcard").count() === 3, "본편 매물 영상만 표시 (쇼츠·정보 영상 제외)");
    await p.click('.chip[data-kind="linked"]');
    ok(await p.locator(".vcard").count() === 2, "매물 정보 연결 필터");
    await p.click(".yt-btn");
    ok(await p.evaluate(() => document.activeElement && document.activeElement.tagName === "IFRAME"), "재생 시 플레이어로 포커스");

    console.log("매물 접수");
    p = await page(browser, { mobile: true });
    await p.goto(BASE + "sell.html");
    await p.waitForTimeout(300);
    await p.click("#submitBtn");
    ok((await p.textContent("#phoneErr")).length > 0, "필수 입력 검증");
    await p.fill("#fPhone", "010-1234-5678");
    await p.fill("#fAddr", "양평군 지평면");
    const composed = await p.evaluate(() => new Promise((res) => {
      document.getElementById("sellForm").addEventListener("submit", () => setTimeout(() => res(document.getElementById("preview").textContent), 50), { once: true });
      document.getElementById("submitBtn").click();
    }));
    ok(composed.includes("양평군 지평면") && composed.includes("010-1234-5678"), "접수 문구 구성");

    console.log("배포 빌드");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gaya-"));
    execFileSync("cp", ["-r", path.join(SITE, "public"), path.join(SITE, "scripts"), tmp]);
    const lp = path.join(tmp, "public/data/listings.json");
    const L = JSON.parse(fs.readFileSync(lp, "utf8")).map((l) => ({ ...l, sample: false }));
    fs.writeFileSync(lp, JSON.stringify(L));
    const sp = path.join(tmp, "public/data/site.json");
    const S = JSON.parse(fs.readFileSync(sp, "utf8")); S.siteUrl = "https://www.example.kr"; fs.writeFileSync(sp, JSON.stringify(S));
    execFileSync("python3", ["scripts/build.py", "--prod"], { cwd: tmp, stdio: "ignore" });
    const dist = path.join(tmp, "dist");
    const pages = fs.readdirSync(path.join(dist, "listing"));
    ok(!pages.includes("1005.html"), "계약완료 매물 페이지 없음");
    ok(!fs.readFileSync(path.join(dist, "sitemap.xml"), "utf8").includes("1005"), "사이트맵에서 계약완료 제외");
    const idx = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    ok(idx.includes("등록번호</b>") && idx.includes("RealEstateAgent"), "정적 명시사항 + 구조화 데이터");
    ok(idx.includes('content="https://www.example.kr/images/og.png"'), "공유 이미지 절대 주소");
    fs.rmSync(tmp, { recursive: true, force: true });
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failed ? `\n실패 ${failed}건` : "\n모두 통과");
  process.exit(failed ? 1 : 0);
})();
