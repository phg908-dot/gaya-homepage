"""scripts/build.py · scripts/update_videos.py 단위 테스트 (표준 라이브러리만 사용)

    python3 -m unittest discover -s tests -p "test_*.py"     (site/ 폴더에서)
"""
import importlib.util
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, SITE / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


build = load("build")
uv = load("update_videos")

BASE = {
    "no": 5001, "status": "거래중", "title": "테스트 토지", "type": "토지", "deal": "매매", "price": 10000,
    "region": {"sido": "경기도", "sigungu": "양평군", "eupmyeon": "지평면", "ri": "옥현리"},
    "land": {"area": 500, "jimok": "답", "zoning": "계획관리지역"}, "building": None,
}


def norm(**kw):
    warns = []
    d = dict(BASE, **kw)
    return build.normalize_all([d], warns)[0], warns


class Normalize(unittest.TestCase):
    def test_complete_listing_is_publishable(self):
        l, _ = norm()
        self.assertEqual(build.listing_problems(l), [])
        self.assertTrue(build.publishable(l))

    def test_text_price_is_blocked(self):
        for bad in ("협의", "비공개", "1억~1억2천"):
            l, _ = norm(price=bad)
            self.assertFalse(build.publishable(l), bad)

    def test_zero_price_is_blocked(self):
        self.assertFalse(build.publishable(norm(price=0)[0]))

    def test_numeric_strings_are_coerced(self):
        l, _ = norm(no="5002", price="32,000")
        self.assertEqual((l["no"], l["price"]), (5002, 32000))
        self.assertTrue(build.publishable(l))

    def test_status_spelling(self):
        self.assertEqual(norm(status="계약 완료")[0]["status"], "계약완료")
        self.assertEqual(norm(status="거래완료")[0]["status"], "계약완료")
        self.assertFalse(build.publishable(norm(status="보류")[0]))

    def test_duplicate_numbers_are_blocked(self):
        ls = build.normalize_all([dict(BASE), dict(BASE)], [])
        self.assertTrue(all(not build.publishable(l) for l in ls))

    def test_bad_coordinates_are_dropped(self):
        l, w = norm(lat='1" onmouseover="x', lng=127.6)
        self.assertIsNone(l["lat"])
        self.assertTrue(w)

    def test_photo_and_video_cleanup(self):
        l, _ = norm(photos=["javascript:alert(1)", "../x.jpg", "images/a.jpg"], videoIds=["https://youtu.be/abcdefghijk", "x"])
        self.assertEqual(l["photos"], ["images/a.jpg"])
        self.assertEqual(l["videoIds"], ["abcdefghijk"])

    def test_residential_needs_rooms_but_shop_does_not(self):
        b = {"area": 50, "totalFloors": 2, "approvalDate": "2010-01-01", "direction": "남향", "baths": 1, "parking": 1, "moveIn": "즉시입주", "maintenance": "없음"}
        self.assertIn("건축물 방 수", build.listing_problems(norm(type="전원주택", building=b)[0]))
        self.assertNotIn("건축물 방 수", build.listing_problems(norm(type="상가", building=b)[0]))

    def test_ri_required_in_eup_myeon(self):
        l, _ = norm(region=dict(BASE["region"], ri=""))
        self.assertTrue(any("리(里)" in x for x in build.listing_problems(l)))

    HOUSE = {"use": "단독주택", "area": 84.5, "totalFloors": 1, "approvalDate": "2015-03-20", "direction": "남향(거실 기준)",
             "rooms": 3, "baths": 2, "parking": 2, "moveIn": "즉시입주", "maintenance": "없음"}

    def test_jibun_private_by_default(self):
        # 지번 비공개 원칙: 지번이 없어도 게시 가능, 입력돼 있어도 showJibun 이 true 일 때만 표시
        l, _ = norm(type="전원주택", building=self.HOUSE)
        self.assertEqual(build.listing_problems(l), [])
        l, _ = norm(type="전원주택", building=self.HOUSE, region=dict(BASE["region"], jibun="123-4"))
        self.assertTrue(build.region_text(l["region"]).endswith("옥현리"))
        l, _ = norm(type="전원주택", building=self.HOUSE, region=dict(BASE["region"], jibun="123-4", showJibun=True))
        self.assertTrue(build.region_text(l["region"]).endswith("옥현리 123-4"))

    def test_direction_is_building_facing(self):
        l, _ = norm(type="전원주택", building=dict(self.HOUSE, direction="남향"))
        self.assertEqual(build.listing_problems(l), [])
        self.assertEqual(build.direction_text("남향"), "남향(건물 정면 기준)")
        self.assertEqual(build.direction_text("남향(거실 기준)"), "남향(거실 기준)")

    def test_value_formats(self):
        hide = dict(BASE["region"])
        bad = {"moveIn": "협의", "maintenance": "월 25만원"}
        for k, v in bad.items():
            l, _ = norm(type="전원주택", region=hide, building=dict(self.HOUSE, **{k: v}))
            self.assertTrue(build.listing_problems(l), k)
        l, _ = norm(type="전원주택", region=hide, building=dict(self.HOUSE, moveIn="11월 중순", maintenance="월 25만원(일반관리비 15만원, 사용료 10만원)"))
        self.assertEqual(build.listing_problems(l), [])

    def test_videos_of_unpublished_listings_are_dropped(self):
        vids = [{"id": "aaaaaaaaaaa", "title": "매물번호 1001"}, {"id": "bbbbbbbbbbb", "title": "매물번호 1001, 1005"},
                {"id": "ccccccccccc", "title": "양평 이야기"}, {"id": "ddddddddddd", "title": "No.9999"},
                {"id": "eeeeeeeeeee", "title": "번호 없음"}]
        kept, dropped = build.filter_videos(vids, {1005}, {"eeeeeeeeeee"})
        # 1005(게시 안 하는 매물) 언급 영상과 차단 영상만 빠지고, 목록에 없는 번호(9999)는 그대로
        self.assertEqual([v["id"] for v in kept], ["aaaaaaaaaaa", "ccccccccccc", "ddddddddddd"])

    def test_listing_video_classification(self):
        yes = ["지평역 걸어서 450m! 양평 지평면 토지 660㎡(200평) 2억3천 #양평토지",
               "정원과 밭까지 2,538㎡(768평) 양평 전원주택｜가야공인중개사 박홍균"]
        no = ["농지 전수조사, 포상금 상한 10배의 정확한 뜻", "3억 전원주택이 정말 3천이 됐을까? 경매 최저가 계산",
              "약 8,763만 원이 약 1억 6,787만 원으로", "농지 화장실 10제곱미터·주차장 25제곱미터", "지평막걸리 파는 곳"]
        for t in yes:
            self.assertTrue(build.is_listing_video({"id": "a" * 11, "title": t}), t)
        for t in no:
            self.assertFalse(build.is_listing_video({"id": "a" * 11, "title": t}), t)
        self.assertTrue(build.is_listing_video({"id": "a" * 11, "title": "(급매)양평 임야에 접한 숲세권 양평전원주택지 매매"}))
        self.assertTrue(build.is_listing_video({"id": "a" * 11, "title": "개울 옆 땅", "description": "◑ 소재지 : 경기도 양평군"}))
        self.assertFalse(build.is_listing_video({"id": "a" * 11, "title": "(매매완료)6천인하! 양평전원주택급매"}))
        self.assertTrue(build.video_age_ok({"published": "2026-01-10"}, 12, today=build.date(2026, 10, 16)))
        self.assertFalse(build.video_age_ok({"published": "2024-12-05"}, 12, today=build.date(2026, 10, 16)))
        self.assertTrue(build.is_listing_video({"id": "b" * 11, "title": "막걸리"}, force_in={"b" * 11}))
        self.assertFalse(build.is_listing_video({"id": "c" * 11, "title": yes[0]}, force_out={"c" * 11}))

    def test_video_category_uses_title_not_hashtag(self):
        # 해시태그의 전원주택, 설명의 대지는 종류를 바꾸지 않는다. 전원주택지는 땅이다.
        cases = [
            ("전기 많이 써도 월 약 5천 원? 양평 용문 전원주택 2,538㎡(768평)",
             "대지 660㎡(200평)와 농지 1,878㎡", "주택"),
            ("지평 시내 대지 1억2천! 양평군 지평면 토지 330㎡(100평) #양평토지 #양평전원주택",
             "", "토지"),
            ("개울 옆 양평 지평 전원주택지 1,855㎡(562평) 2억3천 #양평토지",
             "", "토지"),
            ("양평 전원주택 3억대 | 잔디마당 남향 2층 단독주택 | 대지228평 건평53평",
             "", "주택"),
            ("양평 지평면 주택 전세", "", "전·월세"),
            ("양평 토지 월세", "", "전·월세"),
            ("양평 지평면 농가주택 매매", "", ""),
            ("(급매)양평 임야에 접한 숲세권 양평전원주택지 매매", "", "토지"),
        ]
        for title, desc, want in cases:
            got = build.video_category({"title": title, "description": desc})
            self.assertEqual(got, want, title)

    def test_video_card_phone_is_not_inside_watch_link(self):
        html = build.static_video_card({"id": "abcdefghijk", "title": "지평면 토지 330㎡", "published": "2026-10-02"})
        self.assertIn('class="btn navy card-call" href="tel:01034060071">전화하기', html)
        overlay = re.search(r'<a class="card-link".*?</a>', html, re.S).group(0)
        self.assertNotIn("tel:", overlay)
        self.assertLess(html.index("</h3></div></div><p class=\"card-actions\">"), html.index("tel:01034060071"))

    def test_jsonld_cannot_break_out_of_script(self):
        out = build.ld_json({"name": "<!--<script></script>&"})
        self.assertNotIn("<", out)
        self.assertNotIn(">", out)

    def test_video_number_linking(self):
        ls = build.normalize_all([dict(BASE, no=1001), dict(BASE, no=1002)], [])
        vids = [{"id": "abcdefghijk", "title": "매물번호 1001, 1002", "description": ""},
                {"id": "bbbbbbbbbbb", "title": "piano 1001", "description": ""}]
        build.link_videos(ls, vids)
        self.assertEqual([l["videoIds"] for l in ls], [["abcdefghijk"], ["abcdefghijk"]])


def jpeg_with_gps(orientation=6):
    """GPS IFD 포인터와 회전값이 들어간 최소 JPEG"""
    entries = [(0x0112, 3, 1, struct.pack(">HH", orientation, 0)), (0x8825, 4, 1, struct.pack(">I", 0))]
    ifd = struct.pack(">H", len(entries)) + b"".join(struct.pack(">HHI", t, ty, c) + v for t, ty, c, v in entries) + struct.pack(">I", 0)
    tiff = b"MM\x00\x2a" + struct.pack(">I", 8) + ifd + b"GPSDATA-37.47N"
    app1 = b"Exif\x00\x00" + tiff
    return b"\xff\xd8" + b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1 + b"\xff\xda\x00\x02SCAN\xff\xd9"


class Photos(unittest.TestCase):
    def test_jpeg_gps_removed_orientation_kept(self):
        out = build.strip_jpeg(jpeg_with_gps(6))
        self.assertNotIn(b"GPSDATA", out)
        self.assertIn(b"Exif", out)
        app1 = out[out.index(b"Exif"):]
        self.assertEqual(build._jpeg_orientation(app1), 6)
        self.assertTrue(out.endswith(b"SCAN\xff\xd9"))

    def test_jpeg_upright_drops_exif(self):
        self.assertNotIn(b"Exif", build.strip_jpeg(jpeg_with_gps(1)))

    def test_png_text_removed(self):
        def chunk(t, d):
            return struct.pack(">I", len(d)) + t + d + b"\x00\x00\x00\x00"
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", b"x" * 13) + chunk(b"tEXt", b"GPS\x0037.4") + chunk(b"IDAT", b"d") + chunk(b"IEND", b"")
        out = build.strip_png(png)
        self.assertNotIn(b"tEXt", out)
        self.assertIn(b"IDAT", out)


class Build(unittest.TestCase):
    def test_prod_build_excludes_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(SITE / "public", Path(tmp) / "public", ignore=shutil.ignore_patterns("listing"))
            shutil.copytree(SITE / "scripts", Path(tmp) / "scripts")
            lp = Path(tmp) / "public/data/listings.json"
            lp.write_text(json.dumps([dict(BASE, no=6001, region=dict(BASE["region"], jibun="비밀-123")), dict(BASE, no=6002, price="협의"), dict(BASE, no=6003, status="계약완료")], ensure_ascii=False))
            r = subprocess.run([sys.executable, "scripts/build.py", "--prod"], cwd=tmp, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            pub = json.loads((Path(tmp) / "dist/data/listings.json").read_text())
            self.assertEqual([l["no"] for l in pub], [6001])
            self.assertTrue(all("_issues" not in l for l in pub))
            dist = Path(tmp) / "dist"
            leaked = [f for f in dist.rglob("*") if f.is_file() and f.suffix in (".html", ".json") and "비밀-123" in f.read_text(encoding="utf-8", errors="ignore")]
            self.assertEqual(leaked, [], "지번(비공개)이 배포 파일에 노출되면 안 됨")
            sp = Path(tmp) / "public/data/site.json"
            s = json.loads(sp.read_text())
            s["office"]["regNo"] = ""
            sp.write_text(json.dumps(s, ensure_ascii=False))
            r = subprocess.run([sys.executable, "scripts/build.py", "--prod"], cwd=tmp, capture_output=True, text=True)
            self.assertEqual(r.returncode, 1, "사무소 명시사항이 비면 배포 중단")

    def test_static_first_paint_for_crawlers(self):
        """JS 없이도 매물 링크·현황·사무소 정보가 보이고, 매물 없는 종류의 빠른 링크는 빠진다"""
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(SITE / "public", Path(tmp) / "public", ignore=shutil.ignore_patterns("listing"))
            shutil.copytree(SITE / "scripts", Path(tmp) / "scripts")
            (Path(tmp) / "public/data/listings.json").write_text(json.dumps(
                [dict(BASE, no=6101, urgent=True, region=dict(BASE["region"], jibun="비밀-9")), dict(BASE, no=6102, title="<b>둘째</b>")], ensure_ascii=False))
            r = subprocess.run([sys.executable, "scripts/build.py", "--prod"], cwd=tmp, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            html = (Path(tmp) / "dist/index.html").read_text(encoding="utf-8")
            self.assertLess(html.index('id="l6101"'), html.index('id="l6102"'), "급매가 먼저 (home.js 정렬과 같음)")
            self.assertIn('<h3><a href="listing/6102.html">&lt;b&gt;둘째&lt;/b&gt;</a></h3>', html)
            self.assertIn("<li><b>2</b><span>거래 가능 매물</span></li>", html)
            self.assertIn('data-type="주택"', html)
            self.assertIn('data-type="토지"', html)
            self.assertIn('data-type="전·월세"', html)
            self.assertNotIn('data-type="전원주택"', html)
            self.assertNotIn("농가주택", html)
            self.assertNotIn('data-type="상가"', html)
            self.assertIn('id="listHeading">매물</span>', html)
            self.assertNotIn("비밀-9", html)
            o = json.loads((SITE / "public/data/site.json").read_text())["office"]
            self.assertIn(f'<dd data-office="address">{o["address"]}', html)
            self.assertIn('<div class="empty" id="emptyNone" hidden>', html)
            self.assertIn("양평 지평 부동산", html)
            self.assertIn("양평 가야부동산", html)
            # 매물 글이 없으면 현장 영상을 매물 자리에 넣고, 0건 빈 목록은 만들지 않는다
            (Path(tmp) / "public/data/listings.json").write_text("[]")
            subprocess.run([sys.executable, "scripts/build.py", "--prod"], cwd=tmp, capture_output=True, text=True)
            html = (Path(tmp) / "dist/index.html").read_text(encoding="utf-8")
            self.assertIn('id="listHeading">매물 영상', html)
            self.assertIn("youtube.com/watch", html)
            self.assertIn('id="emptyNone" hidden', html)
            self.assertNotIn(">0건<", html)

    def test_site_url_and_photo_paths(self):
        self.assertIsNone(build.site_url_problem({"siteUrl": "https://a.github.io/repo"}))
        self.assertIn("비어", build.site_url_problem({"siteUrl": ""}))
        self.assertIn("https://", build.site_url_problem({"siteUrl": "www.example.kr"}))
        self.assertEqual(build.url_path("images/1001 거실.jpg"), "images/1001%20%EA%B1%B0%EC%8B%A4.jpg")
        self.assertEqual(build.url_path("images/1002%20a.jpg"), "images/1002%20a.jpg")
        ld = build.agent_ld({"office": {"name": "가야공인중개사사무소"}, "naver": {"searchName": "양평 가야부동산"}, "youtube": {"name": "양평가야부동산"}})
        self.assertEqual(ld["alternateName"], ["양평 가야부동산", "양평가야부동산"])

    @unittest.skipUnless(importlib.util.find_spec("PIL"), "Pillow 없음")
    def test_big_photos_are_shrunk_and_rotated(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            im = Image.new("RGB", (4000, 3000), "white")
            exif = Image.Exif()
            exif[0x0112] = 6  # 세로로 찍은 사진
            im.save(Path(tmp) / "big.jpg", "JPEG", exif=exif.tobytes())
            Image.new("RGB", (800, 600)).save(Path(tmp) / "small.jpg", "JPEG")
            n, warns = build.shrink_photos(Path(tmp))
            self.assertEqual((n, warns), (1, []))
            with Image.open(Path(tmp) / "big.jpg") as out:
                self.assertEqual(out.size, (1200, 1600), "회전이 픽셀에 반영되고 긴 변 1600px")
                self.assertNotIn(0x0112, out.getexif())
            with Image.open(Path(tmp) / "small.jpg") as out:
                self.assertEqual(out.size, (800, 600))


RSS = b"""<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
<entry><yt:videoId>NEWvideo001</yt:videoId><title>T1</title><published>2026-10-15T09:00:00+00:00</published><media:group><media:description>D</media:description></media:group></entry>
<entry><yt:videoId>KEEPvideo01</yt:videoId><title>T2</title><published>2026-01-01T09:00:00+00:00</published><media:group><media:description></media:description></media:group></entry>
</feed>"""


class Videos(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "public/data").mkdir(parents=True)
        (root / "public/data/site.json").write_text(json.dumps({"youtube": {"handle": "@x", "channelId": "UC" + "a" * 22}}))
        (root / "public/data/videos.json").write_text(json.dumps({"videos": [
            {"id": "KEEPvideo01", "title": "old", "description": "old desc", "published": "2026-01-01T09:00:00+00:00", "isShort": False},
            {"id": "GONEvideo01", "title": "gone", "description": "", "published": "2025-01-01T09:00:00+00:00", "isShort": False}]}))
        self.saved = (uv.SITE, uv.OUT, uv.http, uv.time.sleep)
        uv.SITE, uv.OUT = root / "public/data/site.json", root / "public/data/videos.json"
        uv.time.sleep = lambda s: None

    def tearDown(self):
        uv.SITE, uv.OUT, uv.http, uv.time.sleep = self.saved
        self.tmp.cleanup()

    def fake(self, url, follow=True, timeout=20, data=None):
        if "feeds/videos.xml" in url:
            return 200, RSS
        if "/shorts/" in url or "youtubei/v1/next" in url:
            return 0, b""  # 네트워크 오류 흉내 → 판단 보류
        if "oembed" in url:
            return (404, b"") if "GONE" in url else (200, b'{"title": "x"}')
        raise AssertionError(url)

    def test_merge_prune_and_network_errors(self):
        uv.http = self.fake
        self.assertEqual(uv.main(), 0)
        out = json.loads(uv.OUT.read_text())
        ids = [v["id"] for v in out["videos"]]
        self.assertEqual(ids, ["NEWvideo001", "KEEPvideo01"])
        keep = out["videos"][1]
        self.assertEqual((keep["title"], keep["description"]), ("T2", ""), "피드의 빈 설명도 반영")
        self.assertIsNone(out["videos"][0]["isShort"], "판단 불가는 None 으로 남겨 다음에 재시도")
        self.assertNotIn("links", keep, "설명란을 못 읽었으면 링크 칸을 만들지 않아 다음에 다시 시도")

    def test_channel_page_fallback_when_rss_404(self):
        vids_page = {"contents": {"tabs": [{"richGridRenderer": {"contents": [
            {"richItemRenderer": {"content": {"videoRenderer": {"videoId": "AAAAAAAAAA1", "title": {"runs": [{"text": "지평면 전원주택 매물번호 1001"}]}}}}},
            {"richItemRenderer": {"content": {"videoRenderer": {"videoId": "KEEPvideo01", "title": {"runs": [{"text": "새 제목"}]}}}}}]}}]}}
        shorts_page = {"contents": [{"shortsLockupViewModel": {"entityId": "shorts-shelf-item-SSSSSSSSSS1",
            "onTap": {"innertubeCommand": {"reelWatchEndpoint": {"videoId": "SSSSSSSSSS1"}}},
            "overlayMetadata": {"primaryText": {"content": "토지 쇼츠"}}}}]}
        page = lambda d: ("<html><script>var ytInitialData = " + json.dumps(d, ensure_ascii=False) + ";</script></html>").encode()
        watch = b'<html>"publishDate":"2026-10-15T09:00:00-07:00" "shortDescription":"\\ub9e4\\ubb3c\\ubc88\\ud638 1001\\n\\uc124\\uba85"</html>'

        def fake(url, follow=True, timeout=20, data=None):
            if "youtubei/v1/" in url:
                return 0, b""  # 내부 요청 실패 → HTML 경로 사용
            if "feeds/videos.xml" in url:
                return 404, b""
            if url.endswith("/videos?hl=ko&gl=KR"):
                return 200, page(vids_page)
            if url.endswith("/shorts?hl=ko&gl=KR"):
                return 200, page(shorts_page)
            if "/watch?v=" in url:
                return 200, watch
            if "oembed" in url:
                return (404, b"") if "GONE" in url else (200, b'{"title": "x"}')
            raise AssertionError(url)
        uv.http = fake
        self.assertEqual(uv.main(), 0)
        out = {v["id"]: v for v in json.loads(uv.OUT.read_text())["videos"]}
        self.assertEqual(set(out), {"AAAAAAAAAA1", "KEEPvideo01", "SSSSSSSSSS1"})
        self.assertTrue(out["SSSSSSSSSS1"]["isShort"])
        self.assertFalse(out["AAAAAAAAAA1"]["isShort"])
        self.assertEqual(out["AAAAAAAAAA1"]["published"], "2026-10-15T09:00:00-07:00")
        self.assertIn("매물번호 1001", out["AAAAAAAAAA1"]["description"])

    def test_innertube_browse_and_next(self):
        browse_videos = {"contents": [{"lockupViewModel": {"contentId": "LLLLLLLLLL1", "contentType": "LOCKUP_CONTENT_TYPE_VIDEO",
            "metadata": {"lockupMetadataViewModel": {"title": {"content": "양평 지평면 토지 660㎡(200평) 2억3천 #양평토지"}}}}}]}
        nxt = {"contents": {"twoColumnWatchNextResults": {"results": {"results": {"contents": [
            {"videoPrimaryInfoRenderer": {"dateText": {"simpleText": "2026. 10. 3."}}},
            {"videoSecondaryInfoRenderer": {"attributedDescription": {
                "content": "매물번호 1001 설명\n글로 자세히 보기(블로그): https://blog.naver.com/gayayangpyeong...\n#양평토지",
                "commandRuns": [
                    {"startIndex": 30, "length": 40, "onTap": {"innertubeCommand": {"urlEndpoint": {
                        "url": "https://www.youtube.com/redirect?event=video_description&redir_token=X&q=https%3A%2F%2Fblog.naver.com%2Fgayayangpyeong%2F224427678503&v=LLLLLLLLLL1"}}}},
                    {"startIndex": 80, "length": 5, "onTap": {"innertubeCommand": {"commandMetadata": {"webCommandMetadata": {"url": "/hashtag/양평토지"}}}}}]}}}]}}}}}

        def fake(url, follow=True, timeout=20, data=None):
            if "feeds/videos.xml" in url:
                return 404, b""
            if url.startswith("https://www.youtube.com/youtubei/v1/browse"):
                body = json.loads(data)
                return (200, json.dumps(browse_videos).encode()) if body["params"].startswith("EgZ2aWRlb3") else (200, b"{}")
            if url.startswith("https://www.youtube.com/youtubei/v1/next"):
                return 200, json.dumps(nxt, ensure_ascii=False).encode()
            if "/shorts?" in url:
                return 200, b"<html></html>"
            if "oembed" in url:
                return (404, b"") if "GONE" in url else (200, b'{"title": "x"}')
            raise AssertionError(url)
        uv.http = fake
        self.assertEqual(uv.main(), 0)
        out = {v["id"]: v for v in json.loads(uv.OUT.read_text())["videos"]}
        self.assertFalse(out["LLLLLLLLLL1"]["isShort"])
        self.assertEqual(out["LLLLLLLLLL1"]["published"], "2026-10-03")
        self.assertIn("매물번호 1001", out["LLLLLLLLLL1"]["description"])
        self.assertEqual(out["LLLLLLLLLL1"]["links"], ["https://blog.naver.com/gayayangpyeong/224427678503"],
                         "화면에 잘려 보이는 블로그 주소 대신 링크의 원래 주소, 해시태그 링크는 제외")
        keep = out["KEEPvideo01"]
        self.assertIn("매물번호 1001 설명", keep["description"], "예전 영상도 설명란을 다시 읽어 바뀐 내용 반영")
        self.assertEqual(keep["links"], ["https://blog.naver.com/gayayangpyeong/224427678503"])

    def test_refresh_ignores_url_display_differences(self):
        self.assertTrue(uv._same_text("글: https://blog.naver.com/gayayangpyeong/224427678503 끝", "글: https://blog.naver.com/gayayangpyeong... 끝"))
        self.assertFalse(uv._same_text("매매가 2억 3,000만 원", "매매가 2억 1,000만 원"))
        self.assertEqual(uv.text_links("블로그 https://blog.naver.com/a/1 와 https://blog.naver.com/gayayangpyeong... 그리고 https://youtu.be/x"),
                         ["https://blog.naver.com/a/1"])

    def test_real_network_failure_does_not_raise(self):
        self.assertEqual(uv.http("http://127.0.0.1:9/", timeout=2)[0], 0)


class Blog(unittest.TestCase):
    def test_parse_rss_strips_html_and_query(self):
        ub = load("update_blog")
        raw = """<?xml version="1.0"?><rss version="2.0"><channel>
          <item>
            <title><![CDATA[양평 지평 토지 이야기]]></title>
            <link><![CDATA[https://blog.naver.com/gayayangpyeong/224429812285?fromRss=true&trackingCode=rss]]></link>
            <guid>https://blog.naver.com/gayayangpyeong/224429812285</guid>
            <category><![CDATA[지평·양평 매물]]></category>
            <description><![CDATA[현장에 가 봤습니다. <img src="https://example.com/a.jpg" /> 길이 좋습니다.]]></description>
            <pubDate>Thu, 15 Oct 2026 07:00:00 +0900</pubDate>
          </item>
          <item>
            <title>같은 글</title>
            <link>https://blog.naver.com/gayayangpyeong/224429812285?fromRss=true</link>
            <pubDate>Thu, 15 Oct 2026 07:00:00 +0900</pubDate>
          </item>
        </channel></rss>""".encode()
        posts = ub.parse_rss(raw)
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["link"], "https://blog.naver.com/gayayangpyeong/224429812285")
        self.assertEqual(posts[0]["published"], "2026-10-15")
        self.assertNotIn("<", posts[0]["summary"])
        self.assertIn("현장에 가 봤습니다", posts[0]["summary"])
        self.assertEqual(posts[0]["category"], "지평·양평 매물")


if __name__ == "__main__":
    unittest.main()
