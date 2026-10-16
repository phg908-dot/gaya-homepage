"""scripts/build.py · scripts/update_videos.py 단위 테스트 (표준 라이브러리만 사용)

    python3 -m unittest discover -s tests -p "test_*.py"     (site/ 폴더에서)
"""
import importlib.util
import json
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
        kept, dropped = build.filter_videos(vids, {1001}, {"eeeeeeeeeee"})
        self.assertEqual([v["id"] for v in kept], ["aaaaaaaaaaa", "ccccccccccc"])

    def test_listing_video_classification(self):
        yes = ["지평역 걸어서 450m! 양평 지평면 토지 660㎡(200평) 2억3천 #양평토지",
               "정원과 밭까지 2,538㎡(768평) 양평 전원주택｜가야공인중개사 박홍균"]
        no = ["농지 전수조사, 포상금 상한 10배의 정확한 뜻", "3억 전원주택이 정말 3천이 됐을까? 경매 최저가 계산",
              "약 8,763만 원이 약 1억 6,787만 원으로", "농지 화장실 10제곱미터·주차장 25제곱미터", "지평막걸리 파는 곳"]
        for t in yes:
            self.assertTrue(build.is_listing_video({"id": "a" * 11, "title": t}), t)
        for t in no:
            self.assertFalse(build.is_listing_video({"id": "a" * 11, "title": t}), t)
        self.assertTrue(build.is_listing_video({"id": "b" * 11, "title": "막걸리"}, force_in={"b" * 11}))
        self.assertFalse(build.is_listing_video({"id": "c" * 11, "title": yes[0]}, force_out={"c" * 11}))

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
        if "/shorts/" in url:
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
            {"videoSecondaryInfoRenderer": {"attributedDescription": {"content": "매물번호 1001 설명"}}}]}}}}}

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

    def test_real_network_failure_does_not_raise(self):
        self.assertEqual(uv.http("http://127.0.0.1:9/", timeout=2)[0], 0)


if __name__ == "__main__":
    unittest.main()
