#!/usr/bin/env python3
"""유튜브 채널의 새 영상을 public/data/videos.json 에 누적 저장한다.

- API 키 없이 동작: 채널 RSS 피드(최근 15개)를 읽어 기존 목록과 합친다.
  주기적으로 실행되므로 한 번 수집된 영상은 계속 남는다.
- 선택: 환경변수 YT_API_KEY(YouTube Data API v3)가 있으면 채널의 과거 영상 전체를 가져온다.
- 비공개·삭제된 영상은 oEmbed 확인(401/404) 후 목록에서 뺀다.

GitHub Actions에서 정기 실행된다(.github/workflows/deploy.yml). 표준 라이브러리만 사용.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.client import HTTPException
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "public" / "data" / "site.json"
OUT = ROOT / "public" / "data" / "videos.json"

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
HEADERS = {"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9", "Cookie": "CONSENT=YES+1; SOCS=CAI"}
NS = {
    "a": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}
GHA = bool(os.environ.get("GITHUB_ACTIONS"))


def note(msg: str) -> None:
    """GitHub Actions 화면에 경고로 보이도록 출력 (로컬에서는 일반 출력)"""
    print(("::warning::" if GHA else "") + msg, file=sys.stderr)


CHANNEL_ID_RE = [
    re.compile(r'<meta property="og:url" content="https://www\.youtube\.com/channel/(UC[0-9A-Za-z_-]{22})"'),
    re.compile(r'"externalId"\s*:\s*"(UC[0-9A-Za-z_-]{22})"'),
    re.compile(r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[0-9A-Za-z_-]{22})"'),
    re.compile(r'<meta itemprop="(?:identifier|channelId)" content="(UC[0-9A-Za-z_-]{22})"'),
    re.compile(r'"browseId"\s*:\s*"(UC[0-9A-Za-z_-]{22})"'),
]
DESC_MAX = 2000
YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - 리다이렉트를 따라가지 않음
        return None


def http(url: str, *, follow: bool = True, timeout: int = 20) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=HEADERS)
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read() if e.fp else b""
    except (urllib.error.URLError, TimeoutError, ConnectionError, HTTPException, OSError):
        return 0, b""  # 일시적 네트워크 오류: 호출한 쪽에서 '판단 불가'로 처리하고 다음 실행 때 다시 시도


def resolve_channel_id(handle: str) -> str | None:
    handle = handle if handle.startswith("@") else "@" + handle
    base = "https://www.youtube.com/" + urllib.parse.quote(handle, safe="@")
    for url in (base, base + "/videos", base + "/about?hl=ko"):
        status, body = http(url)
        text = body.decode("utf-8", "replace")
        for rx in CHANNEL_ID_RE:
            m = rx.search(text)
            if m:
                return m.group(1)
        hint = "동의(consent) 페이지" if "consent.youtube.com" in text or "before you continue" in text.lower() else f"{len(text)}자"
        note(f"채널 ID를 찾지 못함: {url} → 응답 {status}, {hint}")
    return None


def fetch_rss(channel_id: str) -> list[dict]:
    # 채널 피드가 간헐적으로 404를 내는 경우가 있어, 실패하면 업로드 재생목록(UU…) 피드로 한 번 더 시도
    urls = [f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}",
            f"https://www.youtube.com/feeds/videos.xml?playlist_id=UU{channel_id[2:]}"]
    status, body = 0, b""
    for url in urls:
        status, body = http(url)
        if status == 200:
            break
    if status != 200:
        raise RuntimeError(f"유튜브 RSS 응답 {status} (채널 ID {channel_id})")
    root = ET.fromstring(body)
    items = []
    for e in root.findall("a:entry", NS):
        vid = e.findtext("yt:videoId", default="", namespaces=NS)
        if not vid:
            continue
        group = e.find("media:group", NS)
        desc = group.findtext("media:description", default="", namespaces=NS) if group is not None else ""
        items.append({
            "id": vid,
            "title": (e.findtext("a:title", default="", namespaces=NS) or "").strip(),
            "published": e.findtext("a:published", default="", namespaces=NS),
            "description": desc[:DESC_MAX],
        })
    return items


YT_INITIAL = re.compile(r"(?:var ytInitialData|window\[\"ytInitialData\"\])\s*=\s*(\{.*?\});\s*</script>", re.S)


def _text(node) -> str:
    if not isinstance(node, dict):
        return ""
    if "simpleText" in node:
        return node["simpleText"]
    if "runs" in node:
        return "".join(r.get("text", "") for r in node["runs"])
    return node.get("content", "")


def _walk(node, out: list, short: bool) -> None:
    """ytInitialData 안의 영상 카드(videoRenderer · reelItemRenderer · shortsLockupViewModel)를 모은다"""
    if isinstance(node, dict):
        vr = node.get("videoRenderer") or node.get("gridVideoRenderer")
        if isinstance(vr, dict) and vr.get("videoId"):
            out.append({"id": vr["videoId"], "title": _text(vr.get("title")), "isShort": short})
        lk = node.get("lockupViewModel")  # 2025년 이후 동영상 탭 구조
        if isinstance(lk, dict) and lk.get("contentId") and "VIDEO" in str(lk.get("contentType", "VIDEO")):
            meta = ((lk.get("metadata") or {}).get("lockupMetadataViewModel") or {})
            out.append({"id": lk["contentId"], "title": _text(meta.get("title")), "isShort": short})
        rr = node.get("reelItemRenderer")
        if isinstance(rr, dict) and rr.get("videoId"):
            out.append({"id": rr["videoId"], "title": _text(rr.get("headline")), "isShort": True})
        sl = node.get("shortsLockupViewModel")
        if isinstance(sl, dict):
            vid = (((sl.get("onTap") or {}).get("innertubeCommand") or {}).get("reelWatchEndpoint") or {}).get("videoId")
            if not vid:
                m = re.search(r"([A-Za-z0-9_-]{11})$", str(sl.get("entityId", "")))
                vid = m.group(1) if m else None
            if vid:
                out.append({"id": vid, "title": _text((sl.get("overlayMetadata") or {}).get("primaryText")), "isShort": True})
        for v in node.values():
            _walk(v, out, short)
    elif isinstance(node, list):
        for v in node:
            _walk(v, out, short)


def fetch_channel_pages(channel_id: str) -> list[dict]:
    """RSS가 안 될 때: 채널의 '동영상'·'쇼츠' 탭 페이지에서 영상 목록을 읽는다 (최근 약 30개씩)"""
    found, seen = [], set()
    for tab, short in (("videos", False), ("shorts", True)):
        status, body = http(f"https://www.youtube.com/channel/{channel_id}/{tab}?hl=ko&gl=KR")
        m = YT_INITIAL.search(body.decode("utf-8", "replace")) if status == 200 else None
        if not m:
            note(f"채널 '{tab}' 탭에서 영상 목록을 읽지 못함 (응답 {status})")
            continue
        items: list = []
        _walk(json.loads(m.group(1)), items, short)
        for it in items:
            if YT_ID_RE.match(it["id"]) and it["id"] not in seen:
                seen.add(it["id"])
                found.append(it)
    return found


WATCH_FAIL: dict = {}


def fetch_watch_details(vid: str) -> dict:
    """영상 페이지에서 게시일·설명란을 읽는다 (설명란의 매물번호로 매물과 연결하기 위해)"""
    status, body = http(f"https://www.youtube.com/watch?v={vid}&hl=ko")
    t = body.decode("utf-8", "replace")
    if status != 200 or '"publishDate"' not in t:
        reason = ("로봇 확인 화면" if ("confirm you" in t.lower() or "LOGIN_REQUIRED" in t or "봇이 아닌지" in t)
                  else f"응답 {status}" if status != 200 else "게시일 정보 없음")
        WATCH_FAIL[reason] = WATCH_FAIL.get(reason, 0) + 1
        if status != 200:
            return {}
    out = {}
    m = re.search(r'"publishDate":"([^"]+)"', t) or re.search(r'itemprop="datePublished" content="([^"]+)"', t) or re.search(r'"uploadDate":"([^"]+)"', t)
    if m:
        out["published"] = m.group(1)
    m = re.search(r'"shortDescription":"((?:[^"\\]|\\.)*)"', t)
    if m:
        try:
            out["description"] = json.loads('"' + m.group(1) + '"')[:DESC_MAX]
        except ValueError:
            pass
    return out


def fetch_api_all(channel_id: str, key: str) -> list[dict]:
    """YouTube Data API v3로 업로드 재생목록 전체를 가져온다 (50개당 1 unit)."""
    playlist = "UU" + channel_id[2:]
    items, token = [], ""
    while True:
        q = {"part": "snippet,contentDetails", "playlistId": playlist, "maxResults": "50", "key": key}
        if token:
            q["pageToken"] = token
        status, body = http("https://www.googleapis.com/youtube/v3/playlistItems?" + urllib.parse.urlencode(q))
        if status != 200:
            raise RuntimeError(f"Data API 응답 {status}: {body[:200]!r}")
        data = json.loads(body)
        for it in data.get("items", []):
            sn = it.get("snippet", {})
            vid = it.get("contentDetails", {}).get("videoId") or sn.get("resourceId", {}).get("videoId")
            if not vid or sn.get("title") in ("Private video", "Deleted video"):
                continue
            items.append({
                "id": vid,
                "title": sn.get("title", "").strip(),
                "published": it.get("contentDetails", {}).get("videoPublishedAt") or sn.get("publishedAt", ""),
                "description": (sn.get("description") or "")[:DESC_MAX],
            })
        token = data.get("nextPageToken")
        if not token:
            return items


def api_public_ids(ids: list[str], key: str) -> set[str] | None:
    """Data API로 공개 상태 확인: privacyStatus 가 public 인 영상 ID만 돌려준다 (50개당 1 unit). 실패하면 None"""
    public = set()
    for i in range(0, len(ids), 50):
        q = {"part": "status", "id": ",".join(ids[i:i + 50]), "key": key, "maxResults": "50"}
        status, body = http("https://www.googleapis.com/youtube/v3/videos?" + urllib.parse.urlencode(q))
        if status != 200:
            return None
        for it in json.loads(body).get("items", []):
            if it.get("status", {}).get("privacyStatus") == "public":
                public.add(it["id"])
    return public


def is_short(vid: str) -> bool | None:
    """/shorts/<id> 가 200이면 Shorts, 리다이렉트(3xx)면 일반 영상. 판단 불가면 None."""
    status, _ = http(f"https://www.youtube.com/shorts/{vid}", follow=False, timeout=15)
    if status == 200:
        return True
    if 300 <= status < 400:
        return False
    return None


def oembed(vid: str) -> tuple[bool, str | None]:
    """(삭제·비공개 여부, 현재 제목). oEmbed가 401(비공개·퍼가기 금지)·404(삭제)면 사라진 것으로 본다."""
    url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(f"https://www.youtube.com/watch?v={vid}")
    status, body = http(url, timeout=15)
    if status in (401, 404):
        return True, None
    if status == 200:
        try:
            return False, json.loads(body).get("title")
        except ValueError:
            pass
    return False, None


def main() -> int:
    site = json.loads(SITE.read_text(encoding="utf-8"))
    yt = site.get("youtube", {})
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"videos": []}

    channel_id = yt.get("channelId") or old.get("channelId") or ""
    if not channel_id:
        channel_id = resolve_channel_id(yt.get("handle", "")) or ""
        if not channel_id:
            note("채널 ID를 찾지 못했습니다. data/site.json 의 youtube.channelId 에 UC로 시작하는 ID를 넣어주세요.")
            return 1
        print(f"채널 ID 확인: {channel_id}")

    try:
        fresh = fetch_rss(channel_id)
    except RuntimeError as exc:
        # RSS가 막혔을 때(2025-12 이후 간헐적 404 보고) 채널 페이지에서 읽고, 새 영상만 상세 정보를 가져온다
        note(f"{exc} → 채널 페이지에서 영상 목록을 읽습니다")
        fresh = fetch_channel_pages(channel_id)
        known = {v["id"]: v for v in old.get("videos", []) if isinstance(v, dict)}
        for v in fresh:
            if v["id"] not in known or not known[v["id"]].get("published"):
                v.update(fetch_watch_details(v["id"]))
                time.sleep(0.3)
        if not fresh and not old.get("videos"):
            note("채널에서 공개 영상을 찾지 못했습니다 (아직 공개 영상이 없거나 유튜브가 응답을 막았습니다)")
        if WATCH_FAIL:
            note("영상 상세(게시일·설명란)를 읽지 못한 영상: " + ", ".join(f"{k} {v}개" for k, v in WATCH_FAIL.items()))
    api_key = os.environ.get("YT_API_KEY", "").strip()
    if api_key:
        try:
            fresh = fetch_api_all(channel_id, api_key) + fresh
        except Exception as exc:  # API 실패해도 RSS 결과로 계속 진행
            print(f"Data API 건너뜀: {exc}", file=sys.stderr)

    by_id = {v["id"]: v for v in old.get("videos", []) if isinstance(v, dict) and v.get("id")}
    now = time.time()
    for i, v in enumerate(fresh):  # 앞쪽(최신)일수록 늦은 시각 → 최신순 정렬이 유지됨
        if v["id"] not in by_id:
            v["firstSeen"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - i))
    feed_ids = set()
    for v in fresh:
        feed_ids.add(v["id"])
        cur = by_id.get(v["id"], {})
        # 피드에 있는 영상은 제목·설명을 피드 값으로 갱신 (설명을 지운 경우도 반영)
        merged = {**cur, **{k: val for k, val in v.items() if val is not None and (val != "" or k == "description")}}
        by_id[v["id"]] = merged

    for vid, v in by_id.items():
        if v.get("isShort") is None:
            v["isShort"] = is_short(vid)
            time.sleep(0.3)

    # 피드(최근 15개)에 없는 예전 영상은 매시간 30개씩 돌아가며 삭제·비공개 여부와 제목 변경을 확인
    older = sorted(i for i in by_id if i not in feed_ids)
    batch = 30
    start = (int(time.time() // 3600) * batch) % max(len(older), 1)
    removed = []
    for vid in (older[start:] + older[:start])[:batch]:
        gone, title = oembed(vid)
        if gone:
            removed.append(vid)
        elif title and title != by_id[vid].get("title"):
            by_id[vid]["title"] = title
        time.sleep(0.2)
    # API 키가 있으면 모든 영상의 공개 상태를 매번 확인 — 비공개·일부 공개·삭제 영상을 바로 뺀다
    if api_key and by_id:
        public = api_public_ids(sorted(by_id), api_key)
        if public is not None:
            removed += [vid for vid in by_id if vid not in public and vid not in removed]
    for vid in removed:
        by_id.pop(vid, None)

    def when(v):  # 게시일(시간대 포함 가능)을 UTC 기준 문자열로 맞추고, 없으면 처음 발견한 시각
        p = v.get("published") or ""
        m = re.match(r"(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2}))?", p)
        return (m.group(1) + "T" + (m.group(2) or "00:00:00")) if m else (v.get("firstSeen") or "")
    videos = sorted(by_id.values(), key=when, reverse=True)
    if videos == old.get("videos") and channel_id == old.get("channelId"):
        print(f"변경 없음 ({len(videos)}개)")
        return 0

    out = {"channelId": channel_id, "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "videos": videos}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    added = len(set(by_id) - {v["id"] for v in old.get("videos", [])})
    print(("::notice::" if GHA else "") + f"영상 목록 갱신: 총 {len(videos)}개 (신규 {added}, 제거 {len(removed)})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # 실패 이유를 Actions 화면에 남김
        note(f"영상 수집 실패: {exc}")
        sys.exit(1)
