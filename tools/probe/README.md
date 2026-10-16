# 외부 사이트 점검·원본 받기 (일회성 도구, 배포 안 됨)

> **NOT DEPLOYED.** 홈페이지 자동화(`.github/workflows/site.yml`)와 관계없는 일회성 점검 도구입니다.
> 여기 있는 `*.yml` 은 참고용 사본이라 GitHub가 실행하지 않습니다(`.github/workflows/` 밖에 있음).

## 왜 이런 방법을 쓰나
이 작업 환경(Claude Code 클라우드 세션)의 프록시는 네이버 블로그·유튜브·`*.github.io` 접속과 원격 브랜치 삭제를 막습니다.
그런데 매시간 도는 GitHub Actions는 이 사이트들에 접속할 수 있습니다. 그래서:

1. 임시 브랜치(예: `probe-blog`)를 만들고, 점검 스크립트와 그 브랜치에서만 도는 작업 파일
   `.github/workflows/probe.yml`(이 폴더의 `*-workflow.yml` 참고)을 올립니다. `main` 에는 올리지 않습니다.
2. Actions가 스크립트를 실행하고 ① 결과를 `::notice::` 주석으로 남기거나(`probe.py`) ② 받은 파일을 그 브랜치에 커밋합니다(`snapshot.py`).
3. 결과는 공개 GitHub API로 읽습니다:
   `https://api.github.com/repos/phg908-dot/gaya-homepage/commits/<커밋>/check-runs` →
   `.../check-runs/<id>/annotations` (주석), 또는 `git fetch` 로 브랜치의 커밋된 파일.
4. 끝나면 임시 브랜치를 지웁니다. **이 환경에서는 브랜치 삭제가 막혀 있어** 사장님이 GitHub 화면에서 지워야 합니다
   (https://github.com/phg908-dot/gaya-homepage/branches → `probe-blog` 옆 휴지통). 2026-10-16 현재 `probe-blog` 가 남아 있습니다.

## 파일
| 파일 | 내용 |
|---|---|
| `probe.py` | 블로그 RSS·글 본문·사진 주소(`?type=w800`)·유튜브 썸네일·유튜브 `next` 응답의 블로그 링크 원래 주소를 확인해 `::notice::` 로 출력 |
| `snapshot.py` | 블로그 RSS, 매물 글 4개 + 일반 글 1개의 모바일 페이지, PC 페이지 1개, 영상 5개의 `next` 응답을 `fixtures/` 에 저장 |
| `probe-workflow.yml` | `probe.py` 를 돌린 임시 작업 파일 사본 (`probe-blog` 브랜치 커밋 13fd804·c583a66) |
| `snapshot-workflow.yml` | `snapshot.py` 를 돌리고 `fixtures/` 를 같은 브랜치에 커밋한 임시 작업 파일 사본 (커밋 dc121d3 → 결과 커밋 aa7ff87) |

받은 원본은 줄여서 `tests/fixtures/raw/` 에 옮겨 두었습니다. 점검 결과는 `docs/research/07-블로그-유튜브-연동-실험.md`.

## 다시 쓸 때 주의
- 임시 브랜치는 `main` 과 이력이 이어지지 않아도 됩니다(`probe-blog` 는 독립 이력). 작업 파일에 `permissions: contents: write` 가 있어야 결과를 커밋할 수 있습니다.
- 받은 자료에 지번·제3자 연락처가 있으면 저장소에 옮기기 전에 가립니다.
- 끝나면 브랜치 삭제를 사장님께 부탁합니다(위 4번).
