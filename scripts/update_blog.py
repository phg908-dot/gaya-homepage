#!/usr/bin/env python3
"""네이버 블로그 RSS를 public/data/blog.json 으로 저장한다.

표준 라이브러리만 사용한다. 글을 가져오지 못하면 기존 파일을 그대로 둔다.
내용이 같으면 파일을 다시 쓰지 않아, 매시간 실행해도 빈 커밋이 생기지 않는다.
"""
from __future__ import annotations

import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "public" / "data" / "site.json"
OUT = ROOT / "public" / "data" / "blog.json"
DEFAULT_RSS = "https://rss.blog.naver.com/gayayangpyeong.xml"
DEFAULT_BLOG = "https://blog.naver.com/gayayangpyeong"
UA = "Mozilla/5.0 (compatible; GayaHomepage/1.0; +https://phg908-dot.github.io/gaya-homepage/)"
KEEP = 12
LINK_RE = re.compile(r"https?://blog\.naver\.com/([^/?#\s]+)/(\d+)")


def note(msg: str) -> None:
    print(msg, file=sys.stderr)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            if r.status != 200:
                raise RuntimeError(f"블로그 RSS 응답 {r.status}")
            return r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"블로그 RSS 응답 {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise RuntimeError(f"블로그 RSS를 읽지 못했습니다: {e}") from e


def clean_link(url: str) -> str:
    m = LINK_RE.search(html.unescape(url or ""))
    if m:
        return f"https://blog.naver.com/{m.group(1)}/{m.group(2)}"
    return (url or "").split("?")[0].strip()


def summary_text(raw: str) -> str:
    text = re.sub(r"<[^>]+>", " ", raw or "")
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > 140:
        text = text[:140].rstrip() + "…"
    return text


def published_iso(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        return ""
    try:
        dt = parsedate_to_datetime(raw)
        # 한국 시각의 날짜를 그대로 쓴다. UTC로 바꾸면 아침 글이 전날로 보인다.
        return dt.date().isoformat()
    except (TypeError, ValueError, OverflowError):
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})", raw)
        return m.group(0) if m else ""


def parse_rss(body: bytes) -> list[dict]:
    root = ET.fromstring(body)
    posts = []
    seen = set()
    for item in root.iter("item"):
        title = "".join(item.findtext("title") or "").strip()
        link = clean_link(item.findtext("guid") or item.findtext("link") or "")
        if not title or not link or link in seen:
            continue
        seen.add(link)
        posts.append({
            "title": title,
            "link": link,
            "published": published_iso(item.findtext("pubDate") or ""),
            "category": "".join(item.findtext("category") or "").strip(),
            "summary": summary_text(item.findtext("description") or ""),
        })
    posts.sort(key=lambda p: p.get("published") or "", reverse=True)
    return posts[:KEEP]


def load_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def same_posts(a: list, b: list) -> bool:
    def key(p):
        return (p.get("link"), p.get("title"), p.get("summary"), p.get("published"), p.get("category"))
    return [key(p) for p in a] == [key(p) for p in b]


def main() -> int:
    site = load_json(SITE)
    blog = site.get("blog") if isinstance(site.get("blog"), dict) else {}
    rss = str(blog.get("rss") or DEFAULT_RSS).strip()
    blog_url = str(blog.get("url") or DEFAULT_BLOG).strip()
    posts = parse_rss(fetch(rss))
    if not posts:
        note("블로그 RSS에 글이 없습니다. 기존 목록을 유지합니다.")
        return 1
    old = load_json(OUT)
    if same_posts(old.get("posts") or [], posts) and old.get("blogUrl") == blog_url:
        print(f"변경 없음 ({len(posts)}개)")
        return 0
    out = {
        "blogUrl": blog_url,
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "posts": posts,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"블로그 글 {len(posts)}개를 저장했습니다")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        note(f"블로그 수집 실패: {exc}")
        sys.exit(1)
