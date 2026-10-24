// 매물 광고 명시사항 점검 규칙 (매물 편집기·유튜브 설명란 도구에서 함께 사용)
// 근거: 공인중개사법 제18조의2, 시행령 제17조의2,
//       국토부 고시 「중개대상물의 표시·광고 명시사항 세부기준」(제2024-748호, 2025.1.1. 시행)
//
// 기준은 scripts/build.py 입니다. problems(l, all) 은 배포 때 build.py 가 내리는 판정
//   build.listing_problems(build.normalize_all(목록)[i])  (normalize() 의 '_issues' 포함)
// 과 문구·순서까지 같아야 합니다. 한쪽을 고치면 다른 쪽도 고치세요.
// site/tests/admin-listing.test.js 가 site/tests/rules_crosscheck.py 로 두 쪽을 같은 자료로 돌려 비교합니다.
//
// 비교 기준: 자바스크립트 객체 l 을 JSON.stringify 한 글을 파이썬이 json.loads 로 읽었을 때의 판정.
//   (그래서 숫자 1 과 1.0 은 같은 값이고, NaN·undefined 는 null 로 봅니다.)
//   파이썬의 공백(\s)·숫자(\d)·float()·str() 규칙을 그대로 따릅니다 (전각 숫자 '３２０００' 도 숫자).
//
//   브라우저: <script src="assets/js/rules.js"></script> → window.GAYA_RULES
//   Node    : const R = require("./rules.js")
(function (root) {
  "use strict";

  // 공간정보관리법 시행령 제58조 — 지목 28종 (build.py JIMOK)
  const JIMOK = ["전", "답", "과수원", "목장용지", "임야", "광천지", "염전", "대", "공장용지", "학교용지", "주차장",
    "주유소용지", "창고용지", "도로", "철도용지", "제방", "하천", "구거", "유지", "양어장", "수도용지", "공원",
    "체육용지", "유원지", "종교용지", "사적지", "묘지", "잡종지"];

  // 국토계획법 제36조·시행령 제30조 — 용도지역 21종 (build.py ZONING)
  const ZONING_GROUPS = [
    ["주거지역", ["제1종전용주거지역", "제2종전용주거지역", "제1종일반주거지역", "제2종일반주거지역", "제3종일반주거지역", "준주거지역"]],
    ["상업지역", ["중심상업지역", "일반상업지역", "근린상업지역", "유통상업지역"]],
    ["공업지역", ["전용공업지역", "일반공업지역", "준공업지역"]],
    ["녹지지역", ["보전녹지지역", "생산녹지지역", "자연녹지지역"]],
    ["관리지역", ["보전관리지역", "생산관리지역", "계획관리지역"]],
    ["농림·자연환경보전", ["농림지역", "자연환경보전지역"]],
  ];
  const ZONING = ZONING_GROUPS.flatMap((g) => g[1]);

  // 건축법 시행령 별표1 — 건축물대장 주용도 30종 (build.py BUILDING_USES, 별표 순서)
  const BUILDING_USES = ["단독주택", "공동주택", "제1종 근린생활시설", "제2종 근린생활시설", "문화 및 집회시설", "종교시설",
    "판매시설", "운수시설", "의료시설", "교육연구시설", "노유자시설", "수련시설", "운동시설", "업무시설", "숙박시설", "위락시설",
    "공장", "창고시설", "위험물 저장 및 처리 시설", "자동차 관련 시설", "동물 및 식물 관련 시설", "자원순환 관련 시설",
    "교정시설", "국방·군사시설", "방송통신시설", "발전시설", "묘지 관련 시설", "관광 휴게시설", "장례시설", "야영장 시설"];

  // 편집기에서 고르는 값 (직접 입력도 가능)
  const TYPES = ["토지", "임야", "전원주택", "단독주택", "다가구", "다세대·빌라", "아파트", "펜션", "상가", "사무실", "공장·창고"];
  const DEALS = ["매매", "전세", "월세", "단기임대"];
  const STATUSES = ["거래중", "계약완료"];
  // 방향 = 건물이 바라보는 방향 (사무소 원칙). 기준이 없으면 '(건물 정면 기준)'을 붙여 표시
  const DIRECTIONS = ["동향", "서향", "남향", "북향", "남동향", "남서향", "북동향", "북서향"];
  const DIRECTION_BASIS = "건물 정면 기준";

  // build.py DONE_WORDS / LIVE_WORDS — 공백을 모두 지운 뒤 비교
  const DONE_WORDS = ["계약완료", "거래완료", "완료", "판매완료", "매매완료", "임대완료"];
  const LIVE_WORDS = ["", "거래중", "판매중", "광고중"];

  // 주택(준주택 포함)만 방 수·관리비 필수 (비주택 건축물은 생략 가능 — 2025.1.1. 개정) (build.py RESIDENTIAL_WORDS)
  const RESIDENTIAL_WORDS = ["주택", "아파트", "빌라", "연립", "다세대", "다가구", "원룸", "오피스텔", "펜션",
    "고시원", "다중생활", "기숙사", "주상복합", "노인복지", "공관"];
  const DANDOK_WORDS = ["단독", "전원주택", "농가주택", "다가구", "다중주택", "공관"];
  // 공동주택·준주택: 해당 층 필수 (저/중/고 가능) (build.py APT_WORDS)
  const APT_WORDS = ["아파트", "빌라", "연립", "다세대", "오피스텔", "주상복합", "도시형"];

  // build.py BUILDING_REQUIRED (+ 주택이면 방 수·관리비, 공동주택이면 해당 층) — 이 순서로 점검
  const BUILDING_REQUIRED = [
    ["area", "전용면적"], ["totalFloors", "총 층수"], ["approvalDate", "사용승인일(사용검사일·준공인가일)"],
    ["direction", "방향(기준 포함)"], ["baths", "욕실 수"], ["parking", "주차대수"], ["moveIn", "입주가능일"],
  ];
  const RESIDENTIAL_REQUIRED = [["rooms", "방 수"], ["maintenance", "관리비"]];
  const APT_REQUIRED = [["floor", "해당 층(저/중/고 가능)"]];
  const NUM_KEYS = { land: ["area"], building: ["area", "totalFloors", "rooms", "baths", "parking"] };

  // build.py PHOTO_OK — 이 모양이 아닌 사진 경로는 배포 때 빠집니다
  const PHOTO_OK = /^images\/(?!.*\.\.)[^<>"'\\:?#]+\.(?:jpe?g|png|webp|gif)$/i;

  // build.py 와 같은 문구 (화면에서 해당 입력칸을 찾을 때도 사용)
  const P = {
    NO: "매물번호(no)는 양의 정수여야 합니다",
    TITLE: "제목(title)",
    REGION: "소재지(시도·시군구·읍면동)",
    RI: "소재지의 리(里) — 읍·면 지역은 리까지 적어야 합니다",
    TYPE: "중개대상물 종류",
    DEAL: "거래 형태",
    PRICE: "가격(단일가격 — '비공개'·'협의' 불가)",
    LAND_AREA: "토지 면적",
    JIMOK: "지목",
    BUILDING_PREFIX: "건축물 ",
    MOVE_IN: "입주가능일 형식 — '즉시입주', '2026-11-01', 협의 가능하면 '11월 중순'",
    MAINTENANCE: "관리비 세부내역 — 정액 월 10만원 이상이면 일반관리비·사용료(전기·수도·가스 등)·기타관리비로 나눠 적기",
    status: (v) => `상태값 '${pyStr(v)}' 을(를) 알 수 없습니다 — '거래중' 또는 '계약완료'로 적어 주세요`,
    priceFormat: (k, v) => `가격 항목 ${k} '${pyStr(v)}' — 숫자(만원)만 적어 주세요 ('협의'·'비공개'·범위 불가)`,
    numFormat: (part, k, v) => `${part === "land" ? "토지" : "건물"} ${k} '${pyStr(v)}' — 숫자만 적어 주세요 (예: 562.0)`,
    dup: (n) => `매물번호 중복 (${n}건) — 번호를 하나씩만 쓰세요`,
  };
  const STATUS_ISSUE_RE = /^상태값 '/;
  const DUP_RE = /^매물번호 중복 \(\d+건\)/;
  const NUM_ISSUE_RE = /^(토지|건물) (\w+) '[\s\S]*' — 숫자만/;
  const PRICE_ISSUE_RE = /^가격 항목 (price|deposit|monthly) /;

  // 부당한 표시·광고(과장) 소지가 있는 표현 — 경고만 (게시는 막지 않음)
  const EXAGGERATION = ["역대급", "무조건", "최저가", "급급매", "초급매", "초특가", "파격", "대박", "로또", "확정수익",
    "수익보장", "수익 보장", "100%", "헐값", "반값", "땡처리", "마지막 기회", "최고의", "강력추천", "강력 추천"];

  // ── 파이썬과 같은 판정을 위한 도우미
  // 파이썬 str.isspace() / 정규식 \s 와 같은 공백 문자
  const WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
  const WS_ALL = new RegExp(`[${WS}]+`, "g");
  const WS_EDGE = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
  const strip = (s) => String(s).replace(WS_EDGE, ""); // 파이썬 str.strip()
  const ND = /\p{Nd}/u;
  // 파이썬 \d 와 float() 은 전각·아랍 숫자 등 모든 유니코드 십진 숫자를 숫자로 봅니다 → 0-9 로 바꿔 계산
  function digitValue(ch) {
    const cp = ch.codePointAt(0);
    let start = cp;
    while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start--;
    return (cp - start) % 10;
  }
  const asciiDigits = (s) => String(s).replace(/\p{Nd}/gu, (c) => (c >= "0" && c <= "9" ? c : String(digitValue(c))));

  const isDict = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  // 참/거짓 — 파이썬과 같음 (None·False·0·""·[]·{} 는 거짓)
  function truthy(v) {
    if (v === undefined || v === null || v === false) return false;
    if (v === true) return true;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return Boolean(v);
  }
  const blank = (v) => v === undefined || v === null || v === ""; // 파이썬: v in (None, "")
  // JSON 으로 주고받는 값 기준으로 정리 (NaN·undefined → null, 함수 제거)
  function jsonClone(v) {
    try { const s = JSON.stringify(v); return s === undefined ? null : JSON.parse(s); } catch (_) { return v; }
  }

  // 파이썬 repr(float)
  function pyFloatRepr(x) {
    if (x !== x) return "nan";
    if (x === Infinity) return "inf";
    if (x === -Infinity) return "-inf";
    if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
    const m = String(Math.abs(x)).match(/^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/);
    if (!m) return String(x);
    let digits = m[1] + (m[2] || "");
    let decpt = m[1].length + Number(m[3] || 0);
    while (digits.length > 1 && digits[0] === "0") { digits = digits.slice(1); decpt--; }
    digits = digits.replace(/0+$/, "") || "0";
    let out;
    if (decpt > 16 || decpt < -3) {
      const e = decpt - 1;
      out = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (e < 0 ? "-" : "+") + String(Math.abs(e)).padStart(2, "0");
    } else if (decpt <= 0) out = "0." + "0".repeat(-decpt) + digits;
    else if (decpt >= digits.length) out = digits + "0".repeat(decpt - digits.length) + ".0";
    else out = digits.slice(0, decpt) + "." + digits.slice(decpt);
    return (x < 0 ? "-" : "") + out;
  }
  // 숫자를 JSON 으로 보낸 뒤 파이썬이 str() 한 글자: 정수 표기는 int, 소수점·지수가 있으면 float
  function pyNum(n) {
    if (!Number.isFinite(n)) return pyFloatRepr(n);
    const j = JSON.stringify(n);
    return /[.eE]/.test(j) ? pyFloatRepr(n) : j;
  }
  const NONPRINT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
  const hex = (n, w) => n.toString(16).padStart(w, "0");
  // 파이썬 repr(str)
  function pyStrRepr(s) {
    const q = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = q;
    for (const ch of s) {
      if (ch === q || ch === "\\") out += "\\" + ch;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch !== " " && NONPRINT.test(ch)) {
        const cp = ch.codePointAt(0);
        out += cp < 0x100 ? "\\x" + hex(cp, 2) : cp < 0x10000 ? "\\u" + hex(cp, 4) : "\\U" + hex(cp, 8);
      } else out += ch;
    }
    return out + q;
  }
  function pyRepr(v) {
    if (v === undefined || v === null) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNum(v);
    if (typeof v === "string") return pyStrRepr(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (typeof v === "object") return "{" + Object.keys(v).map((k) => pyStrRepr(k) + ": " + pyRepr(v[k])).join(", ") + "}";
    return pyStrRepr(String(v));
  }
  // 파이썬 str() 과 같은 글자 (메시지·문자열 변환용)
  function pyStr(v) {
    if (v === undefined || v === null) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNum(v);
    if (typeof v === "string") return v;
    return pyRepr(v);
  }

  // build.py to_num(): [값, 올바른지] — 비어 있으면 [null, true], 숫자가 아니면 [null, false]
  const PY_FLOAT = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
  function toNum(v) {
    if (typeof v === "number" && !Number.isFinite(v)) v = null; // JSON 으로 보내면 null
    if (v === undefined || v === null) return [null, true];
    if (typeof v === "boolean") return [null, false];
    if (typeof v === "number") return [v, true];
    if (typeof v === "string") {
      const t = asciiDigits(strip(v.replace(/,/g, "")));
      if (t === "") return [null, true];
      if (PY_FLOAT.test(t)) return [Number(t.replace(/_/g, "")), true];
      const m = t.match(/^([+-]?)(inf|infinity|nan)$/i);
      if (m) return [m[2].toLowerCase() === "nan" ? NaN : m[1] === "-" ? -Infinity : Infinity, true];
      return [null, false];
    }
    return [null, false];
  }
  // build.py as_list()
  function asList(v) {
    if (v === undefined || v === null || v === "") return [];
    if (typeof v === "string") return v.split(",").map(strip).filter(Boolean);
    if (Array.isArray(v)) return v.map((x) => strip(pyStr(x))).filter(Boolean);
    return [];
  }
  const validNo = (n, ok) => ok && typeof n === "number" && Number.isInteger(n) && n > 0;
  // 상태값 → "거래중" / "계약완료" / null(알 수 없음)
  function statusOf(raw) {
    if (typeof raw === "number" && !Number.isFinite(raw)) raw = null;
    const st = (truthy(raw) ? pyStr(raw) : "").replace(WS_ALL, "");
    if (DONE_WORDS.includes(st)) return "계약완료";
    if (LIVE_WORDS.includes(st)) return "거래중";
    return null;
  }
  // 매물번호 중복을 셀 때 쓰는 열쇠 (build.py: 올바르면 정수, 아니면 str(원래 값))
  function noKey(raw) {
    if (typeof raw === "number" && !Number.isFinite(raw)) raw = null;
    const [n, ok] = toNum(raw);
    return validNo(n, ok) ? "n:" + n : "s:" + pyStr(raw);
  }

  // build.py normalize() 중 판정에 쓰이는 부분 + '_issues'
  function pyNormalize(raw) {
    const l = isDict(raw) ? jsonClone(raw) : {};
    const issues = [];
    const n = {};
    const [no, okNo] = toNum(l.no);
    if (!validNo(no, okNo)) issues.push(P.NO);
    n.no = validNo(no, okNo) ? no : pyStr(l.no);
    const st = statusOf(l.status);
    if (st === null) issues.push(P.status(l.status));
    n.status = st === null ? l.status : st;
    if (typeof l.title !== "string" || !strip(l.title)) issues.push(P.TITLE);
    n.title = typeof l.title === "string" ? l.title : truthy(l.title) ? pyStr(l.title) : "";
    for (const k of ["summary", "description", "type", "deal"]) n[k] = l[k] == null ? "" : strip(pyStr(l[k]));
    for (const k of ["price", "deposit", "monthly"]) {
      const [v, ok] = toNum(l[k]);
      if (!ok) issues.push(P.priceFormat(k, l[k]));
      n[k] = v;
    }
    n.region = {};
    if (isDict(l.region)) {
      for (const [k, v] of Object.entries(l.region)) n.region[k] = typeof v === "boolean" ? v : v == null ? "" : strip(pyStr(v));
    }
    const sj = n.region.showJibun;
    delete n.region.showJibun;
    delete n.region.hideJibun;
    n.region.showJibun = sj === true || (typeof sj === "string" && ["true", "1", "예", "y"].includes(sj.toLowerCase()));
    for (const part of ["land", "building"]) {
      const d = l[part];
      if (!isDict(d) || !Object.keys(d).length) { n[part] = null; continue; }
      const o = {};
      for (const [k, v] of Object.entries(d)) {
        o[k] = NUM_KEYS[part].includes(k) || v === null || typeof v === "boolean" || typeof v === "string" ? v : pyStr(v);
      }
      for (const k of NUM_KEYS[part]) {
        const [v, ok] = toNum(d[k]);
        if (!ok) issues.push(P.numFormat(part, k, d[k]));
        o[k] = v;
      }
      n[part] = o;
    }
    for (const k of ["features", "recommendedUse", "photos", "videoIds"]) n[k] = asList(l[k]);
    n.featured = truthy(l.featured);
    n.urgent = truthy(l.urgent);
    n.sample = truthy(l.sample);
    return { n, issues };
  }

  const typeText = (n) => (truthy(n.type) ? pyStr(n.type) : "");
  const useOf = (n) => { const b = isDict(n.building) ? n.building : {}; return truthy(b.use) ? b.use : ""; };
  // build.py is_residential / is_dandok / is_apartment (정리된 값 기준)
  const residentialN = (n) => useOf(n) === "단독주택" || useOf(n) === "공동주택" || RESIDENTIAL_WORDS.some((w) => typeText(n).includes(w));
  const dandokN = (n) => truthy(n.building) && (useOf(n) === "단독주택" || DANDOK_WORDS.some((w) => typeText(n).includes(w)));
  const apartmentN = (n) => truthy(n.building) && (useOf(n) === "공동주택" || APT_WORDS.some((w) => typeText(n).includes(w)));

  // build.py has_single_price() — 값은 정리된 뒤의 숫자 또는 null
  function hasSinglePrice(n) {
    const isNum = (v) => typeof v === "number";
    const pos = (v) => isNum(v) && v > 0;
    if (n.deal === "월세" || n.deal === "단기임대") return isNum(n.deposit) && n.deposit >= 0 && pos(n.monthly);
    if (n.deal === "전세") return pos(n.deposit) || pos(n.price);
    return pos(n.price);
  }

  // build.py MOVE_IN_OK (파이썬 '$' 는 맨 끝 줄바꿈 앞에서도 맞음)
  const D = "\\p{Nd}", S = `[${WS}]`;
  const MOVE_IN_OK = new RegExp(`즉시|^${D}{4}[-.]${S}?${D}{1,2}[-.]${S}?${D}{1,2}\\.?(?=\\n?$)|${D}{1,2}${S}*월${S}*(초|중|하)`, "u");
  const MAN_RE = new RegExp(`(${D}+(?:\\.${D}+)?)${S}*만${S}*원?`, "u");
  const WON_RE = new RegExp(`(${D}{4,})${S}*원`, "u");
  // build.py maintenance_won(): '월 25만원', '120,000원' → 월 금액(원). 못 읽으면 null
  function maintenanceWon(text) {
    const t = (truthy(text) ? pyStr(text) : "").replace(/,/g, "");
    let m = t.match(MAN_RE);
    if (m) return Number(asciiDigits(m[1])) * 10000;
    m = t.match(WON_RE);
    return m ? Number(asciiDigits(m[1])) : null;
  }
  const moveInOk = (v) => MOVE_IN_OK.test(pyStr(v));
  // 관리비가 '정액 월 10만원 이상인데 나눠 적지 않음' 에 해당하는지
  const maintenanceNeedsSplit = (v) => {
    const won = maintenanceWon(v);
    return won !== null && won >= 100000 && !/일반관리비|사용료/.test(pyStr(v));
  };

  // build.py listing_problems() 의 필수 항목 점검 (정리된 값 기준)
  function coreProblems(n) {
    const p = [];
    const r = n.region || {};
    if (!(truthy(r.sido) && truthy(r.sigungu) && truthy(r.eupmyeon))) p.push(P.REGION);
    else if (/[읍면]$/.test(pyStr(r.eupmyeon)) && !truthy(r.ri)) p.push(P.RI);
    if (!truthy(n.type)) p.push(P.TYPE);
    if (!truthy(n.deal)) p.push(P.DEAL);
    if (!hasSinglePrice(n)) p.push(P.PRICE);
    const land = n.land || {};
    const b = n.building;
    if (!truthy(b) && !truthy(land.area)) p.push(P.LAND_AREA);
    if (truthy(land) && !truthy(b) && !truthy(land.jimok)) p.push(P.JIMOK);
    if (truthy(b)) {
      const need = BUILDING_REQUIRED.concat(residentialN(n) ? RESIDENTIAL_REQUIRED : [], apartmentN(n) ? APT_REQUIRED : []);
      need.forEach(([k, label]) => { if (blank(b[k])) p.push(P.BUILDING_PREFIX + label); });
      if (truthy(b.moveIn) && !moveInOk(b.moveIn)) p.push(P.MOVE_IN);
      if (maintenanceNeedsSplit(b.maintenance)) p.push(P.MAINTENANCE);
    }
    return p;
  }

  // 같은 번호가 목록(all)에 몇 번 나오는지 (all 에는 l 자신도 들어 있어야 합니다)
  function dupCount(l, all) {
    const key = (x) => noKey(isDict(x) ? x.no : undefined);
    const k = key(l);
    return all.reduce((c, x) => c + (key(x) === k ? 1 : 0), 0);
  }

  // 게시를 막는 빠진·잘못된 항목 (비어 있으면 명시사항 충족) = build.py listing_problems(normalize(l))
  // all 에 매물 목록 전체를 주면 build.py normalize_all() 처럼 매물번호 중복도 셉니다.
  function problems(l, all) {
    const { n, issues } = pyNormalize(l);
    if (Array.isArray(all)) {
      const c = dupCount(l, all);
      if (c > 1) issues.push(P.dup(c));
    }
    return issues.concat(coreProblems(n));
  }

  function isDone(l) { return isDict(l) && statusOf(l.status) === "계약완료"; }
  const isSample = (l) => isDict(l) && truthy(jsonClone(l.sample));

  // build.py publishable()
  function publishable(l, all) {
    return isDict(l) && !isDone(l) && !isSample(l) && problems(l, all).length === 0;
  }

  // 게시를 막는 모든 이유 (계약완료·샘플 포함) — 화면 표시용
  function blockers(l, all) {
    const b = [];
    if (isDone(l)) b.push("계약완료 매물 — 홈페이지에 게시되지 않습니다");
    if (isSample(l)) b.push("샘플 매물 — 실제 매물이 아니므로 게시되지 않습니다");
    return b.concat(problems(l, all));
  }

  // build.py check() 가 이 매물에 내는 경고와 같은 글 (사무소 정보 경고 제외)
  function checkWarnings(l, all) {
    const { n } = pyNormalize(l);
    const tag = `매물 No.${typeof n.no === "number" ? BigInt(n.no).toString() : pyStr(n.no)}`; // 파이썬 int(no)
    if (n.status === "계약완료") return [`${tag}: 계약완료 — 배포본에서 제외됩니다(통보 후 3일 내 삭제 의무). 유튜브 영상도 비공개 처리하세요`];
    const w = [];
    if (n.sample) w.push(`${tag}: 샘플 매물 — 배포본에서 제외됩니다(존재하지 않는 매물 광고 금지)`);
    const miss = problems(l, all);
    if (miss.length) w.push(`${tag}: 명시사항 누락 → 배포본에서 제외됩니다: ${miss.join(", ")}`);
    const land = n.land || {};
    if (truthy(land.jimok) && !JIMOK.includes(land.jimok)) {
      w.push(`${tag}: 지목 '${pyStr(land.jimok)}' 은(는) 28개 법정 지목이 아닙니다 (예: 대, 전, 답, 임야)`);
    }
    const zoning = truthy(land.zoning) ? land.zoning : "";
    if (typeof zoning === "string") {
      zoning.split(",").map(strip).filter(Boolean).forEach((z) => {
        if (!ZONING.includes(z)) w.push(`${tag}: 용도지역 '${z}' 표기를 확인하세요 (예: 계획관리지역, 자연녹지지역)`);
      });
    }
    const b = n.building || {};
    if (truthy(b) && !truthy(b.use)) {
      w.push(`${tag}: 건축물대장 주용도(building.use, 예: 단독주택·제2종 근린생활시설)를 적으면 매물 종류가 더 정확히 표시됩니다`);
    } else if (truthy(b.use) && !BUILDING_USES.includes(b.use)) {
      w.push(`${tag}: 건축물 용도 '${pyStr(b.use)}' 는 건축법상 용도 이름이 아닙니다 (예: 단독주택, 제1종 근린생활시설)`);
    }
    return w;
  }

  function splitZoning(z) {
    return String(z || "").split(/[,，、]/).map((s) => strip(s)).filter(Boolean);
  }

  // build.py direction_text(): 기준이 적혀 있지 않으면 '(건물 정면 기준)' 을 붙임
  function directionText(d, basis) {
    d = strip(truthy(d) ? pyStr(d) : "");
    if (!d || d.includes("기준")) return d;
    return `${d}(${basis || DIRECTION_BASIS})`;
  }
  // build.py region_text(): 지번은 showJibun 이 true 인 매물만 (그 외에는 리까지)
  function regionText(region, withRi) {
    const r = isDict(region) ? pyNormalize({ region }).n.region : {};
    withRi = withRi !== false;
    const keys = ["sido", "sigungu", "eupmyeon"].concat(withRi ? ["ri"] : []);
    let out = keys.filter((k) => truthy(r[k])).map((k) => pyStr(r[k])).join(" ");
    if (withRi && truthy(r.jibun) && r.showJibun === true) out += " " + pyStr(r.jibun);
    return out;
  }

  const decimals = (n) => { const m = String(n).match(/\.(\d+)$/); return m ? m[1].length : 0; };
  const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  // 게시는 되지만 확인이 필요한 항목 (build.py check() 의 경고 + 편집기 도움말)
  function warnings(l, all) {
    if (!isDict(l)) return [];
    const { n } = pyNormalize(l);
    const w = [];
    if (n.status !== "계약완료") {
      checkWarnings(l, all).forEach((x) => {
        const t = x.replace(/^매물 No\.[^:]*: /, "");
        if (/^(샘플 매물|명시사항 누락)/.test(t)) return; // 화면의 다른 칸에서 따로 보여줌
        w.push(t.replace("(building.use, 예:", "(예:"));
      });
    }
    const b = n.building;
    if (b && truthy(b.approvalDate) && !/^\d{4}-\d{2}(-\d{2})?$/.test(pyStr(b.approvalDate))) {
      w.push("사용승인일은 YYYY-MM-DD 또는 YYYY-MM 형식으로 적으세요 (예: 2015-03-20)");
    }
    const text = `${n.title} ${n.summary}`;
    const hits = EXAGGERATION.filter((x) => text.includes(x));
    if (hits.length) {
      w.push(`과장 표현 주의: '${hits.join("', '")}' — 확인할 수 없는 최상급·단정 표현은 부당한 표시·광고가 될 수 있습니다`);
    }
    if (!n.sample && /샘플/.test(`${n.title} ${n.description}`)) {
      w.push("제목·설명에 '샘플'이라는 말이 남아 있습니다 — 실제 매물 내용으로 고치세요");
    }
    if ((n.deal === "월세" || n.deal === "단기임대") && n.deposit === 0) {
      w.push("보증금이 0원입니다 — 보증금 없는 임대가 맞는지 확인하세요");
    }
    if (truthy(n.region.jibun) && n.region.showJibun) {
      w.push("지번을 홈페이지에 공개합니다 — 의뢰인이 동의한 경우에만 공개하세요");
    }
    const badIds = n.videoIds.filter((id) => !YT_ID_RE.test(id) || id === "videoseries");
    if (badIds.length) w.push(`유튜브 영상 ID 형식이 맞지 않습니다: ${badIds.join(", ")}`);
    const badPhotos = n.photos.filter((p) => !PHOTO_OK.test(p));
    if (badPhotos.length) {
      w.push(`사진 경로 '${badPhotos.join("', '")}' 는 홈페이지에서 빠집니다 — images/파일이름.jpg 모양이어야 합니다 (jpg·png·webp·gif)`);
    }
    const [lat, okLat] = toNum(l.lat);
    const [lng, okLng] = toNum(l.lng);
    const hasLat = !blank(l.lat), hasLng = !blank(l.lng);
    if (hasLat !== hasLng) w.push("지도 좌표는 위도·경도를 모두 넣어야 표시됩니다");
    else if (hasLat && hasLng) {
      if (!okLat || !okLng || lat === null || lng === null || !(lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132)) {
        w.push("좌표가 국내 범위를 벗어났거나 숫자가 아닙니다 — 위도(33~39)·경도(124~132) 순서를 확인하세요 (지도에서 빠집니다)");
      } else if (decimals(lat) > 3 || decimals(lng) > 3) {
        w.push("좌표가 너무 정확합니다 — 지번이 드러나지 않게 소수점 3자리(리·마을 단위)까지만 쓰는 것을 권장합니다");
      }
    }
    return w;
  }

  // 정리된 값으로 판정하는 공개 함수 (원래 매물을 받음)
  const isResidential = (l) => residentialN(pyNormalize(l).n);
  const isDandok = (l) => dandokN(pyNormalize(l).n);
  const isApartment = (l) => apartmentN(pyNormalize(l).n);

  const R = {
    JIMOK, ZONING, ZONING_GROUPS, BUILDING_USES, TYPES, DEALS, STATUSES, DIRECTIONS, DIRECTION_BASIS,
    DONE_WORDS, LIVE_WORDS, RESIDENTIAL_WORDS, DANDOK_WORDS, APT_WORDS,
    BUILDING_REQUIRED, RESIDENTIAL_REQUIRED, APT_REQUIRED, NUM_KEYS, PHOTO_OK, EXAGGERATION,
    P, DUP_RE, NUM_ISSUE_RE, PRICE_ISSUE_RE, STATUS_ISSUE_RE, MOVE_IN_OK,
    truthy, toNum, asList, strip, pyStr, pyRepr, asciiDigits, statusOf, noKey, normalize: (l) => pyNormalize(l).n,
    hasSinglePrice: (l) => hasSinglePrice(pyNormalize(l).n), isResidential, isDandok, isApartment,
    problems, publishable, blockers, warnings, checkWarnings, splitZoning, maintenanceWon, moveInOk,
    maintenanceNeedsSplit, directionText, regionText, isDone, isSample,
  };
  if (typeof module === "object" && module.exports) module.exports = R;
  if (root) root.GAYA_RULES = R;
})(typeof window !== "undefined" ? window : null);
