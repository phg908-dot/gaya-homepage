// 매물 편집기 (admin/listing.html)
// - data/listings.json 을 그대로(계약완료·샘플 포함) 불러와 폼으로 고치고, 고친 파일을 내려받아 GitHub에 올리는 방식
// - 작업 중인 내용은 이 브라우저 localStorage 에 자동 보관 (실패해도 동작)
// - 광고 명시사항 점검은 rules.js(window.GAYA_RULES) — scripts/build.py 와 같은 규칙
// - 보안: 데이터는 textContent / DOM 생성으로만 화면에 넣습니다 (innerHTML 사용 안 함)
(function () {
  "use strict";
  const R = window.GAYA_RULES;
  const G = window.GAYA || {};
  const ROOT = document.body.dataset.root || "../";
  const STORE_KEY = "gaya.listingEditor.v1";
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
    if (eok && rest) return `${eok}억 ${rest.toLocaleString("ko-KR")}만원`;
    if (eok) return `${eok}억원`;
    return `${rest.toLocaleString("ko-KR")}만원`;
  };

  // ── 스키마 (내보낼 때 이 순서로 정리)
  const ORDER = ["no", "status", "featured", "urgent", "sample", "title", "type", "deal", "price", "deposit", "monthly",
    "region", "land", "building", "recommendedUse", "summary", "description", "features", "videoIds", "photos",
    "lat", "lng", "updated"];
  const REGION_KEYS = ["sido", "sigungu", "eupmyeon", "ri"];
  const LAND_KEYS = ["area", "jimok", "zoning", "currentUse", "road"];
  const BUILDING_KEYS = ["area", "totalFloors", "floor", "approvalDate", "direction", "rooms", "baths", "parking",
    "moveIn", "maintenance", "violation"];
  const DEAL_FIELDS = { "매매": ["price"], "전세": ["deposit"], "월세": ["deposit", "monthly"], "단기임대": ["deposit", "monthly"] };
  const YANGPYEONG = ["양평읍", "강상면", "강하면", "양서면", "옥천면", "서종면", "단월면", "청운면", "양동면", "지평면", "용문면", "개군면"];

  function toNum(v) {
    if (v == null || typeof v === "boolean") return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const s = String(v).replace(/[,\s]/g, "");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const toInt = (v) => { const n = toNum(v); return n == null ? null : Math.round(n); };
  const str = (v) => (v == null ? "" : String(v).trim());
  const strList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(str).filter(Boolean);
  const isEmptyObj = (v) => !v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length === 0;
  const zoningText = (z) => R.splitZoning(z).join(", ");
  function withExtras(out, src, keys) {
    if (src && typeof src === "object") {
      for (const k of Object.keys(src)) if (!keys.includes(k) && !(k in out)) out[k] = src[k];
    }
    return out;
  }

  // 스키마 순서·자료형으로 정리한 새 객체 (모르는 항목은 지우지 않고 뒤에 붙임)
  function normalize(l) {
    l = l || {};
    const r = l.region && typeof l.region === "object" ? l.region : {};
    const o = {};
    o.no = toInt(l.no);
    o.status = str(l.status) || "거래중";
    o.featured = !!l.featured;
    o.urgent = !!l.urgent;
    if (l.sample) o.sample = true;
    o.title = str(l.title);
    o.type = str(l.type);
    o.deal = str(l.deal);
    o.price = toInt(l.price);
    o.deposit = toInt(l.deposit);
    o.monthly = toInt(l.monthly);
    o.region = withExtras({ sido: str(r.sido), sigungu: str(r.sigungu), eupmyeon: str(r.eupmyeon), ri: str(r.ri) }, r, REGION_KEYS);
    const land = l.land;
    o.land = isEmptyObj(land) ? null : withExtras({
      area: toNum(land.area), jimok: str(land.jimok), zoning: zoningText(land.zoning),
      currentUse: str(land.currentUse), road: str(land.road),
    }, land, LAND_KEYS);
    const b = l.building;
    o.building = isEmptyObj(b) ? null : withExtras({
      area: toNum(b.area), totalFloors: toInt(b.totalFloors), floor: str(b.floor), approvalDate: str(b.approvalDate),
      direction: str(b.direction), rooms: toInt(b.rooms), baths: toInt(b.baths), parking: toInt(b.parking),
      moveIn: str(b.moveIn), maintenance: str(b.maintenance), violation: !!b.violation,
    }, b, BUILDING_KEYS);
    o.recommendedUse = strList(l.recommendedUse);
    o.summary = str(l.summary);
    o.description = l.description == null ? "" : String(l.description).replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    o.features = strList(l.features);
    o.videoIds = strList(l.videoIds);
    o.photos = strList(l.photos);
    o.lat = toNum(l.lat);
    o.lng = toNum(l.lng);
    o.updated = str(l.updated);
    return withExtras(o, l, ORDER);
  }
  // build.py 와 같은 모양: 2칸 들여쓰기, 한글 그대로, 마지막 줄바꿈
  const serialize = (list) => JSON.stringify(list.map(normalize), null, 2) + "\n";

  // ── 입력값 해석
  function parseManwon(raw) {
    const s0 = String(raw == null ? "" : raw).trim();
    if (!s0) return { value: null, error: "" };
    if (/협의|비공개|문의|미정|추후|[~∼]|\d\s*-\s*\d|^-/.test(s0)) {
      return { value: null, error: "가격은 하나의 금액(숫자)만 쓸 수 있습니다 — '협의'·'비공개'·범위 표시는 금지" };
    }
    const s = s0.replace(/[,\s]/g, "").replace(/원$/, "");
    if (/^\d+(\.\d+)?$/.test(s)) return { value: Math.round(parseFloat(s)), error: "" };
    const m = s.match(/^(?:(\d+(?:\.\d+)?)억)?(?:(\d+(?:\.\d+)?)천)?(?:(\d+(?:\.\d+)?)백)?(\d+(?:\.\d+)?)?만?$/);
    if (m && (m[1] || m[2] || m[3] || m[4])) {
      const v = (+m[1] || 0) * 10000 + (+m[2] || 0) * 1000 + (+m[3] || 0) * 100 + (+m[4] || 0);
      return { value: Math.round(v), error: "" };
    }
    return { value: null, error: "숫자로 입력하세요 (만원 단위, 예: 32000 또는 3억 2천)" };
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  function parseArea(raw) {
    const s0 = String(raw == null ? "" : raw).trim();
    if (!s0) return { value: null, error: "" };
    if (/평/.test(s0)) {
      const py = toNum(s0.replace(/평/g, ""));
      if (py == null || py < 0) return { value: null, error: "숫자로 입력하세요" };
      return { value: round2(py / PY), error: "", note: `${py}평을 ㎡로 바꿨습니다` };
    }
    const n = toNum(s0.replace(/㎡|m²|m2|제곱미터/gi, ""));
    if (n == null || n < 0) return { value: null, error: "숫자로 입력하세요 (㎡)" };
    return { value: n, error: "" };
  }
  function parseInt0(raw) {
    const s = String(raw == null ? "" : raw).replace(/[,\s]|개|대|층|호/g, "").replace(/^no\.?/i, "");
    if (!s) return { value: null, error: "" };
    if (!/^\d+$/.test(s)) return { value: null, error: "0 이상의 정수(숫자)만 입력하세요" };
    return { value: parseInt(s, 10), error: "" };
  }
  function parsePlainNum(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return { value: null, error: "" };
    const n = toNum(s);
    return n == null ? { value: null, error: "숫자로 입력하세요" } : { value: n, error: "" };
  }
  function normYmd(raw) {
    const s = String(raw == null ? "" : raw).trim();
    const d = s.replace(/\D/g, "");
    if (/^\d+$/.test(s) && d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
    if (/^\d+$/.test(s) && d.length === 6) return `${d.slice(0, 4)}-${d.slice(4)}`;
    const m = s.match(/^(\d{4})\s*[.\/\-년]\s*(\d{1,2})\s*(?:[.\/\-월]\s*(\d{1,2})\s*일?)?\s*\.?$/);
    if (m) return m[3] ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : `${m[1]}-${m[2].padStart(2, "0")}`;
    return s;
  }
  // 유튜브 주소(watch?v=, youtu.be/, /shorts/, /embed/, /live/) 또는 11자리 ID → ID
  function ytId(input) {
    const s = String(input == null ? "" : input).trim();
    if (!s) return null;
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    let u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s.replace(/^\/+/, "")); } catch (_) { return null; }
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
    let id = null;
    if (host === "youtu.be") id = u.pathname.split("/")[1];
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      id = u.searchParams.get("v");
      if (!id) { const m = u.pathname.match(/^\/(?:shorts|embed|live|v|e)\/([^/?#]+)/); if (m) id = m[1]; }
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
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
    return (h >>> 0).toString(16);
  }
  const fmtPy = (m2) => (m2 * PY).toLocaleString("ko-KR", { maximumFractionDigits: 1 });
  const fmtTime = (d) => { try { return new Date(d).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } };

  // ── 상태
  const S = {
    original: [], originalText: "", baseHash: "", site: {},
    working: [], sel: null, filter: "all",
    stash: new WeakMap(), storageOK: true, savedAt: null, lastDeleted: null,
  };
  const stashOf = (l) => { if (!S.stash.has(l)) S.stash.set(l, {}); return S.stash.get(l); };
  const isDirty = () => serialize(S.working) !== S.originalText;
  function nextNo() {
    const nos = S.working.concat(S.original).map((l) => toInt(l.no)).filter((n) => n != null);
    return Math.max(1000, ...nos) + 1;
  }
  function dupNos() {
    const seen = new Set(), dup = new Set();
    S.working.forEach((l) => { const n = toInt(l.no); if (seen.has(n)) dup.add(n); seen.add(n); });
    return dup;
  }
  function blankListing() {
    return normalize({
      no: nextNo(), status: "거래중", deal: "매매",
      region: { sido: "경기도", sigungu: "양평군", eupmyeon: "", ri: "" },
      land: { area: null, jimok: "", zoning: "", currentUse: "", road: "" }, building: null, updated: today(),
    });
  }
  const emptyLand = () => ({ area: null, jimok: "", zoning: "", currentUse: "", road: "" });
  const emptyBuilding = () => ({ area: null, totalFloors: null, floor: "", approvalDate: "", direction: "", rooms: null,
    baths: null, parking: null, moveIn: "", maintenance: "", violation: false });

  function getPath(o, path) {
    return path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
  }
  function setPath(o, path, v) {
    const ks = path.split("."), last = ks.pop();
    const parent = ks.reduce((x, k) => (x == null ? null : x[k]), o);
    if (parent) parent[last] = v;
  }

  function verdict(n) {
    const probs = R.problems(n);
    // cls = 표시 색, cat = 목록 거르기 분류
    if (n.status === "계약완료") return { cls: "off", cat: "off", text: "계약완료 · 미게시", probs };
    if (n.sample) return { cls: "bad", cat: "off", text: "샘플 · 미게시", probs };
    if (probs.length) return { cls: "bad", cat: "bad", text: `누락 ${probs.length}개`, probs };
    return { cls: "ok", cat: "ok", text: "게시 가능 ✓", probs };
  }
  function priceLabel(n) {
    if (n.deal === "월세" || n.deal === "단기임대") {
      return n.deposit == null && n.monthly == null ? "" : `${money(n.deposit || 0)} / 월 ${money(n.monthly || 0)}`;
    }
    if (n.deal === "전세") { const v = n.deposit != null ? n.deposit : n.price; return v == null ? "" : money(v); }
    return n.price == null ? "" : money(n.price);
  }

  // ── 불러오기
  async function fetchText(path) {
    const res = await fetch(ROOT + path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${path} (${res.status})`);
    return res.text();
  }
  function setOriginal(list) {
    S.original = list.map(normalize);
    S.originalText = serialize(S.original);
    S.baseHash = hash(S.originalText);
  }
  function showNotice(msg) {
    const n = $("loadNotice");
    n.textContent = msg;
    n.hidden = !msg;
  }
  function showError(msg) {
    $("loadError").textContent = msg;
    $("loadError").hidden = !msg;
  }
  function readDraft() {
    try { const s = localStorage.getItem(STORE_KEY); return s ? JSON.parse(s) : null; } catch (_) { return null; }
  }
  function clearDraft() { try { localStorage.removeItem(STORE_KEY); } catch (_) { /* 저장소 사용 불가 */ } }
  function writeDraft() {
    try {
      if (!isDirty()) localStorage.removeItem(STORE_KEY);
      else localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, base: S.baseHash, savedAt: new Date().toISOString(), listings: S.working.map(normalize) }));
      S.storageOK = true;
      S.savedAt = new Date();
    } catch (_) {
      S.storageOK = false;
    }
    renderSaveState();
  }

  async function init() {
    buildStatic();
    bindEvents();
    let data = [];
    try {
      const text = await fetchText("data/listings.json");
      try {
        data = JSON.parse(text);
        if (!Array.isArray(data)) throw new Error("매물 목록은 [ ] 로 감싼 목록이어야 합니다");
      } catch (e) {
        data = [];
        showError(`listings.json 형식 오류 — ${e.message}. GitHub에서 마지막으로 고친 부분(쉼표·따옴표·괄호)을 확인하거나, 전에 내려받은 파일을 '파일에서 불러오기'로 여세요.`);
      }
    } catch (e) {
      showError(`listings.json 을 불러오지 못했습니다 (${e.message}). 홈페이지 주소의 /admin/listing.html 로 열거나, 미리보기 서버(python3 -m http.server -d public)에서 여세요. '파일에서 불러오기'도 쓸 수 있습니다.`);
    }
    try { S.site = JSON.parse(await fetchText("data/site.json")) || {}; } catch (_) { S.site = {}; }
    setOriginal(data);
    S.working = S.original.map(normalize);

    const d = readDraft();
    if (d && Array.isArray(d.listings)) {
      if (serialize(d.listings) === S.originalText) clearDraft();
      else {
        S.working = d.listings.map(normalize);
        let msg = `지난번 작업 내용(${fmtTime(d.savedAt)} 보관)을 이어서 불러왔습니다. 아직 GitHub에 올리지 않았다면 '저장하기'에서 내려받으세요.`;
        if (d.base !== S.baseHash) msg += " 그 사이 홈페이지의 listings.json 이 바뀌었습니다 — 최신 파일로 새로 시작하려면 '처음 상태로 되돌리기'를 누르세요.";
        showNotice(msg);
      }
    }
    S.working.forEach((l) => { if (l.no == null) l.no = nextNo(); });

    const gh = S.site.admin && S.site.admin.repoEditUrl;
    if (typeof gh === "string" && /^https:\/\//.test(gh)) { $("btnGithub").href = gh; $("btnGithub").hidden = false; }
    else $("githubHint").hidden = false;

    const want = toInt(new URLSearchParams(location.search).get("no"));
    const pick = want != null ? S.working.find((l) => l.no === want) : null;
    if (pick) select(pick, false);
    else select(null);
    renderList();
    renderSaveState();
    document.body.dataset.ready = "1";
  }

  // ── 고정 요소 만들기
  function buildStatic() {
    const t = $("f-type");
    t.append(el("option", { value: "", text: "고르세요" }), ...R.TYPES.map((x) => el("option", { value: x, text: x })),
      el("option", { value: "__custom", text: "직접 입력…" }));
    $("f-jimok").append(el("option", { value: "", text: "고르세요" }), ...R.JIMOK.map((x) => el("option", { value: x, text: x })));
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
  }

  // ── 목록
  function passesFilter(l) {
    if (S.filter === "all") return true;
    return S.filter === verdict(normalize(l)).cat;
  }
  function renderList() {
    const dups = dupNos();
    const rows = S.working.filter(passesFilter);
    $("list").replaceChildren(...rows.map((l) => itemNode(l, dups)));
    $("listCount").textContent = `${S.working.length}개`;
    $("listEmpty").hidden = rows.length > 0;
    $("listEmpty").textContent = S.working.length ? "해당하는 매물이 없습니다." : "등록된 매물이 없습니다. '+ 새 매물'을 눌러 시작하세요.";
    const samples = S.working.filter((l) => l.sample).length;
    $("sampleBox").hidden = !samples;
    $("sampleCount").textContent = String(samples);
  }
  function itemNode(l, dups) {
    const n = normalize(l), v = verdict(n), cur = l === S.sel;
    const label = `No.${n.no ?? "?"}`;
    return el("li", { class: "ed-li", "data-no": String(n.no), "aria-current": cur ? "true" : null },
      el("div", { class: "ed-li-top" },
        el("b", { text: label }),
        el("span", { class: "ed-tag" + (n.status === "계약완료" ? " ed-tag-done" : ""), text: n.status }),
        n.sample ? el("span", { class: "ed-tag ed-tag-sample", text: "샘플" }) : null,
        n.urgent ? el("span", { class: "ed-tag ed-tag-urgent", text: "급매" }) : null,
        dups.has(n.no) ? el("span", { class: "ed-tag ed-tag-sample", text: "번호 중복" }) : null),
      el("div", { class: "ed-li-title", text: n.title || "(제목 없음)" }),
      el("div", { class: "ed-li-meta", text: [n.deal, n.type, priceLabel(n), n.region.eupmyeon].filter(Boolean).join(" · ") }),
      el("span", { class: "ed-badge ed-badge-" + v.cls, text: v.text }),
      el("div", { class: "ed-li-actions" },
        el("button", { type: "button", class: "btn ed-sm " + (cur ? "navy" : "ghost"), "data-act": "edit", "aria-label": `${label} 편집`, text: "편집", onclick: () => select(l, true) }),
        el("button", { type: "button", class: "btn ed-sm ghost", "data-act": "dup", "aria-label": `${label} 복제`, text: "복제", onclick: () => duplicate(l) }),
        el("button", { type: "button", class: "btn ed-sm ghost ed-danger", "data-act": "del", "aria-label": `${label} 삭제`, text: "삭제", onclick: () => remove(l) })));
  }

  function select(l, scroll) {
    S.sel = l || null;
    $("emptyState").hidden = !!S.sel;
    $("form").hidden = !S.sel;
    if (S.sel) fillForm();
    try { history.replaceState(null, "", S.sel ? `?no=${S.sel.no}` : location.pathname); } catch (_) { /* file:// 등 */ }
    renderList();
    renderCheck();
    renderBar();
    if (S.sel && scroll) {
      const narrow = window.matchMedia("(max-width: 759px)").matches;
      (narrow ? $("checkPanel") : $("formHead")).scrollIntoView({ block: "start" });
      $("formHead").focus({ preventScroll: true });
    }
  }

  function create() {
    const l = blankListing();
    S.working.unshift(l);
    S.filter = "all";
    syncFilterChips();
    select(l, true);
    changed(false);
    $("f-title").focus();
  }
  function duplicate(l) {
    const c = normalize(l);
    c.no = nextNo();
    c.title = c.title ? `${c.title} (복사)` : "";
    c.status = "거래중";
    delete c.sample;
    c.videoIds = [];
    c.photos = [];
    c.updated = today();
    S.working.splice(S.working.indexOf(l) + 1, 0, c);
    select(c, true);
    changed(false);
    toast(`No.${l.no}을(를) 복제해 No.${c.no}을(를) 만들었습니다. 영상·사진은 복사하지 않았습니다.`);
  }
  function remove(l) {
    const n = normalize(l);
    const msg = `No.${n.no} "${n.title || "제목 없음"}" 매물을 삭제할까요?` +
      (n.status !== "계약완료" ? "\n\n계약된 매물이라면 삭제 대신 '계약완료'로 바꿔도 홈페이지에서 빠집니다." : "");
    if (!window.confirm(msg)) return;
    const idx = S.working.indexOf(l);
    if (idx < 0) return;
    S.working.splice(idx, 1);
    if (S.sel === l) select(null);
    changed(false);
    toast(`No.${n.no} 매물을 삭제했습니다.`, { label: "되돌리기", run: () => {
      S.working.splice(Math.min(idx, S.working.length), 0, l);
      select(l, false);
      changed(false);
    } });
    $("btnNew").focus();
  }
  function removeSamples() {
    const n = S.working.filter((l) => l.sample).length;
    if (!n || !window.confirm(`샘플 매물 ${n}개를 모두 삭제할까요?`)) return;
    S.working = S.working.filter((l) => !l.sample);
    if (S.sel && !S.working.includes(S.sel)) select(null);
    changed(false);
    toast(`샘플 매물 ${n}개를 삭제했습니다.`);
  }

  // ── 폼 채우기
  function fmtVal(v) { return v == null ? "" : String(v); }
  function fillFields(scope) {
    const l = S.sel;
    scope.querySelectorAll("[data-f]").forEach((inp) => {
      const v = getPath(l, inp.dataset.f);
      if (inp.type === "radio") inp.checked = inp.value === v;
      else if (inp.type === "checkbox") inp.checked = !!v;
      else if (inp.tagName === "SELECT") setSelect(inp, v);
      else inp.value = fmtVal(v);
      setFieldError(inp, "");
    });
    if (scope.contains($("f-deposit")) && l.deal === "전세" && l.deposit == null && l.price != null) $("f-deposit").value = String(l.price);
  }
  function setSelect(sel, v) {
    sel.querySelectorAll("option[data-extra]").forEach((o) => o.remove());
    v = v == null ? "" : String(v);
    if (v && ![...sel.options].some((o) => o.value === v)) {
      sel.append(el("option", { value: v, "data-extra": "1", text: `${v} (목록에 없음)` }));
    }
    sel.value = v;
  }
  function fillForm() {
    const l = S.sel;
    fillFields($("form"));
    // 매물 종류: 목록 + 직접 입력
    const known = R.TYPES.includes(l.type);
    $("f-type").value = !l.type ? "" : known ? l.type : "__custom";
    $("f-type-custom").hidden = known || !l.type;
    $("f-type-custom").value = known ? "" : l.type;
    $("hasLand").checked = !!l.land;
    $("hasBuilding").checked = !!l.building;
    $("landBody").hidden = !l.land;
    $("buildingBody").hidden = !l.building;
    ["py-land", "py-b"].forEach((id) => { $(id).value = ""; setFieldError($(id), ""); });
    $("f-video-in").value = "";
    $("f-photo-in").value = "";
    showMsg("videoErr", "");
    showMsg("photoErr", "");
    syncDirectionHelpers();
    renderTags();
    renderVideos();
    renderPhotos();
    updateDerived();
  }

  function setFieldError(inp, msg) {
    const box = inp.closest(".ed-fld") || inp.parentElement;
    let p = box && box.querySelector(`.ed-ferr[data-for="${inp.id}"]`);
    if (msg) {
      if (!p) {
        p = el("p", { class: "ed-ferr", "data-for": inp.id, id: `err-${inp.id}` });
        box.append(p);
      }
      p.textContent = msg;
      inp.setAttribute("aria-invalid", "true");
      inp.setAttribute("aria-describedby", p.id);
    } else {
      if (p) p.remove();
      inp.removeAttribute("aria-invalid");
      if (inp.getAttribute("aria-describedby") === `err-${inp.id}`) inp.removeAttribute("aria-describedby");
    }
  }
  function showMsg(id, msg) { $(id).textContent = msg; $(id).hidden = !msg; }

  // 화면에서 계산되는 부분(미리보기·필수 표시·가격 칸) 갱신
  function updateDerived() {
    const l = S.sel;
    if (!l) return;
    $("fhNo").textContent = String(l.no ?? "");
    $("fhTitle").textContent = l.title || "새 매물";
    $("hintNo").textContent = String(l.no ?? "");
    $("ytLink").href = `youtube.html?no=${encodeURIComponent(l.no ?? "")}`;
    $("sampleLine").hidden = !l.sample;
    $("doneNote").hidden = l.status !== "계약완료";

    const vis = DEAL_FIELDS[l.deal] || ["price"];
    ["price", "deposit", "monthly"].forEach((k) => { $("fld-" + k).hidden = !vis.includes(k); });
    $("lbl-deposit").textContent = l.deal === "전세" ? "전세금" : "보증금";
    $("lbl-monthly").textContent = l.deal === "단기임대" ? "월 임대료" : "월세";
    const pv = (k, v) => {
      $("pv-" + k).textContent = v == null ? "" : `= ${money(v)}` + (v >= 1000000 ? " — 금액이 매우 큽니다. 만원 단위가 맞는지 확인하세요" : "");
    };
    pv("price", l.price);
    pv("deposit", l.deal === "전세" && l.deposit == null ? l.price : l.deposit);
    pv("monthly", l.monthly);

    const areaPv = (id, m2) => { $(id).textContent = m2 == null ? "" : `= 약 ${fmtPy(m2)}평`; };
    areaPv("pv-land-area", l.land ? l.land.area : null);
    areaPv("pv-b-area", l.building ? l.building.area : null);

    const res = R.isResidential(normalize(l));
    $("req-rooms").hidden = !res;
    $("req-maint").hidden = !res;
    $("req-land-area").hidden = !!l.building;
    $("req-jimok").hidden = !!l.building;
    $("landOffHint").hidden = !!l.land;

    const zones = R.splitZoning(l.land && l.land.zoning);
    $("zoningChips").querySelectorAll("[data-zone]").forEach((b) => b.setAttribute("aria-pressed", String(zones.includes(b.dataset.zone))));
    $("sumCount").textContent = String((l.summary || "").length);

    const hasCoord = l.lat != null && l.lng != null;
    $("mapLink").hidden = !hasCoord;
    if (hasCoord) $("mapLink").href = `https://map.kakao.com/link/map/${encodeURIComponent("No." + l.no)},${l.lat},${l.lng}`;
  }

  // ── 입력 처리
  function onFieldInput(e) {
    const inp = e.target;
    if (!S.sel || !inp.dataset || !inp.dataset.f) return;
    const l = S.sel, path = inp.dataset.f, t = inp.dataset.t;
    let v, err = "";
    if (inp.type === "checkbox") v = inp.checked;
    else if (inp.type === "radio") { if (!inp.checked) return; v = inp.value; }
    else if (t === "money") ({ value: v, error: err } = parseManwon(inp.value));
    else if (t === "int") ({ value: v, error: err } = parseInt0(inp.value));
    else if (t === "area") ({ value: v, error: err } = parseArea(inp.value));
    else if (t === "num") ({ value: v, error: err } = parsePlainNum(inp.value));
    else if (t === "ymd") v = normYmd(inp.value);
    else v = inp.value;

    if (path === "lat" && /\d[^\d.\-]+-?\d/.test(inp.value.trim())) { // "37.47, 127.63" 한 번에 붙여넣기
      const m = inp.value.match(/(-?\d+(?:\.\d+)?)[^\d.\-]+(-?\d+(?:\.\d+)?)/);
      if (m) {
        let a = parseFloat(m[1]), b = parseFloat(m[2]);
        if (a > 90 && b <= 90) [a, b] = [b, a];
        l.lat = a; l.lng = b;
        inp.value = String(a);
        $("f-lng").value = String(b);
        setFieldError(inp, "");
        setFieldError($("f-lng"), "");
        changed(true);
        return;
      }
    }
    if (path === "no" && v != null && v < 1) err = "1 이상의 번호를 쓰세요";
    setFieldError(inp, err);

    const prevDeal = l.deal;
    if (path === "deposit" && l.deal === "전세") l.price = null; // 전세금은 deposit 에 저장
    setPath(l, path, v);
    if (["price", "deposit", "monthly"].includes(path)) stashOf(l)[path] = v;
    if (path === "deal" && prevDeal !== v) applyDeal(l, prevDeal);
    if (path === "building.direction") syncDirectionHelpers();
    if (path === "no") renderVideos();
    changed(path !== "updated");
  }
  // 칸을 벗어나면 보기 좋게 정리 (예: "3억 2천" → 32000)
  function onFieldChange(e) {
    const inp = e.target;
    if (!S.sel || !inp.dataset || !inp.dataset.f || inp.type === "checkbox" || inp.type === "radio" || inp.tagName === "SELECT") return;
    const t = inp.dataset.t;
    if (inp.getAttribute("aria-invalid") === "true") return;
    if (["money", "int", "area", "num", "ymd"].includes(t)) {
      const v = getPath(S.sel, inp.dataset.f);
      if (inp.dataset.f === "deposit" && S.sel.deal === "전세" && v == null && S.sel.price != null) return;
      inp.value = fmtVal(v);
    }
  }
  // 거래 형태가 바뀌면 해당 없는 가격 칸은 비우고(되돌리면 복원), 필요한 칸만 보여줌
  function applyDeal(l, prevDeal) {
    const st = stashOf(l);
    if (prevDeal === "전세" && l.deposit == null && l.price != null) { l.deposit = l.price; l.price = null; }
    ["price", "deposit", "monthly"].forEach((k) => { if (l[k] != null) st[k] = l[k]; });
    const want = DEAL_FIELDS[l.deal] || ["price"];
    ["price", "deposit", "monthly"].forEach((k) => {
      if (!want.includes(k)) l[k] = null;
      else if (l[k] == null && st[k] != null) l[k] = st[k];
    });
    fillFields($("sec-price"));
  }

  function changed(touch) {
    if (touch && S.sel) {
      const t = today();
      if (S.sel.updated !== t) { S.sel.updated = t; $("f-updated").value = t; }
    }
    refresh();
  }
  let raf = 0, saveTimer = 0;
  function refresh() {
    updateDerived();
    renderCheck();
    renderBar();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { renderList(); renderSaveState(); });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeDraft, 300);
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
    $(key === "land" ? "landBody" : "buildingBody").hidden = !on;
    if (on) {
      fillFields($(key === "land" ? "landBody" : "buildingBody"));
      if (key === "building") syncDirectionHelpers();
    }
    changed(true);
  }

  // ── 용도지역 칩
  function onZoneClick(e) {
    const b = e.target.closest("[data-zone]");
    if (!b || !S.sel || !S.sel.land) return;
    const zones = R.splitZoning(S.sel.land.zoning);
    const z = b.dataset.zone, i = zones.indexOf(z);
    if (i >= 0) zones.splice(i, 1); else zones.push(z);
    S.sel.land.zoning = zones.join(", ");
    $("f-zoning").value = S.sel.land.zoning;
    changed(true);
  }

  // ── 방향·입주가능일·관리비 도우미
  function syncDirectionHelpers() {
    const d = S.sel && S.sel.building ? S.sel.building.direction : "";
    const m = String(d || "").match(/^(\S+향)\s*\((.+)\)$/);
    $("dir-face").value = m && [...$("dir-face").options].some((o) => o.value === m[1]) ? m[1] : "";
    if (m && [...$("dir-base").options].some((o) => o.value === m[2])) $("dir-base").value = m[2];
  }
  function onDirectionHelper() {
    const b = S.sel && S.sel.building;
    if (!b || !$("dir-face").value) return;
    b.direction = `${$("dir-face").value}(${$("dir-base").value})`;
    $("f-b-direction").value = b.direction;
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
      const key = box.dataset.tags, arr = S.sel[key] || (S.sel[key] = []);
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
  function addTags(box, text) {
    const key = box.dataset.tags, arr = S.sel[key] || (S.sel[key] = []);
    const add = String(text).split(/[,\n]/).map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
    add.forEach((t) => { if (!arr.includes(t)) arr.push(t); });
    if (add.length) { renderTags(); changed(true); }
  }

  // ── 영상
  function addVideos(text) {
    if (!S.sel) return;
    const parts = String(text).split(/[\s,]+/).filter(Boolean);
    const bad = [], dup = [];
    parts.forEach((p) => {
      const id = ytId(p);
      if (!id) bad.push(p);
      else if (S.sel.videoIds.includes(id)) dup.push(id);
      else S.sel.videoIds.push(id);
    });
    const msg = [bad.length ? `유튜브 주소로 알아볼 수 없습니다: ${bad.join(" ")}` : "", dup.length ? `이미 들어 있는 영상입니다: ${dup.join(", ")}` : ""].filter(Boolean).join(" / ");
    showMsg("videoErr", msg);
    $("f-video-in").value = bad.join(" ");
    renderVideos();
    if (parts.length > bad.length + dup.length) changed(true);
  }
  function moveItem(arr, i, d) { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; }
  function renderVideos() {
    if (!S.sel) return;
    const arr = S.sel.videoIds;
    $("videoList").replaceChildren(...arr.map((id, i) => {
      const ok = /^[A-Za-z0-9_-]{11}$/.test(id);
      return el("li", { class: "ed-vitem", "data-id": id },
        ok ? el("img", { src: `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`, alt: `영상 ${id} 미리보기`, loading: "lazy" })
          : el("div", { class: "ed-ph-img", text: "ID 형식 오류" }),
        el("div", { class: "ed-vi-body" },
          el("code", { text: id }),
          el("span", { class: "ed-row" },
            ok ? el("a", { class: "btn ghost ed-sm", href: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, target: "_blank", rel: "noopener", text: "보기" }) : null,
            i > 0 ? el("button", { type: "button", class: "btn ghost ed-sm", "aria-label": `영상 ${id} 앞으로`, text: "▲", onclick: () => { moveItem(arr, i, -1); renderVideos(); changed(true); } }) : null,
            el("button", { type: "button", class: "btn ghost ed-sm ed-danger", "aria-label": `영상 ${id} 빼기`, text: "빼기", onclick: () => { arr.splice(i, 1); renderVideos(); $("f-video-in").focus(); changed(true); } }))));
    }));
  }

  // ── 사진
  function addPhoto(text) {
    if (!S.sel) return;
    const paths = String(text).split(/[\s,]+/).map(photoPath).filter(Boolean);
    const bad = paths.filter((p) => !/\.(jpe?g|png|webp|gif|avif)$/i.test(p));
    paths.forEach((p) => { if (!S.sel.photos.includes(p)) S.sel.photos.push(p); });
    showMsg("photoErr", bad.length ? `사진 파일(jpg·png·webp)이 맞는지 확인하세요: ${bad.join(", ")}` : "");
    $("f-photo-in").value = "";
    renderPhotos();
    if (paths.length) changed(true);
  }
  function renderPhotos() {
    if (!S.sel) return;
    const arr = S.sel.photos;
    $("photoList").replaceChildren(...arr.map((p, i) => {
      const img = el("img", { src: ROOT + p.split("/").map(encodeURIComponent).join("/"), alt: `사진 ${i + 1}`, loading: "lazy" });
      img.addEventListener("error", () => img.replaceWith(el("div", { class: "ed-ph-img", text: "파일을 찾을 수 없습니다 (public/images 에 올렸는지 확인)" })), { once: true });
      return el("li", { class: "ed-vitem" }, img,
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
    const byLabel = Object.fromEntries(R.BUILDING_REQUIRED.concat(R.RESIDENTIAL_REQUIRED).map(([k, label]) => [R.P.BUILDING_PREFIX + label, "f-b-" + k]));
    const firstEmpty = (ids) => ids.map($).find((x) => !x.closest("[hidden]") && !x.value) || $(ids[0]);
    if (p === R.P.REGION) return firstEmpty(["f-sido", "f-sigungu", "f-eupmyeon"]);
    if (p === R.P.TYPE) return $("f-type");
    if (p === R.P.DEAL) return document.querySelector('input[name="deal"]');
    if (p === R.P.PRICE) return firstEmpty(["f-price", "f-deposit", "f-monthly"]);
    if (p === R.P.LAND_AREA) return l.land ? $("f-land-area") : $("hasLand");
    if (p === R.P.JIMOK) return $("f-jimok");
    return byLabel[p] ? $(byLabel[p]) : null;
  }
  function goToField(target) {
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }
  function renderCheck() {
    const state = $("checkState"), P = $("checkProblems"), W = $("checkWarnings");
    if (!S.sel) {
      const vs = S.working.map((l) => verdict(normalize(l)));
      const c = (cat) => vs.filter((v) => v.cat === cat).length;
      state.className = "ed-state is-off";
      state.textContent = S.working.length
        ? `전체 ${S.working.length}개 — 게시 가능 ${c("ok")} · 누락 ${c("bad")} · 계약완료·샘플 ${c("off")}`
        : "매물이 없습니다";
      P.replaceChildren();
      W.replaceChildren();
      $("warnTitle").hidden = true;
      $("checkHelp").textContent = "매물을 고르면 광고 명시사항이 빠졌는지 하나씩 점검합니다.";
      return;
    }
    const n = normalize(S.sel), v = verdict(n), warns = R.warnings(n);
    const dup = dupNos().has(n.no);
    if (n.status === "계약완료") state.textContent = "계약완료 — 홈페이지에 게시되지 않습니다";
    else if (n.sample) state.textContent = "샘플 매물 — 게시되지 않습니다 (실제 매물로 전환하거나 삭제하세요)";
    else if (v.probs.length) state.textContent = `누락 ${v.probs.length}개 — 채우기 전에는 홈페이지에 올라가지 않습니다`;
    else state.textContent = "게시 가능 ✓ — 광고 명시사항이 모두 들어 있습니다";
    state.className = "ed-state is-" + v.cls;
    P.replaceChildren(...[
      dup ? el("li", { class: "ed-static", text: `매물번호 ${n.no}이(가) 다른 매물과 겹칩니다 — 번호를 바꾸세요` }) : null,
      ...v.probs.map((p) => el("li", null, el("button", { type: "button", "data-problem": p, text: p,
        onclick: () => goToField(fieldForProblem(p)) }))),
    ].filter(Boolean));
    W.replaceChildren(...warns.map((w) => el("li", { text: w })));
    $("warnTitle").hidden = !warns.length;
    $("checkHelp").textContent = v.probs.length
      ? "빨간 항목을 누르면 해당 입력칸으로 이동합니다. 근거: 공인중개사법 제18조의2 · 시행령 제17조의2 · 국토부 명시사항 세부기준(2025.1.1.)"
      : "근거: 공인중개사법 제18조의2 · 시행령 제17조의2 · 국토부 명시사항 세부기준(2025.1.1.). 배포할 때 같은 규칙으로 한 번 더 점검합니다.";
  }
  function renderBar() {
    const bar = $("edBar");
    bar.hidden = !S.sel;
    if (!S.sel) return;
    const n = normalize(S.sel), v = verdict(n);
    const s = $("barState");
    s.className = "ed-bar-state is-" + v.cls;
    s.textContent = `No.${n.no ?? "?"} · ${v.text}`;
  }

  // ── 저장 상태·내보내기
  function diffCounts() {
    const a = new Map(S.original.map((l) => [l.no, JSON.stringify(l)]));
    const b = new Map(S.working.map((l) => { const n = normalize(l); return [n.no, JSON.stringify(n)]; }));
    let add = 0, mod = 0, del = 0;
    b.forEach((v, k) => { if (!a.has(k)) add++; else if (a.get(k) !== v) mod++; });
    a.forEach((_, k) => { if (!b.has(k)) del++; });
    return { add, mod, del };
  }
  function renderSaveState() {
    const dirty = isDirty();
    const pill = $("dirtyPill");
    pill.textContent = dirty ? "저장 안 된 변경 있음" : "변경 없음";
    pill.classList.toggle("is-dirty", dirty);
    const s = $("saveState");
    if (dirty) {
      const d = diffCounts();
      const parts = [d.add && `추가 ${d.add}`, d.mod && `수정 ${d.mod}`, d.del && `삭제 ${d.del}`].filter(Boolean);
      s.textContent = `저장 안 된 변경 있음 — ${parts.length ? parts.join(" · ") : "순서 변경"}`;
    } else s.textContent = "변경 없음 — 홈페이지에 올라간 파일과 같습니다";
    s.className = "ed-save-state " + (dirty ? "is-dirty" : "is-clean");
    $("autosaveNote").textContent = !S.storageOK
      ? "이 브라우저에서는 자동 보관이 되지 않습니다. 창을 닫기 전에 꼭 내려받으세요."
      : dirty && S.savedAt ? `작업 내용은 이 브라우저에 자동 보관 중입니다 (${fmtTime(S.savedAt)}).` : "";
    $("btnReset").disabled = !dirty;
  }
  function exportCheck() {
    const noless = S.working.filter((l) => toInt(l.no) == null).length;
    if (noless) { window.alert(`매물번호가 비어 있는 매물이 ${noless}개 있습니다. 번호를 넣은 뒤 다시 누르세요.`); return false; }
    const dups = [...dupNos()];
    if (dups.length && !window.confirm(`매물번호 ${dups.join(", ")}이(가) 겹칩니다. 그래도 내려받을까요?`)) return false;
    return true;
  }
  function download() {
    if (!exportCheck()) return;
    const text = serialize(S.working);
    const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
    const a = el("a", { href: url, download: "listings.json", hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    const n = S.working.map(normalize), ok = n.filter(R.publishable).length;
    toast(`listings.json 을 내려받았습니다 (게시 가능 ${ok}개 / 전체 ${n.length}개). 이제 GitHub에 올리세요.`);
  }
  async function copyJSON() {
    if (!exportCheck()) return;
    const text = serialize(S.working);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
      const ta = el("textarea", { readonly: true, style: "position:fixed;left:-9999px;top:0" });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch (__) { ok = false; }
      ta.remove();
    }
    toast(ok ? "복사했습니다 — GitHub 편집 화면에서 전체 선택(Ctrl+A) 후 붙여넣기(Ctrl+V) 하세요." : "복사하지 못했습니다. '다운로드'를 쓰세요.");
  }
  function reset() {
    if (!window.confirm("지금까지 바꾼 내용을 모두 버리고, 홈페이지에 올라가 있는 listings.json 상태로 되돌릴까요?")) return;
    S.working = S.original.map(normalize);
    S.stash = new WeakMap();
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
      if (!window.confirm(`${file.name} 의 매물 ${data.length}개로 작업 내용을 바꿀까요?`)) return;
      S.working = data.map(normalize);
      S.working.forEach((l) => { if (l.no == null) l.no = nextNo(); });
      showError("");
      select(null);
      refresh();
      toast(`${file.name} 을(를) 불러왔습니다.`);
    };
    fr.readAsText(file, "utf-8");
  }

  // ── 알림
  let toastTimer = 0;
  function toast(msg, action) {
    const t = $("toast");
    t.replaceChildren(el("span", { text: msg }));
    if (action) t.append(el("button", { type: "button", class: "btn gold ed-sm", text: action.label,
      onclick: () => { t.classList.remove("is-show"); action.run(); } }));
    t.classList.add("is-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("is-show"), action ? 10000 : 5000);
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

    $("f-type").addEventListener("change", onTypeChange);
    $("f-type-custom").addEventListener("input", () => { if (S.sel) { S.sel.type = $("f-type-custom").value.trim(); changed(true); } });
    $("hasLand").addEventListener("change", (e) => toggleSection("land", e.target.checked));
    $("hasBuilding").addEventListener("change", (e) => toggleSection("building", e.target.checked));
    $("zoningChips").addEventListener("click", onZoneClick);
    $("dir-face").addEventListener("change", onDirectionHelper);
    $("dir-base").addEventListener("change", onDirectionHelper);
    $("mi-now").addEventListener("click", () => setBuildingText("moveIn", "즉시입주"));
    $("mi-date").addEventListener("change", (e) => { if (e.target.value) setBuildingText("moveIn", e.target.value); });
    $("mi-apply").addEventListener("click", () => setBuildingText("moveIn", `${$("mi-month").value}월 ${$("mi-part").value}`));
    $("mt-none").addEventListener("click", () => setBuildingText("maintenance", "없음"));

    document.querySelectorAll("[data-py]").forEach((btn) => btn.addEventListener("click", () => {
      const target = $(btn.dataset.py), pyIn = btn.parentElement.querySelector(".ed-py-in");
      const n = toNum(String(pyIn.value).replace(/평/g, ""));
      if (n == null || n <= 0) { setFieldError(pyIn, "평 숫자를 넣으세요"); pyIn.focus(); return; }
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
      const add = () => { addTags(box, input.value); input.value = ""; input.focus(); };
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

    $("btnRound").addEventListener("click", () => {
      const l = S.sel;
      if (!l) return;
      const r3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);
      l.lat = r3(l.lat); l.lng = r3(l.lng);
      $("f-lat").value = fmtVal(l.lat); $("f-lng").value = fmtVal(l.lng);
      changed(true);
    });
    $("btnClearCoord").addEventListener("click", () => {
      if (!S.sel) return;
      S.sel.lat = null; S.sel.lng = null;
      $("f-lat").value = ""; $("f-lng").value = "";
      setFieldError($("f-lat"), ""); setFieldError($("f-lng"), "");
      changed(true);
    });

    $("btnDownload").addEventListener("click", download);
    $("btnCopy").addEventListener("click", copyJSON);
    $("btnReset").addEventListener("click", reset);
    $("btnImport").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ""; });

    window.addEventListener("beforeunload", (e) => {
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
  window.GAYA_LISTING_EDITOR = { ytId, parseManwon, parseArea, normYmd, photoPath, normalize, serialize, ORDER, state: S };

  if (!R) {
    showError("rules.js 를 불러오지 못했습니다. 페이지를 새로고침하세요.");
    return;
  }
  init().catch((e) => {
    console.error(e);
    showError("편집기를 시작하지 못했습니다: " + e.message);
  });
})();
