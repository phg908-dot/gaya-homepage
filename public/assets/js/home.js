(async function () {
  const G = window.GAYA, el = G.el;
  const $ = (id) => document.getElementById(id);

  let data;
  try {
    data = await G.loadData();
  } catch (e) {
    $("emptyNone").hidden = false;
    $("emptyNoneText").textContent = "매물 정보를 불러오지 못했습니다. 잠시 후 다시 시도하시거나 전화로 문의해 주세요.";
    console.error(e);
    return;
  }
  const { site, listings, videos } = data;
  G.fillOfficeBits(site);
  G.renderFooter(site);
  if (site.office.address) $("naverMapLink").href = "https://map.naver.com/p/search/" + encodeURIComponent(site.office.address);

  const TYPE_ORDER = ["토지", "임야", "전원주택", "농가주택", "단독주택", "펜션", "다가구", "다세대·빌라", "아파트", "상가", "사무실", "공장·창고"];
  const DEALS = ["매매", "전세", "월세", "단기임대"];
  const PAGE = 12;
  const R = (l) => l.region || {};

  // ── 상단 현황 (0인 항목은 숨김)
  const shorts = videos.filter((v) => v.isShort).length;
  const eups = new Set(listings.map((l) => R(l).eupmyeon).filter(Boolean)).size;
  // (배포본은 build.py 가 같은 내용을 미리 넣어 둠 → 덮어쓰기)
  $("stats").replaceChildren(...[[listings.length, "거래 가능 매물"], [videos.length, "매물 영상"], [eups, "읍·면 지역"]]
    .filter(([n]) => n > 0)
    .map(([n, label]) => el("li", null, el("b", { text: String(n) }), el("span", { text: label }))));

  // ── 추천·급매 (매물이 적을 때는 전체 목록과 중복되므로 생략)
  const picks = listings.filter((l) => l.featured || l.urgent)
    .sort((a, b) => (b.urgent - a.urgent) || String(b.updated).localeCompare(String(a.updated))).slice(0, 6);
  if (picks.length && listings.length >= 8) {
    $("featured").hidden = false;
    $("featuredCards").replaceChildren(...picks.map((l) => G.card(l, { idPrefix: "f" })));
  }

  // ── 매물이 하나도 없을 때 (불러오기 실패와 구분)
  if (!listings.length) {
    $("emptyNone").hidden = false;
    $("listTools").hidden = true;
    if (data.failed) $("emptyNoneText").textContent = "매물 정보를 불러오지 못했습니다. 잠시 후 다시 시도하시거나 전화로 문의해 주세요.";
  }
  // 매물이 없는 종류의 빠른 링크는 숨김
  document.querySelectorAll("[data-quick]").forEach((a) => { a.hidden = !listings.some((l) => l.type === a.dataset.quick); });

  // ── 필터 상태
  const state = { q: "", type: "", sido: "", sigungu: "", eup: "", deals: new Set(), price: "", area: "", video: false, fav: false, sort: "new", shown: PAGE };

  const types = [...new Set(listings.map((l) => l.type))].sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, "ko");
  });

  // 종류 칩은 한 번만 만들고, 이후에는 눌림 상태·찜 개수만 갱신 (키보드 포커스 유지)
  function buildCats() {
    if (!listings.length) return;
    const chip = (label, value, count) => el("button", { type: "button", class: "cat", "data-type": value,
      onclick: () => { state.type = value; state.fav = false; state.shown = PAGE; sync(true); } },
      label, el("span", { class: "n", text: String(count) }));
    const favChip = el("button", { type: "button", class: "cat cat-fav", "data-fav": "1",
      onclick: () => { state.fav = !state.fav; state.shown = PAGE; sync(true); } },
      el("span", { "aria-hidden": "true", text: "♥ " }), "찜", el("span", { class: "n", id: "favN", text: "0" }));
    $("cats").replaceChildren(chip("전체", "", listings.length), ...types.map((t) => chip(t, t, listings.filter((l) => l.type === t).length)), favChip);
  }
  function paintCats() {
    document.querySelectorAll("#cats .cat[data-type]").forEach((b) => b.setAttribute("aria-pressed", String(!state.fav && state.type === b.dataset.type)));
    const fc = document.querySelector("#cats .cat-fav");
    if (fc) {
      fc.setAttribute("aria-pressed", String(state.fav));
      $("favN").textContent = String(listings.filter((l) => G.favs().has(l.no)).length);
    }
  }

  DEALS.filter((d) => listings.some((l) => l.deal === d)).forEach((d) => {
    $("fDeal").append(el("button", { type: "button", class: "chip", "data-deal": d, "aria-pressed": "false",
      onclick: (e) => {
        state.deals.has(d) ? state.deals.delete(d) : state.deals.add(d);
        e.currentTarget.setAttribute("aria-pressed", String(state.deals.has(d)));
        state.shown = PAGE;
        sync(true);
      } }, d));
  });

  function fillSelect(sel, values, allLabel, current) {
    sel.replaceChildren(el("option", { value: "", text: allLabel }), ...values.map((v) => el("option", { value: v, text: v })));
    sel.value = values.includes(current) ? current : "";
  }
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  function renderRegions() {
    fillSelect($("fSido"), uniq(listings.map((l) => R(l).sido)), "시/도 전체", state.sido);
    state.sido = $("fSido").value;
    fillSelect($("fSigungu"), uniq(listings.filter((l) => !state.sido || R(l).sido === state.sido).map((l) => R(l).sigungu)), "시/군 전체", state.sigungu);
    state.sigungu = $("fSigungu").value;
    fillSelect($("fEup"), uniq(listings.filter((l) => (!state.sido || R(l).sido === state.sido) && (!state.sigungu || R(l).sigungu === state.sigungu)).map((l) => R(l).eupmyeon)), "읍/면/동 전체", state.eup);
    state.eup = $("fEup").value;
  }

  const inRange = (v, range) => {
    if (!range) return true;
    if (v == null) return false;
    const [lo, hi] = range.split("-").map((x) => (x === "" ? null : Number(x)));
    return (lo == null || v >= lo) && (hi == null || v < hi);
  };

  function haystack(l) {
    const land = l.land || {};
    return [l.no, "no." + l.no, l.title, l.type, l.deal, G.regionText(l.region, true), l.summary, l.description,
      (l.features || []).join(" "), (l.recommendedUse || []).join(" "), land.jimok, land.zoning, land.currentUse, land.road,
      l.urgent ? "급매" : "", l.featured ? "추천" : ""].filter(Boolean).join(" ").toLowerCase();
  }

  // 검색어 정리: "매물번호 1002", "1002번", "#1002", "No.1002" → "1002"
  function words(q) {
    return q.toLowerCase().replace(/매물\s*번호|no\.?(?=\s*\d)|#/g, " ").replace(/(\d{3,6})\s*번/g, "$1").split(/\s+/).filter(Boolean);
  }

  function matches(l) {
    if (state.fav && !G.favs().has(l.no)) return false;
    if (!state.fav && state.type && l.type !== state.type) return false;
    if (state.sido && R(l).sido !== state.sido) return false;
    if (state.sigungu && R(l).sigungu !== state.sigungu) return false;
    if (state.eup && R(l).eupmyeon !== state.eup) return false;
    if (state.deals.size && !state.deals.has(l.deal)) return false;
    if (!inRange(G.basePrice(l), state.price)) return false;
    if (!inRange(G.filterArea(l), state.area)) return false;
    if (state.video && !l.videoIds.length) return false;
    if (state.q) {
      const hay = haystack(l);
      if (!words(state.q).every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  const SORTS = {
    "new": (a, b) => (b.urgent - a.urgent) || (b.featured - a.featured) || String(b.updated).localeCompare(String(a.updated)) || b.no - a.no,
    "price-asc": (a, b) => (G.basePrice(a) ?? Infinity) - (G.basePrice(b) ?? Infinity),
    "price-desc": (a, b) => (G.basePrice(b) ?? -1) - (G.basePrice(a) ?? -1),
    "area-desc": (a, b) => (G.filterArea(b) || 0) - (G.filterArea(a) || 0),
  };

  // ── URL 쿼리와 상태 동기화 (필터 결과를 링크로 공유 가능)
  function readQuery() {
    const p = new URLSearchParams(location.search);
    state.q = p.get("q") || "";
    state.type = p.get("type") || "";
    state.sido = p.get("sido") || "";
    state.sigungu = p.get("sigungu") || "";
    state.eup = p.get("eup") || "";
    (p.get("deal") || "").split(",").filter((d) => DEALS.includes(d)).forEach((d) => state.deals.add(d));
    state.price = p.get("price") || "";
    state.area = p.get("area") || "";
    state.video = p.get("video") === "1";
    state.fav = p.get("fav") === "1";
    state.sort = Object.prototype.hasOwnProperty.call(SORTS, p.get("sort")) ? p.get("sort") : "new";
    const n = parseInt(p.get("n"), 10);
    state.shown = n > PAGE && n < 1000 ? Math.ceil(n / PAGE) * PAGE : PAGE;
    // 지금 매물에 없는 종류·거래유형이 링크에 들어 있으면 무시
    if (state.type && !types.includes(state.type)) state.type = "";
    [...state.deals].forEach((d) => { if (!listings.some((l) => l.deal === d)) state.deals.delete(d); });
  }
  function writeQuery() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.type) p.set("type", state.type);
    if (state.sido) p.set("sido", state.sido);
    if (state.sigungu) p.set("sigungu", state.sigungu);
    if (state.eup) p.set("eup", state.eup);
    if (state.deals.size) p.set("deal", [...state.deals].join(","));
    if (state.price) p.set("price", state.price);
    if (state.area) p.set("area", state.area);
    if (state.video) p.set("video", "1");
    if (state.fav) p.set("fav", "1");
    if (state.sort !== "new") p.set("sort", state.sort);
    if (state.shown > PAGE) p.set("n", String(state.shown));
    const qs = p.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  }

  function activeFilterCount() {
    return [state.sido, state.sigungu, state.eup, state.price, state.area].filter(Boolean).length + state.deals.size + (state.video ? 1 : 0);
  }

  let mapApi = null;
  let lastCount = -1;
  function sync(userAction) {
    renderRegions();
    paintCats();
    const rows = listings.filter(matches).sort(SORTS[state.sort]);
    $("cards").replaceChildren(...rows.slice(0, state.shown).map(G.card));
    $("count").textContent = rows.length + "건";
    const left = rows.length - state.shown;
    $("more").hidden = left <= 0;
    $("more").textContent = `매물 더 보기 (${left}건 남음)`;
    const noMatch = listings.length > 0 && rows.length === 0;
    $("empty").hidden = !noMatch;
    $("emptyFav").hidden = !(state.fav && noMatch);
    const n = activeFilterCount();
    $("filterToggle").textContent = n ? `필터 (${n}개 적용)` : "필터";
    $("filterDone").textContent = `매물 ${rows.length}건 보기`;
    $("qInfo").hidden = !state.q;
    $("qInfoText").textContent = state.q ? `"${state.q}" 검색 결과` : "";
    if (mapApi) mapApi.update(rows);
    writeQuery();
    if (userAction && rows.length !== lastCount) G.announce(rows.length ? `매물 ${rows.length}건` : "조건에 맞는 매물이 없습니다");
    lastCount = rows.length;
  }

  // ── 모바일 필터 시트
  const outside = () => [document.querySelector(".top"), document.querySelector(".hero"), $("listings"), document.querySelector(".contact-panel"),
    ...document.querySelectorAll("#main > section:not(.layout), .foot, .mbar")].filter(Boolean);
  function openSheet(open) {
    document.body.classList.toggle("filter-open", open);
    $("filterToggle").setAttribute("aria-expanded", String(open));
    if (window.matchMedia("(max-width: 899px)").matches) outside().forEach((n) => { n.inert = open; });
    if (open) $("fSido").focus();
  }

  function bindControls() {
    $("heroQ").value = state.q;
    $("heroSearch").addEventListener("submit", (e) => {
      e.preventDefault();
      state.q = $("heroQ").value.trim();
      state.shown = PAGE;
      sync(true);
      $("listings").scrollIntoView({ behavior: "smooth" });
      $("listings").focus({ preventScroll: true });
    });
    $("heroQ").addEventListener("search", () => { state.q = $("heroQ").value.trim(); sync(true); });
    $("qClear").addEventListener("click", () => { state.q = ""; $("heroQ").value = ""; sync(true); $("heroQ").focus(); });
    document.querySelectorAll("[data-quick]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      state.type = a.dataset.quick; state.fav = false; state.shown = PAGE;
      sync(true);
      $("listings").scrollIntoView({ behavior: "smooth" });
      const pressed = document.querySelector(`#cats .cat[aria-pressed="true"]`);
      (pressed || $("listings")).focus({ preventScroll: true });
    }));
    $("fSido").addEventListener("change", (e) => { state.sido = e.target.value; state.sigungu = ""; state.eup = ""; state.shown = PAGE; sync(true); });
    $("fSigungu").addEventListener("change", (e) => { state.sigungu = e.target.value; state.eup = ""; state.shown = PAGE; sync(true); });
    $("fEup").addEventListener("change", (e) => { state.eup = e.target.value; state.shown = PAGE; sync(true); });
    $("fPrice").value = state.price;
    $("fArea").value = state.area;
    $("fVideo").checked = state.video;
    $("sort").value = state.sort;
    $("fPrice").addEventListener("change", (e) => { state.price = e.target.value; state.shown = PAGE; sync(true); });
    $("fArea").addEventListener("change", (e) => { state.area = e.target.value; state.shown = PAGE; sync(true); });
    $("fVideo").addEventListener("change", (e) => { state.video = e.target.checked; state.shown = PAGE; sync(true); });
    $("sort").addEventListener("change", (e) => { state.sort = e.target.value; sync(true); });
    $("more").addEventListener("click", () => {
      const first = state.shown;
      state.shown += PAGE;
      sync(false);
      const next = $("cards").children[first];
      if (next) next.querySelector(".card-link").focus();
    });
    document.querySelectorAll("#fDeal .chip").forEach((c) => c.setAttribute("aria-pressed", String(state.deals.has(c.dataset.deal))));
    $("filter").addEventListener("reset", () => {
      Object.assign(state, { q: "", type: "", sido: "", sigungu: "", eup: "", price: "", area: "", video: false, fav: false, shown: PAGE });
      state.deals.clear();
      $("heroQ").value = "";
      document.querySelectorAll("#fDeal .chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
      setTimeout(() => sync(true), 0);
    });
    $("filterToggle").addEventListener("click", () => openSheet(!document.body.classList.contains("filter-open")));
    $("filterClose").addEventListener("click", () => { openSheet(false); $("filterToggle").focus(); });
    $("filterDone").addEventListener("click", () => {
      openSheet(false);
      $("listings").scrollIntoView({ behavior: "smooth" });
      $("listings").focus({ preventScroll: true });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.body.classList.contains("filter-open")) { openSheet(false); $("filterToggle").focus(); }
    });
    // 찜 화면에서 찜을 해제하면 목록이 바뀌므로 포커스를 다음 카드(없으면 찜 칩)로 옮김
    document.addEventListener("gaya:favs", () => {
      if (!state.fav) { paintCats(); return; }
      const cards = [...$("cards").children];
      const idx = cards.findIndex((c) => c.contains(document.activeElement));
      sync(true);
      const after = $("cards").children[Math.max(0, Math.min(idx, $("cards").children.length - 1))];
      (after ? after.querySelector(".card-link") : document.querySelector("#cats .cat-fav")).focus();
    });
  }

  // ── 최신 영상
  function renderVideos() {
    const list = videos.slice(0, 8);
    $("videoEmpty").hidden = list.length > 0;
    $("videoGrid").replaceChildren(...list.map((v) => el("article", { class: "vcard" },
      G.videoFacade(v.id, v.title, { short: v.isShort }),
      el("div", { class: "vbody" },
        el("h3", { text: v.title }),
        el("p", { class: "muted small", text: G.fmtDate(v.published) + (v.isShort ? " · 쇼츠" : "") }),
        ...[...v.listingNos].map((no) => el("a", { class: "vlink", href: G.listingUrl(no), text: `매물 No.${no} 보기 →` }))))));
  }

  // ── 지도 (카카오/네이버 키와 좌표가 있을 때만 표시)
  async function initMap() {
    const hasPos = (p) => p && p.lat != null && p.lng != null;
    const withPos = listings.filter(hasPos);
    if (!withPos.length && !hasPos(site.office)) return;
    const M = await G.loadMap(site);
    if (!M) return;
    $("mapSec").hidden = false;
    const c = withPos.length ? withPos : [site.office];
    const map = M.createMap($("map"), c.reduce((s, p) => s + p.lat, 0) / c.length, c.reduce((s, p) => s + p.lng, 0) / c.length);
    M.fit(map, c);
    let markers = [];
    mapApi = {
      update(rows) {
        markers.forEach(M.removeMarker);
        markers = rows.filter(hasPos).map((l) => {
          const m = M.addMarker(map, l.lat, l.lng, l.title, () => M.openPopup(map, m,
            el("a", { class: "map-pop", href: G.listingUrl(l.no) },
              el("b", { text: `No.${l.no} ${l.deal} ${l.type}` }),
              el("span", { text: G.regionText(l.region, true) }),
              el("span", { text: G.specLine(l) }),
              el("span", { class: "price", text: G.priceText(l) }))));
          return m;
        });
        if (hasPos(site.office)) markers.push(M.addMarker(map, site.office.lat, site.office.lng, site.office.name + " (사무소)"));
      },
    };
    sync(false);
  }

  readQuery();
  buildCats();
  bindControls();
  sync(false);
  renderVideos();
  // 매물을 보고 '뒤로' 왔을 때 보던 위치로 (목록이 늦게 그려져 브라우저가 복원하지 못하는 경우 대비)
  const SCROLL_KEY = "gaya.scroll:" + location.pathname + location.search;
  window.addEventListener("pagehide", () => { try { sessionStorage.setItem("gaya.scroll:" + location.pathname + location.search, String(window.scrollY)); } catch (_) { /* 무시 */ } });
  let restored = false;
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    const y = Number(sessionStorage.getItem(SCROLL_KEY));
    if (nav && (nav.type === "back_forward" || nav.type === "reload") && y > 0) { window.scrollTo(0, y); restored = true; }
  } catch (_) { /* 무시 */ }
  // 다른 페이지의 '매물' 링크(#listings)로 들어온 경우, 내용이 채워진 뒤 위치를 다시 맞춤
  if (!restored && location.hash === "#listings") requestAnimationFrame(() => $("listings").scrollIntoView());
  initMap();
})();
