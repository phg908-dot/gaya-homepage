"""실제 블로그 RSS·글 HTML·유튜브 next 응답을 저장 (테스트 자료용, 임시)"""
import json, re, urllib.request, pathlib
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
def get(url, data=None, ctype=None):
    h = {"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9"}
    if ctype: h["Content-Type"] = ctype
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=30) as r:
        return r.read()
out = pathlib.Path("fixtures"); (out / "blog").mkdir(parents=True, exist_ok=True); (out / "youtube").mkdir(parents=True, exist_ok=True)
rss = get("https://rss.blog.naver.com/gayayangpyeong.xml"); (out / "blog/rss.xml").write_bytes(rss)
t = rss.decode("utf-8", "replace")
posts = re.findall(r"<item>.*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>.*?<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>", t, re.S)
pick = [(ti, ln) for ti, ln in posts if re.search(r"매매", ti)][:4] + [(ti, ln) for ti, ln in posts if not re.search(r"매매", ti)][:1]
for ti, ln in pick:
    no = re.search(r"/(\d{9,})", ln).group(1)
    (out / f"blog/post-{no}.m.html").write_bytes(get(f"https://m.blog.naver.com/PostView.naver?blogId=gayayangpyeong&logNo={no}"))
    print("post", no, ti)
no = re.search(r"/(\d{9,})", pick[0][1]).group(1)
(out / f"blog/post-{no}.pc.html").write_bytes(get(f"https://blog.naver.com/PostView.naver?blogId=gayayangpyeong&logNo={no}&redirect=Dlog&widgetTypeCall=true&directAccess=false"))
for vid in ["d9zp8vq_SFk", "7PRVk7skdtc", "Yi7_zs8ZgEw", "T1bnKBqf4J4", "Yp4KhcA1YDw"]:
    body = json.dumps({"context": {"client": {"clientName": "WEB", "clientVersion": "2.20251001.00.00", "hl": "ko", "gl": "KR"}}, "videoId": vid}).encode()
    (out / f"youtube/next-{vid}.json").write_bytes(get("https://www.youtube.com/youtubei/v1/next?prettyPrint=false", body, "application/json"))
    print("next", vid)
