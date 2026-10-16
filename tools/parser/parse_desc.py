#!/usr/bin/env python3
"""PROTOTYPE (배포 안 됨) — 유튜브 제목·설명란에서 매물 정보를 자동 추출 (표준 라이브러리만 사용).
홈페이지 빌드·자동화에서 쓰지 않는다. 설명은 tools/parser/README.md, 조사 결과는 docs/research/02-영상-설명란-분석.md.

    python3 -B tools/parser/parse_desc.py [videos.json] [build.py] [out.json]   (저장소 최상위에서)

1) ◑/▶/●/■ 로 시작하는 '마커 줄'(키 : 값)을 먼저 읽고
2) 비어 있는 항목만 제목·설명 본문(자유 문장)에서 보충한다.
각 항목의 출처는 src[필드] = marker | marker-extra | text | title | hashtag | computed | inferred 로 남긴다.

지번은 절대 출력하지 않는다(발견되면 flags 에 'jibun_in_source' 만 남김).
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from datetime import date
from pathlib import Path

PY = 0.3025
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent  # 저장소 최상위 (tools/parser/ 의 두 단계 위)
VIDEOS = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "public" / "data" / "videos.json"
BUILD = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "scripts" / "build.py"
OUT = Path(sys.argv[3]) if len(sys.argv) > 3 else HERE / "extracted.json"  # 저장소에 올리지 않는 결과물 — 필요하면 세 번째 인자로 다른 곳에
TODAY = date(2026, 10, 16)


def load_build():
    """build.py 의 판별 함수(is_listing_video 등)를 그대로 쓰기 위해 읽기 전용으로 불러온다 (pyc 안 만듦)."""
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("gaya_build", BUILD)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ───────────────────────── 기본 사전 ─────────────────────────
YP_EUPMYEON = ["양평읍", "강상면", "강하면", "양서면", "옥천면", "서종면", "단월면", "청운면", "양동면", "지평면", "용문면", "개군면"]
LEGAL_ZONING = ["제1종전용주거지역", "제2종전용주거지역", "제1종일반주거지역", "제2종일반주거지역", "제3종일반주거지역", "준주거지역",
                "중심상업지역", "일반상업지역", "근린상업지역", "유통상업지역", "전용공업지역", "일반공업지역", "준공업지역",
                "보전녹지지역", "생산녹지지역", "자연녹지지역", "보전관리지역", "생산관리지역", "계획관리지역", "농림지역", "자연환경보전지역"]
DIR_NORM = {"동남향": "남동향", "서남향": "남서향", "동북향": "북동향", "서북향": "북서향"}

# 마커 줄의 키 → 표준 필드 (긴 것부터 비교)
KEY_ALIASES = {
    "no": ["매물번호", "매물 번호", "No"],
    "name": ["매물이름", "매물명"],
    "addr": ["소재지", "위치", "주소"],
    "type": ["매물종류", "매물 종류", "종류"],
    "deal": ["거래형태", "거래 형태"],
    "price": ["매매가", "매매금액", "금액", "가격", "전세가", "보증금"],
    "monthly": ["월세", "월 임대료"],
    "land_area": ["토지면적", "토지 면적", "토지 합계", "매매면적", "대지면적", "면적"],
    "daeji_part": ["대지로 쓰는 면적", "대지"],
    "nongji_part": ["농지"],
    "river": ["함께 쓰는 하천부지", "하천부지"],
    "bldg_area": ["건축면적", "건물면적", "연면적", "전용면적", "건평", "주택"],
    "rooms": ["방/욕실", "방수", "방"],
    "direction": ["방향"],
    "parking": ["주차대수", "주차"],
    "zoning": ["용도지역", "용도구역", "토지이용계획", "지역지구"],
    "bcr": ["건폐율"],
    "road": ["진입도로", "도로"],
    "infra": ["기반시설", "수도", "식수", "물"],
    "heating": ["난방"],
    "hotwater": ["온수"],
    "built": ["사용승인일", "사용승인", "준공"],
    "structure": ["구조"],
    "split": ["분할 매매", "분할매매", "분할"],
    "access": ["교통", "접근", "생활권"],
    "includes": ["매매 포함"],
    "composition": ["구성"],
    "solar": ["태양광"],
    "terrain": ["지형"],
    "floors": ["총층수", "총 층수", "층수"],
    "move_in": ["입주가능일", "입주"],
    "maintenance": ["관리비"],
}
ALIAS_LIST = sorted(((a, f) for f, al in KEY_ALIASES.items() for a in al), key=lambda x: -len(x[0]))
MARK_RE = re.compile(r"^\s*[◑▶●■◆◎☞]\s*(.*)$")

# 금액(만원): 'X억 Y천만', 'X억 Y,000만', 'X억Y천', 'Y천만', 'Z만' — 'N천 원'(=N천원)은 금액이 아님
AMT_RE = re.compile(
    r"(?P<eok>\d+(?:\.\d+)?)\s*억(?:\s*(?P<a>\d[\d,]*)\s*(?P<au>천|만))?(?:\s*만)?(?:\s*원)?(?P<dae>\s*대)?"
    r"|(?P<c>\d[\d,]*)\s*천(?=\s*만)\s*만(?:\s*원)?"
    r"|(?P<c2>\d[\d,]*)\s*천(?!\s*원|\s*만|\s*\d)"
    r"|(?P<m>\d[\d,]*(?:\.\d+)?)\s*만(?:\s*원)?"
)
AREA_RE = re.compile(r"(?P<approx>약\s*)?(?P<n>\d[\d,]*(?:\.\d+)?)\s*(?P<u>㎡|m²|m2|제곱미터|평방미터|평)(?!당)")
DONE_RE = re.compile(r"(?:매매|계약|거래|판매|매도|임대)\s*완료")
URL_RE = re.compile(r"https?://\S+")


def num(s):
    return float(str(s).replace(",", ""))


def nice(x):
    if x is None:
        return None
    x = round(float(x), 2)
    return int(x) if x.is_integer() else x


# ───────────────────────── 금액 ─────────────────────────
def amounts(text):
    """[(만원, start, end, approx_dae)] — 'N천 원'처럼 원 단위 금액은 제외"""
    out = []
    for m in AMT_RE.finditer(text):
        if m.group("eok"):
            v = num(m.group("eok")) * 10000
            if m.group("a"):
                v += num(m.group("a")) * (1000 if m.group("au") == "천" else 1)
            out.append((v, m.start(), m.end(), bool(m.group("dae"))))
        elif m.group("c"):
            out.append((num(m.group("c")) * 1000, m.start(), m.end(), False))
        elif m.group("c2"):
            out.append((num(m.group("c2")) * 1000, m.start(), m.end(), False))
        elif m.group("m"):
            out.append((num(m.group("m")), m.start(), m.end(), False))
    return out


def strip_parens(s):
    prev = None
    while prev != s:
        prev, s = s, re.sub(r"\([^()]*\)", " ", s)
    return s


def top_parens(s):
    """가장 바깥 괄호 안의 글 목록 (중첩 허용)"""
    out, depth, start = [], 0, 0
    for i, ch in enumerate(s):
        if ch == "(":
            if depth == 0:
                start = i + 1
            depth += 1
        elif ch == ")" and depth:
            depth -= 1
            if depth == 0:
                out.append(s[start:i])
    return out


def parse_price(val):
    """가격 줄 하나 → dict(price, per_py, range, prev, alt, approx, note)"""
    r = {}
    main = strip_parens(val)
    parens = top_parens(val)
    # 평당/㎡당 단가
    per = re.search(r"평당\s*약?\s*(\d[\d,]*(?:\.\d+)?)\s*만\s*원?(?:\s*[~\-]\s*(\d[\d,]*)\s*만\s*원?)?", val)
    if per:
        r["per_py"] = nice(num(per.group(1)))
        if per.group(2):
            r["per_py_range"] = [nice(num(per.group(1))), nice(num(per.group(2)))]
    per_eok = re.search(r"평당\s*(\d+)\s*억\s*(\d[\d,]*)?\s*만?", val)
    if per_eok:  # '평당1억4000만원' 같은 오기
        r["per_py_suspect"] = per_eok.group(0)
    main_wo_per = re.sub(r"평당\s*약?\s*[\d,.]+\s*(?:억\s*[\d,]*\s*)?만\s*원?(?:\s*[~\-]\s*[\d,]+\s*만\s*원?)?|㎡당\s*약?\s*[\d,.]+\s*만(?:\s*\d+\s*천)?\s*원?", " ", main)
    am = amounts(main_wo_per)
    if len(am) >= 2 and re.search(r"~", main_wo_per[am[0][2]:am[1][1]]):
        r["range"] = [nice(am[0][0]), nice(am[1][0])]
    elif len(am) >= 2 and (re.search(r"-{2,}|→|=>|➡", main_wo_per[am[0][2]:am[1][1]]) or re.match(r"\s*으로", main_wo_per[am[-1][2]:])):
        r["price"], r["prev"] = nice(am[-1][0]), nice(am[0][0])
    elif am:
        r["price"] = nice(am[0][0])
        if am[0][3]:
            r["approx"] = "대"
    for p in parens:
        pa = amounts(re.sub(r"㎡당.*|평당.*", "", strip_parens(p)))
        if not pa:
            continue
        if "인하" in p or "에서" in p:
            r["prev"] = nice(pa[0][0])
        elif "~" in p and len(pa) >= 2:
            r["range"] = [nice(pa[0][0]), nice(pa[1][0])]
        else:
            ar = AREA_RE.search(p)
            p = strip_parens(p) if not ar else p
            r.setdefault("alt", []).append({"price": nice(pa[0][0]), "label": re.sub(r"\s+", " ", p).strip()[:60],
                                            "area_m2": nice(area_m2(ar)) if ar else None})
    if "협의" in val:
        r["negotiable"] = True
    return r


# ───────────────────────── 면적 ─────────────────────────
def area_m2(m):
    n = num(m.group("n"))
    return n / PY if m.group("u") == "평" else n


def measures(text):
    """'677㎡ (205평)' 처럼 ㎡·평이 짝을 이루면 한 측정값으로 묶는다 → [{m2, py, computed, approx, start}]"""
    ms = list(AREA_RE.finditer(text))
    out, i = [], 0
    while i < len(ms):
        a = ms[i]
        rec = {"start": a.start(), "approx": bool(a.group("approx"))}
        if a.group("u") != "평":
            rec["m2"] = num(a.group("n"))
            if i + 1 < len(ms) and ms[i + 1].group("u") == "평" and ms[i + 1].start() - a.end() <= 3:
                rec["py"] = num(ms[i + 1].group("n"))
                i += 1
            rec["computed"] = False
        else:
            rec["py"] = num(a.group("n"))
            rec["m2"] = rec["py"] / PY
            rec["computed"] = True
        out.append(rec)
        i += 1
    return out


def py_mismatch(mm):
    return mm.get("py") and not mm["computed"] and abs(mm["m2"] * PY - mm["py"]) / mm["py"] > 0.02


# ───────────────────────── 소재지 ─────────────────────────
JIBUN_RE = re.compile(r"(?:산\s*)?\d+(?:-\d+)?(?:\s*번지)?(?:\s*외\s*\d+\s*필지)?")


def parse_addr(s):
    """소재지 문자열 → (region dict, flags). 지번·괄호 안내문은 버린다."""
    flags = []
    note = [p for p in re.findall(r"\(([^()]*)\)", s) if not re.search(r"문의|안내|상세", p)]
    t = strip_parens(s)
    reg = {}
    m = re.search(r"(경기도|경기)\s*", t)
    if m:
        reg["sido"] = "경기도"
    m = re.search(r"(양평군|양평)(?=\s|$|[가-힣]{1,3}[읍면])", t)
    if m:
        reg["sigungu"] = "양평군"
    m = re.search(r"([가-힣]{1,3}[읍면])(?![가-힣])", t)
    if m and (m.group(1) in YP_EUPMYEON or reg.get("sigungu") != "양평군"):
        reg["eupmyeon"] = m.group(1)
        rest = t[m.end():]
        mr = re.match(r"\s*([가-힣]{1,4}리)(?![가-힣])", rest)
        if mr:
            reg["ri"] = mr.group(1)
            rest = rest[mr.end():]
            mv = re.match(r"\s*([가-힣]{1,5}마을)", rest)
            if mv:
                reg["village"] = mv.group(1)
                rest = rest[mv.end():]
        if re.match(r"\s*" + JIBUN_RE.pattern + r"(?![㎡평])", rest) and re.search(r"\d", rest[:12]):
            flags.append("jibun_in_source")
    if reg.get("eupmyeon") in YP_EUPMYEON and "sigungu" not in reg:
        reg["sigungu"] = "양평군"
        flags.append("sigungu_inferred")
    if reg.get("sigungu") == "양평군" and "sido" not in reg:
        reg["sido"] = "경기도"
        flags.append("sido_inferred")
    if note:
        reg["note"] = ", ".join(n.strip() for n in note if n.strip())
    return reg, flags


# ───────────────────────── 기타 항목 ─────────────────────────
def parse_rooms(val):
    rooms = baths = None
    for seg in re.split(r"/|(?<!\d)\.(?!\d)|\.(?=[가-힣])", val):
        target = "baths" if re.search(r"욕실|화장실", seg) else "rooms"
        pairs = re.findall(r"(\d+)\s*층\s*(\d+)\s*개?", seg)
        n = None
        if pairs:
            n = sum(int(b) for _, b in pairs)
        else:
            m = (re.search(r"(?:욕실|화장실)\s*(\d+)", seg) if target == "baths" else re.search(r"(?<!다락)방\s*(\d+)", seg)) \
                or re.search(r"(\d+)\s*개", seg)
            n = int(m.group(1)) if m else None
        if n is not None:
            if target == "baths":
                baths = n
            else:
                rooms = n
    return rooms, baths


def parse_direction(val, key_basis=None):
    m = re.search(r"(정)?([동서남북]{1,2})향", val)
    if not m:
        return None
    d = m.group(2) + "향"
    d = DIR_NORM.get(d, d)
    basis = key_basis or (re.search(r"\(([^()]*기준)\)", val) or [None, None])[1]
    out = {"value": d, "raw": m.group(0)}
    if basis:
        out["basis"] = basis.strip()
    if re.search(r"가능", val[m.end():m.end() + 4]):
        out["conditional"] = True
    return out


def parse_zoning(val):
    raw = val.strip()
    legal, other = [], []
    t = raw.replace(" ", "")
    for z in LEGAL_ZONING:
        if z in t:
            legal.append(z)
    for short, full in (("계획관리", "계획관리지역"), ("생산관리", "생산관리지역"), ("보전관리", "보전관리지역"), ("자연녹지", "자연녹지지역")):
        if short in t and full not in legal:
            legal.append(full)
    if re.search(r"제?1종주거", t) and not any("1종" in z for z in legal):
        other.append("제1종(일반/전용 미상)주거지역")
    for w in ("농업진흥지역", "농업진흥구역", "농업보호구역", "농업보호", "자연취락지구", "도시지역"):
        if w in t and not any(w in o for o in other):
            other.append(w if w != "농업보호" or "농업보호구역" in t else "농업보호(구역)")
    if "자연환경보전" in t and "자연환경보전지역" not in legal:
        legal.append("자연환경보전지역")
    return {"raw": raw, "legal": legal, "other": [o for o in other if o != "농업보호(구역)" or "농업보호구역" not in other]}


def parse_road(val):
    out = {"raw": val.strip()[:80]}
    m = re.search(r"폭\s*(\d+(?:\.\d+)?)\s*(?:m|미터)", val) or re.search(r"(\d+(?:\.\d+)?)\s*m\s*(?:포장)?\s*(?:진입)?\s*도로", val)
    if m:
        out["width_m"] = nice(num(m.group(1)))
    if "포장" in val:
        out["paved"] = "비포장" not in val
    return out


INFRA_WORDS = ["상수도", "하수도", "도시가스", "마을상수도", "지하수", "정화조", "우수관로", "전기", "관로"]


def parse_infra(val):
    found = []
    for w in INFRA_WORDS:
        if w in val and not any(w in f for f in found):
            found.append(w)
    if re.search(r"상하수도", val):
        found += [w for w in ("상수도", "하수도") if w not in found]
    return {"raw": val.strip()[:100], "items": found}


def parse_built(val):
    m = re.search(r"(\d{4})\s*[년.\-]?\s*(\d{1,2})?\s*월?", val)
    if not m:
        return None
    return m.group(1) + (f"-{int(m.group(2)):02d}" if m.group(2) else "")


def floors_from(text):
    m = re.search(r"지상\s*(\d+)\s*층", text)
    if m:
        return int(m.group(1)), "지상N층"
    m = re.search(r"(\d+)\s*층\s*(?:단독주택|주택|근생|건물|전원주택)", text)
    if m:
        return int(m.group(1)), "N층 주택"
    fl = [int(x) for x in re.findall(r"(?<![\d,])(\d)\s*층(?!\s*\d*\s*개)", text)]
    if fl:
        return max(fl), "층별 면적"
    return None, None


# ───────────────────────── 매물종류 ─────────────────────────
ADJ_FOREST = re.compile(r"임야\s*(?:에|와|과)?\s*접(?:한)?|임야접|국유림\s*접|국유지\s*접|자연림")


LAND_RE = re.compile(r"전원주택지|주택지|농지|대지|토지|부지|농막용|주말농장|임야(?!\s*(?:에|와|과)?\s*접)")


def classify_type(text, house_ev=True):
    """문구 → (사이트 매물종류, 세부, 근거단어). 건물 정보가 없으면 땅 단어를 먼저 본다."""
    t = ADJ_FOREST.sub(" ", re.sub(r"#\S+", " ", text))
    if not house_ev:
        m = LAND_RE.search(t)
        if m:
            w = m.group(0)
            if w.startswith("임야"):
                return "임야", "임야", w
            return "토지", {"전원주택지": "전원주택지", "주택지": "전원주택지", "농지": "농지", "대지": "대지"}.get(w, "토지"), w
    if re.search(r"근생|근린생활", t):
        return "상가?", "근린생활시설(주택 겸용 여부 확인)", "근생"
    if "농가주택" in t:
        return "농가주택", "농가주택", "농가주택"
    if re.search(r"전원주택(?!지)", t):
        return "전원주택", "전원주택", "전원주택"
    if "단독주택" in t:
        return "단독주택", "단독주택", "단독주택"
    if re.search(r"전원주택지|주택지", t):
        return "토지", "전원주택지", "전원주택지"
    if re.search(r"농지|대지|토지|부지|농막용|주말농장|밭|논", t):
        w = re.search(r"농지|대지|토지|부지|농막용|주말농장|밭|논", t).group(0)
        return "토지", {"농지": "농지", "대지": "대지"}.get(w, "토지"), w
    if re.search(r"임야|산\b", t):
        return "임야", "임야", "임야"
    if re.search(r"공장|창고", t):
        return "공장·창고", "공장·창고", "공장/창고"
    if re.search(r"상가|점포", t):
        return "상가", "상가", "상가"
    return None, None, None


# ───────────────────────── 사무소 표시 ─────────────────────────
def office_block(desc):
    o = {}
    m = re.search(r"가야\s*공인중개사(?:\s*사무소)?", desc)
    if m:
        o["name"] = re.sub(r"\s+", "", m.group(0)) if "사무소" in m.group(0) else m.group(0)
        o["name_forms"] = sorted(set(re.sub(r"\s+", " ", x) for x in re.findall(r"가야\s*공인중개사(?:\s*사무소)?", desc)))
    if "지평의병로 32" in desc:
        o["address"] = "경기도 양평군 지평면 지평의병로 32"
    if "010-3406-0071" in desc:
        o["tel"] = "010-3406-0071"
    m = re.search(r"(허가등록번호|중개사무소\s*등록번호|등\s*록\s*번\s*호|등록번호|허가번호|중개\s*등록번호)\s*[:：]?\s*(가-)?(\d{3,4}-\d{2,3}(?:-\d{3,5})?)", desc)
    if m:
        o["regNo_raw"] = (m.group(2) or "") + m.group(3)
        o["regNo_label"] = re.sub(r"\s+", "", m.group(1))
        if re.fullmatch(r"\d{3}-\d{2}-\d{5}", m.group(3)):
            o["regNo_problem"] = "사업자등록번호 형식(XXX-XX-XXXXX) — 중개사무소 등록번호(가-3644-198)가 아님"
    elif re.search(r"\(3644-198\)", desc):
        o["regNo_raw"], o["regNo_label"] = "3644-198", "상호 괄호"
    if re.search(r"대\s*표[^\n]{0,20}박\s*홍\s*균|박홍균\s*(?:공인중개사|대표)|공인중개사\s*박홍균", desc):
        o["ceo"] = "박홍균"
    return o


# ───────────────────────── 요약문 ─────────────────────────
BOILER = re.compile(r"^(가야공인중개사 박홍균 블로그|글로 자세히 보기|https?://|\[|#|-{3,}|━|게시일|문의|자세한 내용|\s*•|▶ 본편|본편|※|■|✅|⚠|📌|영상이 도움|공기 좋고)")


def summary(desc):
    for ln in desc.splitlines():
        s = ln.strip().strip('"“”').strip()
        if not s or BOILER.match(s) or MARK_RE.match(ln) or len(s) < 12:
            continue
        s = re.split(r"(?<=[다요까])[.?!]\s|(?<=[.])\s(?=[가-힣])", s)[0]
        return s[:140]
    return None


# ───────────────────────── 한 영상 파싱 ─────────────────────────
def marker_lines(desc):
    """[(field|None, key_raw, key_paren, value, line_no)] — 키 없는 마커 줄은 field=None"""
    out = []
    lines = desc.splitlines()
    for i, ln in enumerate(lines):
        m = MARK_RE.match(ln)
        if not m:
            continue
        body = m.group(1).strip()
        hit = None
        for alias, field in ALIAS_LIST:
            mm = re.match(re.escape(alias) + r"\s*(\([^)]*\))?\s*[:：]?\s*(.*)$", body)
            if mm and (alias != "No" or re.match(r"No\.?\s*\d", body)):
                # '방향'과 '방' 같은 접두 충돌: 키 바로 뒤가 ':' 이나 공백·괄호·숫자여야 함
                nxt = body[len(alias):len(alias) + 1]
                if nxt and not re.match(r"[\s:：(\d/.,]", nxt):
                    continue
                hit = (field, alias, (mm.group(1) or "").strip("() "), mm.group(2).strip())
                break
        if hit:
            out.append((*hit, i))
        else:
            out.append((None, "", "", body, i))
    # 들여쓴 이어지는 줄('     방2.화장실2')은 바로 앞 마커 줄의 덧붙임으로 본다
    cont = []
    for i, ln in enumerate(lines):
        if not MARK_RE.match(ln) and i > 0 and (MARK_RE.match(lines[i - 1]) or (cont and cont[-1][4] == i - 1)) and ln.strip() \
                and not re.match(r"^\s*[-━]{3,}", ln):
            cont.append((None, "", "", ln.strip(), i))
    return out, cont


def parse_video(v):
    title, desc = v.get("title", ""), v.get("description", "") or ""
    F, S, flags = {}, {}, []

    def put(field, value, src):
        if value in (None, "", [], {}):
            return
        if field not in F:
            F[field], S[field] = value, src

    marks, cont = marker_lines(desc)
    extra = [m[3] for m in marks if m[0] is None] + [c[3] for c in cont]
    for field, alias, paren, val, _ in marks:
        if field is None:
            continue
        if not val and field != "bcr":
            if field == "no":
                flags.append("no_marker_empty")
            continue
        if field == "no":
            mm = re.match(r"([가-힣]{0,3})\s*(\d{2,6})", val)
            if mm:
                put("no", {"raw": re.sub(r"\s+", "", mm.group(0)), "prefix": mm.group(1) or None, "num": int(mm.group(2))}, "marker")
        elif field == "name":
            put("name", val, "marker")
        elif field == "addr":
            reg, fl = parse_addr(val)
            put("region", reg, "marker")
            flags += fl
        elif field == "type":
            put("type_raw", val, "marker")
        elif field == "deal":
            put("deal", val.split()[0], "marker")
        elif field == "price":
            p = parse_price(val)
            put("price_raw", val, "marker")
            if alias == "보증금":
                put("deposit", p.get("price"), "marker")
            for k, x in p.items():
                put("price_" + k if k != "price" else "price", x, "marker")
        elif field == "monthly":
            p = parse_price(val)
            put("monthly", p.get("price"), "marker")
        elif field == "land_area":
            ms = measures(val)
            put("land_raw", val, "marker")
            if ms:
                main = ms[0]
                put("land_m2", nice(main["m2"]), "marker" + ("+computed" if main["computed"] else ""))
                if main.get("py"):
                    put("land_py", nice(main["py"]), "marker")
                if py_mismatch(main):
                    flags.append(f"land_m2_py_mismatch:{val}")
                if re.search(r"~", val) and len(ms) >= 2:
                    put("land_range_m2", [nice(ms[0]["m2"]), nice(ms[1]["m2"])], "marker")
                if main["approx"]:
                    flags.append("land_area_approx")
                road = re.search(r"도로\s*지분\s*(\d[\d,.]*\s*(?:㎡|평)[^,)]*)", val)
                if road:
                    rm = measures(road.group(1))
                    put("road_share_m2", nice(rm[0]["m2"]) if rm else None, "marker")
                    put("road_share_included", bool(re.search(r"포함", val)) and "+" not in val, "marker")
                elif re.search(r"도로\s*지분\s*포함", val):
                    put("road_share_included", True, "marker")
                riv = re.search(r"하천부지\s*점용\s*(\d[\d,.]*\s*평)", val)
                if riv:
                    put("river_m2", nice(measures(riv.group(1))[0]["m2"]), "marker+computed")
                for jm, ja in re.findall(r"(대지|전|답|임야)\s*(\d[\d,.]*\s*평)", val):
                    F.setdefault("jimok_parts", []).append({"jimok": {"대지": "대"}.get(jm, jm), "m2": nice(measures(ja)[0]["m2"])})
                    S["jimok_parts"] = "marker"
        elif field in ("daeji_part", "nongji_part"):
            ms = measures(val)
            if ms:
                F.setdefault("jimok_parts", []).append({"jimok": "대" if field == "daeji_part" else "농지(전·답 미상)", "m2": nice(ms[0]["m2"]),
                                                        "label": alias})
                S["jimok_parts"] = "marker"
        elif field == "river":
            ms = measures(val)
            if ms:
                put("river_m2", nice(ms[0]["m2"]), "marker")
                put("river_note", val[:80], "marker")
        elif field == "bldg_area":
            ms = measures(val)
            put("bldg_raw", val, "marker")
            if alias == "주택":
                put("house_hint", True, "marker")
            if ms:
                tot = re.search(r"합계\s*(\d[\d,.]*\s*(?:㎡|평))", val)
                m0 = measures(tot.group(1))[0] if tot else (measures(re.sub(r"\(.*?\)", " ", val)) or ms)[0]
                put("bldg_m2", nice(m0["m2"]), "marker" + ("+computed" if m0["computed"] else ""))
                if re.search(r"\+", val):
                    flags.append("bldg_area_sum_ambiguous")
                if alias == "건축면적" and re.search(r"합계|1층.*2층", val):
                    flags.append("bldg_area_label:건축면적이라 적었지만 층별 합계(연면적)")
            fl, how = floors_from(val)
            if fl:
                put("floors", fl, "marker(" + how + ")")
        elif field == "rooms":
            r_, b_ = parse_rooms(val)
            put("rooms", r_, "marker")
            put("baths", b_, "marker")
        elif field == "direction":
            d = parse_direction(val, paren if "기준" in paren else None)
            put("direction", d, "marker")
        elif field == "parking":
            mm = re.search(r"(\d+)\s*대", val)
            put("parking", int(mm.group(1)) if mm else val, "marker")
        elif field == "zoning":
            put("zoning", parse_zoning(val), "marker")
        elif field == "bcr":
            mm = re.search(r"(\d+)\s*%", val or "")
            m2 = re.search(r"용적[률율]\s*(\d+)\s*%", val or "")
            whole = val
            if not mm:
                mm = re.search(r"(\d+)\s*%", whole)
            put("bcr", int(mm.group(1)) if mm else None, "marker")
            put("far", int(m2.group(1)) if m2 else None, "marker")
        elif field == "road":
            put("road", parse_road(val), "marker")
        elif field == "infra":
            put("infra", parse_infra(val), "marker")
        elif field == "heating":
            put("heating", val, "marker")
        elif field == "built":
            put("built", parse_built(val), "marker")
        elif field == "structure":
            put("structure", val, "marker")
        elif field == "split":
            put("split", val[:120], "marker")
        elif field == "access":
            F.setdefault("access", []).append(val[:120])
            S["access"] = "marker"
        elif field == "floors":
            mm = re.search(r"(\d+)", val)
            put("floors", int(mm.group(1)) if mm else None, "marker")
        elif field == "move_in":
            put("move_in", val, "marker")
        elif field == "maintenance":
            put("maintenance", val, "marker")
        else:
            put(field, val[:120], "marker")

    # 키 없는 마커 줄 / 이어지는 줄: '건폐율 60%, 용적률 200%', '150평 매매가 1억2천만원', '방2.화장실2', ':300평이상 분할가능'
    for x in extra:
        if re.search(r"건폐율", x) and "bcr" not in F:
            mm = re.search(r"건폐율\D*(\d+)\s*%", x)
            m2 = re.search(r"용적[률율]\D*(\d+)\s*%", x)
            put("bcr", int(mm.group(1)) if mm else None, "marker-extra")
            put("far", int(m2.group(1)) if m2 else None, "marker-extra")
        if re.search(r"매매가|매매금액", x) and "price" not in F:
            a = amounts(x)
            if a:
                put("price", nice(a[-1][0]), "marker-extra")
        if re.search(r"분할", x):
            put("split", x.strip(": ")[:120], "marker-extra")
        r_, b_ = parse_rooms(x) if re.search(r"방\s*\d|화장실\s*\d|욕실\s*\d", x) else (None, None)
        put("rooms", r_, "marker-extra")
        put("baths", b_, "marker-extra")
        if re.search(r"지하\s*\d+\s*층|지상\s*\d+\s*층", x):
            fl, how = floors_from(x)
            if fl and "floors" in F and F["floors"] != fl:
                flags.append(f"floors_conflict:{F['floors']} vs {fl}({x[:40]})")
            put("floors", fl, "marker-extra(" + str(how) + ")")
        if "농가주택" in x:
            put("register_use_hint", "농가주택(건축물대장상 표기라고 적힘)", "marker-extra")
        if re.search(r"평당", x) and "price_per_py" not in F:
            p = parse_price(x)
            if p.get("per_py"):
                put("price_per_py", p["per_py"], "marker-extra")

    # ── 자유 문장(제목·본문) 보충 ──
    body = "\n".join(ln for ln in desc.splitlines() if not MARK_RE.match(ln))
    office_cut = re.split(r"━{5,}|-{20,}\n\s*상\s+호|상호[ :]|상\s{3,}호", body)[0]
    # 사무소 줄·해시태그 줄·'• 본편 칩' 줄은 매물 문장이 아니다 (예: '문의:양평 지평 가야공인중개사' → 지평면 오인)
    office_cut = "\n".join(ln for ln in office_cut.splitlines()
                           if not re.search(r"가야\s*공인중개사|010-3406-0071|^\s*문의|등록번호|허가번호|^\s*#|^\s*•|^\s*\S*\s*•", ln))
    title_clean = re.sub(r"#\S+", " ", title)
    text_sources = (("title", title_clean), ("text", office_cut))

    # 쇼츠의 한 줄 요약: '매물번호 금768 / 경기도 양평군 용문면 금곡리 / 집과 땅 2,538㎡(768평) / 매매 4억 9,500만 원'
    for ln in desc.splitlines():
        if ln.count(" / ") >= 2 and re.search(r"매물\s*번호|매매\s*\d|㎡|평\)", ln) and "가야" not in ln:
            for seg in [x.strip() for x in ln.split(" / ")]:
                if re.match(r"매물\s*번호", seg):
                    mm = re.search(r"([가-힣]{0,3})\s?(\d{2,6})", seg[4:])
                    if mm:
                        put("no", {"raw": mm.group(1) + mm.group(2), "prefix": mm.group(1) or None, "num": int(mm.group(2))}, "slash-line")
                elif re.search(r"[읍면]\s*[가-힣]{1,4}리|양평군", seg):
                    reg, fl = parse_addr(seg)
                    put("region", reg, "slash-line")
                elif re.match(r"(매매|전세|월세)\s*\d", seg):
                    put("deal", seg[:2], "slash-line")
                    a = amounts(seg)
                    if a:
                        put("price", nice(a[0][0]), "slash-line")
                elif re.match(r"토지이용계획|용도지역", seg):
                    put("zoning", parse_zoning(re.sub(r"^(토지이용계획|용도지역)\s*", "", seg)), "slash-line")
                elif AREA_RE.search(seg):
                    m0 = measures(seg)[0]
                    put("land_m2", nice(m0["m2"]), "slash-line")
                    if m0.get("py"):
                        put("land_py", nice(m0["py"]), "slash-line")

    if "no" not in F:
        for src, t in text_sources:
            mm = re.search(r"매물\s*번호\s*[:：]?\s*([가-힣]{0,3})\s?(\d{2,6})", t) or re.search(r"(?<![A-Za-z])No\.?\s*()(\d{3,6})", t)
            if mm:
                put("no", {"raw": (mm.group(1) or "") + mm.group(2), "prefix": mm.group(1) or None, "num": int(mm.group(2))}, src)
                break
    if "region" not in F or "ri" not in F.get("region", {}):
        for src, t in text_sources:
            mm = re.search(r"(?:경기도?\s*)?(?:양평군?\s*)?(?:" + "|".join(YP_EUPMYEON) + r")\s*[가-힣]{1,4}리(?![가-힣])(?:\s*[가-힣]{1,5}마을)?", t)
            if mm:
                reg, fl = parse_addr(mm.group(0))
                if "region" not in F:
                    put("region", reg, src)
                elif reg.get("ri") and reg.get("eupmyeon") == F["region"].get("eupmyeon"):
                    F["region"]["ri"] = reg["ri"]
                    S["region"] = S["region"] + "+" + src + "(ri)"
                break
    if "region" not in F:
        for src, t in text_sources:
            mm = re.search(r"(?:경기도?\s*)?(?:양평군?\s*)?(" + "|".join(YP_EUPMYEON) + r")", t)
            if mm:
                reg, fl = parse_addr(mm.group(0))
                put("region", reg, src)
                break
            mm = re.search(r"양평\s*(지평|용문|양동|개군|단월|청운|옥천|서종|양서|강상|강하)(?![면가-힣])", t)
            if mm:
                put("region", {"sido": "경기도", "sigungu": "양평군", "eupmyeon": mm.group(1) + "면"}, src + "-weak")
                break
    if "region" in F and "ri" not in F["region"]:
        tags = re.findall(r"#([가-힣]{1,4}리)(?:전원주택|토지|땅)", desc)
        if tags:
            F["region"]["ri_hashtag"] = tags[0]
            flags.append("ri_only_in_hashtag")

    # 매물종류·지목
    house_ev = any(k in F for k in ("bldg_m2", "rooms", "baths", "built", "house_hint", "heating"))
    if "type_raw" in F:
        t_, sub, w = classify_type(F["type_raw"], house_ev)
        if t_ in ("토지",) and house_ev:
            flags.append("type_conflict:marker says land but building fields present")
        put("type", t_, "marker")
        put("type_detail", sub, "marker")
    if "type" not in F:
        if house_ev:
            t_, sub, w = classify_type(title)
            if not t_ or t_ in ("토지", "임야"):
                t_, sub, w = classify_type(office_cut)
            if t_ in (None, "토지", "임야"):
                t_, sub = "전원주택", "주택(건물 정보로 추정)"
                flags.append("type_inferred_from_building_fields")
            put("type", t_, "title/text" if w else "inferred")
            put("type_detail", sub, "title/text")
        else:
            for src, t in text_sources:
                t_, sub, w = classify_type(t, False)
                if t_:
                    put("type", t_, src)
                    put("type_detail", sub, src)
                    break
    if F.get("type") == "상가?":
        flags.append("type_ambiguous:근생건물(주택 겸용) — 상가/전원주택 판단 필요")
    jm = None
    tr = F.get("type_raw", "") + " " + title + " " + office_cut
    mm = re.search(r"지목\s*[:：]?\s*(대지|대|전|답|임야|잡종지|과수원)", tr)
    if mm:
        jm, jsrc = {"대지": "대"}.get(mm.group(1), mm.group(1)), "marker" if "지목" in F.get("type_raw", "") else "text"
    elif F.get("jimok_parts"):
        js = sorted(set(p["jimok"] for p in F["jimok_parts"]))
        jm, jsrc = "+".join(js), "marker(parts)"
    elif F.get("type_detail") == "농지":
        jm, jsrc = "농지(전·답·과수원 미상)", "inferred"
    if jm:
        put("jimok", jm, jsrc)

    if "deal" not in F:
        for src, t in text_sources:
            mm = re.search(r"매매|전세|월세|임대", t)
            if mm:
                put("deal", {"임대": "임대(형태 미상)"}.get(mm.group(0), mm.group(0)), src)
                break

    # 가격 보충: 제목 → 본문 첫 문단
    if "price" not in F and "price_per_py" not in F and "price_range" not in F:
        for src, t in text_sources:
            t2 = re.sub(r"(전기요금|요금|관리비|세금|양도세)[^\n]{0,15}|\d+\s*(?:천|만원?)\s*(?:인하|할인|다운)", " ", t)
            mm = re.search(r"(?:매매가?|가격|금액)\s*[:：]?\s*(\d[^\n]{0,20})", t2) if src == "text" else None
            p = parse_price(mm.group(1)) if mm and amounts(mm.group(1)) else parse_price(t2.split("\n\n")[0] if src == "text" else t2)
            if p.get("price") and p["price"] >= 1000:
                put("price", p["price"], src)
                if p.get("approx"):
                    put("price_approx", p["approx"], src)
                if p.get("prev"):
                    put("price_prev", p["prev"], src)
                break
            if p.get("per_py"):
                put("price_per_py", p["per_py"], src)
                break
    if "price" in F and S["price"].startswith("marker") is False and "price_approx" in F:
        flags.append("price_only_approx(…억대)")
    if "price_per_py" in F and "price" not in F and "price_range" not in F:
        py = F.get("land_py") or (F["land_m2"] * PY if F.get("land_m2") else None)
        if py:
            if F["price_per_py"] > 1000:
                flags.append(f"price_per_py_implausible:{F['price_per_py']}만원/평 × {nice(py)}평")
            else:
                put("price", nice(F["price_per_py"] * py), "computed(평당×평)")
                flags.append("price_computed_from_per_py")
    if F.get("price_per_py_suspect"):
        flags.append("price_per_py_suspect:" + F["price_per_py_suspect"])
    if True:
        tp = parse_price(re.sub(r"\d+\s*(?:천|만원?)\s*(?:인하|할인|다운)", " ", title_clean))
        if tp.get("price") and F.get("price") and abs(tp["price"] - F["price"]) > 1 and not tp.get("approx"):
            flags.append(f"title_price_differs:{nice(tp['price'])} vs {F['price']}")

    # 면적 보충 (제목)
    if "land_m2" not in F:
        for src, t in text_sources:
            t2 = re.sub(r"건평\s*\d[\d,.]*\s*평|건축면적[^/]*", " ", t)
            ms = measures(t2.split("\n\n")[0] if src == "text" else t2)
            if ms:
                main = ms[0]
                put("land_m2", nice(main["m2"]), src + ("+computed" if main["computed"] else ""))
                if main.get("py"):
                    put("land_py", nice(main["py"]), src)
                break
    for mm_ in measures(title):
        if py_mismatch(mm_):
            flags.append(f"title_m2_py_mismatch:{nice(mm_['m2'])}㎡ vs {nice(mm_['py'])}평")
    if "bldg_m2" not in F:
        mm = re.search(r"건평\s*(\d[\d,.]*)\s*평", title + " " + office_cut)
        if mm:
            put("bldg_m2", nice(num(mm.group(1)) / PY), "title+computed")
    if "floors" not in F and (house_ev or F.get("type") in ("전원주택", "단독주택", "농가주택")):
        fl, how = floors_from((F.get("type_raw") or "") + " " + title)
        if fl:
            put("floors", fl, "title/type(" + how + ")")
    if "floors" not in F and house_ev:
        allm = " ".join(m[3] for m in marks)
        fl = [int(x) for x in re.findall(r"(?<![\d,])(\d)\s*층", allm)]
        if fl:
            put("floors", max(fl), "inferred(마커 줄의 'N층' 언급)")
            flags.append("floors_inferred_from_mentions")
    if "rooms" not in F and house_ev:
        mm = re.search(r"방\s*(\d+)", office_cut)
        if mm:
            put("rooms", int(mm.group(1)), "text")
    if "direction" not in F:
        for src, t in text_sources:
            d = parse_direction(t)
            if d:
                put("direction", d, src)
                break
    if "road" not in F:
        for src, t in text_sources:
            mm = re.search(r"폭\s*\d+(?:\.\d+)?\s*(?:m|미터)[^\n.,#]{0,12}(?:진입\s*도로|진입로|도로)|(?:진입\s*도로|진입로)\s*(?:폭\s*)?\d+(?:\.\d+)?\s*(?:m|미터)[^\n.,#]{0,6}", t)
            if mm:
                put("road", parse_road(mm.group(0)), src)
                break
    if "zoning" not in F:
        for src, t in text_sources:
            mm = re.search(r"(계획관리|생산관리|보전관리|자연녹지|제\s*1\s*종\s*(?:일반|전용)?\s*주거|농업진흥|농업보호)[가-힣]*", t)
            if mm:
                put("zoning", parse_zoning(mm.group(0)), src)
                break
    if "infra" not in F:
        mm = re.search(r"[^\n.]{0,10}(상하수도|상수도|하수도|지하수)[^\n.]{0,20}", office_cut)
        if mm:
            put("infra", parse_infra(mm.group(0)), "text")
    if "bcr" not in F:
        mm = re.search(r"건폐율\s*(\d+)\s*%", office_cut)
        if mm:
            put("bcr", int(mm.group(1)), "text")
    if "split" not in F:
        mm = re.search(r"[^\n.]{0,20}(절반으로 나눠|절반으로 나눈|분할\s*매매|분할매매가능|분할가능|분할 가능)[^\n.]{0,30}", (F.get("type_raw") or "") + "\n" + office_cut)
        if mm:
            put("split", mm.group(0).strip()[:120], "text")
        elif re.search(r"#분할매매", desc):
            put("split", "#분할매매 (해시태그만)", "hashtag")

    # 블로그·참조·완료·인하
    blogs = URL_RE.findall(desc)
    blog = [u for u in blogs if "blog.naver.com" in u]
    if blog:
        u = blog[0].rstrip(".,)")
        trunc = blog[0].endswith("...")
        F["blog"] = {"url": u.rstrip("."), "truncated": trunc,
                     "kind": "post?" if trunc or re.search(r"gayayangpyeong/\d+", u) else "blog-home"}
        S["blog"] = "text"
    refs = re.findall(r"^\s*(?:[^\n•]*?)•\s*(.+?)\s*$", desc, re.M)
    if refs:
        F["refs_titles"] = [r.replace("\xa0", " ").replace("...", "").strip() for r in refs]
        S["refs_titles"] = "text(chip)"
    if re.search(r"\[[^\]]*자동 입력\]", desc):
        flags.append("unfilled_placeholder:" + ",".join(re.findall(r"\[([^\]]*자동 입력)\]", desc)))
    if DONE_RE.search(title) or DONE_RE.search(desc[:300]):
        F["status"], S["status"] = "done", "title/text"
    if re.search(r"인하|급매", title):
        F["price_event"], S["price_event"] = sorted(set(re.findall(r"대폭인하|\d+천인하|급매", title))), "title"
    if len(desc) >= 2000:
        flags.append("description_truncated_at_2000")
    F["summary"], S["summary"] = summary(desc), "text"
    if F.get("summary") and F.get("region", {}).get("eupmyeon"):
        other = [e for e in YP_EUPMYEON if e in F["summary"] and e != F["region"]["eupmyeon"]]
        if other:
            flags.append(f"summary_conflict:요약문은 {other[0]}, 소재지는 {F['region']['eupmyeon']} (복사해 온 옛 문구 의심)")
    F["office"] = office_block(desc)
    hashtags = re.findall(r"#[^\s#]+", desc)
    if hashtags:
        F["hashtags"] = hashtags[:12]
    return F, S, sorted(set(flags))


# ───────────────────────── listings.json 형태로 변환 + 명시사항 점검 ─────────────────────────
def to_listing(v, F):
    reg = {k: F.get("region", {}).get(k) for k in ("sido", "sigungu", "eupmyeon", "ri") if F.get("region", {}).get(k)}
    is_bldg = F.get("type") in ("전원주택", "단독주택", "농가주택", "상가?")
    land = {"area": F.get("land_m2")}
    if F.get("jimok") and "미상" not in F["jimok"] and "+" not in F["jimok"]:
        land["jimok"] = F["jimok"]
    elif F.get("jimok"):
        land["jimok_unverified"] = F["jimok"]
    if F.get("zoning"):
        land["zoning"] = ", ".join(F["zoning"]["legal"]) or None
    if F.get("road"):
        land["road"] = F["road"]["raw"]
    b = None
    if is_bldg:
        d = F.get("direction") or {}
        b = {"use": "단독주택" if F.get("type") in ("전원주택", "단독주택", "농가주택") else "", "area": F.get("bldg_m2"),
             "totalFloors": F.get("floors"), "approvalDate": F.get("built"),
             "direction": (d.get("value", "") + (f"({d['basis']})" if d.get("basis") else "")) or None,
             "rooms": F.get("rooms"), "baths": F.get("baths"), "parking": F.get("parking"),
             "moveIn": F.get("move_in"), "maintenance": F.get("maintenance")}
    return {"no": (F.get("no") or {}).get("num") or 0, "status": "거래중", "title": v["title"][:60],
            "type": (F.get("type") or "").rstrip("?"), "deal": F.get("deal") or "", "price": F.get("price"),
            "region": reg, "land": {k: x for k, x in land.items() if x not in (None, "")} or None, "building": b,
            "summary": F.get("summary") or "", "videoIds": [v["id"]]}


def disclosure(B, v, F):
    """build.py listing_problems() 를 그대로 적용 + 설명란 사무소 명시사항 점검"""
    l = to_listing(v, F)
    warns = []
    nl = B.normalize(l, warns)
    miss = [m for m in B.listing_problems(nl) if not m.startswith("매물번호")]
    o = F.get("office", {})
    office_miss = [lab for k, lab in (("name", "명칭"), ("address", "소재지"), ("tel", "연락처"), ("regNo_raw", "등록번호"), ("ceo", "대표 성명")) if not o.get(k)]
    notes = []
    if o.get("regNo_problem"):
        office_miss.append("등록번호(잘못된 번호)")
    elif o.get("regNo_raw") and not o["regNo_raw"].startswith("가-"):
        notes.append(f"등록번호 '{o['regNo_raw']}' — 등록증 표기(가-3644-198)와 다름")
    if o.get("name") and o["name"] not in ("가야공인중개사사무소",):
        notes.append(f"명칭 표기 '{o['name']}' — site.json 명칭(가야공인중개사사무소)과 다름(등록증 명칭 확인 필요)")
    if F.get("price_range") or (F.get("price_per_py") and S_price_computed(F)):
        notes.append("가격이 단일금액이 아님(범위·평당 단가)")
    return {"listing_missing": miss, "office_missing": office_miss, "notes": notes}


def S_price_computed(F):
    return F.get("_price_src", "").startswith("computed")


# ───────────────────────── 관계(같은 매물) ─────────────────────────
def norm_title(t):
    return re.sub(r"[\s|｜/·.,!?…]+", "", t)


def relations(recs):
    by_id = {r["id"]: r for r in recs}
    parent = {r["id"]: r["id"] for r in recs}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    edges = []
    longs = [r for r in recs if not r["isShort"]]
    # A. 쇼츠 설명란의 본편 칩('• 제목...')
    for r in recs:
        for ref in r["fields"].get("refs_titles", []):
            key = norm_title(ref)[:18]
            for L in longs:
                if L["id"] != r["id"] and key and norm_title(L["title"]).startswith(key):
                    edges.append((r["id"], L["id"], "chip-ref"))
    # B. 같은 매물번호(원문) + 같은 읍면
    for i, a in enumerate(recs):
        for b in recs[i + 1:]:
            na, nb = (a["fields"].get("no") or {}).get("raw"), (b["fields"].get("no") or {}).get("raw")
            ea, eb = a["fields"].get("region", {}).get("eupmyeon"), b["fields"].get("region", {}).get("eupmyeon")
            if na and na == nb and (ea == eb or not ea or not eb):
                edges.append((a["id"], b["id"], f"same-no:{na}"))
    # C. 같은 읍면 + 면적(±1%) + 가격 / D. 분할(대안가격이 상대의 본가격과 일치) / E. 같은 리+면적, 가격 다름(시차)
    for i, a in enumerate(recs):
        fa = a["fields"]
        for b in recs[i + 1:]:
            fb = b["fields"]
            if a["kind"] != "listing" or b["kind"] != "listing":
                continue
            ea, eb = fa.get("region", {}).get("eupmyeon"), fb.get("region", {}).get("eupmyeon")
            if not ea or ea != eb:
                continue
            ma, mb = fa.get("land_m2"), fb.get("land_m2")
            same_area = ma and mb and abs(ma - mb) / max(ma, mb) <= 0.01
            if same_area and fa.get("price") and fa.get("price") == fb.get("price"):
                edges.append((a["id"], b["id"], "same-area+price"))
                continue
            for x, y in ((fa, fb), (fb, fa)):
                for alt in x.get("price_alt", []):
                    if alt.get("price") == y.get("price") and (not alt.get("area_m2") or not y.get("land_m2") or abs(alt["area_m2"] - y["land_m2"]) / y["land_m2"] < 0.02):
                        edges.append((a["id"], b["id"], "split-offer(alt price matches)"))
            ra, rb = fa.get("region", {}).get("ri"), fb.get("region", {}).get("ri")
            if same_area and ra and ra == rb and fa.get("price") != fb.get("price"):
                o, n = sorted((a, b), key=lambda r: r["published"] or "")
                edges.append((a["id"], b["id"], f"same-ri+area, price {o['fields'].get('price')}({o['published'][:4]})→{n['fields'].get('price')}({n['published'][:4]}) (re-listed?)"))
    for a, b, why in edges:
        parent[find(a)] = find(b)
    groups = {}
    for r in recs:
        groups.setdefault(find(r["id"]), []).append(r["id"])
    out = []
    for g in groups.values():
        if len(g) < 2:
            continue
        ge = [e for e in edges if e[0] in g]
        out.append({"members": sorted(g, key=lambda i: by_id[i]["published"] or ""),
                    "kinds": sorted(set(by_id[i]["kind"] for i in g)),
                    "edges": [{"a": a, "b": b, "why": w} for a, b, w in ge]})
    return out


def main():
    B = load_build()
    data = json.loads(VIDEOS.read_text(encoding="utf-8"))
    vids = data["videos"]
    recs = []
    for v in vids:
        F, S, flags = parse_video(v)
        build_listing = bool(B.is_listing_video(v))
        age_ok = B.video_age_ok(v, 12, TODAY)
        my_listing = build_listing or bool(F.get("no")) or sum(1 for k in ("price", "land_m2", "region", "type") if k in F and S[k].startswith("marker")) >= 3
        if F.get("status") == "done":
            kind = "listing-done"
        elif my_listing:
            kind = "listing"
        else:
            kind = "info"
        shown = v.get("isShort") is False and build_listing and age_ok
        if kind == "info":  # 정보 영상에서 잡힌 우연한 숫자는 버린다
            F = {k: x for k, x in F.items() if k in ("summary", "office", "blog", "refs_titles", "hashtags")}
        F["_price_src"] = S.get("price", "")
        r = {"id": v["id"], "title": v["title"], "isShort": v.get("isShort"), "published": v.get("published"),
             "kind": kind, "build_is_listing": build_listing, "age_ok_12m": age_ok, "shown_on_site": shown,
             "fields": F, "src": S, "flags": flags}
        if kind.startswith("listing"):
            r["disclosure"] = disclosure(B, v, F)
            r["as_listing_draft"] = to_listing(v, F)
        F.pop("_price_src", None)
        recs.append(r)
    groups = relations(recs)
    by_id = {r["id"]: r for r in recs}
    CMP = ["no", "region", "type", "jimok", "deal", "price", "land_m2", "bldg_m2", "rooms", "baths", "direction", "road", "zoning", "infra", "bcr", "split", "river_m2"]
    for g in groups:
        if "listing" not in g["kinds"]:
            continue
        mem = [by_id[i] for i in g["members"]]
        longs = [r for r in mem if not r["isShort"] and r["age_ok_12m"]] or [r for r in mem if not r["isShort"]]
        main = max(longs, key=lambda r: len(r["fields"])) if longs else None
        g["main"] = main["id"] if main else None
        if not main:
            continue
        enrich, conflict = {}, {}
        for r in mem:
            if r is main:
                continue
            for f in CMP:
                a, b = main["fields"].get(f), r["fields"].get(f)
                if b in (None, "", [], {}):
                    continue
                if a in (None, "", [], {}):
                    enrich.setdefault(f, []).append({"from": r["id"], "value": b})
                else:
                    va = a.get("value") if isinstance(a, dict) and "value" in a else a
                    vb = b.get("value") if isinstance(b, dict) and "value" in b else b
                    if f == "region":
                        va, vb = (a.get("eupmyeon"), a.get("ri")), (b.get("eupmyeon"), b.get("ri") or a.get("ri"))
                    if f in ("road", "zoning", "infra", "split"):
                        continue
                    if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
                        if abs(va - vb) / max(abs(va), 1) > 0.002:
                            conflict.setdefault(f, []).append({"from": r["id"], "main": va, "other": vb})
                    elif va != vb:
                        conflict.setdefault(f, []).append({"from": r["id"], "main": va, "other": vb})
        g["enrich_main_from_others"] = enrich
        g["conflicts_with_main"] = conflict
    # 커버리지
    FIELDS = ["no", "region", "region.ri", "type", "type.explicit", "jimok", "jimok.legal", "deal", "price", "land_m2", "bldg_m2", "floors", "rooms", "baths", "direction",
              "direction.basis", "parking", "built", "move_in", "maintenance", "zoning", "road", "infra", "bcr", "split", "blog", "blog.post_url_intact",
              "summary", "office.name", "office.address", "office.tel", "office.regNo_raw", "office.ceo"]

    def has(r, f):
        F = r["fields"]
        if f == "type.explicit":
            return bool(F.get("type")) and r["src"].get("type", "").startswith("marker")
        if f == "jimok.legal":
            return F.get("jimok") in ("전", "답", "과수원", "목장용지", "임야", "대", "잡종지", "공장용지", "창고용지")
        if f == "region.ri":
            return bool(F.get("region", {}).get("ri"))
        if f == "direction.basis":
            return bool((F.get("direction") or {}).get("basis"))
        if f == "blog.post_url_intact":
            return bool(F.get("blog")) and not F["blog"]["truncated"] and F["blog"]["kind"] != "blog-home"
        if f.startswith("office."):
            return bool(F.get("office", {}).get(f.split(".")[1]))
        return F.get(f) not in (None, "", [], {})

    sets = {
        "shown": [r for r in recs if r["shown_on_site"]],
        "long_listing_live": [r for r in recs if r["isShort"] is False and r["kind"] == "listing"],
        "short_listing": [r for r in recs if r["isShort"] and r["kind"].startswith("listing")],
    }
    cov = {f: {k: sum(1 for r in s if has(r, f)) for k, s in sets.items()} for f in FIELDS}
    for f in FIELDS:
        base = f.split(".")[0]
        cov[f]["long_live_from_marker"] = sum(1 for r in sets["long_listing_live"] if has(r, f) and r["src"].get(base, "").startswith(("marker", "slash")))
    cov["_n"] = {k: len(s) for k, s in sets.items()}
    out = {"generated": TODAY.isoformat(), "source": str(VIDEOS), "videos_updated": data.get("updated"),
           "counts": {"all": len(recs), "long": sum(1 for r in recs if r["isShort"] is False), "short": sum(1 for r in recs if r["isShort"]),
                      "listing": sum(1 for r in recs if r["kind"] == "listing"), "listing_done": sum(1 for r in recs if r["kind"] == "listing-done"),
                      "info": sum(1 for r in recs if r["kind"] == "info"), "shown": len(sets["shown"])},
           "coverage": cov, "groups": groups, "records": recs}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT}  ({len(recs)} videos, {len(groups)} groups)")


if __name__ == "__main__":
    main()
