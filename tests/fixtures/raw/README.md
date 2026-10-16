# 실제 원본 자료 (테스트용 고정 자료)

사장님 본인의 **공개** 콘텐츠(네이버 블로그 `gayayangpyeong`, 유튜브 채널 `@가야부동산-w1w`)를
2026-10-16 04:42(UTC)에 GitHub Actions에서 그대로 받아 둔 것입니다.
이 작업 환경(프록시)에서는 네이버·유튜브에 직접 접속할 수 없어서, 임시 브랜치 `probe-blog`의
일회성 Actions 작업(`tools/probe/snapshot.py`)이 받아서 커밋한 것을 옮겨 왔습니다
(원래 커밋: `probe-blog` 브랜치 aa7ff87 "원본 저장 (테스트 자료)").

블로그 글·유튜브 설명란 파서(앞으로 만들 `blog.json` 수집, 설명란 → 매물 정보 추출)를
네트워크 없이 시험하기 위한 자료입니다. 홈페이지에 그대로 게시하는 자료가 아닙니다.

## 파일

| 파일 | 내용 |
|---|---|
| `blog/rss.xml` | `https://rss.blog.naver.com/gayayangpyeong.xml` 응답 그대로 (글 50개: 제목·링크·날짜·요약·썸네일 1장) |
| `blog/post-<logNo>.m.html` | 모바일 글 보기 `https://m.blog.naver.com/PostView.naver?blogId=gayayangpyeong&logNo=<logNo>` 응답 그대로. 본문은 `class="se-main-container"` 안, 사진 주소는 `mblogthumb-phinf.pstatic.net` (주소 뒤에 `?type=w800` 을 붙여야 200) |
| `blog/post-224440209904.pc.html` | 같은 글의 PC용 보기(`blog.naver.com/PostView.naver?...&redirect=Dlog&widgetTypeCall=true&directAccess=false`) |
| `youtube/next-<영상ID>.json` | 유튜브 내부 요청 `POST https://www.youtube.com/youtubei/v1/next` 응답을 **줄인 것** |

### 블로그 글 (매물 글 4개 + 일반 글 1개)
- `224440209904` — 양평 전원주택 매매｜용문 금곡리 768평 (영상 7PRVk7skdtc 와 같은 매물)
- `224427678503` — 지평면 토지 매매, 지평역 450m 대지 200평 (영상 d9zp8vq_SFk · Yp4KhcA1YDw 설명란이 이 글을 가리킴)
- `224427890454` — 지평면 개울 옆 전원주택지 1,126평 2억 3천 (영상 T1bnKBqf4J4 설명란이 이 글을 가리킴)
- `224198501745` — 지평역 도보 1분 단독주택 매매 3억 (2026-02-28 글 — 연결된 최근 영상 없음)
- `224429812285` — 일반 글(지평막걸리 직판장 소개)

### 유튜브 `next` 응답을 줄인 방법
원본은 영상마다 약 400KB(관련 영상·댓글·화면 설정 포함)입니다. 파서가 쓰는 부분만 남겼습니다.
- 남긴 것: `contents.twoColumnWatchNextResults.results.results.contents` 안의
  `videoPrimaryInfoRenderer`(제목·게시일 `dateText`)와 `videoSecondaryInfoRenderer`(설명란 `attributedDescription.content`,
  링크 원래 주소가 들어 있는 `attributedDescription.commandRuns`, 채널 정보). 원래 위치(경로)는 그대로입니다.
- 지운 것: 나머지 전부(관련 영상 목록에는 다른 채널 영상 제목·연락처가 섞여 있음)와 의미 없는 추적값(`trackingParams`, `clickTrackingParams`, `loggingContext`).
- 확인: `scripts/update_videos.py` 의 `fetch_next_details()` 에 이 파일을 넣으면 게시일·설명란·링크가 원본과 같이 나옵니다.
  d9zp8vq_SFk·Yp4KhcA1YDw → `https://blog.naver.com/gayayangpyeong/224427678503`,
  T1bnKBqf4J4 → `.../224427890454`, 7PRVk7skdtc·Yi7_zs8ZgEw → 블로그 첫 화면 주소만(글 주소 없음 → 제목·면적·가격으로 짝지어야 함).

## 손댄 곳
- `blog/post-224429812285.m.html`: 글에 적힌 **다른 가게의 전화번호 2개**를 같은 자릿수의 `000-000-0000`, `000-0000-0000` 으로 가렸습니다(공개 저장소에 제3자 연락처를 올리지 않기 위해). 그 밖의 블로그 HTML은 받은 그대로입니다.
- 설명란과 블로그 글 끝에는 시공 협력사 **일치건축** 연락처 묶음이 있습니다. 실제 자료 그대로 두었습니다 —
  파서가 이 묶음을 **중개사무소 연락처로 쓰지 않는지** 시험하는 데 필요합니다. 중개사무소 번호는 010-3406-0071 하나뿐입니다.
- 지번은 들어 있지 않습니다(확인함). 새 자료를 넣을 때도 지번이 있으면 가려 주세요.

## 다시 받을 때
`tools/probe/README.md` 의 방법(임시 브랜치 + Actions 작업이 결과를 커밋)으로 다시 받고, 위와 같이 줄이세요.
