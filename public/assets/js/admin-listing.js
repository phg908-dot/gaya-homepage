// 매물 편집기 (admin/listing.html)
// - data/listings.json 을 그대로(계약완료·샘플 포함) 불러와 폼으로 고치고, 고친 파일을 내려받아 GitHub에 올리는 방식
// - 작업 중인 내용은 이 브라우저 localStorage 에 자동 보관 (실패해도 동작). 홈페이지 파일이 그 사이 바뀌면 고르게 함
// - 광고 명시사항 점검은 rules.js(window.GAYA_RULES) — scripts/build.py 와 문구·순서까지 같은 판정.
//   점검은 '내려받을 파일에 들어갈 모양'(canonical)으로 하므로, 편집기에서 본 결과 = 배포 때 build.py 결과
// - 보안: 데이터는 textContent / DOM 생성으로만 화면에 넣습니다 (innerHTML 사용 안 함)
(function () {
  "use strict";
  const R = window.GAYA_RULES;
  const G = window.GAYA || {};
  const ROOT = document.body.dataset.root || "../";
  const STORE_KEY = "gaya.listingEditor.v1";
  const BAK_KEY = STORE_KEY + ".bak";     // 지우거나 바꾸기 직전의 작업 내용 (한 번 더 되살릴 수 있게)
  const MAXNO_KEY = STORE_KEY + ".maxNo"; // 이 브라우저에서 본·내보낸 가장 큰 매물번호 (지운 번호를 다시 주지 않게)
  const PY = 0.3025;
  const $ = (id) => document.getElementById(id);

  const el = G.el || function (tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c);
    return e;
  };
  const money = G.money || function (manwon) {
    if (manwon == null || manwon === "") return "";
    const n = Number(manwon), eok = Math.floor(n / 10000), rest = n % 10000;
    if (eok && rest) return `${eok}억 ${rest.toLocaleString("ko-KR")}만원`;
    if (eok) return `${eok}억원`;
    return `${rest.toLocaleString("ko-KR")}만원`;
  };

  // ── 내보내는 모양 (이 순서로 정리. 모르는 항목은 지우지 않고 맨 뒤에 붙임)
  const ORDER = ["no", "status", "featured", "urgent", "sample", "title", "type", "deal", "price", "deposit", "monthly",
    "region", "land", "building", "recommendedUse", "summary", "description", "features", "videoIds", "photos",
    "lat", "lng", "updated"];
  const REGION_KEYS = ["sido", "sigungu", "eupmyeon", "ri", "jibun", "showJibun"];
  const LAND_KEYS = ["area", "jimok", "zoning", "currentUse", "road"];
  const BUILDING_KEYS = ["use", "area", "totalFloors", "floor", "approvalDate", "direction", "rooms", "baths", "parking",
    "moveIn", "maintenance", "violation"];
  const DROPPED = { region: ["hideJibun"] }; // 예전 항목 (지번은 이제 비공개가 원칙 — showJibun 만 사용)
  const DEAL_FIELDS = { "매매": ["price"], "전세": ["deposit"], "월세": ["deposit", "monthly"], "단기임대": ["deposit", "monthly"] };
  const PRICE_KEYS = ["price", "deposit", "monthly"];
  const YANGPYEONG = ["양평읍", "강상면", "강하면", "양서면", "옥천면", "서종면", "단월면", "청운면", "양동면", "지평면", "용문면", "개군면"];

  const isDict = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  const isPosInt = (n) => typeof n === "number" && Number.isInteger(n) && n > 0;
  // 숫자 칸: build.py 가 숫자로 읽는 값이면 숫자(또는 null), 못 읽는 값('협의' 등)은 그대로 두어 점검에서 알려 줌
  function numVal(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const [n, ok] = R.toNum(v);
    return ok && (n === null || Number.isFinite(n)) ? n : v;
  }
  // 글 칸: 앞뒤 공백 정리, 비어 있으면 "", 숫자는 글자로 (참/거짓·목록 같은 잘못된 값은 그대로 두어 점검에서 알려 줌)
  function textVal(v) {
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return R.strip(v);
    if (typeof v === "number") return R.pyStr(v);
    return v;
  }
  const zoningVal = (z) => (typeof z === "string" ? R.splitZoning(z).join(", ") : textVal(z));
  function withExtras(out, src, known) {
    if (isDict(src)) for (const k of Object.keys(src)) if (!known.includes(k) && !(k in out)) out[k] = src[k];
    return out;
  }
  const blankPart = (o, keys) => keys.every((k) => o[k] == null || o[k] === "" || o[k] === false) &&
    Object.keys(o).every((k) => keys.includes(k));

  function regionVal(r) {
    r = isDict(r) ? r : {};
    const o = {};
    for (const k of ["sido", "sigungu", "eupmyeon", "ri", "jibun"]) o[k] = typeof r[k] === "boolean" ? r[k] : textVal(r[k]);
    const sj = r.showJibun;
    const s = sj == null || typeof sj === "boolean" ? "" : R.strip(R.pyStr(sj)).toLowerCase();
    o.showJibun = sj === true || ["true", "1", "예", "y"].includes(s); // build.py normalize() 와 같은 판정
    return withExtras(o, r, REGION_KEYS.concat(DROPPED.region));
  }
  function landVal(d) {
    if (!isDict(d) || !Object.keys(d).length) return null;
    return withExtras({ area: numVal(d.area), jimok: textVal(d.jimok), zoning: zoningVal(d.zoning),
      currentUse: textVal(d.currentUse), road: textVal(d.road) }, d, LAND_KEYS);
  }
  function buildingVal(d) {
    if (!isDict(d) || !Object.keys(d).length) return null;
    return withExtras({
      use: textVal(d.use), area: numVal(d.area), totalFloors: numVal(d.totalFloors), floor: textVal(d.floor),
      approvalDate: textVal(d.approvalDate), direction: textVal(d.direction), rooms: numVal(d.rooms),
      baths: numVal(d.baths), parking: numVal(d.parking), moveIn: textVal(d.moveIn), maintenance: textVal(d.maintenance),
      violation: R.truthy(d.violation),
    }, d, BUILDING_KEYS);
  }

  // 내려받을 파일에 들어가는 모양 (항목 순서·자료형 정리, 모르는 항목 보존). 여러 번 해도 결과가 같음
  function canonical(l) {
    l = isDict(l) ? l : {};
    const o = {};
    o.no = numVal(l.no);
    const st = R.statusOf(l.status);
    o.status = st || l.status;
    o.featured = R.truthy(l.featured);
    o.urgent = R.truthy(l.urgent);
    if (R.truthy(l.sample)) o.sample = true;
    o.title = typeof l.title === "string" ? R.strip(l.title) : l.title == null ? "" : l.title;
    o.type = textVal(l.type);
    o.deal = textVal(l.deal);
    for (const k of PRICE_KEYS) o[k] = numVal(l[k]);
    o.region = regionVal(l.region);
    o.land = landVal(l.land);
    o.building = buildingVal(l.building);
    // 건물만 있는 매물(아파트·상가 호실)의 빈 토지 칸은 '토지 없음'(null) — 상세 페이지에 빈 '토지' 표가 생기지 않게
    if (o.land && o.building && blankPart(o.land, LAND_KEYS)) o.land = null;
    o.recommendedUse = R.asList(l.recommendedUse);
    o.summary = textVal(l.summary);
    o.description = typeof l.description === "string" ? R.strip(l.description.replace(/\r\n?/g, "\n")) : textVal(l.description);
    o.features = R.asList(l.features);
    o.videoIds = [...new Set(R.asList(l.videoIds).map((x) => ytId(x) || x))];
    o.photos = R.asList(l.photos);
    o.lat = numVal(l.lat);
    o.lng = numVal(l.lng);
    o.updated = textVal(l.updated);
    return withExtras(o, l, ORDER);
  }
  // build.py 와 같은 모양: 2칸 들여쓰기, 한글 그대로, 마지막 줄바꿈
  const serialize = (list) => JSON.stringify(list, null, 2) + "\n";

  // ── 입력값 해석
  const MONEY_BAN = /협의|비공개|문의|미정|추후|별도|[~∼〜]|\d\s*[-–]\s*\d|^[-–]/;
  function parseManwon(raw) {
    const s0 = R.asciiDigits(R.strip(String(raw == null ? "" : raw)));
    if (!s0) return { value: null, error: "" };
    if (MONEY_BAN.test(s0)) {
      return { value: null, error: "가격은 하나의 금액(숫자)만 쓸 수 있습니다 — '협의'·'비공개'·범위 표시는 법으로 금지되어 있습니다" };
    }
    let s = s0.replace(/[,\s]/g, "");
    // '300,000원' 처럼 단위(만·천·억) 없이 '원'으로 끝나면 원 단위 → 만원으로 바꿈 (그대로 두면 1만 배가 됨)
    if (/원$/.test(s) && !/[억천백만]/.test(s)) {
      const w = s.slice(0, -1);
      if (!/^\d+$/.test(w)) return { value: null, error: "숫자로 입력하세요 (만원 단위, 예: 32000 또는 3억 2천)" };
      const won = Number(w);
      if (won % 10000) {
        return { value: null, error: `원 단위로 적으셨나요? 이 칸은 만원 단위입니다 — 만원 미만은 쓸 수 없습니다 (예: 300,000원 → 30)` };
      }
      return { value: won / 10000, error: "", note: `${won.toLocaleString("ko-KR")}원 → ${(won / 10000).toLocaleString("ko-KR")}만원으로 바꿨습니다` };
    }
    s = s.replace(/원$/, "");
    let v = null;
    if (/^\d+(\.\d+)?$/.test(s)) v = parseFloat(s);
    else {
      const m = s.match(/^(?:(\d+(?:\.\d+)?)억)?(?:(\d+(?:\.\d+)?)천)?(?:(\d+(?:\.\d+)?)백)?(\d+(?:\.\d+)?)?만?$/);
      if (m && (m[1] || m[2] || m[3] || m[4])) v = (+m[1] || 0) * 10000 + (+m[2] || 0) * 1000 + (+m[3] || 0) * 100 + (+m[4] || 0);
    }
    if (v == null) return { value: null, error: "숫자로 입력하세요 (만원 단위, 예: 32000 또는 3억 2천)" };
    v = Math.round(v * 1e6) / 1e6;
    if (!Number.isInteger(v)) return { value: null, error: "만원 단위의 정수로 적어 주세요 (예: 1억 5천5백 → 15500)" };
    return { value: v, error: "" };
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  function parseArea(raw) {
    const s0 = R.asciiDigits(R.strip(String(raw == null ? "" : raw)));
    if (!s0) return { value: null, error: "" };
    if (/평/.test(s0)) {
      const [py, ok] = R.toNum(s0.replace(/평/g, ""));
      if (!ok || py == null || !(py >= 0) || !Number.isFinite(py)) return { value: null, error: "숫자로 입력하세요" };
      return { value: round2(py / PY), error: "", note: `${py}평을 ㎡로 바꿨습니다` };
    }
    const [n, ok] = R.toNum(s0.replace(/㎡|m²|m2|제곱미터/gi, ""));
    if (!ok || n == null || !(n >= 0) || !Number.isFinite(n)) return { value: null, error: "숫자로 입력하세요 (㎡)" };
    return { value: n, error: "" };
  }
  function parseCount(raw) { // 층수·방·욕실·주차
    const s = R.asciiDigits(String(raw == null ? "" : raw)).replace(/[,\s]|개|대|층|호|칸/g, "");
    if (!s) return { value: null, error: "" };
    if (!/^\d+$/.test(s)) return { value: null, error: "0 이상의 정수(숫자)만 입력하세요" };
    return { value: parseInt(s, 10), error: "" };
  }
  function parseNo(raw) {
    const s = R.asciiDigits(String(raw == null ? "" : raw)).replace(/[,\s]/g, "").replace(/^(no\.?|매물번호)/i, "");
    if (!s) return { value: null, error: "매물번호를 넣으세요 (1 이상의 정수)" };
    if (!/^\d+$/.test(s) || parseInt(s, 10) < 1) return { value: null, error: "매물번호는 1 이상의 정수만 쓸 수 있습니다" };
    return { value: parseInt(s, 10), error: "" };
  }
  const PAIR_RE = /^\s*(-?\d+(?:\.\d+)?)\s*(?:[,/]\s*|\s+)(-?\d+(?:\.\d+)?)\s*$/;
  function parseCoord(raw) {
    const s = R.asciiDigits(R.strip(String(raw == null ? "" : raw)));
    if (!s) return { value: null, error: "" };
    const [n, ok] = R.toNum(s);
    return !ok || n == null || !Number.isFinite(n) ? { value: null, error: "숫자로 입력하세요" } : { value: n, error: "" };
  }
  function normYmd(raw) {
    const s = R.asciiDigits(String(raw == null ? "" : raw).trim());
    const d = s.replace(/\D/g, "");
    if (/^\d+$/.test(s) && d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
    if (/^\d+$/.test(s) && d.length === 6) return `${d.slice(0, 4)}-${d.slice(4)}`;
    const m = s.match(/^(\d{4})\s*[.\/\-년]\s*(\d{1,2})\s*(?:[.\/\-월]\s*(\d{1,2})\s*일?)?\s*\.?$/);
    if (m) return m[3] ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : `${m[1]}-${m[2].padStart(2, "0")}`;
    return s;
  }
  // 유튜브 영상 주소(watch?v=, youtu.be/, /shorts/, /embed/, /live/) 또는 11자리 ID → ID.
  // common.js GAYA.ytId·build.py yt_id 가 받는 모양만 돌려주고, 재생목록(videoseries·list=)은 거부
  const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  function ytId(input) {
    const s = String(input == null ? "" : input).trim();
    if (!s) return null;
    if (YT_ID_RE.test(s)) return s === "videoseries" ? null : s;
    let u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s.replace(/^\/+/, "")); } catch (_) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
    let id = null;
    if (host === "youtu.be") id = u.pathname.split("/")[1];
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      id = u.searchParams.get("v");
      if (!id) { const m = u.pathname.match(/^\/(?:shorts|embed|live|v|e)\/([^/?#]+)/); if (m) id = m[1]; }
    }
    return id && id !== "videoseries" && YT_ID_RE.test(id) ? id : null;
  }
  const isPlaylist = (s) => /[?&]list=|\/playlist\b|videoseries/.test(String(s));
  function photoPath(raw) {
    let s = String(raw || "").trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^public\//, "");
    if (!s) return "";
    if (!s.includes("/")) s = "images/" + s;
    return s;
  }
  function today() {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function hash(s) { // 내용이 바뀌었는지만 확인하는 짧은 지문
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16) + ":" + s.length;
  }
  const fmtPy = (m2) => (m2 * PY).toLocaleString("ko-KR", { maximumFractionDigits: 1 });
  const fmtTime = (d) => { try { return new Date(d).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } };
  const noLabel = (no) => (isPosInt(no) ? String(no) : "?");

  // ── 상태
  const S = {
    original: [], originalText: "", baseHash: "", site: {}, basis: R ? R.DIRECTION_BASIS : "",
    defaults: { sido: "경기도", sigungu: "양평군" },
    working: [], sel: null, filter: "all",
    stash: new WeakMap(),   // 매물별: 끈 토지·건물, 거래 형태별 가격
    fresh: new Map(),       // '+ 새 매물'로 만들고 아직 손대지 않은 매물 → 처음 모양
    usedNos: new Set(),     // 이번에 쓰거나 나눠 준 번호 (지운 매물 번호를 다시 주지 않게)
    closedNos: new Set(),   // site.json closedListingNos (지운 매물 번호 — build.py 가 이 번호를 쓴 영상을 뺌)
    cited: new Map(),       // data/videos.json 에서 '매물번호 N'을 적은 영상: N → [제목]
    storageOK: true, savedAt: null, loadFailed: false, pendingDraft: null,
    offline: null,          // 홈페이지 파일을 못 읽어 {how: "draft"|"import", name} 기준으로 작업 중
    hasBak: false, bakLabel: "", // 백업해 둔 작업 내용이 있는지 + '시각, 매물 N개'
    exported: null,         // 마지막으로 내려받은/복사한 내용 {hash, at, how}
    lastCheck: null,
  };
  const stashOf = (l) => { if (!S.stash.has(l)) S.stash.set(l, {}); return S.stash.get(l); };
  const freshKey = (l) => JSON.stringify(canonical(l));
  const isUntouchedFresh = (l) => S.fresh.has(l) && S.fresh.get(l) === freshKey(l);
  // 내려받을 목록 (손대지 않은 새 매물은 빼고)
  const exportList = () => S.working.filter((l) => !isUntouchedFresh(l)).map(canonical);
  const exportText = () => serialize(exportList());
  const isDirty = () => !S.loadFailed && exportText() !== S.originalText;

  // 새 번호 = 홈페이지가 지금까지 쓴 어떤 번호보다 큰 수 중, 유튜브 영상이 이미 적고 있는 번호를 건너뛴 첫 번호.
  // 지운 매물의 번호를 다시 주면 그 매물을 소개한 유튜브 영상('매물번호 N')이 새 매물에 붙으므로(build.py link_videos) 피함:
  //  - 이보다 큰 번호로: 목록·원본·이번에 나눠 준 번호, site.json closedListingNos(지운 번호), 이 브라우저에서 본 가장 큰 번호
  //  - 건너뜀: data/videos.json 의 영상 제목·설명란이 '매물번호 N'으로 적은 번호 (예전 매물·계약완료 영상)
  function nextNo(extra) {
    const nos = S.working.concat(S.original).map((l) => numVal(l.no)).filter(isPosInt)
      .concat([...S.usedNos], [...S.closedNos], [readMaxNo()], extra || []);
    let n = Math.max(1000, ...nos) + 1;
    while (S.cited.has(n) || S.closedNos.has(n)) n++;
    return n;
  }
  function readMaxNo() {
    try { const n = Number(localStorage.getItem(MAXNO_KEY)); return isPosInt(n) ? n : 0; } catch (_) { return 0; }
  }
  function noteMaxNo(list) { // 홈페이지 파일에 있던 번호·내려받은 번호를 기억 (영상이 언급할 수 있는 6자리까지)
    const m = Math.max(0, ...list.map((l) => numVal(l.no)).filter((n) => isPosInt(n) && n <= 999999));
    if (m > readMaxNo()) {
      try { localStorage.setItem(MAXNO_KEY, String(m)); } catch (_) { /* 저장소 사용 불가 */ }
    }
  }
  // build.py NO_RE / cited_numbers(): 영상 제목·설명의 "No.1001", "매물번호 1001, 1002"
  const NO_RE = /(?<![A-Za-z])(?:No\.?|매물\s*번호)\s*[:#.]?\s*(\d{3,6}(?:\s*[,·/]\s*\d{3,6})*)/gi;
  function citedNumbers(v) {
    const text = `${v.title == null ? "" : v.title}\n${v.description == null ? "" : v.description}`;
    const out = new Set();
    for (const m of text.matchAll(NO_RE)) for (const n of m[1].match(/\d{3,6}/g) || []) out.add(parseInt(n, 10));
    return out;
  }
  // build.py: {int(x) for x in site.get("closedListingNos") or [] if str(x).isdigit()}
  function closedNos(v) {
    const items = Array.isArray(v) ? v : typeof v === "string" ? [...v] : [];
    return new Set(items.map((x) => (typeof x === "number" ? (Number.isInteger(x) && x >= 0 ? x : null)
      : typeof x === "string" && /^\d+$/.test(R.asciiDigits(x)) ? parseInt(R.asciiDigits(x), 10) : null)).filter(isPosInt));
  }
  // 매물번호 칸 아래 안내: 지운 매물 번호이거나, 다른 매물을 소개한 영상이 이미 쓰는 번호
  function noWarning(c) {
    if (!isPosInt(c.no)) return "";
    if (S.closedNos.has(c.no)) {
      return `No.${c.no}은(는) site.json 의 closedListingNos(지운 매물 번호)에 들어 있어, 이 번호를 적은 유튜브 영상이 홈페이지에서 빠집니다. 새 매물이면 다른 번호를 쓰세요.`;
    }
    const titles = S.cited.get(c.no);
    if (titles && !S.original.some((o) => o.no === c.no)) {
      const shown = titles.slice(0, 2).map((t) => `'${t}'`).join(", ") + (titles.length > 2 ? " 등" : "");
      return `유튜브 영상 ${titles.length}개의 설명란·제목에 '매물번호 ${c.no}'가 적혀 있습니다 (${shown}). 같은 번호의 영상은 이 매물 페이지에 자동으로 붙으니, 이 매물의 영상이 아니면 번호를 바꾸세요.`;
    }
    return "";
  }
  function blankListing() {
    return canonical({
      no: nextNo(), status: "거래중", deal: "매매",
      region: { sido: S.defaults.sido, sigungu: S.defaults.sigungu, eupmyeon: "", ri: "", jibun: "", showJibun: false },
      land: emptyLand(), building: null, updated: today(),
    });
  }
  const emptyLand = () => ({ area: null, jimok: "", zoning: "", currentUse: "", road: "" });
  const emptyBuilding = () => ({ use: "", area: null, totalFloors: null, floor: "", approvalDate: "", direction: "", rooms: null,
    baths: null, parking: null, moveIn: "", maintenance: "", violation: false });

  function getPath(o, path) {
    return path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
  }
  function setPath(o, path, v) {
    const ks = path.split("."), last = ks.pop();
    const parent = ks.reduce((x, k) => (x == null ? null : x[k]), o);
    if (isDict(parent)) parent[last] = v;
  }

  // 목록 전체를 내보낼 모양으로 + 매물별 판정 (번호 중복은 build.py 처럼 목록 전체로 셈).
  // 중복은 같은 번호끼리만 세면 되므로 번호별 묶음(group)을 넘김 → 매물이 많아도 입력마다 목록 전체를 두 번 돌지 않음
  function snapshot() {
    const items = S.working.map((l) => ({ l, c: canonical(l) }));
    const groups = new Map();
    items.forEach((x) => { const k = R.noKey(x.c.no); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x.c); });
    items.forEach((x) => { x.group = groups.get(R.noKey(x.c.no)); x.v = verdict(x.c, x.group); });
    return items;
  }
  const selItem = (snap) => snap.find((x) => x.l === S.sel) || null;
  function verdict(c, all) {
    const probs = R.problems(c, all);
    // cls = 표시 색, cat = 목록 거르기 분류
    if (c.status === "계약완료") return { cls: "off", cat: "off", text: "계약완료 · 미게시", short: "계약완료", probs };
    if (c.sample) return { cls: "bad", cat: "off", text: "샘플 · 미게시", short: "샘플", probs };
    if (probs.length) return { cls: "bad", cat: "bad", text: `누락 ${probs.length}개`, short: `누락 ${probs.length}`, probs };
    return { cls: "ok", cat: "ok", text: "게시 가능 ✓", short: "게시 가능 ✓", probs };
  }
  function priceLabel(n) {
    const num = (v) => typeof v === "number";
    if (n.deal === "월세" || n.deal === "단기임대") {
      return !num(n.deposit) && !num(n.monthly) ? "" : `${money(num(n.deposit) ? n.deposit : 0)} / 월 ${money(num(n.monthly) ? n.monthly : 0)}`;
    }
    if (n.deal === "전세") { const v = num(n.deposit) ? n.deposit : n.price; return num(v) ? money(v) : ""; }
    return num(n.price) ? money(n.price) : "";
  }

  // ── 불러오기
  async function fetchText(path) {
    const res = await fetch(ROOT + path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${path} (HTTP ${res.status})`);
    return res.text();
  }
  function setOriginal(list) {
    S.original = list.map(canonical);
    S.originalText = serialize(S.original);
    S.baseHash = hash(S.originalText);
    S.original.forEach((l) => { if (isPosInt(l.no)) S.usedNos.add(l.no); });
    noteMaxNo(S.original);
  }
  function showNotice(msg) {
    $("loadNotice").textContent = msg;
    $("loadNotice").hidden = !msg;
  }
  function readDraft(key) {
    try {
      const s = localStorage.getItem(key || STORE_KEY);
      const d = s ? JSON.parse(s) : null;
      return isDict(d) && Array.isArray(d.listings) ? d : null;
    } catch (_) { return null; }
  }
  function clearDraft() { try { localStorage.removeItem(STORE_KEY); } catch (_) { /* 저장소 사용 불가 */ } }
  // 임시 저장본을 지우거나 다른 내용으로 바꾸기 직전에 한 번 더 보관 ('백업해 둔 작업 내용 되살리기')
  function backupDraft() {
    flushDraft();
    try {
      const s = localStorage.getItem(STORE_KEY);
      if (s) localStorage.setItem(BAK_KEY, s);
    } catch (_) { /* 저장소 사용 불가 */ }
    readBak();
  }
  function readBak() {
    const b = readDraft(BAK_KEY);
    S.hasBak = !!b;
    S.bakLabel = b ? draftLabel(b) : "";
    return b;
  }
  function draftLabel(d) {
    return `${fmtTime(d.savedAt)}에 보관, 매물 ${d.listings.length}개`;
  }
  let saveTimer = 0;
  function writeDraft() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (S.loadFailed || S.pendingDraft) return; // 고르기 전에는 예전 임시 저장본을 덮어쓰지 않음
    try {
      const list = exportList();
      if (serialize(list) === S.originalText) localStorage.removeItem(STORE_KEY);
      else {
        localStorage.setItem(STORE_KEY, JSON.stringify({ v: 2, base: S.baseHash, baseListings: S.original,
          savedAt: new Date().toISOString(), listings: list, exported: S.exported, usedNos: [...S.usedNos] }));
      }
      S.storageOK = true;
      S.savedAt = new Date();
    } catch (_) {
      S.storageOK = false;
    }
    renderSaveState();
  }
  const flushDraft = () => { if (saveTimer) writeDraft(); };

  async function init() {
    buildStatic();
    bindEvents();
    let data = null, err = "";
    try {
      const text = await fetchText("data/listings.json");
      try {
        data = JSON.parse(text);
        if (!Array.isArray(data)) throw new Error("매물 목록은 [ ] 로 감싼 목록이어야 합니다");
      } catch (e) {
        data = null;
        err = `홈페이지의 listings.json 형식이 잘못되어 열 수 없습니다 (${e.message}). GitHub에서 public/data/listings.json 을 마지막으로 고친 부분(쉼표·따옴표·괄호)을 확인해 고쳐 주세요.`;
      }
    } catch (e) {
      err = `홈페이지의 listings.json 을 불러오지 못했습니다 (${e.message}). 홈페이지 주소의 /admin/listing.html 로 열었는지 확인하세요 (파일을 내 컴퓨터에서 바로 열면 동작하지 않습니다). 미리보기는 python3 -m http.server -d public 으로 여세요.`;
    }
    const [siteText, videosText] = await Promise.all(["data/site.json", "data/videos.json"].map((p) => fetchText(p).catch(() => "")));
    try { S.site = JSON.parse(siteText); } catch (_) { S.site = {}; }
    if (!isDict(S.site)) S.site = {};
    S.closedNos = closedNos(S.site.closedListingNos);
    try { // 영상 목록은 없어도 동작 (번호 겹침 안내·새 번호에만 씀)
      const vd = JSON.parse(videosText);
      const vids = Array.isArray(vd) ? vd : isDict(vd) && Array.isArray(vd.videos) ? vd.videos : [];
      vids.filter(isDict).forEach((v) => citedNumbers(v).forEach((n) => {
        if (!S.cited.has(n)) S.cited.set(n, []);
        S.cited.get(n).push(typeof v.title === "string" && v.title.trim() ? v.title.trim() : String(v.id || "제목 없음"));
      }));
    } catch (_) { /* 영상 목록 없음 */ }
    readBak();
    const basis = S.site.policy && S.site.policy.directionBasis;
    if (typeof basis === "string" && basis.trim()) S.basis = basis.trim();
    const addr = String((S.site.office && S.site.office.address) || "").trim().split(/\s+/);
    if (addr.length >= 2 && /(도|시)$/.test(addr[0]) && /(시|군|구)$/.test(addr[1])) S.defaults = { sido: addr[0], sigungu: addr[1] };

    const gh = S.site.admin && S.site.admin.repoEditUrl;
    if (typeof gh === "string" && /^https:\/\//.test(gh)) { $("btnGithub").href = gh; $("btnGithub").hidden = false; }
    else $("githubHint").hidden = false;

    if (err) failLoad(err);
    else {
      setOriginal(data);
      S.working = S.original.map(canonical);
      restoreDraft();
      const want = numVal(new URLSearchParams(location.search).get("no"));
      const pick = isPosInt(want) && !S.pendingDraft ? S.working.find((l) => l.no === want) : null;
      select(pick || null, false);
    }
    renderList();
    renderSaveState();
    if (S.pendingDraft) $("draftChoice").focus();
    document.body.dataset.ready = "1";
  }

  // 홈페이지 파일을 못 읽으면 편집·내려받기를 막음 (빈 목록이 실제 매물을 덮어쓰지 않게)
  // 이 브라우저에 보관된 작업 내용이 있으면 알려 주고 그것으로 이어서 할 수 있게 함 (고친 내용이 사라지지 않게)
  function failLoad(msg) {
    S.loadFailed = true;
    S.working = [];
    S.sel = null;
    $("loadErrorText").textContent = msg;
    $("loadError").hidden = false;
    $("ed").hidden = true;
    $("edBar").hidden = true;
    const d = savedWork();
    $("loadDraft").hidden = !d;
    if (d) {
      $("loadDraftText").textContent = `이 브라우저에 ${d.fromBak ? "백업해 둔" : "자동 보관된"} 작업 내용이 있습니다 (${draftLabel(d)}). ` +
        "아직 GitHub에 올리지 않은 변경이 들어 있을 수 있으니, 먼저 이것으로 이어서 작업하세요.";
    }
  }
  function savedWork() {
    const d = readDraft(STORE_KEY);
    if (d) return d;
    const b = readDraft(BAK_KEY);
    return b ? Object.assign(b, { fromBak: true }) : null;
  }
  function endLoadFailure() {
    S.loadFailed = false;
    $("loadError").hidden = true;
    $("ed").hidden = false;
  }
  // 홈페이지 파일 없이 보관된 작업 내용으로 시작 (기준 = 그 작업을 시작할 때의 홈페이지 파일)
  function continueOffline() {
    const d = savedWork();
    if (!d) return;
    setOriginal(Array.isArray(d.baseListings) ? d.baseListings : d.listings);
    S.working = d.listings.map(canonical);
    S.exported = d.exported && typeof d.exported.hash === "string" ? d.exported : null;
    (Array.isArray(d.usedNos) ? d.usedNos : []).filter(isPosInt).forEach((n) => S.usedNos.add(n));
    S.offline = { how: "draft" };
    endLoadFailure();
    showNotice(`홈페이지의 listings.json 을 읽지 못해, 이 브라우저에 보관된 작업 내용(${draftLabel(d)})으로 이어서 작업합니다. ` +
      "그 사이 다른 기기에서 홈페이지 파일을 고쳤다면 그 내용은 들어 있지 않으니, 내려받아 올리기 전에 확인하세요.");
    select(null);
    refresh();
    $("listPane").focus();
  }

  // ── 임시 저장본 되살리기
  function restoreDraft() {
    const d = readDraft();
    if (!d || !Array.isArray(d.listings)) return;
    const mine = d.listings.map(canonical);
    if (serialize(mine) === S.originalText) { clearDraft(); return; }
    if (d.base === S.baseHash) {
      S.working = mine;
      S.exported = d.exported && typeof d.exported.hash === "string" ? d.exported : null;
      (Array.isArray(d.usedNos) ? d.usedNos : []).filter(isPosInt).forEach((n) => S.usedNos.add(n));
      showNotice(`지난번 작업 내용(${fmtTime(d.savedAt)} 보관)을 이어서 불러왔습니다. 아직 GitHub에 올리지 않았다면 '저장하기'에서 내려받으세요.`);
      return;
    }
    // 그 사이 홈페이지의 listings.json 이 바뀜 → 임시 저장본이 최신 파일을 덮어쓰지 않도록 고르게 함
    S.pendingDraft = d;
    const base = Array.isArray(d.baseListings) ? d.baseListings.map(canonical) : null;
    const mineChanged = changedNos(base || S.original, mine);
    const serverChanged = base ? changedNos(base, S.original) : [];
    $("draftChoiceText").textContent = `이 브라우저에 ${fmtTime(d.savedAt)}에 보관된 작업 내용이 있는데, 그 뒤에 홈페이지의 listings.json 이 바뀌었습니다. 어느 것으로 작업할까요? (고르기 전에는 편집과 내려받기가 멈춰 있습니다)`;
    $("draftChoiceList").replaceChildren(
      el("li", { text: `임시 저장본에서 고친 매물: ${mineChanged.length ? mineChanged.join(", ") : "없음"}` }),
      base ? el("li", { text: `그 사이 홈페이지 파일에서 바뀐 매물: ${serverChanged.length ? serverChanged.join(", ") : "없음"}` }) : null);
    $("draftChoice").hidden = false;
    $("ed").inert = true;
    $("ed").setAttribute("aria-hidden", "true");
  }
  // 두 목록에서 달라진 매물 (번호 기준) → ["No.1001(수정)", ...]
  function changedNos(a, b) {
    const key = (l) => R.noKey(l.no);
    const A = new Map(a.map((l) => [key(l), JSON.stringify(l)]));
    const B = new Map(b.map((l) => [key(l), JSON.stringify(l)]));
    const out = [];
    B.forEach((v, k) => { const n = `No.${k.replace(/^[ns]:/, "")}`; if (!A.has(k)) out.push(n + "(추가)"); else if (A.get(k) !== v) out.push(n + "(수정)"); });
    A.forEach((_, k) => { if (!B.has(k)) out.push(`No.${k.replace(/^[ns]:/, "")}(삭제)`); });
    return out;
  }
  function closeDraftChoice() {
    S.pendingDraft = null;
    $("draftChoice").hidden = true;
    $("ed").inert = false;
    $("ed").removeAttribute("aria-hidden");
  }
  function useServer() {
    if (!window.confirm("지금 홈페이지에 올라가 있는 listings.json 으로 시작할까요?\n\n이 브라우저의 임시 저장본은 백업으로 옮깁니다 (필요하면 '저장하기' 칸의 '백업해 둔 작업 내용 되살리기'로 다시 열 수 있습니다).")) return;
    backupDraft();
    clearDraft();
    closeDraftChoice();
    showNotice("");
    refresh();
    toast("홈페이지에 올라가 있는 최신 listings.json 으로 시작합니다.");
    $("listPane").focus();
  }
  function useDraft() {
    const d = S.pendingDraft;
    if (!d) return;
    const mine = d.listings.map(canonical);
    let notes = [];
    if (Array.isArray(d.baseListings)) {
      const r = merge3(d.baseListings.map(canonical), mine, S.original);
      S.working = r.list;
      notes = r.notes;
    } else {
      // 예전 형식(기준 파일 없음): 임시 저장본 그대로 — 그 사이 바뀐 홈페이지 내용이 사라질 수 있음을 알림
      const lost = changedNos(mine, S.original);
      if (!window.confirm(`임시 저장본을 그대로 쓰면 그 사이 홈페이지 파일에서 바뀐 내용(${lost.join(", ") || "알 수 없음"})이 사라질 수 있습니다. 그래도 쓸까요?`)) return;
      S.working = mine;
    }
    (Array.isArray(d.usedNos) ? d.usedNos : []).filter(isPosInt).forEach((n) => S.usedNos.add(n));
    closeDraftChoice();
    showNotice(notes.length ? "임시 저장본을 최신 파일 위에 다시 적용했습니다. 확인할 점: " + notes.join(" / ")
      : "임시 저장본에서 고친 매물을 최신 파일 위에 다시 적용했습니다. 확인한 뒤 내려받아 GitHub에 올리세요.");
    select(null);
    refresh();
    writeDraft();
    $("listPane").focus();
  }
  // 백업해 둔 작업 내용 되살리기 ('불러온 원본 사용'·'처음 상태로 되돌리기'·'파일에서 불러오기' 직전에 옮겨 둔 것).
  // 지금 작업 내용과 서로 바꿈. 그 사이 기준 파일이 바뀌었으면 백업에서 고친 매물만 지금 파일 위에 다시 적용
  function restoreBackup() {
    if (S.loadFailed || S.pendingDraft) return;
    const b = readBak();
    if (!b) { renderSaveState(); return; }
    if (!window.confirm(`백업해 둔 작업 내용(${draftLabel(b)})을 되살릴까요?\n\n지금 작업 내용은 백업으로 옮깁니다 (이 단추를 다시 누르면 서로 바뀝니다).`)) return;
    const mine = b.listings.map(canonical);
    let list = mine, notes = [];
    if (b.base !== S.baseHash) {
      if (Array.isArray(b.baseListings)) {
        const r = merge3(b.baseListings.map(canonical), mine, S.original);
        list = r.list;
        notes = r.notes;
      } else {
        const lost = changedNos(mine, S.original);
        if (lost.length && !window.confirm(`예전 형식의 백업이라 그대로 쓰면 그 사이 바뀐 내용(${lost.join(", ")})이 사라질 수 있습니다. 그래도 쓸까요?`)) return;
      }
    }
    if (S.sel) commitPending(S.sel);
    flushDraft();
    let cur = null;
    try { cur = localStorage.getItem(STORE_KEY); } catch (_) { /* 저장소 사용 불가 */ }
    try { if (cur) localStorage.setItem(BAK_KEY, cur); else localStorage.removeItem(BAK_KEY); } catch (_) { /* 저장소 사용 불가 */ }
    readBak();
    S.working = list;
    S.working.forEach((l) => { if (isPosInt(l.no)) S.usedNos.add(l.no); });
    (Array.isArray(b.usedNos) ? b.usedNos : []).filter(isPosInt).forEach((n) => S.usedNos.add(n));
    S.stash = new WeakMap();
    S.fresh = new Map();
    S.exported = list === mine && b.exported && typeof b.exported.hash === "string" ? b.exported : null;
    S.sel = null;
    select(null);
    refresh();
    writeDraft();
    showNotice(notes.length ? "백업해 둔 작업 내용을 지금 파일 위에 다시 적용했습니다. 확인할 점: " + notes.join(" / ")
      : "백업해 둔 작업 내용을 되살렸습니다. 확인한 뒤 내려받아 GitHub에 올리세요.");
    $("listPane").focus();
  }
  // 세 갈래 합치기: base(임시 저장본을 만들 때의 홈페이지 파일) → mine(임시 저장본), theirs(지금 홈페이지 파일)
  function merge3(base, mine, theirs) {
    const key = (l) => R.noKey(l.no);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const firstBy = (list) => { const m = new Map(); list.forEach((l) => { if (!m.has(key(l))) m.set(key(l), l); }); return m; };
    const B = firstBy(base), M = firstBy(mine), T = firstBy(theirs);
    const out = theirs.slice();
    const added = [], notes = [];
    const taken = () => new Set(out.concat(added).map((l) => l.no).filter(isPosInt));
    mine.forEach((m) => {
      const k = key(m), b = B.get(k), t = T.get(k);
      if (M.get(k) !== m) { added.push(m); return; } // 임시 저장본 안의 중복 번호
      if (t && same(m, t)) return;                   // 이미 같음
      if (!b) {                                       // 임시 저장본에서 새로 만든 매물
        if (t) {
          const old = m.no;
          m.no = nextNo([...taken()]);
          S.usedNos.add(m.no);
          notes.push(`No.${old}: 홈페이지 파일에도 같은 번호의 매물이 생겨, 임시 저장본의 새 매물을 No.${m.no}(으)로 바꿨습니다`);
        }
        added.push(m);
        return;
      }
      if (same(m, b)) return;                         // 임시 저장본에서 안 고침 → 홈페이지 파일 그대로
      if (!t) {
        notes.push(`No.${noLabel(m.no)}: 홈페이지 파일에서는 지워졌지만 임시 저장본에서 고친 매물이라 다시 넣었습니다`);
        added.push(m);
        return;
      }
      if (!same(t, b)) notes.push(`No.${noLabel(m.no)}: 양쪽에서 모두 바뀌어 임시 저장본 내용을 썼습니다 — 홈페이지 파일 쪽 변경은 빠졌으니 확인하세요`);
      out[out.indexOf(t)] = m;
    });
    B.forEach((b, k) => { // 임시 저장본에서 지운 매물
      if (M.has(k)) return;
      const t = T.get(k);
      if (!t) return;
      if (same(t, b)) out.splice(out.indexOf(t), 1);
      else notes.push(`No.${noLabel(b.no)}: 임시 저장본에서는 지웠지만 홈페이지 파일에서 바뀌어 남겨 두었습니다`);
    });
    return { list: added.concat(out), notes };
  }

  // ── 고정 요소 만들기
  function buildStatic() {
    const t = $("f-type");
    t.append(el("option", { value: "", text: "고르세요" }), ...R.TYPES.map((x) => el("option", { value: x, text: x })),
      el("option", { value: "__custom", text: "직접 입력…" }));
    $("f-jimok").append(el("option", { value: "", text: "고르세요" }), ...R.JIMOK.map((x) => el("option", { value: x, text: x })));
    $("f-b-use").append(el("option", { value: "", text: "고르세요 (모르면 비워 두기)" }), ...R.BUILDING_USES.map((x) => el("option", { value: x, text: x })));
    $("f-b-dir").append(el("option", { value: "", text: "고르세요" }), ...R.DIRECTIONS.map((x) => el("option", { value: x, text: x })),
      el("option", { value: "__custom", text: "직접 입력…" }));
    $("dl-eupmyeon").append(...YANGPYEONG.map((x) => el("option", { value: x })));
    $("zoningChips").append(...R.ZONING_GROUPS.map(([g, zs]) => el("div", { class: "ed-zgroup" },
      el("b", { text: g }), ...zs.map((z) => el("button", { type: "button", class: "chip", "data-zone": z, "aria-pressed": "false", text: z })))));
    const mm = $("mi-month");
    for (let i = 1; i <= 12; i++) mm.append(el("option", { value: String(i), text: `${i}월` }));
    mm.value = String(((new Date().getMonth() + 1) % 12) + 1);
    document.querySelectorAll(".ed-tagbox").forEach((box) => {
      box.querySelector(".ed-sugg").append(...box.dataset.sugg.split(",").map((s) =>
        el("button", { type: "button", class: "chip", "data-sugg": s, "aria-pressed": "false", text: s })));
    });
    // 입력칸 설명(aria-describedby) 기억 — 오류 문구는 이 앞에 덧붙임
    document.querySelectorAll("#form input, #form select, #form textarea").forEach((inp) => {
      inp.dataset.desc = inp.getAttribute("aria-describedby") || "";
    });
  }

  // ── 목록
  // 줄마다 보이는 내용이 그대로면 예전 줄(DOM)을 그대로 씀 → 제목을 칠 때 그 매물 한 줄만 다시 그림
  // (매물이 100~200개여도 글자마다 목록 전체의 배치를 다시 계산하지 않게)
  const rowCache = new WeakMap(); // 매물 → {sig, node}
  function renderList(snap) {
    const items = snap || snapshot();
    // '게시 가능' 등으로 거르더라도 지금 고치는 매물은 계속 보이게
    const rows = items.filter((x) => x.l === S.sel || S.filter === "all" || x.v.cat === S.filter);
    const nodes = rows.map((x) => {
      const dup = x.group.length > 1;
      const sig = JSON.stringify([x.c.no, x.c.status, !!x.c.sample, x.c.urgent, dup, x.c.title, rowMeta(x.c), x.v.cls, x.v.text, x.l === S.sel]);
      const hit = rowCache.get(x.l);
      if (hit && hit.sig === sig) return hit.node;
      const node = itemNode(x, dup);
      rowCache.set(x.l, { sig, node });
      return node;
    });
    const list = $("list"), cur = [...list.children];
    if (cur.length === nodes.length && nodes.every((n, i) => n === cur[i] || !n.isConnected)) {
      nodes.forEach((n, i) => { if (n !== cur[i]) cur[i].replaceWith(n); });
    } else list.replaceChildren(...nodes);
    $("listCount").textContent = `${S.working.length}개`;
    $("listEmpty").hidden = rows.length > 0;
    $("listEmpty").textContent = S.working.length ? "해당하는 매물이 없습니다." : "등록된 매물이 없습니다. '+ 새 매물'을 눌러 시작하세요.";
    const samples = items.filter((x) => x.c.sample).length;
    $("sampleBox").hidden = !samples;
    $("sampleCount").textContent = String(samples);
  }
  const rowMeta = (c) => [c.deal, c.type, priceLabel(c), c.region.eupmyeon].filter((x) => typeof x === "string" && x).join(" · ");
  function itemNode({ l, c, v }, dup) {
    const cur = l === S.sel;
    const label = `No.${noLabel(c.no)}`;
    return el("li", { class: "ed-li", "data-no": String(c.no), "aria-current": cur ? "true" : null },
      el("div", { class: "ed-li-top" },
        el("b", { text: label }),
        el("span", { class: "ed-tag" + (c.status === "계약완료" ? " ed-tag-done" : ""), text: R.pyStr(c.status) }),
        c.sample ? el("span", { class: "ed-tag ed-tag-sample", text: "샘플" }) : null,
        c.urgent ? el("span", { class: "ed-tag ed-tag-urgent", text: "급매" }) : null,
        dup ? el("span", { class: "ed-tag ed-tag-sample", text: "번호 중복" }) : null),
      el("div", { class: "ed-li-title", text: typeof c.title === "string" && c.title ? c.title : "(제목 없음)" }),
      el("div", { class: "ed-li-meta", text: rowMeta(c) }),
      el("span", { class: "ed-badge ed-badge-" + v.cls, text: v.text }),
      el("div", { class: "ed-li-actions" },
        el("button", { type: "button", class: "btn ed-sm " + (cur ? "navy" : "ghost"), "data-act": "edit", "aria-label": `${label} 편집`, text: "편집", onclick: () => select(l, true) }),
        el("button", { type: "button", class: "btn ed-sm ghost", "data-act": "dup", "aria-label": `${label} 복제`, text: "복제", onclick: () => duplicate(l) }),
        el("button", { type: "button", class: "btn ed-sm ghost ed-danger", "data-act": "del", "aria-label": `${label} 삭제`, text: "삭제", onclick: () => remove(l) })));
  }

  function select(l, scroll) {
    const prev = S.sel;
    if (prev && prev !== l) {
      commitPending(prev);
      if (isUntouchedFresh(prev)) dropFresh(prev);
    }
    S.sel = l || null;
    $("emptyState").hidden = !!S.sel;
    $("form").hidden = !S.sel;
    if (S.sel) fillForm();
    try { history.replaceState(null, "", S.sel && isPosInt(S.sel.no) ? `?no=${S.sel.no}` : location.pathname); } catch (_) { /* file:// 등 */ }
    const snap = snapshot();
    renderList(snap);
    renderCheck(snap);
    renderBar(snap);
    if (S.sel && scroll) {
      const narrow = window.matchMedia("(max-width: 759px)").matches;
      (narrow ? $("checkPanel") : $("formHead")).scrollIntoView({ block: "start" });
      $("formHead").focus({ preventScroll: true });
    }
  }
  // 손대지 않은 새 매물은 다른 매물로 옮겨 가면 없앰 ('+ 새 매물'을 잘못 눌러도 빈 매물이 남지 않게)
  function dropFresh(l) {
    const i = S.working.indexOf(l);
    if (i >= 0) S.working.splice(i, 1);
    S.fresh.delete(l);
    if (isPosInt(l.no) && !S.working.some((x) => x.no === l.no)) S.usedNos.delete(l.no);
    scheduleSave();
  }
  // 다른 매물로 옮기기 전에, 입력칸에 적어 두고 '추가'를 누르지 않은 특징·영상·사진을 원래 매물에 넣고 칸을 비움
  function commitPending(l) {
    const added = [], dropped = [];
    document.querySelectorAll(".ed-tagbox").forEach((box) => {
      const inp = box.querySelector("input");
      if (inp.value.trim() && addTagsTo(l, box.dataset.tags, inp.value).length) added.push(`${box.dataset.name} '${inp.value.trim()}'`);
      inp.value = "";
    });
    const vText = $("f-video-in").value.trim();
    if (vText) {
      const r = addVideosTo(l, vText);
      if (r.ok.length) added.push(`영상 ${r.ok.length}개`);
      if (r.bad.length) dropped.push(...r.bad);
    }
    const pText = $("f-photo-in").value.trim();
    if (pText) {
      const r = addPhotosTo(l, pText);
      if (r.ok.length) added.push(`사진 ${r.ok.length}장`);
      if (r.bad.length) dropped.push(...r.bad);
    }
    $("f-video-in").value = "";
    $("f-photo-in").value = "";
    if (added.length) l.updated = today();
    if (added.length || dropped.length) {
      toast([added.length ? `No.${noLabel(l.no)}에 입력 중이던 ${added.join(", ")}을(를) 넣었습니다.` : "",
        dropped.length ? `알아볼 수 없는 '${dropped.join("', '")}'은(는) 넣지 않았습니다.` : ""].filter(Boolean).join(" "));
      scheduleSave();
    }
  }

  function create() {
    if (S.loadFailed || S.pendingDraft) return;
    if (S.sel) { // 먼저 지금 매물을 정리 (손대지 않은 새 매물이면 없애고 번호도 돌려받음)
      const prev = S.sel;
      commitPending(prev);
      if (isUntouchedFresh(prev)) dropFresh(prev);
      S.sel = null;
    }
    const l = blankListing();
    S.usedNos.add(l.no);
    S.working.unshift(l);
    S.filter = "all";
    syncFilterChips();
    select(l, true);
    S.fresh.set(l, freshKey(l));
    refresh();
    $("f-title").focus();
  }
  function duplicate(l) {
    const c = canonical(l);
    c.no = nextNo();
    S.usedNos.add(c.no);
    c.title = typeof c.title === "string" && c.title ? `${c.title} (복사)` : "";
    c.status = "거래중";
    c.videoIds = [];
    c.photos = [];
    c.updated = today();
    // 샘플을 복제하면 복사본도 샘플 (내용을 실제 매물로 고친 뒤 '실제 매물로 전환'을 눌러야 게시)
    S.working.splice(S.working.indexOf(l) + 1, 0, c);
    select(c, true);
    changed(false);
    toast(`No.${noLabel(numVal(l.no))}을(를) 복제해 No.${c.no}을(를) 만들었습니다. 영상·사진은 복사하지 않았습니다.` +
      (c.sample ? " 샘플 매물의 복사본이라 샘플 표시를 그대로 두었습니다 — 실제 매물로 고친 뒤 '실제 매물로 전환'을 누르세요." : ""));
  }
  function remove(l) {
    const n = canonical(l);
    const vids = isPosInt(n.no) && S.cited.has(n.no) ? S.cited.get(n.no).length : 0;
    const msg = `No.${noLabel(n.no)} "${typeof n.title === "string" && n.title ? n.title : "제목 없음"}" 매물을 삭제할까요?` +
      (n.status !== "계약완료" ? "\n\n계약된 매물이라면 삭제 대신 '계약완료'로 바꾸세요. 홈페이지에서 빠지고, 이 번호를 적은 유튜브 영상도 홈페이지에서 함께 빠집니다." : "") +
      (isPosInt(n.no) && S.original.some((o) => o.no === n.no)
        ? `\n\n삭제하면 No.${n.no}은(는) 새 매물에 다시 쓰지 않습니다. ` +
          (vids ? `이 번호를 적은 유튜브 영상이 ${vids}개 있으니, ` : "이 번호를 적은 유튜브 영상이 있다면 ") +
          `홈페이지 설정(site.json)의 closedListingNos 에 ${n.no}을(를) 적어 두세요 — 그래야 그 영상이 홈페이지에서 빠집니다.`
        : "");
    if (!window.confirm(msg)) return;
    const idx = S.working.indexOf(l);
    if (idx < 0) return;
    S.working.splice(idx, 1);
    if (S.sel === l) select(null);
    changed(false);
    let undone = false;
    toast(`No.${noLabel(n.no)} 매물을 삭제했습니다.`, { label: "되돌리기", run: () => {
      if (undone || S.working.includes(l)) return; // 한 번만
      undone = true;
      let note = `No.${noLabel(l.no)} 매물을 되살렸습니다.`;
      if (isPosInt(l.no) && S.working.some((x) => x.no === l.no)) {
        const old = l.no;
        l.no = nextNo();
        S.usedNos.add(l.no);
        note = `No.${old}은(는) 그 사이 다른 매물이 쓰고 있어 No.${l.no}(으)로 되살렸습니다.`;
      }
      S.fresh.delete(l);
      S.working.splice(Math.min(idx, S.working.length), 0, l);
      select(l, false);
      changed(false);
      toast(note);
      $("formHead").focus();
    } });
    $("btnNew").focus();
  }
  function removeSamples() {
    const n = S.working.filter((l) => R.truthy(l.sample)).length;
    if (!n || !window.confirm(`샘플 매물 ${n}개를 모두 삭제할까요?`)) return;
    S.working = S.working.filter((l) => !R.truthy(l.sample));
    if (S.sel && !S.working.includes(S.sel)) select(null);
    changed(false);
    toast(`샘플 매물 ${n}개를 삭제했습니다.`);
  }

  // ── 폼 채우기
  function fmtVal(v) { return v == null ? "" : typeof v === "string" ? v : R.pyStr(v); }
  const PARSERS = { money: parseManwon, int: parseCount, no: parseNo, area: parseArea, num: parseCoord };
  function fillFields(scope) {
    const l = S.sel;
    scope.querySelectorAll("[data-f]").forEach((inp) => {
      const v = getPath(l, inp.dataset.f);
      if (inp.type === "radio") inp.checked = inp.value === v;
      else if (inp.type === "checkbox") inp.checked = R.truthy(v);
      else if (inp.tagName === "SELECT") setSelect(inp, v);
      else inp.value = fmtVal(v);
      setFieldNote(inp, "");
      // 파일에 숫자가 아닌 값('협의' 등)이 들어 있으면 바로 알려 줌
      const p = PARSERS[inp.dataset.t];
      setFieldError(inp, p && v != null && v !== "" && typeof v !== "number" ? p(fmtVal(v)).error || "숫자로 고쳐 주세요" : "");
    });
    if (scope.contains($("f-deposit")) && l.deal === "전세" && l.deposit == null && l.price != null) $("f-deposit").value = fmtVal(l.price);
  }
  function setSelect(sel, v) {
    sel.querySelectorAll("option[data-extra]").forEach((o) => o.remove());
    v = v == null ? "" : typeof v === "string" ? v : R.pyStr(v);
    if (v && ![...sel.options].some((o) => o.value === v)) {
      sel.append(el("option", { value: v, "data-extra": "1", text: `${v} (목록에 없음)` }));
    }
    sel.value = v;
  }
  function fillForm() {
    const l = S.sel;
    fillFields($("form"));
    // 매물 종류: 목록 + 직접 입력
    const type = typeof l.type === "string" ? l.type : fmtVal(l.type);
    const known = R.TYPES.includes(type);
    $("f-type").value = !type ? "" : known ? type : "__custom";
    $("f-type-custom").hidden = known || !type;
    $("f-type-custom").value = known ? "" : type;
    syncSections();
    ["py-land", "py-b"].forEach((id) => { $(id).value = ""; setFieldError($(id), ""); });
    // 이전 매물에서 치다 만 글이 이 매물에 들어가지 않게 (옮길 때는 commitPending 이 원래 매물에 넣어 둠)
    document.querySelectorAll(".ed-tagbox input, #f-video-in, #f-photo-in").forEach((i) => { i.value = ""; i.removeAttribute("aria-invalid"); });
    showMsg("videoErr", "");
    showMsg("photoErr", "");
    showMsg("priceNote", "");
    syncDirection();
    renderTags();
    renderVideos();
    renderPhotos();
    updateDerived();
  }
  function syncSections() {
    const l = S.sel;
    [["hasLand", "landBody", !!l.land], ["hasBuilding", "buildingBody", !!l.building]].forEach(([sw, body, on]) => {
      $(sw).checked = on;
      $(sw).setAttribute("aria-expanded", String(on));
      $(body).hidden = !on;
    });
  }

  function msgNode(inp, cls, prefix) {
    const box = inp.closest(".ed-fld") || inp.parentElement;
    return { box, node: box && box.querySelector(`.${cls}[data-for="${inp.id}"]`), id: `${prefix}-${inp.id}` };
  }
  function describe(inp) {
    const ids = [];
    if (inp.getAttribute("aria-invalid") === "true") ids.push(`err-${inp.id}`);
    if ($(`note-${inp.id}`)) ids.push(`note-${inp.id}`);
    if (inp.dataset.desc) ids.push(inp.dataset.desc);
    if (ids.length) inp.setAttribute("aria-describedby", ids.join(" "));
    else inp.removeAttribute("aria-describedby");
  }
  function setFieldError(inp, msg) {
    const { box, node, id } = msgNode(inp, "ed-ferr", "err");
    let p = node;
    if (msg) {
      if (!p) { p = el("p", { class: "ed-ferr", "data-for": inp.id, id }); box.append(p); }
      p.textContent = msg;
      inp.setAttribute("aria-invalid", "true");
    } else {
      if (p) p.remove();
      inp.removeAttribute("aria-invalid");
    }
    describe(inp);
  }
  function setFieldNote(inp, msg) {
    const { box, node, id } = msgNode(inp, "ed-fnote", "note");
    let p = node;
    if (msg) {
      if (!p) { p = el("p", { class: "ed-fnote", "data-for": inp.id, id }); box.append(p); }
      p.textContent = msg;
    } else if (p) p.remove();
    describe(inp);
  }
  function showMsg(id, msg) { $(id).textContent = msg; $(id).hidden = !msg; }

  // 화면에서 계산되는 부분(미리보기·필수 표시·가격 칸) 갱신
  function updateDerived() {
    const l = S.sel;
    if (!l) return;
    const c = canonical(l);
    $("fhNo").textContent = noLabel(c.no);
    $("fhTitle").textContent = typeof c.title === "string" && c.title ? c.title : "새 매물";
    $("hintNo").textContent = noLabel(c.no);
    const nw = noWarning(c);
    $("noWarn").textContent = nw;
    $("noWarn").hidden = !nw;
    $("ytLink").href = `youtube.html?no=${encodeURIComponent(isPosInt(c.no) ? c.no : "")}`;
    $("sampleLine").hidden = !c.sample;
    $("doneNote").hidden = c.status !== "계약완료";

    const vis = DEAL_FIELDS[c.deal] || ["price"];
    PRICE_KEYS.forEach((k) => { $("fld-" + k).hidden = !vis.includes(k); });
    $("lbl-deposit").textContent = c.deal === "전세" ? "전세금" : "보증금";
    $("lbl-monthly").textContent = c.deal === "단기임대" ? "월 임대료" : "월세";
    const pv = (k, v, big) => {
      $("pv-" + k).textContent = typeof v !== "number" ? "" : `= ${money(v)}` + (v >= big ? " — 금액이 매우 큽니다. 만원 단위가 맞는지 확인하세요 (1,500,000원 → 150)" : "");
    };
    pv("price", c.price, 1000000);
    pv("deposit", c.deal === "전세" && c.deposit == null ? c.price : c.deposit, 1000000);
    pv("monthly", c.monthly, 10000);

    const areaPv = (id, m2) => { $(id).textContent = typeof m2 === "number" ? `= 약 ${fmtPy(m2)}평` : ""; };
    areaPv("pv-land-area", l.land ? numVal(l.land.area) : null);
    areaPv("pv-b-area", l.building ? numVal(l.building.area) : null);

    // 필수 표시: build.py 와 같은 판정 (주택 → 방·관리비, 공동주택 → 해당 층, 읍·면 → 리)
    $("req-rooms").hidden = !R.isResidential(c);
    $("req-maint").hidden = !R.isResidential(c);
    $("req-floor").hidden = !R.isApartment(c);
    $("req-ri").hidden = !/[읍면]$/.test(R.pyStr(c.region.eupmyeon));
    $("req-land-area").hidden = !!l.building;
    $("req-jimok").hidden = !!l.building;
    $("landOffHint").hidden = !!l.land;
    $("landEmptyNote").hidden = !(l.land && l.building && !c.land);

    // 소재지·방향: 홈페이지에 실제로 보이는 글
    const where = R.regionText(c.region, true);
    $("pv-region").textContent = `홈페이지 표시: ${where || "(시·도부터 적어 주세요)"}` +
      (R.truthy(c.region.jibun) && !c.region.showJibun ? " — 지번은 비공개" : "");
    const dir = c.building ? c.building.direction : "";
    $("pv-direction").textContent = R.truthy(dir) ? `홈페이지 표시: ${R.directionText(dir, S.basis)}` : "";

    const zones = R.splitZoning(l.land && typeof l.land.zoning === "string" ? l.land.zoning : "");
    $("zoningChips").querySelectorAll("[data-zone]").forEach((b) => b.setAttribute("aria-pressed", String(zones.includes(b.dataset.zone))));
    $("sumCount").textContent = String(typeof l.summary === "string" ? l.summary.length : 0);

    const hasCoord = typeof c.lat === "number" && typeof c.lng === "number";
    $("mapLink").hidden = !hasCoord;
    if (hasCoord) $("mapLink").href = `https://map.kakao.com/link/map/${encodeURIComponent("No." + noLabel(c.no))},${c.lat},${c.lng}`;
  }

  // ── 입력 처리
  function parseField(inp) {
    const t = inp.dataset.t;
    if (inp.type === "checkbox") return { value: inp.checked, error: "" };
    if (inp.type === "radio" || inp.tagName === "SELECT") return { value: inp.value, error: "" };
    if (t === "ymd") return { value: normYmd(inp.value), error: "" };
    if (PARSERS[t]) return PARSERS[t](inp.value);
    return { value: inp.value, error: "" };
  }
  function onFieldInput(e) {
    const inp = e.target;
    if (!S.sel || !inp.dataset || !inp.dataset.f) return;
    if (inp.type === "radio" && !inp.checked) return;
    const l = S.sel, path = inp.dataset.f;
    // 위도·경도를 한 칸에 이어서 치는 중이면 칸을 벗어날 때(또는 붙여넣을 때) 나눔
    if ((path === "lat" || path === "lng") && PAIR_RE.test(R.asciiDigits(inp.value))) {
      setFieldError(inp, "");
      setFieldNote(inp, "칸을 벗어나면 위도·경도로 나눠 넣습니다");
      return;
    }
    const { value, error, note } = parseField(inp);
    setFieldError(inp, error);
    setFieldNote(inp, note || "");
    const prevDeal = l.deal;
    if (path === "deposit" && l.deal === "전세") l.price = null; // 전세금은 deposit 에 저장
    setPath(l, path, value);
    if (path === "deal" && prevDeal !== value) applyDeal(l, prevDeal);
    if (path === "building.direction") syncDirection(true);
    if (path === "no") renderVideos();
    changed(path !== "updated");
  }
  // 칸을 벗어나면 보기 좋게 정리 (예: "3억 2천" → 32000, "300,000원" → 30)
  function onFieldChange(e) {
    const inp = e.target;
    if (!S.sel || !inp.dataset || !inp.dataset.f || inp.type === "checkbox" || inp.type === "radio" || inp.tagName === "SELECT") return;
    const path = inp.dataset.f, t = inp.dataset.t;
    if ((path === "lat" || path === "lng") && splitCoordPair(inp, inp.value)) return;
    if (inp.getAttribute("aria-invalid") === "true") return;
    if (PARSERS[t] || t === "ymd") {
      const v = getPath(S.sel, path);
      if (path === "deposit" && S.sel.deal === "전세" && v == null && S.sel.price != null) return;
      inp.value = fmtVal(v);
      setFieldNote(inp, "");
    }
  }
  // "37.471, 127.632" → 위도·경도 (순서가 바뀌었으면 바로잡음)
  function splitCoordPair(inp, text) {
    const m = R.asciiDigits(String(text || "")).match(PAIR_RE);
    if (!m || !S.sel) return false;
    let a = parseFloat(m[1]), b = parseFloat(m[2]);
    if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
    S.sel.lat = a;
    S.sel.lng = b;
    $("f-lat").value = String(a);
    $("f-lng").value = String(b);
    ["f-lat", "f-lng"].forEach((id) => { setFieldError($(id), ""); setFieldNote($(id), ""); });
    changed(true);
    return true;
  }
  // 거래 형태가 바뀌면: 그 형태로 전에 넣은 가격이 있으면 되살리고, 없으면 가격 칸을 비움
  // (월세 보증금이 전세금으로 넘어가는 식으로 다른 종류의 가격이 저절로 게시되지 않게)
  function applyDeal(l, prevDeal) {
    const st = stashOf(l);
    st.byDeal = st.byDeal || {};
    const snap = { price: l.price, deposit: l.deposit, monthly: l.monthly };
    if (prevDeal === "전세" && snap.deposit == null && snap.price != null) { snap.deposit = snap.price; snap.price = null; }
    if (PRICE_KEYS.some((k) => snap[k] != null)) st.byDeal[prevDeal || ""] = snap;
    const saved = st.byDeal[l.deal] || {};
    const want = DEAL_FIELDS[l.deal] || ["price"];
    PRICE_KEYS.forEach((k) => { l[k] = want.includes(k) && saved[k] != null ? saved[k] : null; });
    const restored = want.some((k) => l[k] != null);
    fillFields($("sec-price"));
    const msg = restored ? `전에 넣은 ${l.deal} 가격을 다시 넣었습니다 — 맞는지 확인하세요.`
      : PRICE_KEYS.some((k) => snap[k] != null) ? `거래 형태를 ${l.deal}(으)로 바꿔 가격 칸을 비웠습니다 — ${l.deal} 가격을 새로 넣으세요.` : "";
    showMsg("priceNote", msg);
  }

  function changed(touch) {
    if (touch && S.sel) {
      const t = today();
      if (S.sel.updated !== t) { S.sel.updated = t; $("f-updated").value = t; }
    }
    refresh();
  }
  let raf = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeDraft, 300);
  }
  function refresh() {
    updateDerived();
    const snap = snapshot();
    renderCheck(snap);
    renderBar(snap);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { renderList(); renderSaveState(); });
    scheduleSave();
  }

  // ── 매물 종류
  function onTypeChange() {
    if (!S.sel) return;
    const v = $("f-type").value;
    const custom = v === "__custom";
    $("f-type-custom").hidden = !custom;
    if (custom) { S.sel.type = $("f-type-custom").value.trim(); $("f-type-custom").focus(); }
    else S.sel.type = v;
    changed(true);
  }

  // ── 토지·건물 켜고 끄기 (끈 내용은 다시 켜면 복원)
  function toggleSection(key, on) {
    const l = S.sel;
    if (!l) return;
    const st = stashOf(l);
    if (on) l[key] = l[key] || st[key] || (key === "land" ? emptyLand() : emptyBuilding());
    else { if (l[key]) st[key] = l[key]; l[key] = null; }
    syncSections();
    if (on) {
      fillFields($(key === "land" ? "landBody" : "buildingBody"));
      if (key === "building") syncDirection();
    }
    changed(true);
  }

  // ── 용도지역 칩
  function onZoneClick(e) {
    const b = e.target.closest("[data-zone]");
    if (!b || !S.sel || !S.sel.land) return;
    const zones = R.splitZoning(typeof S.sel.land.zoning === "string" ? S.sel.land.zoning : "");
    const z = b.dataset.zone, i = zones.indexOf(z);
    if (i >= 0) zones.splice(i, 1); else zones.push(z);
    S.sel.land.zoning = zones.join(", ");
    $("f-zoning").value = S.sel.land.zoning;
    changed(true);
  }

  // ── 방향: 8방향 고르기 + 직접 입력 ('기준'을 적지 않으면 홈페이지에 '(건물 정면 기준)'이 붙음)
  function syncDirection(typing) {
    if (typing) { $("f-b-dir").value = "__custom"; return; } // 직접 입력 중에는 칸을 그대로 둠
    const b = S.sel && S.sel.building;
    const d = b ? fmtVal(b.direction).trim() : "";
    const known = R.DIRECTIONS.includes(d);
    $("f-b-dir").value = known ? d : d ? "__custom" : "";
    $("f-b-direction").hidden = known || !d;
  }
  function onDirectionSelect() {
    const b = S.sel && S.sel.building;
    if (!b) return;
    const v = $("f-b-dir").value;
    if (v === "__custom") {
      $("f-b-direction").hidden = false;
      $("f-b-direction").value = fmtVal(b.direction);
      $("f-b-direction").focus();
      return;
    }
    b.direction = v;
    $("f-b-direction").value = v;
    $("f-b-direction").hidden = true;
    setFieldError($("f-b-direction"), "");
    changed(true);
  }
  function setBuildingText(key, v) {
    const b = S.sel && S.sel.building;
    if (!b) return;
    b[key] = v;
    $("f-b-" + key).value = v;
    setFieldError($("f-b-" + key), "");
    changed(true);
  }

  // ── 태그 (특징·추천 용도)
  function renderTags() {
    document.querySelectorAll(".ed-tagbox").forEach((box) => {
      const key = box.dataset.tags;
      if (!Array.isArray(S.sel[key])) S.sel[key] = R.asList(S.sel[key]);
      const arr = S.sel[key];
      box.querySelector(".ed-taglist").replaceChildren(...arr.map((t, i) => el("li", null,
        el("span", { text: t }),
        el("button", { type: "button", "aria-label": `${t} 지우기`, text: "✕", onclick: () => {
          arr.splice(i, 1);
          renderTags();
          box.querySelector("input").focus();
          changed(true);
        } }))));
      box.querySelectorAll("[data-sugg]").forEach((c) => c.setAttribute("aria-pressed", String(arr.includes(c.dataset.sugg))));
    });
  }
  function addTagsTo(l, key, text) {
    if (!Array.isArray(l[key])) l[key] = R.asList(l[key]);
    const arr = l[key];
    const add = String(text).split(/[,\n]/).map((s) => s.trim().replace(/^#/, "")).filter((t) => t && !arr.includes(t));
    add.forEach((t) => { if (!arr.includes(t)) arr.push(t); });
    return add;
  }

  // ── 영상
  function addVideosTo(l, text) {
    if (!Array.isArray(l.videoIds)) l.videoIds = R.asList(l.videoIds);
    const parts = String(text).split(/[\s,]+/).filter(Boolean);
    const ok = [], bad = [], dup = [], lists = [];
    parts.forEach((p) => {
      const id = ytId(p);
      if (!id) (isPlaylist(p) ? lists : bad).push(p);
      else if (l.videoIds.includes(id)) dup.push(id);
      else { l.videoIds.push(id); ok.push(id); }
    });
    return { ok, bad: bad.concat(lists), plainBad: bad, dup, lists };
  }
  function addVideos(text) {
    if (!S.sel) return;
    const r = addVideosTo(S.sel, text);
    const msg = [
      r.lists.length ? `재생목록 주소입니다 — 영상 하나의 주소(공유 → 링크 복사)를 넣으세요: ${r.lists.join(" ")}` : "",
      r.plainBad.length ? `유튜브 영상 주소로 알아볼 수 없습니다: ${r.plainBad.join(" ")}` : "",
      r.dup.length ? `이미 들어 있는 영상입니다: ${r.dup.join(", ")}` : "",
    ].filter(Boolean).join(" / ");
    showMsg("videoErr", msg);
    $("f-video-in").value = r.bad.join(" ");
    $("f-video-in").setAttribute("aria-invalid", String(r.bad.length > 0));
    renderVideos();
    if (r.ok.length) changed(true);
  }
  function moveItem(arr, i, d) { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; }
  function renderVideos() {
    if (!S.sel) return;
    if (!Array.isArray(S.sel.videoIds)) S.sel.videoIds = R.asList(S.sel.videoIds);
    const arr = S.sel.videoIds;
    $("videoList").replaceChildren(...arr.map((id, i) => {
      const ok = YT_ID_RE.test(id) && id !== "videoseries";
      return el("li", { class: "ed-vitem", "data-id": id },
        ok ? el("img", { src: `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`, alt: `영상 ${id} 미리보기`, loading: "lazy" })
          : el("div", { class: "ed-ph-img", text: "영상 ID 형식 오류 — 빼고 다시 넣으세요" }),
        el("div", { class: "ed-vi-body" },
          el("code", { text: id }),
          el("span", { class: "ed-row" },
            ok ? el("a", { class: "btn ghost ed-sm", href: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, target: "_blank", rel: "noopener", text: "보기" }) : null,
            i > 0 ? el("button", { type: "button", class: "btn ghost ed-sm", "aria-label": `영상 ${id} 앞으로`, text: "▲", onclick: () => { moveItem(arr, i, -1); renderVideos(); changed(true); } }) : null,
            el("button", { type: "button", class: "btn ghost ed-sm ed-danger", "aria-label": `영상 ${id} 빼기`, text: "빼기", onclick: () => { arr.splice(i, 1); renderVideos(); $("f-video-in").focus(); changed(true); } }))));
    }));
  }

  // ── 사진 (파일 이름에 띄어쓰기가 있어도 한 장으로 — 여러 장은 쉼표·줄바꿈으로 구분)
  function addPhotosTo(l, text) {
    if (!Array.isArray(l.photos)) l.photos = R.asList(l.photos);
    const ok = [], bad = [], dup = [];
    String(text).split(/[,\n]+/).map((s) => s.trim()).filter(Boolean).forEach((raw) => {
      const p = photoPath(raw);
      if (!R.PHOTO_OK.test(p)) bad.push(raw);
      else if (l.photos.includes(p)) dup.push(p);
      else { l.photos.push(p); ok.push(p); }
    });
    return { ok, bad, dup };
  }
  function addPhoto(text) {
    if (!S.sel) return;
    const r = addPhotosTo(S.sel, text);
    const heic = r.bad.some((b) => /\.hei[cf]$/i.test(b));
    showMsg("photoErr", [
      r.bad.length ? `사진 파일 이름이 아닙니다: '${r.bad.join("', '")}' — jpg·png·webp·gif 파일 이름을 적으세요 (예: 1005-1.jpg)${heic ? ". 아이폰 HEIC 사진은 JPG로 바꿔 올리세요" : ""}` : "",
      r.dup.length ? `이미 들어 있는 사진입니다: ${r.dup.join(", ")}` : "",
    ].filter(Boolean).join(" / "));
    $("f-photo-in").value = r.bad.join(", "); // 잘못된 것은 고칠 수 있게 칸에 남김 (목록에는 넣지 않음)
    $("f-photo-in").setAttribute("aria-invalid", String(r.bad.length > 0));
    renderPhotos();
    if (r.ok.length) changed(true);
  }
  function renderPhotos() {
    if (!S.sel) return;
    if (!Array.isArray(S.sel.photos)) S.sel.photos = R.asList(S.sel.photos);
    const arr = S.sel.photos;
    $("photoList").replaceChildren(...arr.map((p, i) => {
      const ok = R.PHOTO_OK.test(p);
      const img = ok ? el("img", { src: ROOT + p.split("/").map(encodeURIComponent).join("/"), alt: `사진 ${i + 1}`, loading: "lazy" })
        : el("div", { class: "ed-ph-img", text: "홈페이지에서 빠지는 경로입니다 — 빼고 다시 넣으세요" });
      if (ok) img.addEventListener("error", () => img.replaceWith(el("div", { class: "ed-ph-img", text: "파일을 찾을 수 없습니다 (public/images 에 올렸는지 확인)" })), { once: true });
      return el("li", { class: "ed-vitem", "data-photo": p }, img,
        el("div", { class: "ed-vi-body" },
          el("code", { text: p }),
          el("span", { class: "ed-row" },
            i > 0 ? el("button", { type: "button", class: "btn ghost ed-sm", "aria-label": `${p} 앞으로`, text: "▲", onclick: () => { moveItem(arr, i, -1); renderPhotos(); changed(true); } }) : null,
            el("button", { type: "button", class: "btn ghost ed-sm ed-danger", "aria-label": `${p} 빼기`, text: "빼기", onclick: () => { arr.splice(i, 1); renderPhotos(); changed(true); } }))));
    }));
  }

  // ── 게시 점검
  function fieldForProblem(p) {
    const l = S.sel;
    const firstEmpty = (ids) => ids.map($).find((x) => !x.closest("[hidden]") && !x.value) || $(ids[0]);
    if (p === R.P.NO || R.DUP_RE.test(p)) return $("f-no");
    if (R.STATUS_ISSUE_RE.test(p)) return document.querySelector('input[name="status"]');
    if (p === R.P.TITLE) return $("f-title");
    if (p === R.P.REGION) return firstEmpty(["f-sido", "f-sigungu", "f-eupmyeon"]);
    if (p === R.P.RI) return $("f-ri");
    if (p === R.P.TYPE) return $("f-type");
    if (p === R.P.DEAL) return document.querySelector('input[name="deal"]');
    if (p === R.P.PRICE) return firstEmpty(["f-price", "f-deposit", "f-monthly"]);
    const pm = p.match(R.PRICE_ISSUE_RE);
    if (pm) return $("f-" + pm[1]);
    const nm = p.match(R.NUM_ISSUE_RE);
    if (nm) return nm[1] === "토지" ? $("f-land-area") : $("f-b-" + nm[2]);
    if (p === R.P.LAND_AREA) return l.land ? $("f-land-area") : $("hasLand");
    if (p === R.P.JIMOK) return $("f-jimok");
    if (p === R.P.MOVE_IN) return $("f-b-moveIn");
    if (p === R.P.MAINTENANCE) return $("f-b-maintenance");
    const byLabel = Object.fromEntries(R.BUILDING_REQUIRED.concat(R.RESIDENTIAL_REQUIRED, R.APT_REQUIRED)
      .map(([k, label]) => [R.P.BUILDING_PREFIX + label, k === "direction" ? "f-b-dir" : "f-b-" + k]));
    return byLabel[p] ? $(byLabel[p]) : null;
  }
  function goToField(target) {
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }
  function announce(text) {
    const n = $("srLive");
    n.textContent = "";
    setTimeout(() => { n.textContent = text; }, 50);
  }
  function renderCheck(snap) {
    const state = $("checkState"), P = $("checkProblems"), W = $("checkWarnings");
    const items = snap || snapshot();
    if (!S.sel) {
      const vs = items.map((x) => x.v);
      const c = (cat) => vs.filter((v) => v.cat === cat).length;
      state.className = "ed-state is-off";
      state.textContent = S.working.length
        ? `전체 ${S.working.length}개 — 게시 가능 ${c("ok")} · 누락 ${c("bad")} · 계약완료·샘플 ${c("off")}`
        : "매물이 없습니다";
      P.replaceChildren();
      W.replaceChildren();
      $("warnTitle").hidden = true;
      $("checkHelp").textContent = "매물을 고르면 광고 명시사항이 빠졌는지 하나씩 점검합니다.";
      S.lastCheck = null;
      return;
    }
    const it = selItem(items);
    if (!it) return;
    const n = it.c, v = it.v, warns = R.warnings(n, it.group);
    let text;
    if (n.status === "계약완료") text = "계약완료 — 홈페이지에 게시되지 않습니다";
    else if (n.sample) text = "샘플 매물 — 게시되지 않습니다 (실제 매물로 전환하거나 삭제하세요)";
    else if (v.probs.length) text = `누락 ${v.probs.length}개 — 채우기 전에는 홈페이지에 올라가지 않습니다`;
    else text = "게시 가능 ✓ — 광고 명시사항이 모두 들어 있습니다";
    state.textContent = text;
    state.className = "ed-state is-" + v.cls;
    P.replaceChildren(...v.probs.map((p) => el("li", null, el("button", { type: "button", "data-problem": p, text: p,
      onclick: () => goToField(fieldForProblem(p)) }))));
    W.replaceChildren(...warns.map((w) => el("li", { text: w })));
    $("warnTitle").hidden = !warns.length;
    $("checkHelp").textContent = v.probs.length
      ? "빨간 항목을 누르면 해당 입력칸으로 이동합니다. 근거: 공인중개사법 제18조의2 · 시행령 제17조의2 · 국토부 명시사항 세부기준(2025.1.1.)"
      : "근거: 공인중개사법 제18조의2 · 시행령 제17조의2 · 국토부 명시사항 세부기준(2025.1.1.). 배포할 때 같은 규칙으로 한 번 더 점검합니다.";
    // 화면 읽기 프로그램에는 게시 가능 ↔ 누락 처럼 판정이 바뀔 때만 알림 (글자마다 읽지 않게)
    const key = `${S.working.indexOf(S.sel)}:${v.cat}`;
    if (S.lastCheck !== null && S.lastCheck !== key) announce(`게시 점검: ${v.text}`);
    S.lastCheck = key;
  }
  function renderBar(snap) {
    const bar = $("edBar");
    bar.hidden = !S.sel || S.loadFailed;
    if (!S.sel) return;
    const it = selItem(snap || snapshot());
    if (!it) return;
    const n = it.c, v = it.v;
    const s = $("barState");
    s.className = "ed-bar-state is-" + v.cls;
    s.textContent = `${noLabel(n.no)} · ${v.short}`;
    s.setAttribute("aria-label", `No.${noLabel(n.no)} 게시 점검: ${v.text}`);
  }

  // ── 저장 상태·내보내기
  function diffCounts(list) {
    const key = (l) => R.noKey(l.no);
    const a = new Map(S.original.map((l) => [key(l), JSON.stringify(l)]));
    const b = new Map(list.map((l) => [key(l), JSON.stringify(l)]));
    let add = 0, mod = 0, del = 0;
    b.forEach((v, k) => { if (!a.has(k)) add++; else if (a.get(k) !== v) mod++; });
    a.forEach((_, k) => { if (!b.has(k)) del++; });
    return [add && `추가 ${add}`, mod && `수정 ${mod}`, del && `삭제 ${del}`].filter(Boolean).join(" · ") || "순서 변경";
  }
  function saveStatus() {
    if (S.loadFailed) return { cls: "bad", pill: "불러오기 실패", text: "홈페이지의 listings.json 을 불러오지 못해 내려받을 수 없습니다" };
    if (S.pendingDraft) {
      return { cls: "wait", pill: "작업 내용 선택 필요",
        text: "위에서 '불러온 원본 사용' 또는 '임시 저장본 사용'을 먼저 고르세요 — 고르기 전에는 내려받을 수 없습니다" };
    }
    const list = exportList(), text = serialize(list);
    // 홈페이지 파일을 못 읽고 불러온 파일·보관된 작업으로 시작했으면, 무엇과 비교한 결과인지 밝힘
    const base = !S.offline ? "" : S.offline.how === "import" ? `불러온 파일(${S.offline.name})` : "보관된 작업을 시작할 때의 파일";
    if (text === S.originalText) {
      return { cls: "clean", pill: "변경 없음", text: base ? `변경 없음 — ${base}과 같습니다 (홈페이지 파일은 읽지 못했습니다)`
        : "변경 없음 — 홈페이지에 올라간 파일과 같습니다" };
    }
    const parts = diffCounts(list) + (base ? ` · ${base} 기준` : "");
    if (S.exported && S.exported.hash === hash(text)) {
      return { cls: "done", pill: `${S.exported.how} · GitHub에 올리세요`,
        text: `${S.exported.how} (${fmtTime(S.exported.at)}) — 이제 GitHub에 올리면 홈페이지에 반영됩니다 (${parts})` };
    }
    return { cls: "dirty", pill: "GitHub에 안 올린 변경 있음", text: `GitHub에 아직 안 올린 변경 — ${parts}` };
  }
  function renderSaveState() {
    const st = saveStatus();
    const pill = $("dirtyPill");
    pill.textContent = st.pill;
    pill.className = "ed-pill" + (st.cls === "dirty" ? " is-dirty" : st.cls === "done" ? " is-done" : "");
    $("saveState").textContent = st.text;
    $("saveState").className = "ed-save-state is-" + st.cls;
    const bs = $("barSave");
    bs.className = "ed-bar-save" + (st.cls === "dirty" ? " is-dirty" : st.cls === "done" ? " is-done" : "");
    $("barSaveSr").textContent = st.cls === "dirty" ? " (GitHub에 안 올린 변경 있음)" : st.cls === "done" ? " (내려받음 — GitHub에 올리기 전)" : "";
    const dirty = st.cls === "dirty" || st.cls === "done";
    $("autosaveNote").textContent = S.loadFailed ? ""
      : !S.storageOK ? "이 브라우저에서는 자동 보관이 되지 않습니다. 창을 닫기 전에 꼭 내려받으세요."
        : dirty && S.savedAt ? `작업 내용은 이 브라우저에 자동 보관 중입니다 (${fmtTime(S.savedAt)}).` : "";
    $("btnReset").disabled = !dirty;
    ["btnDownload", "btnCopy"].forEach((id) => { $(id).disabled = S.loadFailed || !!S.pendingDraft; });
    const rb = $("btnRestoreBak");
    rb.hidden = !S.hasBak || S.loadFailed || !!S.pendingDraft;
    rb.textContent = `백업해 둔 작업 내용 되살리기 (${S.bakLabel})`;
  }
  // 내려받기·복사 전에 확인 — 문제가 있으면 null
  function exportCheck() {
    if (S.loadFailed) {
      window.alert("홈페이지의 listings.json 을 불러오지 못해 내려받을 수 없습니다. 빈 목록이 실제 매물을 덮어쓰지 않도록 막아 두었습니다. 화면 위쪽 안내를 따라 주세요.");
      return null;
    }
    if (S.pendingDraft) {
      window.alert("먼저 화면 위쪽에서 '불러온 원본 사용' 또는 '임시 저장본 사용'을 고르세요.");
      $("draftChoice").focus();
      return null;
    }
    const list = exportList();
    const badNo = list.filter((l) => !isPosInt(l.no));
    if (badNo.length) {
      window.alert(`매물번호가 비어 있거나 잘못된 매물이 ${badNo.length}개 있습니다 (1 이상의 정수만 가능): ` +
        badNo.map((l) => `'${typeof l.title === "string" && l.title ? l.title : "제목 없음"}'`).join(", ") + "\n번호를 고친 뒤 다시 누르세요.");
      const target = S.working.find((l) => !isUntouchedFresh(l) && !isPosInt(numVal(l.no)));
      if (target) { select(target, true); goToField($("f-no")); }
      return null;
    }
    const counts = new Map();
    list.forEach((l) => counts.set(l.no, (counts.get(l.no) || 0) + 1));
    const dups = [...counts].filter(([, c]) => c > 1).map(([no]) => no);
    if (dups.length && !window.confirm(`매물번호 ${dups.join(", ")}이(가) 겹칩니다 (겹친 매물은 홈페이지에 게시되지 않습니다). 그래도 내려받을까요?`)) return null;
    if (!list.length && S.original.length &&
      !window.confirm(`매물이 하나도 없습니다. 이 파일을 올리면 홈페이지의 매물 ${S.original.length}개가 모두 지워집니다. 그래도 내려받을까요?`)) return null;
    return list;
  }
  function markExported(text, how, list) {
    S.exported = { hash: hash(text), at: new Date().toISOString(), how };
    noteMaxNo(list); // 내보낸 번호는 나중에 지워도 이 브라우저에서 다시 주지 않음
    writeDraft();
    renderSaveState();
  }
  function download() {
    flushDraft();
    const list = exportCheck();
    if (!list) return;
    const text = serialize(list);
    const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
    const a = el("a", { href: url, download: "listings.json", hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    markExported(text, "내려받음", list);
    const ok = list.filter((l) => R.publishable(l, list)).length;
    toast(`listings.json 을 내려받았습니다 (게시 가능 ${ok}개 / 전체 ${list.length}개). 이제 GitHub에 올리세요.`);
  }
  async function copyJSON() {
    flushDraft();
    const list = exportCheck();
    if (!list) return;
    const text = serialize(list);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
      const ta = el("textarea", { readonly: true, style: "position:fixed;left:-9999px;top:0" });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch (__) { ok = false; }
      ta.remove();
    }
    if (ok) markExported(text, "복사함", list);
    toast(ok ? "복사했습니다 — GitHub 편집 화면에서 전체 선택(Ctrl+A) 후 붙여넣기(Ctrl+V) 하세요." : "복사하지 못했습니다. '내려받기'를 쓰세요.");
  }
  function reset() {
    const to = S.offline ? (S.offline.how === "import" ? `불러온 파일(${S.offline.name})` : "보관된 작업을 시작할 때의 파일")
      : "홈페이지에 올라가 있는 listings.json";
    if (!window.confirm(`지금까지 바꾼 내용을 모두 버리고, ${to} 상태로 되돌릴까요?\n\n버린 작업 내용은 백업으로 옮겨 둡니다 ('백업해 둔 작업 내용 되살리기'로 다시 열 수 있습니다).`)) return;
    if (S.sel) commitPending(S.sel);
    backupDraft();
    S.working = S.original.map(canonical);
    S.stash = new WeakMap();
    S.fresh = new Map();
    S.exported = null;
    S.sel = null;
    clearDraft();
    showNotice("");
    select(null);
    refresh();
    toast("처음 상태로 되돌렸습니다.");
  }
  function importFile(file) {
    const fr = new FileReader();
    fr.onload = () => {
      let data;
      try {
        data = JSON.parse(String(fr.result));
        if (!Array.isArray(data)) throw new Error("매물 목록은 [ ] 로 감싼 목록이어야 합니다");
      } catch (e) {
        toast(`불러올 수 없는 파일입니다 — ${e.message}`);
        return;
      }
      const list = data.map(canonical);
      const BAK_NOTE = "\n\n지금 작업 내용은 백업으로 옮겨 둡니다 ('저장하기' 칸의 '백업해 둔 작업 내용 되살리기'로 다시 열 수 있습니다).";
      if (S.loadFailed) {
        // 이 브라우저에 아직 올리지 않은 작업 내용이 있으면 알리고 백업 (불러온 파일이 덮어쓰지 않게)
        const d = readDraft(STORE_KEY);
        if (!window.confirm(`${file.name} 의 매물 ${list.length}개로 작업을 시작할까요? 이 파일을 GitHub에 올리면 홈페이지 매물이 이 내용으로 바뀝니다.` +
          (d ? `\n\n이 브라우저에 자동 보관된 작업 내용(${draftLabel(d)})이 있습니다. 그것으로 이어서 하려면 '취소'를 누르고 '보관된 작업 내용으로 이어서 하기'를 누르세요.` +
            "\n파일을 불러오면 보관된 작업 내용은 백업으로 옮겨 둡니다 ('저장하기' 칸의 '백업해 둔 작업 내용 되살리기'로 다시 열 수 있습니다)." : ""))) return;
        backupDraft();
        clearDraft();
        setOriginal(list);
        S.offline = { how: "import", name: file.name };
        endLoadFailure();
        showNotice(`홈페이지의 listings.json 을 읽지 못해, 불러온 파일(${file.name})을 기준으로 작업합니다. 그 사이 홈페이지 파일이 바뀌었다면 그 내용은 들어 있지 않으니, 올리기 전에 확인하세요.`);
      } else {
        const missing = changedNos(S.original, list).filter((x) => /\(삭제\)$/.test(x)).map((x) => x.replace("(삭제)", ""));
        if (!window.confirm(`지금 작업 내용을 ${file.name} 의 매물 ${list.length}개로 바꿀까요?` +
          (missing.length ? `\n\n홈페이지 파일에만 있는 매물 ${missing.length}개(${missing.join(", ")})는 빠집니다.` : "") +
          (readDraft(STORE_KEY) ? BAK_NOTE : ""))) return;
        backupDraft();
      }
      S.working = list.map(canonical);
      S.working.forEach((l) => { if (isPosInt(l.no)) S.usedNos.add(l.no); });
      S.stash = new WeakMap();
      S.fresh = new Map();
      S.exported = null;
      S.sel = null;
      select(null);
      refresh();
      toast(`${file.name} 을(를) 불러왔습니다.`);
    };
    fr.readAsText(file, "utf-8");
  }

  // ── 알림 (되돌리기 단추는 한 번만, 알림이 사라지면 단추도 없앰)
  let toastTimer = 0;
  function toast(msg, action) {
    const t = $("toast");
    clearTimeout(toastTimer);
    const hide = () => {
      t.classList.remove("is-show");
      const b = t.querySelector("button");
      if (b) {
        const focused = document.activeElement === b;
        b.remove();
        if (focused) (S.sel ? $("formHead") : $("btnNew")).focus();
      }
    };
    t.replaceChildren(el("span", { text: msg }));
    if (action) {
      const b = el("button", { type: "button", class: "btn gold ed-sm", text: action.label });
      b.addEventListener("click", () => { b.remove(); hide(); action.run(); }, { once: true });
      t.append(b);
    }
    t.classList.add("is-show");
    toastTimer = setTimeout(hide, action ? 10000 : 5000);
  }

  // ── 이벤트 연결
  function bindEvents() {
    const form = $("form");
    form.addEventListener("submit", (e) => e.preventDefault());
    form.addEventListener("input", onFieldInput);
    form.addEventListener("change", onFieldChange);
    form.addEventListener("keydown", (e) => { // 한 줄 입력칸에서 Enter 로 폼이 제출되지 않게
      if (e.key === "Enter" && e.target.tagName === "INPUT" && !e.isComposing) e.preventDefault();
    });

    $("btnNew").addEventListener("click", create);
    $("btnDupSel").addEventListener("click", () => S.sel && duplicate(S.sel));
    $("btnDelSel").addEventListener("click", () => S.sel && remove(S.sel));
    $("btnDelSamples").addEventListener("click", removeSamples);
    $("btnUnsample").addEventListener("click", () => {
      if (!S.sel) return;
      delete S.sel.sample;
      changed(true);
      toast("실제 매물로 전환했습니다. 제목의 [샘플] 표시와 내용을 실제 매물에 맞게 고치세요.");
    });
    document.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
      S.filter = b.dataset.filter;
      syncFilterChips();
      renderList();
    }));
    $("btnUseServer").addEventListener("click", useServer);
    $("btnUseDraft").addEventListener("click", useDraft);
    $("btnContinueDraft").addEventListener("click", continueOffline);
    $("btnRestoreBak").addEventListener("click", restoreBackup);

    $("f-type").addEventListener("change", onTypeChange);
    $("f-type-custom").addEventListener("input", () => { if (S.sel) { S.sel.type = $("f-type-custom").value.trim(); changed(true); } });
    $("hasLand").addEventListener("change", (e) => toggleSection("land", e.target.checked));
    $("hasBuilding").addEventListener("change", (e) => toggleSection("building", e.target.checked));
    $("zoningChips").addEventListener("click", onZoneClick);
    $("f-b-dir").addEventListener("change", onDirectionSelect);
    $("mi-now").addEventListener("click", () => setBuildingText("moveIn", "즉시입주"));
    $("mi-date").addEventListener("change", (e) => { if (e.target.value) setBuildingText("moveIn", e.target.value); });
    $("mi-apply").addEventListener("click", () => setBuildingText("moveIn", `${$("mi-month").value}월 ${$("mi-part").value}`));
    $("mt-none").addEventListener("click", () => setBuildingText("maintenance", "없음"));

    document.querySelectorAll("[data-py]").forEach((btn) => btn.addEventListener("click", () => {
      const target = $(btn.dataset.py), pyIn = btn.parentElement.querySelector(".ed-py-in");
      const [n, ok] = R.toNum(String(pyIn.value).replace(/평/g, ""));
      if (!ok || n == null || !(n > 0) || !Number.isFinite(n)) { setFieldError(pyIn, "평 숫자를 넣으세요"); pyIn.focus(); return; }
      setFieldError(pyIn, "");
      target.value = String(round2(n / PY));
      target.dispatchEvent(new Event("input", { bubbles: true }));
      pyIn.value = "";
      toast(`${n}평 = ${target.value}㎡ 로 넣었습니다.`);
    }));
    document.querySelectorAll(".ed-py-in").forEach((inp) => inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); inp.parentElement.querySelector("[data-py]").click(); }
    }));

    document.querySelectorAll(".ed-tagbox").forEach((box) => {
      const input = box.querySelector("input"), btn = box.querySelector(".ed-addrow button");
      const add = () => {
        if (!S.sel) return;
        if (addTagsTo(S.sel, box.dataset.tags, input.value).length) { renderTags(); changed(true); }
        input.value = "";
        input.focus();
      };
      btn.addEventListener("click", add);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); add(); } });
      box.querySelector(".ed-sugg").addEventListener("click", (e) => {
        const c = e.target.closest("[data-sugg]");
        if (!c || !S.sel) return;
        const arr = S.sel[box.dataset.tags], i = arr.indexOf(c.dataset.sugg);
        if (i >= 0) arr.splice(i, 1); else arr.push(c.dataset.sugg);
        renderTags();
        changed(true);
      });
    });

    $("btnAddVideo").addEventListener("click", () => addVideos($("f-video-in").value));
    $("f-video-in").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); addVideos(e.target.value); } });
    $("f-video-in").addEventListener("paste", (e) => { // 붙여넣으면 바로 추가
      const text = (e.clipboardData || window.clipboardData).getData("text");
      if (text && ytId(text.trim().split(/\s+/)[0])) { e.preventDefault(); addVideos(text); }
    });
    $("btnAddPhoto").addEventListener("click", () => addPhoto($("f-photo-in").value));
    $("f-photo-in").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); addPhoto(e.target.value); } });

    // 좌표 "37.471, 127.632" 는 붙여넣을 때 바로 나눔 (한 글자씩 칠 때는 칸을 벗어날 때)
    ["f-lat", "f-lng"].forEach((id) => $(id).addEventListener("paste", (e) => {
      const text = (e.clipboardData || window.clipboardData).getData("text");
      if (PAIR_RE.test(R.asciiDigits(text || ""))) { e.preventDefault(); splitCoordPair($(id), text); }
    }));
    $("btnRound").addEventListener("click", () => {
      const l = S.sel;
      if (!l) return;
      const r3 = (n) => (typeof n === "number" ? Math.round(n * 1000) / 1000 : n);
      l.lat = r3(numVal(l.lat)); l.lng = r3(numVal(l.lng));
      $("f-lat").value = fmtVal(l.lat); $("f-lng").value = fmtVal(l.lng);
      changed(true);
    });
    $("btnClearCoord").addEventListener("click", () => {
      if (!S.sel) return;
      S.sel.lat = null; S.sel.lng = null;
      $("f-lat").value = ""; $("f-lng").value = "";
      ["f-lat", "f-lng"].forEach((id) => { setFieldError($(id), ""); setFieldNote($(id), ""); });
      changed(true);
    });

    $("btnDownload").addEventListener("click", download);
    $("btnCopy").addEventListener("click", copyJSON);
    $("btnReset").addEventListener("click", reset);
    $("btnImport").addEventListener("click", () => $("importFile").click());
    $("btnImportErr").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ""; });
    $("ytLink").addEventListener("click", flushDraft);

    // 탭을 닫거나 다른 앱으로 가기 직전의 입력도 보관
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushDraft(); });
    window.addEventListener("beforeunload", (e) => {
      flushDraft();
      if (!S.storageOK && isDirty()) { e.preventDefault(); e.returnValue = ""; }
    });
    window.addEventListener("storage", (e) => { // 다른 탭에서 같은 편집기를 고친 경우
      if (e.key === STORE_KEY) showNotice("다른 탭에서 매물 편집기 내용이 바뀌었습니다. 한 탭에서만 작업하세요 (새로고침하면 마지막 보관본을 불러옵니다).");
    });
  }
  function syncFilterChips() {
    document.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === S.filter)));
  }

  // 테스트·다른 도구에서 쓰는 순수 함수
  window.GAYA_LISTING_EDITOR = { ytId, parseManwon, parseArea, parseCount, parseNo, normYmd, photoPath, canonical,
    normalize: canonical, serialize, merge3, ORDER, REGION_KEYS, LAND_KEYS, BUILDING_KEYS, state: S, flush: flushDraft };

  if (!R) {
    $("loadErrorText").textContent = "rules.js 를 불러오지 못했습니다. 페이지를 새로고침하세요.";
    $("loadError").hidden = false;
    $("ed").hidden = true;
    return;
  }
  init().catch((e) => {
    console.error(e);
    failLoad("편집기를 시작하지 못했습니다: " + e.message);
    document.body.dataset.ready = "1";
  });
})();
