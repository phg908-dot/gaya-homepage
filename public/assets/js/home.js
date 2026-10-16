// 첫 화면: 큰 종류 버튼, 매물이 없으면 현장 영상을 매물처럼 보여 준다.
(async function () {
  const G = window.GAYA, el = G.el;
  const $ = (id) => document.getElementById(id);
  const CATS = ["", "토지", "전원주택", "농가주택"];
  const PAGE = 12;

  let data;
  try {
    data = await G.loadData();
  } catch (e) {
    $("emptyNone").hidden = false;
    $("emptyNoneText").textContent = "매물 정보를 불러오지 못했습니다. 잠시 후 다시 전화해 주세요.";
    console.error(e);
    return;
  }
  const { site, listings, videos } = data;
  const blog = data.blog || { posts: [] };
  G.fillOfficeBits(site);
  G.renderFooter(site);
  if (site.office.address) {
    const map = $("naverMapLink");
    if (map) map.href = "https://map.naver.com/p/search/" + encodeURIComponent(site.office.address);
  }

  const useVideos = listings.length === 0 && videos.length > 0;
  if (useVideos) {
    $("listHeading").textContent = "매물 영상";
    $("listNote").textContent = "등록된 매물 글이 없으면, 유튜브에 올린 현장 영상을 매물로 보여 드립니다. 그림을 누르면 영상이 열립니다.";
    $("videos").hidden = true;
  } else if (!listings.length) {
    $("emptyNone").hidden = false;
    if (data.failed) $("emptyNoneText").textContent = "매물 정보를 불러오지 못했습니다. 잠시 후 다시 전화해 주세요.";
  }

  const eups = new Set(listings.map((l) => (l.region || {}).eupmyeon).filter(Boolean)).size;
  const statItems = useVideos
    ? [[videos.length, "매물 영상"]]
    : [[listings.length, "거래 가능 매물"], [videos.length, "매물 영상"], [eups, "읍·면 지역"]];
  $("stats").replaceChildren(...statItems.filter(([n]) => n > 0).map(([n, label]) =>
    el("li", null, el("b", { text: String(n) }), el("span", { text: label }))));

  const state = { q: "", type: "", shown: PAGE };

  // 제목으로 종류를 정한다. #양평전원주택 같은 해시태그와 설명의 대지·농지 언급은
  // 집을 토지로, 전원주택지(땅)를 집으로 바꾸지 않는다. build.py video_category 와 같다.
  function categoryFrom(text) {
    const t = String(text || "").replace(/#[^\s#]+/g, " ");
    if (/농가\s*주택(?!지)/.test(t)) return "농가주택";
    if (/단독주택|건평|\d+\s*층/.test(t)) return "전원주택";
    if (/토지|대지|임야|주택지|농지|주말농장|전원주택지/.test(t)) return "토지";
    if (/전원주택(?!지)/.test(t)) return "전원주택";
    return "";
  }
  function videoCategory(v) {
    return categoryFrom(v.title) || categoryFrom(String(v.description || "").slice(0, 300));
  }

  function haystack(l) {
    const land = l.land || {};
    return [l.no, "no." + l.no, l.title, l.type, l.deal, G.regionText(l.region, true), l.summary, l.description,
      (l.features || []).join(" "), (l.recommendedUse || []).join(" "), land.jimok, land.zoning, land.currentUse, land.road,
      l.urgent ? "급매" : "", l.featured ? "추천" : ""].filter(Boolean).join(" ").toLowerCase();
  }
  function words(q) {
    return q.toLowerCase().replace(/매물\s*번호|no\.?(?=\s*\d)|#/g, " ").replace(/(\d{3,6})\s*번/g, "$1").split(/\s+/).filter(Boolean);
  }
  function textHit(text, q) {
    if (!q) return true;
    const hay = String(text || "").toLowerCase();
    return words(q).every((w) => hay.includes(w));
  }

  function matchesListing(l) {
    if (state.type && l.type !== state.type) return false;
    return textHit(haystack(l), state.q);
  }
  function matchesVideo(v) {
    if (state.type && videoCategory(v) !== state.type) return false;
    return textHit((v.title || "") + " " + (v.description || ""), state.q);
  }

  function readQuery() {
    const p = new URLSearchParams(location.search);
    state.q = p.get("q") || "";
    state.type = p.get("type") || "";
    if (!CATS.includes(state.type)) state.type = "";
    const n = parseInt(p.get("n"), 10);
    state.shown = n > PAGE && n < 1000 ? Math.ceil(n / PAGE) * PAGE : PAGE;
  }
  function writeQuery() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.type) p.set("type", state.type);
    if (state.shown > PAGE) p.set("n", String(state.shown));
    const qs = p.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  }

  function videoCard(v) {
    const cat = videoCategory(v);
    const watch = "https://www.youtube.com/watch?v=" + encodeURIComponent(v.id);
    return el("article", { class: "card video-listing", id: "v" + v.id },
      el("a", { class: "card-link", href: watch, target: "_blank", rel: "noopener", "aria-label": (v.title || "영상") + " 영상 보기" }),
      el("div", { class: "card-media" },
        el("img", { src: G.thumb(v.id), alt: "", loading: "lazy", decoding: "async" }),
        el("span", { class: "yt-play", "aria-hidden": "true" })),
      el("div", { class: "card-body" },
        el("p", { class: "meta" }, [cat, G.fmtDate(v.published)].filter(Boolean).join(" · ")),
        el("h3", { text: v.title || "매물 영상" }),
        el("p", { class: "card-actions" },
          el("a", { class: "btn gold", href: watch, target: "_blank", rel: "noopener", text: "영상 보기" }),
          el("a", { class: "btn navy", href: "tel:" + String(site.office.tel || "").replace(/[^0-9+]/g, ""), text: "전화하기" }))));
  }

  let lastCount = -1;
  function sync(userAction) {
    document.querySelectorAll("#cats .cat").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.type === state.type)));
    const rows = useVideos ? videos.filter(matchesVideo) : listings.filter(matchesListing);
    const view = rows.slice(0, state.shown);
    $("cards").replaceChildren(...(useVideos ? view.map(videoCard) : view.map(G.card)));
    $("count").textContent = rows.length ? rows.length + "건" : "";
    const left = rows.length - state.shown;
    $("more").hidden = left <= 0;
    $("more").textContent = useVideos ? `영상 더 보기 (${left}건 남음)` : `매물 더 보기 (${left}건 남음)`;
    const sourceCount = useVideos ? videos.length : listings.length;
    const noMatch = sourceCount > 0 && rows.length === 0;
    $("empty").hidden = !noMatch;
    if (sourceCount > 0) $("emptyNone").hidden = true;
    $("qInfo").hidden = !state.q;
    $("qInfoText").textContent = state.q ? `"${state.q}" 검색 결과` : "";
    writeQuery();
    if (userAction && rows.length !== lastCount) {
      G.announce(rows.length ? (useVideos ? `영상 ${rows.length}건` : `매물 ${rows.length}건`) : "조건에 맞는 매물이 없습니다. 전화로 말씀해 주세요.");
    }
    lastCount = rows.length;
  }

  function renderVideos() {
    if (useVideos) return;
    const list = videos.slice(0, 6);
    $("videoEmpty").hidden = list.length > 0;
    $("videoGrid").replaceChildren(...list.map((v) => el("article", { class: "vcard" },
      G.videoFacade(v.id, v.title, { short: v.isShort }),
      el("div", { class: "vbody" },
        el("h3", { text: v.title }),
        el("p", { class: "muted", text: G.fmtDate(v.published) }),
        ...[...v.listingNos].slice(0, 2).map((no) => el("a", { class: "vlink", href: G.listingUrl(no), text: `매물 번호 ${no} 보기` }))))));
  }

  function renderBlog() {
    const posts = Array.isArray(blog.posts) ? blog.posts.slice(0, 6) : [];
    $("blogEmpty").hidden = posts.length > 0;
    $("blogList").replaceChildren(...posts.map((p) => el("a", {
      class: "blog-card", href: p.link, target: "_blank", rel: "noopener",
    },
      el("p", { class: "when", text: [p.category, G.fmtDate(p.published)].filter(Boolean).join(" · ") }),
      el("h3", { text: p.title || "블로그 글" }),
      p.summary ? el("p", { text: p.summary }) : null)));
  }

  readQuery();
  $("heroQ").value = state.q;
  $("heroSearch").addEventListener("submit", (e) => {
    e.preventDefault();
    state.q = $("heroQ").value.trim();
    state.shown = PAGE;
    sync(true);
    $("listings").scrollIntoView({ behavior: "smooth" });
    $("listings").focus({ preventScroll: true });
  });
  $("heroQ").addEventListener("search", () => { state.q = $("heroQ").value.trim(); state.shown = PAGE; sync(true); });
  $("qClear").addEventListener("click", () => { state.q = ""; $("heroQ").value = ""; state.shown = PAGE; sync(true); $("heroQ").focus(); });
  document.querySelectorAll("#cats .cat").forEach((b) => b.addEventListener("click", () => {
    state.type = b.dataset.type || "";
    state.shown = PAGE;
    sync(true);
  }));
  $("more").addEventListener("click", () => {
    const first = state.shown;
    state.shown += PAGE;
    sync(false);
    const next = $("cards").children[first];
    if (next) {
      const link = next.querySelector(".card-link");
      if (link) link.focus();
    }
  });

  sync(false);
  renderVideos();
  renderBlog();

  const SCROLL_KEY = "gaya.scroll:" + location.pathname + location.search;
  window.addEventListener("pagehide", () => { try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)); } catch (_) { /* 무시 */ } });
  let restored = false;
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    const y = Number(sessionStorage.getItem(SCROLL_KEY));
    if (nav && (nav.type === "back_forward" || nav.type === "reload") && y > 0) { window.scrollTo(0, y); restored = true; }
  } catch (_) { /* 무시 */ }
  if (!restored && location.hash === "#listings") requestAnimationFrame(() => $("listings").scrollIntoView());
})();
