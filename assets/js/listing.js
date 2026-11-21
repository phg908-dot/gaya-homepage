// 매물 상세 페이지: 영상 썸네일 → 클릭 재생, 찜·공유·인쇄, 비슷한 매물, 위치 지도
(async function () {
  const G = window.GAYA, el = G.el;
  const no = Number(document.body.dataset.no);

  document.querySelectorAll(".yt[data-yt]").forEach((box) => {
    box.replaceWith(G.videoFacade(box.dataset.yt, box.dataset.title, { short: box.classList.contains("yt-short") }));
  });

  // 찜 버튼 (공유 버튼 앞에 추가)
  const actions = document.querySelector(".detail-actions");
  if (actions && no) {
    const on = () => G.favs().has(no);
    const fav = el("button", { type: "button", class: "btn ghost fav-inline", "aria-pressed": String(on()) });
    const paint = () => {
      fav.replaceChildren(el("span", { "aria-hidden": "true", text: on() ? "♥" : "♡" }), " 찜하기");
      fav.setAttribute("aria-pressed", String(on()));
    };
    fav.addEventListener("click", () => { G.toggleFav(no); paint(); G.announce(on() ? "찜한 매물에 추가했습니다" : "찜을 해제했습니다"); });
    paint();
    actions.prepend(fav);
  }

  const share = document.getElementById("share");
  if (share) {
    share.addEventListener("click", async () => {
      const data = { title: document.title, url: location.href };
      try {
        if (navigator.share) await navigator.share(data);
        else {
          await navigator.clipboard.writeText(location.href);
          share.textContent = "링크 복사됨 ✓";
          G.announce("링크를 복사했습니다");
          setTimeout(() => { share.textContent = "공유하기"; }, 2000);
        }
      } catch (_) { /* 사용자가 공유를 취소함 */ }
    });
  }
  const print = document.getElementById("print");
  if (print) print.addEventListener("click", () => window.print());

  let data;
  try {
    data = await G.loadData();
  } catch (e) {
    console.error(e);
    return;
  }
  const { site, listings } = data;
  G.fillOfficeBits(site);
  G.renderFooter(site);

  // 비슷한 매물: 같은 읍·면 → 같은 종류 → 나머지 순으로 최대 3개
  const me = listings.find((l) => l.no === no);
  if (me) {
    const score = (l) => (l.region && me.region && l.region.eupmyeon === me.region.eupmyeon ? 2 : 0) + (l.type === me.type ? 1 : 0);
    const rel = listings.filter((l) => l.no !== no).map((l) => [score(l), l]).filter(([s]) => s > 0)
      .sort((a, b) => b[0] - a[0] || String(b[1].updated).localeCompare(String(a[1].updated))).slice(0, 3).map(([, l]) => l);
    if (rel.length) {
      document.getElementById("related").hidden = false;
      document.getElementById("relCards").replaceChildren(...rel.map(G.card));
    }
  }

  const node = document.getElementById("lmap");
  if (node) {
    const M = await G.loadMap(site);
    if (M) {
      document.getElementById("lmapBox").hidden = false;
      const lat = Number(node.dataset.lat), lng = Number(node.dataset.lng);
      const map = M.createMap(node, lat, lng);
      M.addMarker(map, lat, lng, document.querySelector("h1").textContent);
    }
  }
})();
