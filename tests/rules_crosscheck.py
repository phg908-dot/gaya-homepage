#!/usr/bin/env python3
"""rules.js ↔ scripts/build.py 교차 확인 도우미 (tests/admin-listing.test.js 가 호출).

표준입력으로 매물 JSON 배열을 받아 build.normalize_all() + build.listing_problems() 로 판정하고
매물마다 게시 불가 사유 목록을 JSON 으로 출력한다.

    echo '[{"no": 1, ...}, ...]' | python3 tests/rules_crosscheck.py            → [[사유, ...], ...]
    echo '{"groups": [[...], [...]]}' | python3 tests/rules_crosscheck.py --detail
        → 묶음마다 [{"problems", "publishable", "warnings", "residential", "apartment", "dandok",
                      "maintenanceWon", "moveInOk", "region", "direction"}, ...]
      (묶음 = 매물번호 중복을 함께 세는 목록 하나)

출력은 ASCII JSON (짝 없는 서로게이트 문자도 안전하게).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build  # noqa: E402

# 사무소 정보·홈페이지 주소가 모두 있는 site.json — 매물별 경고만 비교하도록 (사이트 전체 경고는 아래에서 한 번 더 뺌)
OFFICE = {"siteUrl": "https://example.com", "office": {k: "x" for k in build.OFFICE_REQUIRED}}


def listing_warnings(l):
    """build.check() 가 이 매물 하나에 내는 경고 (사무소·siteUrl 같은 사이트 전체 경고 제외)"""
    site_wide = build.check(OFFICE, [])
    return [w for w in build.check(OFFICE, [l]) if w not in site_wide]


def judge(group, detail):
    warns = []
    out = []
    for l in build.normalize_all(group, warns):
        problems = build.listing_problems(l)
        if not detail:
            out.append(problems)
            continue
        b = l.get("building") or {}
        row = {"problems": problems, "publishable": build.publishable(l),
               "residential": build.is_residential(l), "apartment": build.is_apartment(l), "dandok": build.is_dandok(l),
               "maintenanceWon": build.maintenance_won(b.get("maintenance")),
               "moveInOk": bool(build.MOVE_IN_OK.search(str(b.get("moveIn")))) if b.get("moveIn") else None,
               "direction": build.direction_text(b.get("direction"))}
        try:
            row["warnings"] = listing_warnings(l)
        except Exception as e:  # build.py 가 처리하지 못하는 값 (예: zoning 이 true)
            row["warnings"] = {"error": f"{type(e).__name__}: {e}"}
        try:
            row["region"] = build.region_text(l.get("region"))
        except Exception as e:
            row["region"] = {"error": f"{type(e).__name__}: {e}"}
        out.append(row)
    return out


def main():
    detail = "--detail" in sys.argv
    data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    if isinstance(data, dict) and "groups" in data:
        result = [judge(g, detail) for g in data["groups"]]
    else:
        result = judge(data, detail)
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
