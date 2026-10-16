"""GitHub Actions 에서 네이버 블로그·유튜브 장면 이미지 접근 가능 여부 점검 (임시)"""
import json, re, urllib.request, urllib.parse, html as H, sys

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
def get(url, ref=None, n=None):
    h = {"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9"}
    if ref: h["Referer"] = ref
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=20) as r:
            b = r.read() if n is None else r.read(n)
            return r.status, b, r.headers.get("content-type", "")
    except urllib.error.HTTPError as e:
        return e.code, b"", ""
    except Exception as e:
        return 0, str(e).encode(), ""
OUT = []
def note(m): OUT.append(m.replace("\n", " ")[:700]); print(m)
def flush():
    blob = " ‖ ".join(OUT)
    for i in range(0, min(len(blob), 9 * 3800), 3800):
        print("::notice::" + blob[i:i + 3800].replace("%", "%25").replace("\r", "").replace("\n", " "))

# 1) 블로그 RSS
s, b, ct = get("https://rss.blog.naver.com/gayayangpyeong.xml")
t = b.decode("utf-8", "replace")
items = re.findall(r"<item>(.*?)</item>", t, re.S)
note(f"RSS {s} {len(b)}B items={len(items)} ct={ct}")
posts = []
for it in items[:60]:
    title = re.search(r"<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>", it, re.S)
    link = re.search(r"<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>", it, re.S)
    date = re.search(r"<pubDate>(.*?)</pubDate>", it)
    desc = re.search(r"<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</description>", it, re.S)
    imgs = re.findall(r'<img[^>]+src="([^"]+)"', H.unescape(desc.group(1)) if desc else "")
    posts.append((title and title.group(1).strip(), link and link.group(1).strip(), date and date.group(1), len(desc.group(1)) if desc else 0, imgs[:2]))
note("TITLES " + " / ".join(f"{(p[2] or '')[5:16]} {p[0]}" for p in posts[:50]))

# 2) 글 본문 (모바일 PostView) → 이미지 주소
pick = [p for p in posts if re.search(r"매매|전원주택|토지|임야", p[0] or "")][:2]
for p in pick:
    m = re.search(r"/(\d{9,})", p[1] or "")
    if not m: continue
    url = f"https://m.blog.naver.com/PostView.naver?blogId=gayayangpyeong&logNo={m.group(1)}"
    s, b, ct = get(url)
    page = b.decode("utf-8", "replace")
    srcs = re.findall(r'(?:data-lazy-src|src|data-src)="(https://(?:postfiles|blogfiles|mblogthumb-phinf)[^"]+)"', page)
    srcs = list(dict.fromkeys(srcs))
    note(f"PAGE {s} {len(b)}B imgs={len(srcs)} {url}")
    mm = re.search(r'class="se-main-container"(.*)', page, re.S)
    text = re.sub(r"<[^>]+>", " ", mm.group(1)[:20000]) if mm else ""
    note("TEXT " + re.sub(r"\s+", " ", H.unescape(text))[:600])
    note("SRCS " + " , ".join(x[:110] for x in srcs[:6]))
    for u in srcs[:1]:
        for q in ["", "?type=w800", "?type=w966"]:
            uu = u.split("?")[0] + q
            for ref in [None, "https://m.blog.naver.com/"]:
                s2, b2, ct2 = get(uu, ref)
                note(f"IMG {s2} {len(b2)}B {ct2} ref={bool(ref)} {uu[:140]}")

# 3) 유튜브 썸네일·자동 장면
vid = "d9zp8vq_SFk"
for name in ["maxresdefault", "sddefault", "hqdefault", "hq1", "hq2", "hq3", "1", "2", "3"]:
    s, b, ct = get(f"https://i.ytimg.com/vi/{vid}/{name}.jpg")
    note(f"YTIMG {name} {s} {len(b)}B")

# 4) 유튜브 설명란 링크 원문(축약 안 된 주소)이 innertube next 에 있는지
body = json.dumps({"context": {"client": {"clientName": "WEB", "clientVersion": "2.20251001.00.00", "hl": "ko", "gl": "KR"}}, "videoId": vid}).encode()
try:
    req = urllib.request.Request("https://www.youtube.com/youtubei/v1/next?prettyPrint=false", data=body, headers={"User-Agent": UA, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        t = r.read().decode("utf-8", "replace")
    links = sorted(set(re.findall(r"blog\.naver\.com[^\"\\\s]{0,80}", t)))
    note(f"NEXT links {links[:10]}")
    q = sorted(set(re.findall(r"q=(https?%3A%2F%2F[^&\"]+)", t)))
    note(f"NEXT redirect q {[urllib.parse.unquote(x) for x in q][:10]}")
except Exception as e:
    note(f"NEXT fail {e}")

flush()
