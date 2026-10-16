#!/usr/bin/env python3
"""매물별 상세 페이지(public/listing/<번호>.html), sitemap.xml, robots.txt 를 생성하고
광고 명시사항(공인중개사법 제18조의2, 시행령 제17조의2, 국토부 고시 명시사항 세부기준) 누락을 점검한다.
표준 라이브러리만 사용.

    python3 scripts/build.py           # 미리보기용: 전체 생성 + 경고 출력
    python3 scripts/build.py --check   # 점검만 (파일 생성 안 함)
    python3 scripts/build.py --prod    # 배포용(dist/): 샘플·계약완료·명시사항 누락 매물 제외.
                                       #   사무소 명시사항이 비어 있으면 배포 중단(exit 1)
    (--gha 를 함께 주면 GitHub Actions 주석 형식으로 출력)
"""
from __future__ import annotations

import json
import re
import shutil
import struct
import sys
from datetime import date
from html import escape
from urllib.parse import quote
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public"
DATA = PUB / "data"
DIST = ROOT / "dist"

PY = 0.3025
# 영상 제목·설명의 "No.1001", "매물번호 1001, 1002" (영단어 속 'no'는 제외)
NO_RE = re.compile(r"(?<![A-Za-z])(?:No\.?|매물\s*번호)\s*[:#.]?\s*(\d{3,6}(?:\s*[,·/]\s*\d{3,6})*)", re.I)
GHA = "--gha" in sys.argv
WARN = "::warning::" if GHA else "경고: "
ERR = "::error::" if GHA else "오류: "


def load(name, default=None):
    p = DATA / name
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"{ERR}data/{name} {e.lineno}번째 줄 {e.colno}번째 글자 근처 형식 오류 (쉼표·따옴표·괄호 확인): {e.msg}")
        sys.exit(1)


def money(n):
    if n is None or n == "":
        return ""
    n = int(n)
    eok, rest = divmod(n, 10000)
    if eok and rest:
        return f"{eok}억\u00a0{rest:,}만원"
    if eok:
        return f"{eok}억원"
    return f"{rest:,}만원"


def price_text(l):
    if l.get("deal") in ("월세", "단기임대"):
        if l.get("deposit") is None and l.get("monthly") is None:
            return "가격 문의"
        return f"보증금\u00a0{money(l.get('deposit') or 0)} / 월\u00a0{money(l.get('monthly') or 0)}"
    if l.get("deal") == "전세":
        v = l.get("deposit") if l.get("deposit") is not None else l.get("price")
        return money(v) if v is not None else "가격 문의"
    return money(l["price"]) if l.get("price") is not None else "가격 문의"


def area_text(m2):
    if m2 in (None, ""):
        return ""
    m2 = float(m2)
    py = f"{m2 * PY:,.1f}".rstrip("0").rstrip(".")
    return f"{m2:,.2f}".rstrip("0").rstrip(".") + f"㎡\u00a0({py}평)"


def region_text(r, with_ri=True):
    """소재지 표시. 지번은 비공개가 원칙 — showJibun 이 true 인 매물만 지번을 붙인다 (그 외에는 리까지)."""
    r = r or {}
    keys = ["sido", "sigungu", "eupmyeon"] + (["ri"] if with_ri else [])
    out = " ".join(r.get(k) for k in keys if r.get(k))
    if with_ri and r.get("jibun") and r.get("showJibun") is True:
        out += " " + str(r["jibun"])
    return out


DIRECTION_BASIS = "건물 정면 기준"


def direction_text(d, basis=None):
    """방향: 건물이 바라보는 방향. 기준이 적혀 있지 않으면 '(건물 정면 기준)'을 붙인다."""
    d = str(d or "").strip()
    if not d or "기준" in d:
        return d
    return f"{d}({basis or DIRECTION_BASIS})"


def link_videos(listings, videos, hidden=()):
    by_no = {}
    for l in listings:
        l["videoIds"] = [v for v in l.get("videoIds") or [] if v not in hidden]
        by_no.setdefault(l.get("no"), l)
    for v in videos:
        if v.get("id") in hidden:
            continue
        text = f"{v.get('title', '')}\n{v.get('description', '')}"
        for m in NO_RE.finditer(text):
            for num in re.findall(r"\d{3,6}", m.group(1)):
                l = by_no.get(int(num))
                if l is not None and v["id"] not in l["videoIds"]:
                    l["videoIds"].append(v["id"])


# ── 입력값 정규화: 손으로 고친 JSON의 흔한 실수(문자열 숫자, 띄어쓴 상태값, URL 형태 영상 등)를 바로잡고
#    고칠 수 없는 값은 '_issues'(게시 불가 사유)로 남긴다. '_'로 시작하는 키는 배포 데이터에 쓰지 않는다.
YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
YT_URL = re.compile(r"(?:youtu\.be/|[?&]v=|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})")
DONE_WORDS = {"계약완료", "거래완료", "완료", "판매완료", "매매완료", "임대완료"}
LIVE_WORDS = {"", "거래중", "판매중", "광고중"}
PHOTO_OK = re.compile(r"^images/(?!.*\.\.)[^<>\"'\\:?#]+\.(?:jpe?g|png|webp|gif)$", re.I)


def yt_id(x):
    x = str(x or "").strip()
    if YT_ID.match(x):
        return x
    m = YT_URL.search(x)
    return m.group(1) if m else None


def to_num(v):
    """숫자로 바꿀 수 있으면 (값, True), 비어 있으면 (None, True), 숫자가 아니면 (None, False)"""
    if v is None or isinstance(v, bool):
        return None, v is None
    if isinstance(v, (int, float)):
        return v, True
    if isinstance(v, str):
        t = v.replace(",", "").strip()
        if t == "":
            return None, True
        try:
            f = float(t)
            return (int(f) if f.is_integer() else f), True
        except ValueError:
            return None, False
    return None, False


def as_list(v):
    if v is None or v == "":
        return []
    if isinstance(v, str):
        return [x.strip() for x in v.split(",") if x.strip()]
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return []


def normalize(raw, warns):
    l = dict(raw) if isinstance(raw, dict) else {}
    issues = []
    no, ok = to_num(l.get("no"))
    if not ok or no is None or not float(no).is_integer() or no <= 0:
        issues.append("매물번호(no)는 양의 정수여야 합니다")
        l["no"] = str(l.get("no"))
    else:
        l["no"] = int(no)
    tag = f"매물 No.{l['no']}"
    st = re.sub(r"\s+", "", str(l.get("status") or ""))
    if st in DONE_WORDS:
        l["status"] = "계약완료"
    elif st in LIVE_WORDS:
        l["status"] = "거래중"
    else:
        issues.append(f"상태값 '{l.get('status')}' 을(를) 알 수 없습니다 — '거래중' 또는 '계약완료'로 적어 주세요")
    if not isinstance(l.get("title"), str) or not l["title"].strip():
        issues.append("제목(title)")
        l["title"] = str(l.get("title") or "")
    for k in ("summary", "description", "type", "deal"):
        l[k] = "" if l.get(k) is None else str(l.get(k)).strip()
    for k in ("price", "deposit", "monthly"):
        v, ok = to_num(l.get(k))
        if not ok:
            issues.append(f"가격 항목 {k} '{l.get(k)}' — 숫자(만원)만 적어 주세요 ('협의'·'비공개'·범위 불가)")
        l[k] = v
    reg = l.get("region") if isinstance(l.get("region"), dict) else {}
    l["region"] = {k: (v if isinstance(v, bool) else "" if v is None else str(v).strip()) for k, v in reg.items()}
    sj = l["region"].pop("showJibun", False)
    l["region"].pop("hideJibun", None)  # 예전 필드 (지번은 비공개가 원칙)
    l["region"]["showJibun"] = sj is True or (isinstance(sj, str) and sj.lower() in ("true", "1", "예", "y"))
    for part, num_keys in (("land", ("area",)), ("building", ("area", "totalFloors", "rooms", "baths", "parking"))):
        d = l.get(part)
        if not isinstance(d, dict) or not d:
            l[part] = None
            continue
        d = dict(d)
        for k in num_keys:
            v, ok = to_num(d.get(k))
            if not ok:
                issues.append(f"{'토지' if part == 'land' else '건물'} {k} '{d.get(k)}' — 숫자만 적어 주세요 (예: 562.0)")
            d[k] = v
        for k, v in list(d.items()):
            if k not in num_keys and v is not None and not isinstance(v, (bool, str)):
                d[k] = str(v)
        l[part] = d
    for k in ("features", "recommendedUse", "photos"):
        l[k] = as_list(l.get(k))
    good = [p for p in l["photos"] if PHOTO_OK.match(p)]
    for bad in set(l["photos"]) - set(good):
        warns.append(f"{tag}: 사진 경로 '{bad}' 는 사용할 수 없어 제외합니다 (images/파일명.jpg 형식)")
    l["photos"] = good
    vids = []
    for x in as_list(l.get("videoIds")):
        i = yt_id(x)
        if i:
            vids.append(i)
        else:
            warns.append(f"{tag}: 영상 '{x}' 에서 유튜브 영상 ID를 찾지 못해 제외합니다")
    l["videoIds"] = list(dict.fromkeys(vids))
    lat, ok1 = to_num(l.get("lat"))
    lng, ok2 = to_num(l.get("lng"))
    if lat is None or lng is None or not (ok1 and ok2) or not (33 <= lat <= 39 and 124 <= lng <= 132):
        if l.get("lat") not in (None, "") or l.get("lng") not in (None, ""):
            warns.append(f"{tag}: 좌표(lat/lng)가 올바르지 않아 지도에서 제외합니다")
        lat = lng = None
    l["lat"], l["lng"] = (float(lat), float(lng)) if lat is not None else (None, None)
    l["featured"], l["urgent"], l["sample"] = bool(l.get("featured")), bool(l.get("urgent")), bool(l.get("sample"))
    l["_issues"] = issues
    return l


def normalize_all(listings, warns):
    if not isinstance(listings, list):
        print(f"{ERR}data/listings.json 은 [ ... ] 목록이어야 합니다")
        sys.exit(1)
    out = [normalize(x, warns) for x in listings]
    counts = {}
    for l in out:
        counts[l["no"]] = counts.get(l["no"], 0) + 1
    for l in out:
        if counts[l["no"]] > 1:
            l["_issues"].append(f"매물번호 중복 ({counts[l['no']]}건) — 번호를 하나씩만 쓰세요")
    return out


# 매물 영상 판별: 제목·설명에 면적(㎡·평)이 있고, 가격·매물 해시태그·사무소 서명 중 하나가 함께 있으면 매물 영상
AREA_RE = re.compile(r"\d[\d,]*(?:\.\d+)?\s*(?:㎡|m²|평)")
PRICE_RE = re.compile(r"\d+\s*억|\d[\d,]*\s*만\s*원|\d+\s*천(?!\s*원)")
TAG_RE = re.compile(r"#\S*(?:토지|전원주택|임야|농가|매매|전세|월세|상가|쉼터)|가야공인중개사")


def is_listing_video(v, linked_ids=frozenset(), force_in=frozenset(), force_out=frozenset()):
    if v.get("id") in force_out:
        return False
    if v.get("id") in force_in or v.get("id") in linked_ids or cited_numbers(v):
        return True
    t = v.get("title", "")
    return bool(AREA_RE.search(t) and (PRICE_RE.search(t) or TAG_RE.search(t)))


def cited_numbers(v):
    text = f"{v.get('title', '')}\n{v.get('description', '')}"
    return {int(n) for m in NO_RE.finditer(text) for n in re.findall(r"\d{3,6}", m.group(1))}


def filter_videos(videos, live_nos, blocked_vids, closed=()):
    """매물번호를 언급하는 영상은 그 번호가 모두 게시 중인 매물일 때만 남긴다 (계약완료 영상 노출 방지)."""
    kept, dropped = [], []
    for v in videos:
        nums = cited_numbers(v)
        if v["id"] in blocked_vids or (nums & set(closed)) or (nums and not nums <= live_nos):
            dropped.append(v["id"])
        else:
            kept.append(v)
    return kept, dropped


def public_copy(l):
    """배포 데이터용 사본: 내부 키('_')를 빼고, 지번은 공개 표시하는 매물(showJibun)만 남긴다 (지번 비공개 원칙)."""
    out = {k: v for k, v in l.items() if not k.startswith("_")}
    r = dict(out.get("region") or {})
    if not r.get("showJibun"):
        r.pop("jibun", None)
    out["region"] = r
    return out


# ── 광고 명시사항 점검
# 근거: 공인중개사법 제18조의2, 시행령 제17조의2, 국토부 고시 「중개대상물의 표시·광고 명시사항 세부기준」(제2024-748호, 2025.1.1. 시행)
OFFICE_REQUIRED = {"name": "중개사무소 명칭", "address": "소재지", "tel": "연락처", "regNo": "등록번호", "ceo": "개업공인중개사 성명"}
BUILDING_REQUIRED = {
    "area": "전용면적", "totalFloors": "총 층수", "approvalDate": "사용승인일(사용검사일·준공인가일)",
    "direction": "방향(기준 포함)", "baths": "욕실 수", "parking": "주차대수", "moveIn": "입주가능일",
}
# 주택(준주택 포함)만 방 수·관리비 필수 (비주택 건축물은 생략 가능 — 2025.1.1. 개정)
RESIDENTIAL_WORDS = ("주택", "아파트", "빌라", "연립", "다세대", "다가구", "원룸", "오피스텔", "펜션",
                     "고시원", "다중생활", "기숙사", "주상복합", "노인복지", "공관")
# 단독주택 판정 (지번은 사무소 원칙상 비공개 — 리까지 표시)
DANDOK_WORDS = ("단독", "전원주택", "농가주택", "다가구", "다중주택", "공관")
# 공동주택·준주택: 동·층수 표시 (층수는 저/중/고로 대체 가능)
APT_WORDS = ("아파트", "빌라", "연립", "다세대", "오피스텔", "주상복합", "도시형")
# 건축물대장 주용도 (건축법 시행령 별표1)
BUILDING_USES = {"단독주택", "공동주택", "제1종 근린생활시설", "제2종 근린생활시설", "문화 및 집회시설", "종교시설", "판매시설",
                 "운수시설", "의료시설", "교육연구시설", "노유자시설", "수련시설", "운동시설", "업무시설", "숙박시설", "위락시설",
                 "공장", "창고시설", "위험물 저장 및 처리 시설", "자동차 관련 시설", "동물 및 식물 관련 시설", "자원순환 관련 시설",
                 "교정시설", "국방·군사시설", "방송통신시설", "발전시설", "묘지 관련 시설", "관광 휴게시설", "장례시설", "야영장 시설"}
MOVE_IN_OK = re.compile(r"즉시|^\d{4}[-.]\s?\d{1,2}[-.]\s?\d{1,2}\.?$|\d{1,2}\s*월\s*(초|중|하)")

JIMOK = {"전", "답", "과수원", "목장용지", "임야", "광천지", "염전", "대", "공장용지", "학교용지", "주차장", "주유소용지", "창고용지",
         "도로", "철도용지", "제방", "하천", "구거", "유지", "양어장", "수도용지", "공원", "체육용지", "유원지", "종교용지", "사적지", "묘지", "잡종지"}
ZONING = {"제1종전용주거지역", "제2종전용주거지역", "제1종일반주거지역", "제2종일반주거지역", "제3종일반주거지역", "준주거지역",
          "중심상업지역", "일반상업지역", "근린상업지역", "유통상업지역", "전용공업지역", "일반공업지역", "준공업지역",
          "보전녹지지역", "생산녹지지역", "자연녹지지역", "보전관리지역", "생산관리지역", "계획관리지역", "농림지역", "자연환경보전지역"}


def is_residential(l):
    use = (l.get("building") or {}).get("use") or ""
    return use in ("단독주택", "공동주택") or any(w in (l.get("type") or "") for w in RESIDENTIAL_WORDS)


def is_dandok(l):
    use = (l.get("building") or {}).get("use") or ""
    return bool(l.get("building")) and (use == "단독주택" or any(w in (l.get("type") or "") for w in DANDOK_WORDS))


def is_apartment(l):
    use = (l.get("building") or {}).get("use") or ""
    return bool(l.get("building")) and (use == "공동주택" or any(w in (l.get("type") or "") for w in APT_WORDS))


def maintenance_won(text):
    """'월 25만원', '120,000원' 같은 관리비 문구에서 월 금액(원)을 읽는다. 못 읽으면 None"""
    t = str(text or "").replace(",", "")
    m = re.search(r"(\d+(?:\.\d+)?)\s*만\s*원?", t)
    if m:
        return float(m.group(1)) * 10000
    m = re.search(r"(\d{4,})\s*원", t)
    return float(m.group(1)) if m else None


def has_single_price(l):
    """단일가격 표시 여부 (값은 normalize() 이후 숫자 또는 None)"""
    pos = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0
    deal = l.get("deal")
    if deal in ("월세", "단기임대"):
        return isinstance(l.get("deposit"), (int, float)) and l["deposit"] >= 0 and pos(l.get("monthly"))
    if deal == "전세":
        return pos(l.get("deposit")) or pos(l.get("price"))
    return pos(l.get("price"))


def office_problems(site):
    o = site.get("office", {})
    return [f"사무소 명시사항 누락: {label} (data/site.json office.{k})" for k, label in OFFICE_REQUIRED.items() if not o.get(k)]


def listing_problems(l):
    """광고에 반드시 필요한 항목 중 빠진 것 목록 (비어 있으면 게시 가능)."""
    p = list(l.get("_issues") or [])
    r = l.get("region") or {}
    if not (r.get("sido") and r.get("sigungu") and r.get("eupmyeon")):
        p.append("소재지(시도·시군구·읍면동)")
    elif str(r.get("eupmyeon")).endswith(("읍", "면")) and not r.get("ri"):
        p.append("소재지의 리(里) — 읍·면 지역은 리까지 적어야 합니다")
    if not l.get("type"):
        p.append("중개대상물 종류")
    if not l.get("deal"):
        p.append("거래 형태")
    if not has_single_price(l):
        p.append("가격(단일가격 — '비공개'·'협의' 불가)")
    land, b = l.get("land") or {}, l.get("building")
    if not b and not land.get("area"):
        p.append("토지 면적")
    if land and not b and not land.get("jimok"):
        p.append("지목")
    if b:
        need = dict(BUILDING_REQUIRED)
        if is_residential(l):
            need.update({"rooms": "방 수", "maintenance": "관리비"})
        if is_apartment(l):
            need["floor"] = "해당 층(저/중/고 가능)"
        p += [f"건축물 {label}" for k, label in need.items() if b.get(k) in (None, "")]
        if b.get("moveIn") and not MOVE_IN_OK.search(str(b["moveIn"])):
            p.append("입주가능일 형식 — '즉시입주', '2026-11-01', 협의 가능하면 '11월 중순'")
        won = maintenance_won(b.get("maintenance"))
        if won is not None and won >= 100000 and not re.search(r"일반관리비|사용료", str(b.get("maintenance"))):
            p.append("관리비 세부내역 — 정액 월 10만원 이상이면 일반관리비·사용료(전기·수도·가스 등)·기타관리비로 나눠 적기")
    return p


def check(site, listings):
    warns = office_problems(site)
    for l in listings:
        tag = f"매물 No.{l.get('no')}"
        if l.get("status") == "계약완료":
            warns.append(f"{tag}: 계약완료 — 배포본에서 제외됩니다(통보 후 3일 내 삭제 의무). 유튜브 영상도 비공개 처리하세요")
            continue
        if l.get("sample"):
            warns.append(f"{tag}: 샘플 매물 — 배포본에서 제외됩니다(존재하지 않는 매물 광고 금지)")
        miss = listing_problems(l)
        if miss:
            warns.append(f"{tag}: 명시사항 누락 → 배포본에서 제외됩니다: {', '.join(miss)}")
        land = l.get("land") or {}
        if land.get("jimok") and land["jimok"] not in JIMOK:
            warns.append(f"{tag}: 지목 '{land['jimok']}' 은(는) 28개 법정 지목이 아닙니다 (예: 대, 전, 답, 임야)")
        for z in [x.strip() for x in (land.get("zoning") or "").split(",") if x.strip()]:
            if z not in ZONING:
                warns.append(f"{tag}: 용도지역 '{z}' 표기를 확인하세요 (예: 계획관리지역, 자연녹지지역)")
        b = l.get("building") or {}
        if b and not b.get("use"):
            warns.append(f"{tag}: 건축물대장 주용도(building.use, 예: 단독주택·제2종 근린생활시설)를 적으면 매물 종류가 더 정확히 표시됩니다")
        elif b.get("use") and b["use"] not in BUILDING_USES:
            warns.append(f"{tag}: 건축물 용도 '{b['use']}' 는 건축법상 용도 이름이 아닙니다 (예: 단독주택, 제1종 근린생활시설)")
    return warns


def publishable(l):
    return l.get("status") != "계약완료" and not l.get("sample") and not listing_problems(l)


def key_facts(l):
    """상세 상단 핵심 정보 한 줄: 대지·건물 면적, 방/욕실, 지목·용도지역, 도로"""
    land, b = l.get("land") or {}, l.get("building") or {}
    parts = []
    if land.get("area"):
        parts.append(("대지\u00a0" if b else "토지\u00a0") + area_text(land["area"]))
    if b.get("area"):
        parts.append("건물(전용)\u00a0" + area_text(b["area"]))
    rb = "\u00a0·\u00a0".join(x for x in [f"방\u00a0{b['rooms']}" if b.get("rooms") is not None else "",
                                          f"욕실\u00a0{b['baths']}" if b.get("baths") is not None else ""] if x)
    if rb:
        parts.append(rb)
    if not b:
        parts += [x for x in [land.get("jimok"), land.get("zoning")] if x]
    if land.get("road"):
        parts.append(land["road"])
    return " · ".join(parts)


def rows(l):
    r = []
    land = l.get("land") or {}
    if land:
        r.append(("토지", None))
    if land.get("area"):
        r.append(("토지 면적", area_text(land["area"])))
    for k, label in [("jimok", "지목"), ("zoning", "용도지역"), ("currentUse", "현 이용상태"), ("road", "도로 조건")]:
        if land.get(k):
            r.append((label, land[k]))
    b = l.get("building") or {}
    if b:
        r.append(("건물", None))
        if b.get("violation"):
            r.append(("위반건축물", "건축물대장상 위반건축물"))
        if b.get("area"):
            r.append(("전용면적", area_text(b["area"])))
        floors = " / ".join(x for x in [f"총 {b['totalFloors']}층" if b.get("totalFloors") else "", f"해당 {b['floor']}" if b.get("floor") else ""] if x)
        if floors:
            r.append(("층수", floors))
        if b.get("approvalDate") not in (None, ""):
            r.append(("사용승인일", str(b["approvalDate"])))
        if b.get("direction"):
            r.append(("방향", direction_text(b["direction"])))
        if b.get("rooms") is not None:
            r.append(("방", f"{b['rooms']}개"))
        if b.get("baths") is not None:
            r.append(("욕실", f"{b['baths']}개"))
        if b.get("parking") is not None:
            r.append(("주차", f"{b['parking']}대"))
        for k, label in [("moveIn", "입주가능일"), ("maintenance", "관리비")]:
            if b.get(k) not in (None, ""):
                r.append((label, str(b[k])))
    use = (l.get("building") or {}).get("use")
    kind = f"{l.get('type', '')} (건축물대장: {use})" if use and use != l.get("type") else l.get("type", "")
    r += [("거래 정보", None), ("매물번호", f"No.{l['no']}"), ("거래 형태", l.get("deal", "")), ("가격", price_text(l)),
          ("매물 종류", kind), ("소재지", region_text(l.get("region")))]
    if l.get("recommendedUse"):
        r.append(("추천 용도", ", ".join(l["recommendedUse"])))
    if l.get("updated"):
        r.append(("정보 갱신일", l["updated"]))
    return r


def seo_title(l, o):
    """검색 결과용 제목: 지역 + 종류 + 거래 + 면적 + 가격 | 상호"""
    r = l.get("region") or {}
    where = " ".join(x for x in [(r.get("sigungu") or "").removesuffix("군").removesuffix("시"), r.get("eupmyeon"), r.get("ri")] if x)
    land_a, bld_a = (l.get("land") or {}).get("area"), (l.get("building") or {}).get("area")
    size = f" 대지 {area_text(land_a)}" if land_a and bld_a else f" {area_text(land_a)}" if land_a else f" 전용 {area_text(bld_a)}" if bld_a else ""
    return f"{where} {l.get('type', '')} {l.get('deal', '')}{size} {price_text(l)} | No.{l['no']} {o.get('name', '')}".strip()


ICON = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 11.5 12 4l9 7.5V20h-6v-5H9v5H3z" fill="currentColor"/></svg>'
FONT_URL = "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
# 글꼴 CSS는 첫 화면 표시를 막지 않도록 비동기로 불러온다 (못 불러오면 기본 글꼴)
FONT = (f'<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>\n'
        f'  <link rel="stylesheet" href="{FONT_URL}" media="print" onload="this.media=\'all\'">\n'
        f'  <noscript><link rel="stylesheet" href="{FONT_URL}"></noscript>')


def header_html(root, o, current=""):
    tel = o.get("tel", "")
    items = [("매물", f"{root}#listings"), ("영상", f"{root}videos.html"), ("매물 접수", f"{root}sell.html"), ("사무소 소개", f"{root}about.html")]
    nav = "".join(f'<a href="{h}"{" aria-current=page" if k == current else ""}>{k}</a>' for k, h in items)
    return f"""<header class="top">
    <div class="wrap top-in">
      <a class="brand" href="{root}"><span class="logo" aria-hidden="true">{ICON}</span><span>{escape(o.get('name', ''))}</span></a>
      <nav class="nav" aria-label="주 메뉴">{nav}</nav>
      <a class="tel-btn" href="tel:{re.sub(r'[^0-9+]', '', tel)}">{escape(tel)}</a>
    </div>
  </header>"""


def office_spans(o):
    items = [("상호", o.get("name")), ("대표", o.get("ceo")), ("등록번호", o.get("regNo")), ("소재지", o.get("address")),
             ("연락처", " / ".join(x for x in [o.get("tel"), o.get("mobile")] if x))]
    return "".join(f"<span><b>{k}</b> {escape(v) if v else '<em class=missing>입력 필요</em>'}</span>" for k, v in items)


def footer_html(root, o):
    return f"""<footer class="foot">
    <div class="wrap">
      <nav class="foot-nav" aria-label="하단 메뉴"><a href="{root}#listings">매물</a><a href="{root}videos.html">영상</a><a href="{root}sell.html">매물 접수</a><a href="{root}about.html">사무소 소개</a><a data-youtube href="#" target="_blank" rel="noopener">유튜브</a></nav>
      <p class="office-info" id="officeInfo">{office_spans(o)}</p>
      <p class="muted small">매물 정보는 갱신일 기준이며, 계약 전 반드시 현장과 공부서류를 확인하시기 바랍니다. © {date.today().year} {escape(o.get('name', ''))}</p>
    </div>
  </footer>"""


def office_dl(o):
    items = [("상호", o.get("name")), ("대표", o.get("ceo")), ("등록번호", o.get("regNo")), ("소재지", o.get("address")),
             ("연락처", " / ".join(x for x in [o.get("tel"), o.get("mobile")] if x))]
    return "".join(f"<dt>{k}</dt><dd>{escape(v) if v else '<em class=missing>입력 필요</em>'}</dd>" for k, v in items)


def nw_join(text):
    """' · '로 구분된 항목을 각각 줄바꿈 없는 묶음으로 (숫자와 ㎡ 사이에서 끊기지 않게)"""
    return " · ".join(f'<span class="nw">{escape(x)}</span>' for x in text.split(" · "))


def ld_json(obj):
    # <script> 안에 넣는 JSON: <, >, & 를 모두 유니코드 이스케이프 (</script>, <!-- 로 깨지지 않게)
    return json.dumps(obj, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def agent_ld(site):
    o = site["office"]
    base = (site.get("siteUrl") or "").rstrip("/")
    ld = {"@context": "https://schema.org", "@type": "RealEstateAgent", "name": o.get("name"),
          "telephone": o.get("tel"), "url": base + "/" if base else None,
          "address": {"@type": "PostalAddress", "streetAddress": o.get("address"), "addressCountry": "KR"} if o.get("address") else None,
          "image": base + "/images/og.png" if base else None,
          "sameAs": [youtube_url(site)] if youtube_url(site) else None}
    if o.get("lat") is not None and o.get("lng") is not None:
        ld["geo"] = {"@type": "GeoCoordinates", "latitude": o["lat"], "longitude": o["lng"]}
    return {k: v for k, v in ld.items() if v}


def page(l, site, videos_by_id):
    o = site["office"]
    base = (site.get("siteUrl") or "").rstrip("/")
    tel = o.get("tel", "")
    tel_href = "tel:" + re.sub(r"[^0-9+]", "", tel)
    sms_to = re.sub(r"[^0-9+]", "", o.get("mobile") or tel)
    title = seo_title(l, o)
    desc = f"[{l.get('deal', '')}] {l.get('type', '')} {region_text(l.get('region'), True)} · {price_text(l)}. {l.get('summary', '')} 문의 {tel}".strip()
    photos = l.get("photos") or []
    vids = l.get("videoIds") or []
    img = (f"{base}/{photos[0]}" if base else f"../{photos[0]}") if photos else (f"https://i.ytimg.com/vi/{vids[0]}/hqdefault.jpg" if vids else (f"{base}/images/og.png" if base else ""))
    url = f"{base}/listing/{l['no']}.html" if base else ""
    head_extra = (f'<link rel="canonical" href="{escape(url)}">\n  <meta property="og:url" content="{escape(url)}">\n  ' if url else "") + \
                 (f'<meta property="og:image" content="{escape(img)}">\n  ' if img else "")

    video_html = "".join(
        f'<div class="yt{" yt-short" if (videos_by_id.get(v) or {}).get("isShort") else ""}" data-yt="{escape(v)}" data-title="{escape((videos_by_id.get(v) or {}).get("title", l["title"]))}">'
        f'<noscript><a href="https://www.youtube.com/watch?v={escape(v)}">유튜브에서 영상 보기</a></noscript></div>'
        for v in vids)
    gallery = "".join(f'<img src="../{escape(p)}" alt="{escape(l["title"])} 사진 {i + 1}" loading="lazy" decoding="async">' for i, p in enumerate(photos))
    spec = "".join(f'<tr class="grp"><th colspan="2" scope="colgroup">{escape(k)}</th></tr>' if v is None else
                   f"<tr><th scope=row>{escape(k)}</th><td>{escape(v)}</td></tr>" for k, v in rows(l))
    tags = "".join(f"<li>{escape(t)}</li>" for t in l.get("features") or [])
    b = l.get("building") or {}
    badges = "".join([
        '<span class="b b-urgent">급매</span>' if l.get("urgent") else "",
        '<span class="b b-feat">추천</span>' if l.get("featured") else "",
        '<span class="b b-video">▶ 영상</span>' if vids else "",
        '<span class="b b-viol">위반건축물</span>' if b.get("violation") else "",
    ])
    listing_ld = {
        "@context": "https://schema.org", "@type": "RealEstateListing", "name": l["title"], "description": desc,
        "url": url or None, "datePosted": l.get("updated"), "image": img or None,
        "offers": {"@type": "Offer", "priceCurrency": "KRW", "price": int((l.get("price") if l.get("price") is not None else l.get("deposit")) * 10000),
                   "seller": {"@type": "RealEstateAgent", "name": o.get("name"), "telephone": tel}}
        if l.get("deal") in ("매매", "전세") and (l.get("price") is not None or l.get("deposit") is not None) else None,
    }
    crumbs_ld = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "홈", "item": (base + "/") if base else None},
        {"@type": "ListItem", "position": 2, "name": l.get("type", ""), "item": (f"{base}/?type={l.get('type', '')}#listings") if base else None},
        {"@type": "ListItem", "position": 3, "name": f"No.{l['no']}"}]}
    for it in crumbs_ld["itemListElement"]:
        if not it.get("item"):
            it.pop("item", None)
    listing_ld = {k: v for k, v in listing_ld.items() if v}
    has_pos = l.get("lat") is not None and l.get("lng") is not None
    region_q = escape(l.get("type", ""))

    return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(title)}</title>
  <meta name="description" content="{escape(desc)}">
  <meta name="theme-color" content="#1f3a5f">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="ko_KR">
  <meta name="twitter:card" content="summary_large_image">
  <meta property="og:site_name" content="{escape(o.get('name', ''))}">
  <meta property="og:title" content="{escape(l['title'])} · {escape(price_text(l))}">
  <meta property="og:description" content="{escape(desc)}">
  {head_extra}<link rel="icon" href="../images/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="../images/apple-touch-icon.png">
  {FONT}
  <link rel="stylesheet" href="../assets/css/style.css">
  <script type="application/ld+json">{ld_json(listing_ld)}</script>
  <script type="application/ld+json">{ld_json(crumbs_ld)}</script>
</head>
<body data-root="../" data-page="listing" data-no="{int(l['no'])}">
  <a class="skip" href="#main">본문 바로가기</a>
  {header_html("../", o, "매물")}
  <main class="wrap page" id="main">
    <nav class="crumbs" aria-label="현재 위치"><a href="../">홈</a> › <a href="../?type={region_q}#listings">{escape(l.get('type', ''))}</a> › No.{l['no']}</nav>
    <div class="detail">
      <div>
        <div class="badges">{badges}</div>
        <p class="meta"><span class="deal deal-{escape(l.get('deal', ''))}">{escape(l.get('deal', ''))}</span> {escape(l.get('type', ''))} · {escape(region_text(l.get('region'), True))} · No.{l['no']}</p>
        <h1>{escape(l['title'])}</h1>
        <p class="price">{escape(price_text(l))}</p>
        {f'<p class="keyfacts">{nw_join(key_facts(l))}</p>' if key_facts(l) else ''}
        {f'<p class="muted">{escape(l["summary"])}</p>' if l.get('summary') else ''}
        <div class="detail-actions">
          <button class="btn ghost" type="button" id="share">공유하기</button>
          <button class="btn ghost" type="button" id="print">인쇄 · PDF</button>
        </div>
        {f'<section class="videos-stack" aria-label="현장 영상">{video_html}</section>' if video_html else ''}
        {f'<div class="gallery">{gallery}</div>' if gallery else ''}
        <section class="box"><h2>매물 정보</h2><table class="spec"><tbody>{spec}</tbody></table>
          <p class="disclaimer">토지 면적은 토지대장, 건물 면적은 건축물대장 기준이며 실제 경계·면적과 다를 수 있습니다. 계약 전 공부서류와 현장을 반드시 확인하세요.</p></section>
        {f'<section class="box"><h2>상세 설명</h2><p class="desc">{escape(l.get("description", ""))}</p>' + (f'<ul class="tags">{tags}</ul>' if tags else '') + '</section>' if l.get('description') or tags else ''}
        {f'<section class="box" id="lmapBox" hidden><h2>위치</h2><div id="lmap" class="map map-sm" data-lat="{float(l["lat"])}" data-lng="{float(l["lng"])}"></div><p class="muted small">위치는 대략적인 표시이며, 정확한 위치는 상담 시 안내해 드립니다.</p></section>' if has_pos else ''}
      </div>
      <aside class="sticky-cta">
        <div class="panel">
          <h2 class="h3">이 매물 문의하기</h2>
          <p class="muted">문의 시 매물번호를 말씀해 주세요: <b>No.{l['no']}</b></p>
          <a class="tel-big" href="{tel_href}">{escape(tel)}</a>
          {f'<a class="tel-sub" href="tel:{sms_to}">{escape(o["mobile"])}</a>' if o.get('mobile') else ''}
          <div class="two">
            <a class="btn gold" href="sms:{sms_to}?&body={quote('[가야공인중개사] 매물 No.' + str(l['no']) + ' 문의드립니다.')}">문자 문의</a>
            <a class="btn navy" data-kakao href="#" target="_blank" rel="noopener">카카오톡</a>
          </div>
        </div>
        <div class="panel office-box"><h2 class="h3">중개사무소 정보</h2><dl>{office_dl(o)}</dl></div>
      </aside>
    </div>
    <section class="related" id="related" hidden aria-labelledby="relTitle">
      <div class="sec-head"><h2 id="relTitle">비슷한 매물</h2><a class="more-link" href="../#listings">전체 매물 보기 →</a></div>
      <div class="cards" id="relCards"></div>
    </section>
  </main>
  {footer_html("../", o)}
  <nav class="mbar" aria-label="빠른 연락">
    <a href="{tel_href}"><span aria-hidden="true">☎</span> 전화</a>
    <a href="sms:{sms_to}?&body={quote('[가야공인중개사] 매물 No.' + str(l['no']) + ' 문의드립니다.')}"><span aria-hidden="true">✉</span> 문자</a>
    <a data-kakao href="#" target="_blank" rel="noopener">카톡</a>
  </nav>
  <script src="../assets/js/common.js"></script>
  <script src="../assets/js/listing.js"></script>
</body>
</html>
"""


def inject_static(out, site):
    """배포본 HTML에 사무소 명시사항(정적)·구조화 데이터·절대 URL 메타를 넣는다 (JS 없이도 보이도록)."""
    o = site["office"]
    base = (site.get("siteUrl") or "").rstrip("/")
    for f in out.glob("*.html"):
        html = f.read_text(encoding="utf-8")
        html = html.replace("<!--office-->", office_spans(o))
        if f.name == "404.html":
            html = html.replace('href="/" data-home', f'href="{escape(base)}/" data-home' if base else 'href="/" data-home')
            html = html.replace("tel:0317722060", "tel:" + re.sub(r"[^0-9+]", "", o.get("tel", "")))
            html = html.replace("전화 031-772-2060", "전화 " + escape(o.get("tel", "")))
        if f.name == "index.html":
            html = html.replace("<!--jsonld-->", f'<script type="application/ld+json">{ld_json(agent_ld(site))}</script>')
        if base:
            path = "" if f.name == "index.html" else f.name
            html = html.replace("<!--head-->", f'<link rel="canonical" href="{escape(base)}/{path}">\n  <meta property="og:url" content="{escape(base)}/{path}">')
            html = html.replace('content="images/og.png"', f'content="{escape(base)}/images/og.png"')
        f.write_text(html, encoding="utf-8")


def youtube_url(site):
    h = str((site.get("youtube") or {}).get("handle") or "").strip()
    if not h:
        return ""
    return "https://www.youtube.com/" + (h if h.startswith("@") else "@" + h)


# ── 사진 메타데이터 제거: 휴대폰 사진의 GPS(정확한 위치)·촬영기기 정보를 배포본에서 지운다.
#    JPEG는 회전 정보(Orientation)만 남기고 EXIF/XMP를 제거, PNG·WebP는 메타데이터 덩어리를 제거.
def _jpeg_orientation(app1):
    try:
        t = app1[6:]
        e = "<" if t[:2] == b"II" else ">"
        ifd = struct.unpack(e + "I", t[4:8])[0]
        n = struct.unpack(e + "H", t[ifd:ifd + 2])[0]
        for i in range(n):
            ent = t[ifd + 2 + 12 * i: ifd + 14 + 12 * i]
            if struct.unpack(e + "H", ent[:2])[0] == 0x0112:
                return struct.unpack(e + "H", ent[8:10])[0]
    except (struct.error, IndexError):
        pass
    return 1


def strip_jpeg(b):
    if b[:2] != b"\xff\xd8":
        return None
    out, i = bytearray(b[:2]), 2
    while i + 4 <= len(b):
        if b[i] != 0xFF:
            return None
        marker = b[i + 1]
        if marker == 0xDA:  # 영상 데이터 시작 — 나머지는 그대로
            out += b[i:]
            return bytes(out)
        size = struct.unpack(">H", b[i + 2:i + 4])[0]
        seg = b[i:i + 2 + size]
        payload = seg[4:]
        if marker == 0xE1 and payload.startswith(b"Exif\x00\x00"):
            o = _jpeg_orientation(payload)
            if o != 1:
                mini = b"Exif\x00\x00MM\x00\x2a" + struct.pack(">I", 8) + struct.pack(">H", 1) + struct.pack(">HHI", 0x0112, 3, 1) + struct.pack(">HH", o, 0) + struct.pack(">I", 0)
                out += b"\xff\xe1" + struct.pack(">H", len(mini) + 2) + mini
        elif marker == 0xE1 or marker == 0xED or marker == 0xFE:  # XMP, Photoshop/IPTC, 주석
            pass
        else:
            out += seg
        i += 2 + size
    return None


def strip_png(b):
    if b[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    out, i = bytearray(b[:8]), 8
    while i + 8 <= len(b):
        n = struct.unpack(">I", b[i:i + 4])[0]
        typ = b[i + 4:i + 8]
        chunk = b[i:i + 12 + n]
        if typ not in (b"eXIf", b"tEXt", b"zTXt", b"iTXt"):
            out += chunk
        i += 12 + n
        if typ == b"IEND":
            break
    return bytes(out)


def strip_webp(b):
    if b[:4] != b"RIFF" or b[8:12] != b"WEBP":
        return None
    out, i = bytearray(), 12
    while i + 8 <= len(b):
        typ = b[i:i + 4]
        n = struct.unpack("<I", b[i + 4:i + 8])[0]
        chunk = bytearray(b[i:i + 8 + n + (n & 1)])
        if typ == b"VP8X" and len(chunk) > 8:
            chunk[8] &= ~0x0C & 0xFF  # EXIF·XMP 플래그 해제
        if typ not in (b"EXIF", b"XMP "):
            out += chunk
        i += 8 + n + (n & 1)
    return b"RIFF" + struct.pack("<I", len(out) + 4) + b"WEBP" + bytes(out)


def strip_photo_metadata(folder):
    done, warns = 0, []
    for f in sorted(folder.rglob("*")):
        ext = f.suffix.lower()
        if ext in (".heic", ".heif"):
            warns.append(f"{f.name}: HEIC 사진은 대부분의 브라우저에서 보이지 않습니다. JPG로 바꿔 올려 주세요")
            continue
        fn = {".jpg": strip_jpeg, ".jpeg": strip_jpeg, ".png": strip_png, ".webp": strip_webp}.get(ext)
        if not fn:
            continue
        b = f.read_bytes()
        nb = fn(b)
        if nb is None:
            warns.append(f"{f.name}: 사진 형식을 확인할 수 없어 메타데이터를 지우지 못했습니다")
        elif nb != b:
            f.write_bytes(nb)
            done += 1
    return done, warns


def main():
    prod = "--prod" in sys.argv
    site = load("site.json")
    if not isinstance(site, dict) or not isinstance(site.get("office"), dict):
        print(f"{ERR}data/site.json 에 office 정보가 없습니다")
        return 1
    global DIRECTION_BASIS
    DIRECTION_BASIS = str((site.get("policy") or {}).get("directionBasis") or DIRECTION_BASIS)
    warns = []
    listings = normalize_all(load("listings.json", []), warns)
    vdata = load("videos.json", {"videos": []})
    videos = [v for v in (vdata.get("videos") if isinstance(vdata, dict) else []) or [] if isinstance(v, dict) and YT_ID.match(str(v.get("id", "")))]
    hidden = site.get("hiddenVideos") or []
    hidden = {yt_id(x) for x in ([hidden] if isinstance(hidden, str) else hidden)} - {None}
    link_videos(listings, videos, hidden)

    for w in warns + check(site, listings):
        print(WARN + w)
    if "--check" in sys.argv:
        return 0

    out = PUB
    if prod:
        errs = office_problems(site)
        if errs:
            for e in errs:
                print(ERR + e)
            print(ERR + "사무소 명시사항이 모두 채워져야 배포됩니다. 배포를 중단합니다.")
            return 1
        # 배포본은 dist/ 에 따로 만든다 (원본 public/ 은 건드리지 않음)
        out = DIST
        if out.exists():
            shutil.rmtree(out)
        shutil.copytree(PUB, out, ignore=shutil.ignore_patterns("listing", "sitemap.xml", "robots.txt"))
        live_nos = {l["no"] for l in listings if publishable(l)}
        closed = {int(x) for x in site.get("closedListingNos") or [] if str(x).isdigit()}
        blocked_vids = {v for l in listings if l["no"] not in live_nos for v in l.get("videoIds") or []}
        yt = site.get("youtube") or {}
        force_in = {yt_id(x) for x in as_list(yt.get("listingVideos"))} - {None}
        force_out = {yt_id(x) for x in as_list(yt.get("notListingVideos"))} - {None}
        linked = {v for l in listings if l["no"] in live_nos for v in l.get("videoIds") or []}
        # 홈페이지에는 본편(쇼츠 제외) 매물 영상만 싣는다 — 쇼츠 여부가 확인되지 않은 영상도 제외
        non_listing = [v["id"] for v in videos if v.get("isShort") is not False or not is_listing_video(v, linked, force_in, force_out)]
        if non_listing:
            print(f"쇼츠·정보 영상 등 {len(non_listing)}개는 홈페이지에 싣지 않습니다 (본편 매물 영상만 게시)")
        videos = [v for v in videos if v["id"] not in set(non_listing)]
        kept, dropped = filter_videos(videos, live_nos, blocked_vids, closed)
        if dropped:
            print(f"광고할 수 없는 매물(계약완료·샘플·명시사항 누락·목록에 없는 번호)을 소개하는 영상 {len(dropped)}개를 배포본에서 뺐습니다: {', '.join(dropped)}")
        vjson = dict(vdata) if isinstance(vdata, dict) else {}
        vjson["videos"] = kept
        (out / "data" / "videos.json").write_text(json.dumps(vjson, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        videos = kept
        listings = [l for l in listings if publishable(l)]
        (out / "data" / "listings.json").write_text(json.dumps([public_copy(l) for l in listings], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        inject_static(out, site)
        n, pw = strip_photo_metadata(out / "images")
        for w in pw:
            print(WARN + w)
        if n:
            print(f"사진 {n}장의 위치(GPS)·촬영 정보를 지웠습니다")

    pages = out / "listing"
    if pages.exists():
        shutil.rmtree(pages)
    pages.mkdir()
    vid_by_id = {v["id"]: v for v in videos}
    made = []
    for l in listings:
        if not isinstance(l.get("no"), int):
            continue
        try:
            (pages / f"{l['no']}.html").write_text(page(l, site, vid_by_id), encoding="utf-8")
            made.append(l)
        except Exception as e:  # 미리보기는 건너뛰고 계속, 배포는 중단(이전 배포가 그대로 유지됨)
            print(f"{ERR}매물 No.{l.get('no')} 상세 페이지를 만들지 못했습니다: {e}")
            if prod:
                return 1
    listings = made

    base = (site.get("siteUrl") or "").rstrip("/")
    if base:
        today = date.today().isoformat()
        valid = lambda d: d if re.match(r"^\d{4}-\d{2}-\d{2}$", str(d or "")) else today
        newest = max([valid(l.get("updated")) for l in listings] or [today])
        urls = [(f"{base}/", newest), (f"{base}/videos.html", today), (f"{base}/sell.html", None), (f"{base}/about.html", None)] + \
               [(f"{base}/listing/{l['no']}.html", valid(l.get("updated"))) for l in listings]
        sm = "".join(f"<url><loc>{escape(u)}</loc>" + (f"<lastmod>{m}</lastmod>" if m else "") + "</url>" for u, m in urls)
        (out / "sitemap.xml").write_text(f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{sm}</urlset>\n', encoding="utf-8")
    (out / "robots.txt").write_text("User-agent: *\nAllow: /\nDisallow: /admin/\n" + (f"Sitemap: {base}/sitemap.xml\n" if base else ""), encoding="utf-8")
    print(f"{'배포용(dist/)' if prod else '미리보기용(public/)'} 상세 페이지 {len(listings)}개 생성")
    return 0


if __name__ == "__main__":
    sys.exit(main())
