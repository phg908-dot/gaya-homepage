// 공통 유틸 — 모든 페이지에서 사용
(function () {
  const ROOT = document.body.dataset.root || "./";

  async function getJSON(path) {
    const res = await fetch(ROOT + path, { cache: "no-cache" });
    if (!res.ok) throw new Error(path + " " + res.status);
    return res.json();
  }

  // 유튜브 영상 ID: ID 그대로 또는 watch?v= / youtu.be / shorts / embed 주소에서 추출
  function ytId(x) {
    x = String(x || "").trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(x)) return x;
    const m = /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/.exec(x);
    return m ? m[1] : null;
  }
  const asList = (v) => (Array.isArray(v) ? v.map(String) : v ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : []);
  const DONE = new Set(["계약완료", "거래완료", "완료", "판매완료", "매매완료", "임대완료"]);
  const LIVE = new Set(["", "거래중", "판매중", "광고중"]);

  // 각 파일을 따로 불러와 하나가 실패해도 나머지는 동작 (site.json 은 필수)
  async function loadData() {
    const [site, listings, videos, blog] = await Promise.all([
      getJSON("data/site.json"),
      getJSON("data/listings.json").catch((e) => { console.error(e); return null; }),
      getJSON("data/videos.json").catch(() => null),
      getJSON("data/blog.json").catch(() => null),
    ]);
    const hidden = new Set(asList(site.hiddenVideos).map(ytId).filter(Boolean));
    if (site.policy && site.policy.directionBasis) directionBasis = String(site.policy.directionBasis);
    // 미리보기에서도 배포본과 같게: 계약완료·알 수 없는 상태 제외, 번호·목록 형식 보정
    const live = (Array.isArray(listings) ? listings : []).map((l) => Object.assign({}, l, {
      no: Number(l.no),
      status: String(l.status || "").replace(/\s+/g, ""),
      videoIds: asList(l.videoIds).map(ytId).filter((id) => id && !hidden.has(id)),
      photos: asList(l.photos).filter((p) => /^images\/[^<>"'\\:?#]+\.(jpe?g|png|webp|gif)$/i.test(p) && !p.includes("..")),
      features: asList(l.features), recommendedUse: asList(l.recommendedUse),
    })).filter((l) => Number.isInteger(l.no) && l.no > 0 && LIVE.has(l.status) && !DONE.has(l.status));
    // 매물번호를 언급하는 영상은 그 번호가 모두 게시 중인 매물일 때만 표시 (계약완료 매물 영상 노출 방지)
    const liveNos = new Set(live.map((l) => l.no));
    const excludedNos = new Set((Array.isArray(listings) ? listings : []).map((l) => Number(l.no)).filter((n) => Number.isInteger(n) && !liveNos.has(n)));
    const closed = new Set(asList(site.closedListingNos).map(Number));
    const blocked = new Set((Array.isArray(listings) ? listings : []).filter((l) => !liveNos.has(Number(l.no))).flatMap((l) => asList(l.videoIds).map(ytId)));
    const yt = site.youtube || {};
    const forceIn = new Set(asList(yt.listingVideos).map(ytId).filter(Boolean));
    const forceOut = new Set(asList(yt.notListingVideos).map(ytId).filter(Boolean));
    const linked = new Set(live.flatMap((l) => l.videoIds));
    const vids = ((videos && Array.isArray(videos.videos)) ? videos.videos : []).filter((v) => {
      if (!v || ytId(v.id) !== v.id || hidden.has(v.id) || blocked.has(v.id)) return false;
      if (v.isShort !== false || !isListingVideo(v, linked, forceIn, forceOut)) return false;  // 본편(쇼츠 제외) 매물 영상만
      if (!forceIn.has(v.id) && !linked.has(v.id) && !videoAgeOk(v, yt.maxAgeMonths ?? 12)) return false;  // 오래된 영상 제외
      // 홈페이지 목록에서 게시하지 않는 번호(계약완료 등)를 언급한 영상은 제외 — 목록에 없는 번호는 그대로
      return citedNumbers(v).every((n) => !closed.has(n) && !excludedNos.has(n));
    });
    linkVideos(live, vids);
    const posts = blog && Array.isArray(blog.posts) ? blog.posts.filter((p) => p && p.title && /^https:\/\/blog\.naver\.com\//.test(String(p.link || ""))) : [];
    return { site, listings: live, videos: vids, blog: { posts }, failed: !Array.isArray(listings) };
  }

  // 영상 ↔ 매물 연결: listings[].videoIds + 영상 제목/설명의 "No.1234", "매물번호 1234, 1235"
  // (영단어 속 'no'는 제외 — 구형 브라우저 호환을 위해 lookbehind 대신 앞 글자를 함께 매칭)
  const NO_RE = /(^|[^A-Za-z])(?:No\.?|매물\s*번호)\s*[:#.]?\s*(\d{3,6}(?:\s*[,·/]\s*\d{3,6})*)/gi;
  // 매물 영상 판별 (scripts/build.py is_listing_video 와 같은 규칙):
  // 제목에 면적(㎡·평)이 있고 가격·매물 해시태그·사무소 서명 중 하나가 함께 있으면 매물 영상
  const AREA_RE = /\d[\d,]*(?:\.\d+)?\s*(?:㎡|m²|평)/;
  const PRICE_RE = /\d+\s*억|\d[\d,]*\s*만\s*원|\d+\s*천(?!\s*원)/;
  const TAG_RE = /#\S*(?:토지|전원주택|임야|농가|매매|전세|월세|상가|쉼터)|가야공인중개사/;
  const DEAL_WORD_RE = /매매|매물|급매|분양|임대|전세|월세/;
  const PROP_WORD_RE = /전원주택|토지|대지|임야|주택지|농막|주말농장|부지|단독주택|농가주택|상가|창고|공장/;
  const MARKER_RE = /[◑▶■●]\s*(?:소재지|매물\s*번호|매물\s*종류)/;
  const DONE_RE = /(?:매매|계약|거래|판매|매도|임대)\s*완료/;
  function isListingVideo(v, linked, forceIn, forceOut) {
    if (forceOut.has(v.id)) return false;
    if (forceIn.has(v.id) || linked.has(v.id)) return true;
    const t = v.title || "", d = v.description || "";
    if (DONE_RE.test(t) || DONE_RE.test(d.slice(0, 300))) return false;
    if (citedNumbers(v).length || MARKER_RE.test(d)) return true;
    if (DEAL_WORD_RE.test(t) && PROP_WORD_RE.test(t)) return true;
    return AREA_RE.test(t) && (PRICE_RE.test(t) || TAG_RE.test(t));
  }
  function videoAgeOk(v, maxMonths) {
    if (!maxMonths) return true;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.published || "");
    if (!m) return true;
    const now = new Date();
    return (now.getFullYear() - Number(m[1])) * 12 + (now.getMonth() + 1 - Number(m[2])) <= Number(maxMonths);
  }

  function citedNumbers(v) {
    const out = [];
    const text = (v.title || "") + "\n" + (v.description || "");
    for (const m of text.matchAll(NO_RE)) (m[2].match(/\d{3,6}/g) || []).forEach((n) => out.push(Number(n)));
    return out;
  }
  function linkVideos(listings, videos) {
    const byNo = new Map(listings.map((l) => [l.no, l]));
    videos.forEach((v) => {
      v.listingNos = new Set();
      const text = (v.title || "") + "\n" + (v.description || "");
      for (const m of text.matchAll(NO_RE)) {
        (m[2].match(/\d{3,6}/g) || []).map(Number).forEach((no) => { if (byNo.has(no)) v.listingNos.add(no); });
      }
    });
    listings.forEach((l) => {
      l.videoIds = l.videoIds || [];
      videos.forEach((v) => {
        if (v.listingNos.has(l.no) && !l.videoIds.includes(v.id)) l.videoIds.push(v.id);
        if (l.videoIds.includes(v.id)) v.listingNos.add(l.no);
      });
    });
  }

  // 금액: 만원 단위 정수 → "3억 2,000만원"
  function money(manwon) {
    if (manwon == null || manwon === "") return "";
    const n = Number(manwon);
    const eok = Math.floor(n / 10000);
    const rest = n % 10000;
    if (eok && rest) return `${eok}억\u00a0${rest.toLocaleString("ko-KR")}만원`;
    if (eok) return `${eok}억원`;
    return `${rest.toLocaleString("ko-KR")}만원`;
  }

  function priceText(l) {
    if (l.deal === "월세" || l.deal === "단기임대") {
      if (l.deposit == null && l.monthly == null) return "가격 문의";
      return `보증금\u00a0${money(l.deposit || 0)} / 월\u00a0${money(l.monthly || 0)}`;
    }
    if (l.deal === "전세") return l.deposit != null ? money(l.deposit) : l.price != null ? money(l.price) : "가격 문의";
    return l.price != null ? money(l.price) : "가격 문의";
  }

  // 필터·정렬용 기준 금액(만원)
  function basePrice(l) {
    if (l.deal === "매매") return l.price;
    return l.deposit != null ? l.deposit : l.price;
  }

  const PY = 0.3025;
  function areaText(m2) {
    if (m2 == null || m2 === "") return "";
    const n = Number(m2);
    return `${n.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}㎡\u00a0(${(n * PY).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}평)`;
  }

  // 대표 면적: 건물이 있으면 건물(전용/연)면적, 없으면 토지면적
  function mainArea(l) {
    if (l.building && l.building.area) return { label: "건물", m2: l.building.area };
    if (l.land && l.land.area) return { label: "토지", m2: l.land.area };
    return null;
  }

  // 면적 필터·정렬 기준: 토지가 있으면 토지(대지) 면적, 없으면 건물 전용면적
  function filterArea(l) {
    if (l.land && l.land.area) return Number(l.land.area);
    if (l.building && l.building.area) return Number(l.building.area);
    return null;
  }

  // 날짜 표시: 2026-10-15T… → 2026. 10. 15.
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    return m ? `${m[1]}. ${Number(m[2])}. ${Number(m[3])}.` : "";
  }

  // 스크린리더 상태 알림 (화면에는 보이지 않음)
  function announce(text) {
    let n = document.getElementById("srStatus");
    if (!n) {
      n = document.createElement("p");
      n.id = "srStatus"; n.className = "sr"; n.setAttribute("role", "status");
      document.body.append(n);
    }
    n.textContent = "";
    setTimeout(() => { n.textContent = text; }, 60);
  }

  // 소재지: withRi 이면 리까지. 지번은 비공개가 원칙 — showJibun 이 true 인 매물만 표시
  function regionText(r, withRi) {
    if (!r) return "";
    const jibun = withRi && r.jibun && r.showJibun === true ? r.jibun : "";
    return [r.sido, r.sigungu, r.eupmyeon, withRi ? r.ri : "", jibun].filter(Boolean).join(" ");
  }

  // 방향: 건물이 바라보는 방향. 기준이 없으면 '(건물 정면 기준)'을 붙임
  let directionBasis = "건물 정면 기준";
  function directionText(d) {
    d = String(d || "").trim();
    return !d || d.includes("기준") ? d : `${d}(${directionBasis})`;
  }

  // 건축물 광고 명시사항 요약 (총층수·사용승인일·방향·주차·입주가능일·관리비)
  function buildingLine(l) {
    const b = l.building;
    if (!b) return "";
    return [
      b.totalFloors ? `총\u00a0${b.totalFloors}층${b.floor ? `(${b.floor})` : ""}` : "",
      b.approvalDate ? `${String(b.approvalDate).slice(0, 7).replace("-", ".")}\u00a0사용승인` : "",
      directionText(b.direction),
      b.parking != null ? `주차\u00a0${b.parking}대` : "",
      b.moveIn ? `입주\u00a0${b.moveIn}` : "",
      b.maintenance ? `관리비\u00a0${b.maintenance}` : "",
    ].filter(Boolean).join(" · ");
  }

  const thumb = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
  const listingUrl = (no) => `${ROOT}listing/${no}.html`;

  // 카드용 핵심 정보 한 줄: 토지 → 지목·용도지역·면적, 건물 → 전용면적·방/욕실
  function specLine(l) {
    const b = l.building, land = l.land;
    const parts = [];
    if (b && b.area) {
      if (land && land.area) parts.push(`대지\u00a0${areaText(land.area)}`);
      parts.push(`전용\u00a0${areaText(b.area)}`);
      const rb = [b.rooms != null ? `방\u00a0${b.rooms}` : "", b.baths != null ? `욕실\u00a0${b.baths}` : ""].filter(Boolean).join("\u00a0·\u00a0");
      if (rb) parts.push(rb);
    } else if (land) {
      if (land.jimok) parts.push(land.jimok);
      if (land.zoning) parts.push(land.zoning);
      if (land.area) parts.push(areaText(land.area));
    }
    return parts.join(" · ");
  }

  // 찜한 매물 (이 브라우저에만 저장)
  // 메모리의 목록이 기준이고, 저장소(localStorage)는 가능한 경우에만 저장 (사생활 보호 모드 등에서도 동작)
  const FAV_KEY = "gaya.favs";
  let favSet = null;
  function favs() {
    if (!favSet) {
      try { favSet = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]").map(Number)); } catch (_) { favSet = new Set(); }
    }
    return favSet;
  }
  function toggleFav(no) {
    const s = favs();
    s.has(no) ? s.delete(no) : s.add(no);
    try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch (_) { /* 저장 불가 환경 */ }
    document.querySelectorAll(`.fav[data-no="${no}"]`).forEach(paintFav);
    document.dispatchEvent(new CustomEvent("gaya:favs", { detail: s }));
    return s.has(no);
  }
  function paintFav(b) {
    const on = favs().has(Number(b.dataset.no));
    b.setAttribute("aria-pressed", String(on));
    b.firstChild.textContent = on ? "♥" : "♡";
  }
  function favButton(no, label) {
    const b = el("button", { type: "button", class: "fav", "data-no": no, "aria-label": `${label} 찜하기` }, el("span", { "aria-hidden": "true" }));
    paintFav(b);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFav(no);
    });
    return b;
  }

  // ' · '로 구분된 항목을 각각 줄바꿈 없는 묶음으로 (숫자와 ㎡ 사이에서 끊기지 않게)
  function nwParts(text) {
    const out = [];
    text.split(" · ").forEach((t, i) => { if (i) out.push(" · "); out.push(el("span", { class: "nw", text: t })); });
    return out;
  }

  // 매물 카드 (목록·관련 매물 공용)
  function card(l, opts) {
    const idPrefix = opts && typeof opts === "object" && opts.idPrefix ? opts.idPrefix : "l";
    const img = l.photos && l.photos[0] ? ROOT + l.photos[0] : l.videoIds && l.videoIds[0] ? thumb(l.videoIds[0]) : null;
    const spec = specLine(l);
    return el("article", { class: "card", id: idPrefix + l.no },
      el("a", { class: "card-link", href: listingUrl(l.no), "aria-label": `No.${l.no} ${l.title} 상세보기` }),
      el("div", { class: "card-media" },
        img ? el("img", { src: img, alt: "", loading: "lazy", decoding: "async",
          onerror: (e) => e.currentTarget.replaceWith(el("div", { class: "ph", "aria-hidden": "true" }, el("span", { text: l.type }))) })
          : el("div", { class: "ph", "aria-hidden": "true" }, el("span", { text: l.type })),
        el("div", { class: "badges" },
          l.urgent ? el("span", { class: "b b-urgent", text: "급매" }) : null,
          l.featured ? el("span", { class: "b b-feat", text: "추천" }) : null,
          l.videoIds && l.videoIds.length ? el("span", { class: "b b-video", text: "▶ 영상" }) : null,
          l.building && l.building.violation ? el("span", { class: "b b-viol", text: "위반건축물" }) : null),
        el("span", { class: "no", text: "No." + l.no }),
        favButton(l.no, l.title)),
      el("div", { class: "card-body" },
        el("p", { class: "meta" }, el("span", { class: "deal deal-" + l.deal, text: l.deal }), " ", l.type, " · ", regionText(l.region, true)),
        el("h3", { text: l.title }),
        el("p", { class: "price", text: priceText(l) }),
        spec ? el("p", { class: "spec-line" }, nwParts(spec)) : null,
        l.building ? el("p", { class: "spec-line2" }, nwParts(buildingLine(l))) : null,
        l.summary ? el("p", { class: "sum", text: l.summary }) : null));
  }

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c);
    return e;
  }

  // 영상: 썸네일을 먼저 보여주고 클릭 시 iframe 로드 (페이지 속도 개선)
  function videoFacade(id, title, opts) {
    const short = opts && opts.short;
    const box = el("div", { class: "yt" + (short ? " yt-short" : "") });
    const btn = el("button", { type: "button", class: "yt-btn", "aria-label": (title || "영상") + " 재생" },
      el("img", { src: thumb(id), alt: "", loading: "lazy", onerror: (e) => { e.currentTarget.style.visibility = "hidden"; } }),
      el("span", { class: "yt-play", "aria-hidden": "true" }));
    btn.addEventListener("click", () => {
      const f = el("iframe", {
        src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&playsinline=1`,
        title: title || "YouTube 영상",
        allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
        allowfullscreen: true,
      });
      box.replaceChildren(f);
      f.focus();
    }, { once: true });
    box.append(btn);
    return box;
  }

  // 중개사무소 명시사항(공인중개사법 제18조의2) — 모든 페이지 하단에 자동 표시
  function officeLines(o) {
    const rows = [
      ["상호", o.name],
      ["대표", o.ceo],
      ["등록번호", o.regNo],
      ["소재지", o.address],
      ["연락처", [o.tel, o.mobile].filter(Boolean).join(" / ")],
    ];
    return rows;
  }

  function renderFooter(site) {
    const f = document.getElementById("officeInfo");
    if (!f) return;
    const o = site.office;
    f.replaceChildren(...officeLines(o).map(([k, v]) =>
      el("span", null, el("b", { text: k }), " ", v ? v : el("em", { class: "missing", text: "입력 필요" }))));
    const missing = officeLines(o).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      document.body.prepend(el("div", { class: "notice", role: "status",
        text: `사무소 명시사항(${missing.join(", ")})이 비어 있습니다. data/site.json을 채운 뒤 공개하세요.` }));
    }
  }

  function fillOfficeBits(site) {
    const o = site.office;
    const digits = (s) => String(s || "").replace(/[^0-9+]/g, "");
    document.querySelectorAll("[data-office]").forEach((n) => {
      const key = n.dataset.office;
      const keep = n.hasAttribute("data-keep");
      if (key === "telLink") {
        n.href = "tel:" + digits(o.tel);
        if (!keep) n.textContent = o.tel;
      } else if (key === "mobileLink") {
        if (!o.mobile) { n.hidden = true; return; }
        n.href = "tel:" + digits(o.mobile);
        n.hidden = false;
        if (!keep) n.textContent = o.mobile;
      } else if (key === "smsLink") {
        const to = digits(o.mobile || o.tel);
        n.href = `sms:${to}${n.dataset.body ? "?&body=" + encodeURIComponent(n.dataset.body) : ""}`;
      } else if (key === "address" && o.address) {
        n.textContent = o.addressNote && !keep ? `${o.address} (${o.addressNote})` : o.address;
      } else if (o[key]) n.textContent = o[key];
    });
    // 카카오톡 채널이 없으면: data-kakao="sms" 는 문자 문의 버튼으로 바꾸고, 나머지는 숨김
    let kakao = String(o.kakaoChannel || "").trim();
    if (/^(pf|open)\.kakao\.com\//.test(kakao)) kakao = "https://" + kakao;
    if (!/^https:\/\/(pf|open)\.kakao\.com\//.test(kakao)) kakao = "";
    document.querySelectorAll("[data-kakao]").forEach((n) => {
      if (kakao) { n.href = kakao; return; }
      if (n.dataset.kakao === "sms") {
        n.href = `sms:${digits(o.mobile || o.tel)}?&body=${encodeURIComponent(n.dataset.body || "[가야공인중개사] 문의드립니다.")}`;
        n.removeAttribute("target");
        n.textContent = "문자 문의";
      } else n.hidden = true;
    });
    const h = String((site.youtube || {}).handle || "").trim();
    document.querySelectorAll("[data-youtube]").forEach((n) => {
      if (!h) { n.hidden = true; return; }
      n.href = "https://www.youtube.com/" + (h.startsWith("@") ? h : "@" + h);
    });
    const blogUrl = String((site.blog && site.blog.url) || "").trim();
    document.querySelectorAll("[data-blog]").forEach((n) => {
      if (blogUrl) n.href = blogUrl;
    });
    const ig = String((site.instagram && (site.instagram.url || site.instagram.handle)) || "").trim();
    document.querySelectorAll("[data-instagram]").forEach((n) => {
      if (!ig) return;
      n.href = ig.startsWith("http") ? ig : "https://www.instagram.com/" + ig.replace(/^@/, "") + "/";
    });
    const y = document.getElementById("year");
    if (y) y.textContent = new Date().getFullYear();
  }

  // ── 지도: 카카오맵(appKey) 우선, 없으면 네이버 지도(keyId). 둘 다 없으면 null
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.append(s);
    });
  }

  function kakaoAdapter(km) {
    return {
      provider: "kakao",
      createMap: (node, lat, lng) => new km.Map(node, { center: new km.LatLng(lat, lng), level: 8 }),
      addMarker(map, lat, lng, title, onClick) {
        const m = new km.Marker({ map, position: new km.LatLng(lat, lng), title });
        if (onClick) km.event.addListener(m, "click", onClick);
        return m;
      },
      removeMarker: (m) => m.setMap(null),
      openPopup(map, marker, node) {
        if (this._pop) this._pop.setMap(null);
        this._pop = new km.CustomOverlay({ map, position: marker.getPosition(), content: node, yAnchor: 1.45 });
      },
      fit(map, pts) {
        if (pts.length < 2) return;
        const b = new km.LatLngBounds();
        pts.forEach((p) => b.extend(new km.LatLng(p.lat, p.lng)));
        map.setBounds(b);
      },
    };
  }

  function naverAdapter(nm) {
    return {
      provider: "naver",
      createMap: (node, lat, lng) => new nm.Map(node, { center: new nm.LatLng(lat, lng), zoom: 12, mapTypeControl: true }),
      addMarker(map, lat, lng, title, onClick) {
        const m = new nm.Marker({ map, position: new nm.LatLng(lat, lng), title });
        if (onClick) nm.Event.addListener(m, "click", onClick);
        return m;
      },
      removeMarker: (m) => m.setMap(null),
      openPopup(map, marker, node) {
        this._info = this._info || new nm.InfoWindow({ borderWidth: 0, backgroundColor: "transparent", disableAnchor: true });
        this._info.setContent(node);
        this._info.open(map, marker);
      },
      fit(map, pts) {
        if (pts.length < 2) return;
        const b = new nm.LatLngBounds(new nm.LatLng(pts[0].lat, pts[0].lng), new nm.LatLng(pts[0].lat, pts[0].lng));
        pts.forEach((p) => b.extend(new nm.LatLng(p.lat, p.lng)));
        map.fitBounds(b);
      },
    };
  }

  let mapPromise = null;
  function loadMap(site) {
    if (mapPromise) return mapPromise;
    const kakaoKey = site.kakaoMap && site.kakaoMap.appKey;
    const naverKey = site.naverMap && site.naverMap.keyId;
    mapPromise = (async () => {
      try {
        if (kakaoKey) {
          await loadScript(`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(kakaoKey)}&autoload=false`);
          await new Promise((r) => window.kakao.maps.load(r));
          return kakaoAdapter(window.kakao.maps);
        }
        if (naverKey) {
          let failed = false;
          window.navermap_authFailure = () => { failed = true; console.error("네이버 지도 인증 실패: Web 서비스 URL 등록을 확인하세요."); };
          await loadScript(`https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(naverKey)}`);
          return failed || !(window.naver && window.naver.maps) ? null : naverAdapter(window.naver.maps);
        }
      } catch (e) {
        console.error("지도 로드 실패", e);
      }
      return null;
    })();
    return mapPromise;
  }

  window.GAYA = { ROOT, loadData, money, priceText, basePrice, areaText, mainArea, filterArea, regionText, thumb, listingUrl, el, videoFacade, renderFooter, fillOfficeBits, loadMap, specLine, card, favs, toggleFav, fmtDate, announce, ytId, buildingLine, directionText };
})();
