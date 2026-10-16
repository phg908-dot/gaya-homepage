# 가야공인중개사사무소 홈페이지

유튜브에 올린 현장 영상이 **자동으로** 홈페이지에 들어가는 매물 홈페이지입니다.
서버가 필요 없는 정적 사이트라 호스팅비는 무료이고, 도메인 비용(연 2~3만원)만 듭니다.

```
public/              ← 홈페이지 원본 (이 폴더 안의 data/*.json 만 고치면 됩니다)
  index.html           메인 (매물 검색·필터·지도·최신 영상)
  videos.html          영상 모음 (일반/쇼츠/매물 연결)
  sell.html            매물 접수 (내용을 문자로 보내는 방식 — 개인정보를 저장하지 않음)
  about.html           사무소 소개·대표 인사말·자주 묻는 질문 (인사말 문구는 이 파일에서 직접 수정)
  data/site.json       사무소 정보·유튜브·지도 설정
  data/listings.json   매물 목록
  data/videos.json     유튜브 영상 목록 (자동 갱신 — 직접 고치지 마세요)
  data/blog.json       네이버 블로그 최신 글 (자동 갱신 — 직접 고치지 마세요)
  admin/listing.html   매물 등록·수정 화면 (JSON을 직접 고치지 않아도 됨, 검색 노출 안 됨)
  admin/youtube.html   유튜브 설명란 문구 생성기 (검색 노출 안 됨)
  images/              사진·아이콘·공유 미리보기(og.png)
scripts/
  update_videos.py     유튜브 새 영상 수집 (매시간 자동 실행)
  update_blog.py       네이버 블로그 새 글 수집 (같은 시간에 자동 실행)
  build.py             매물 상세 페이지·사이트맵 생성 + 광고 명시사항 점검
.github/workflows/site.yml   자동화 (영상 수집 → 커밋 → (선택) 배포)
```

---

## 1. 처음 한 번만 하는 설정

### 1-1. 저장소
이 폴더의 내용을 **사이트 전용 새 GitHub 저장소**(예: `gaya-homepage`)의 최상위에 둡니다.
연구자료가 있는 저장소를 공개로 바꾸면 안 됩니다.

### 1-2. 호스팅 — 둘 중 하나

| | Cloudflare Pages **(권장)** | GitHub Pages |
|---|---|---|
| 비용 | 무료 | 무료 |
| 저장소 | 비공개 가능 | **공개 저장소만** (무료 플랜) |
| 상업적 사이트 | 허용 | 이용약관상 "사업 목적 무료 호스팅" 제한 조항이 있어 회색지대 |
| 무료 주소 | `이름.pages.dev` | `아이디.github.io/저장소` |

**Cloudflare Pages**
1. dash.cloudflare.com 가입 → Workers & Pages → Create → Pages → *Connect to Git* → 저장소 선택
2. Framework preset: `None` · Build command: `pip install pillow; python3 scripts/build.py --prod` (Pillow: 휴대폰 사진을 배포 때 자동으로 줄임) · Build output directory: `dist`
3. Save and Deploy. 이후 커밋(영상 자동 갱신 포함)마다 자동으로 다시 배포됩니다.

**GitHub Pages** (기본 설정 — 따로 할 일 없음)
1. 저장소가 Public 이면, `main` 에 올릴 때마다 자동화가 배포본을 `gh-pages` 브랜치에 올리고, 유튜브·블로그 목록이 바뀌면 `main` 에도 커밋합니다. 커밋이 거부되면 Settings → Actions → General → Workflow permissions → **Read and write permissions** 를 선택하고 저장하세요.
2. Pages가 자동으로 켜지지 않았다면 Settings → Pages → Build and deployment → *Deploy from a branch* → `gh-pages` / `(root)` → Save (한 번만).
3. 주소: `https://아이디.github.io/저장소이름/` → `site.json` 의 `"siteUrl"` 에 넣으면 사이트맵·공유 미리보기가 완성됩니다.
4. Cloudflare Pages 로 옮길 때는 저장소 변수 `HOSTING` = `cloudflare` 로 이 배포를 끕니다.

> ⚠ 공개 저장소에서는 `listings.json` 내용이 누구에게나 보입니다. 지번은 비공개 원칙이므로 **공개 저장소에서는 `jibun` 칸을 비워 두세요.**
> (홈페이지 배포본에서는 `showJibun` 이 아닌 매물의 지번을 자동으로 지우지만, 저장소 원본은 그대로 보입니다.)

> 비공개 저장소의 GitHub Actions 무료 사용량은 월 2,000분이고, 매시간 영상 확인은 월 약 720분입니다.

### 1-3. 도메인
도메인은 사장님 명의로 직접 사야 합니다(가비아·카페24 등, 첫해 약 1.6~2만원, 연장 약 2.3~2.6만원 — 결제 화면에서 확인).
후보(사용 가능 여부는 등록업체에서 조회): `gayabds.com`, `gayabds.co.kr`, `gaya2060.co.kr`, `gayayp.co.kr`, `가야부동산.kr`

- **Cloudflare Pages**: 프로젝트 → Custom domains → `www.도메인` 추가 → 안내된 CNAME 을 가비아 DNS에 등록
  (www 없는 주소까지 쓰려면 도메인의 네임서버를 Cloudflare로 옮기는 것이 가장 쉽습니다)
- **GitHub Pages**: 먼저 Settings → Pages → Custom domain 에 도메인 입력 후, 가비아 DNS에
  - `A @` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
  - `CNAME www` → `아이디.github.io`
  - 하루 안에 인증서가 발급되면 **Enforce HTTPS** 체크

도메인이 정해지면 `public/data/site.json` 의 `"siteUrl"` 에 `https://www.도메인` 을 넣으세요(사이트맵·공유 미리보기에 사용).

### 1-4. 유튜브
- `site.json` 의 `youtube.handle` 로 채널을 자동으로 찾습니다. 실패하면 `youtube.channelId` 에 `UC…` 로 시작하는 채널 ID를 넣으세요.
  (YouTube 스튜디오 → 설정 → 채널 → 고급 설정, 또는 채널 정보 → 공유 → *채널 ID 복사*)
- 기본(API 키 없음): 유튜브 피드에 보이는 **최근 15개**부터 시작해 이후 영상이 계속 쌓입니다.
- **예전 영상까지 전부** 넣으려면 무료 YouTube Data API 키를 한 번 등록합니다.
  console.cloud.google.com → 프로젝트 만들기 → API 및 서비스 → 라이브러리 → *YouTube Data API v3* 사용 →
  사용자 인증 정보 → API 키 만들기(키 제한: YouTube Data API v3) →
  GitHub 저장소 Settings → Secrets and variables → Actions → New repository secret → 이름 `YT_API_KEY`

### 1-4-1. 네이버 블로그 · 인스타그램
- 블로그 주소는 `site.json` 의 `blog.url`, 글 목록은 `blog.rss` 입니다. 기본값은 `https://blog.naver.com/gayayangpyeong` 과 `https://rss.blog.naver.com/gayayangpyeong.xml` 입니다.
- 매시간 자동화가 RSS를 읽어 `public/data/blog.json` 에 최신 글 12개를 저장합니다. 홈페이지 "블로그 소식"이 이 파일을 읽습니다. 글이 그대로면 파일을 다시 쓰지 않습니다.
- 인스타그램은 `site.json` 의 `instagram.url` (기본 `@honggyun8`) 로 연결만 합니다. 글 내용을 끌어오지는 않습니다.

### 1-5. 지도 (선택 — 없으면 지도 영역만 숨겨집니다)
매물에 좌표(`lat`, `lng`)가 있어야 지도에 표시됩니다. 카카오맵 키가 있으면 카카오맵을, 없으면 네이버 지도를 씁니다.

**카카오맵 (권장 — 카드 등록 불필요, 하루 30만 회 무료)**
1. developers.kakao.com → 카카오 계정 로그인 → 앱 만들기
2. 앱 → 플랫폼 키 → **JavaScript 키** 복사, *JavaScript SDK 도메인*에 홈페이지 주소 등록 (`http://localhost` 도 추가하면 미리보기 가능)
3. 제품 설정 → **카카오맵 → 사용 설정 ON** (2024-12 이후 만든 앱은 필수)
4. `site.json` → `"kakaoMap": { "appKey": "복사한 키" }`

**네이버 지도**
1. ncloud.com 가입 (결제수단 등록이 요구될 수 있음). 무료 이용량은 *대표 계정* 1개에만 적용됩니다.
2. 콘솔 → Services → Application Services → **Maps** → Application 등록 (console.ncloud.com/maps/application)
   - API 선택: **Dynamic Map** 체크 (빠지면 429 오류)
   - Web 서비스 URL: 홈페이지 주소를 **호스트만** 입력(경로·포트 빼고, www 빼고), 미리보기용 `http://localhost` 도 추가
3. 목록에서 앱 선택 → **인증 정보** → *Client ID* 복사 (Client Secret 은 홈페이지에 넣지 않습니다)
4. `site.json` → `"naverMap": { "keyId": "복사한 Client ID" }` (스크립트는 2025년 바뀐 `ncpKeyId` 방식으로 불러옵니다)
5. 요금 사고 방지: Application → **한도 및 알림 설정**에서 일·월 한도 지정
6. "인증 실패" 가 뜨면 등록한 Web 서비스 URL 과 실제 주소가 같은지 확인하세요.
   옛 AI·NAVER API 로 발급한 키는 2025-07 부터 무료 이용량이 없으니 새 Maps 에서 다시 발급하세요.

### 1-6. 검색 노출
- 네이버 서치어드바이저·Google Search Console 에 사이트 등록 → 소유 확인 → `https://도메인/sitemap.xml` 제출
- 네이버 스마트플레이스의 홈페이지 주소를 정지된 옛 주소에서 새 도메인으로 변경

---

## 2. 평소 운영

### 영상 올리기 → 자동 반영 (할 일 없음)
1. 유튜브에 영상을 올립니다.
2. 최대 1시간 안에 홈페이지 "최신 매물 영상"에 자동으로 추가됩니다.
   - 홈페이지에는 **본편(쇼츠 제외) 매물 영상만** 올라갑니다. 정보·일상 영상(농지법, 세금, 경매 등)은 싣지 않습니다.
   - 매물 영상 판별: 제목에 **면적(㎡·평)** 과 함께 **가격(1억2천 등)·매물 해시태그(#양평토지 등)·'가야공인중개사'** 중 하나가 있거나,
     제목·설명란에 **매물번호**가 있거나, 매물(`listings.json`)의 `videoIds` 에 연결된 영상.
   - 제목·설명에 **'매매완료'·'계약완료'** 등이 있으면 싣지 않습니다. 팔린 매물 영상은 이렇게 표시하거나 유튜브에서 비공개로 돌리세요.
   - **게시 후 12개월이 지난 영상은 기본으로 싣지 않습니다**(이미 거래됐을 가능성). 아직 거래 중이면 `youtube.listingVideos` 에 넣으세요.
     기간은 `youtube.maxAgeMonths` 로 바꿉니다(0이면 제한 없음).
   - 자동 판별이 틀리면 `site.json` 의 `youtube.listingVideos`(꼭 싣기) / `youtube.notListingVideos`(싣지 않기)에 영상 주소를 넣으세요.
3. 영상 **설명란이나 제목에 `매물번호 1001`** 을 넣으면 그 매물 상세 페이지에 영상이 자동으로 붙습니다.
   `admin/youtube.html` (예: `https://도메인/admin/youtube.html`)에서 매물을 고르면 명시사항이 모두 들어간 설명란 문구를 복사할 수 있습니다.
4. 비공개·삭제한 영상은 자동으로 빠집니다(API 키가 없으면 예전 영상은 매시간 30개씩 돌아가며 확인하므로 하루 정도 걸릴 수 있고,
   API 키가 있으면 매시간 전부 확인하며 '일부 공개'도 뺍니다). 공개 상태로 두되 홈페이지에서만 빼려면
   `site.json` 의 `"hiddenVideos"` 에 영상 ID나 주소를 넣으세요.
5. API 키가 없으면 유튜브 피드에 보이는 최근 15개 영상만 제목·설명 변경을 바로 반영합니다. 예전 영상의 설명란에
   매물번호를 나중에 추가했다면, 매물의 `videoIds` 에 영상 주소를 직접 넣어 주세요.

### 매물 올리기 / 수정
**쉬운 방법:** `https://도메인/admin/listing.html` 에서 양식으로 입력 → 빠진 법정 항목을 바로 알려 줍니다 →
*listings.json 다운로드* → GitHub에서 `public/data/listings.json` 편집 화면에 붙여넣기(또는 파일 업로드) → *Commit changes*.
(`site.json` 의 `"admin": { "repoEditUrl": "https://github.com/아이디/저장소/edit/main/public/data/listings.json" }` 을 넣으면 편집 화면으로 바로 가는 버튼이 생깁니다.)

**직접 수정:** GitHub 웹에서 `public/data/listings.json` 을 열어 연필 아이콘으로 수정 → *Commit changes*. 몇 분 뒤 반영됩니다.
아래 예시의 `// 설명` 은 이해를 돕기 위한 것이고 실제 파일에는 넣으면 안 됩니다. 쉼표·따옴표가 틀리면 배포가 실패하고 이전 버전이 그대로 유지되니, Actions 화면에서 오류를 확인하세요.

```json
{
  "no": 1005,                       // 매물번호 (중복 불가, 영상 설명란에 쓰는 번호)
  "status": "거래중",                // 계약되면 "계약완료" → 홈페이지에서 즉시 빠짐
  "featured": true,                 // 추천 배지
  "urgent": false,                  // 급매 배지
  "title": "지평면 남향 전원주택 · 대지 170평",
  "type": "전원주택",                // 토지, 임야, 전원주택, 단독주택, 상가, 공장·창고 …
  "deal": "매매",                    // 매매, 전세, 월세, 단기임대
  "price": 32000,                   // 만원 단위. 매매가 (전세는 deposit, 월세는 deposit+monthly)
  "deposit": null, "monthly": null,
  "region": {
    "sido": "경기도", "sigungu": "양평군", "eupmyeon": "지평면",
    "ri": "망미리",                 // 읍·면 지역은 리(里)까지 필수
    "jibun": "123-4",               // 사무소 기록용 (지번은 비공개가 원칙 — 홈페이지에는 리까지만 표시)
    "showJibun": false              // 특정 매물만 지번을 공개하고 싶을 때 true
  },
  "land": {                         // 토지가 없으면 null (예: 상가 호실)
    "area": 562.0,                  // ㎡, 토지대장 기준 (평은 자동 계산)
    "jimok": "대",                  // 28개 법정 지목 중 하나: 대, 전, 답, 임야, 잡종지 …
    "zoning": "계획관리지역",        // 용도지역 (토지이음 확인). 여러 개면 "계획관리지역, 농림지역"
    "currentUse": "주택부지",        // 현 이용상태
    "road": "4m 포장도로 접함"       // 도로 조건
  },
  "building": {                     // 건물이 없으면 null
    "use": "단독주택",              // 건축물대장 주용도 (단독주택, 공동주택, 제1종 근린생활시설 …)
    "area": 84.5,                   // 전용면적 ㎡
    "totalFloors": 1, "floor": "",  // 공동주택은 해당 층 필수 (저/중/고 가능)
    "approvalDate": "2015-03-20",   // 사용승인일
    "direction": "남향",            // 건물이 바라보는 방향 → '남향(건물 정면 기준)'으로 표시
                                    //   다른 기준이면 직접: '남동향(거실 기준)'
    "rooms": 3, "baths": 2, "parking": 2,
    "moveIn": "즉시입주",            // 날짜 또는 "즉시입주", 협의 시 "11월 중순"
    "maintenance": "없음",          // 정액 월 10만원 이상이면 일반관리비/사용료/기타 나눠 적기
    "violation": false              // 건축물대장상 위반건축물이면 true
  },
  "recommendedUse": ["실거주", "세컨하우스"],   // 추천 용도
  "summary": "카드에 보이는 한 줄 설명",
  "description": "상세 설명 (줄바꿈은 \\n)",
  "features": ["남향", "지하수"],
  "videoIds": [],                   // 설명란에 매물번호를 넣었다면 비워 둬도 자동 연결
  "photos": ["images/1005-1.jpg"],  // public/images 에 사진 업로드 (휴대폰 원본 그대로 OK — 배포 때 긴 변 1600px로 줄이고 위치정보 삭제)
  "lat": 37.47, "lng": 127.63,      // 지도 표시용 — 정확한 지번이 아닌 리(里) 단위 대략 위치 권장
  "updated": "2026-10-16"
}
```

### 광고 명시사항 — 자동 점검
공인중개사법 제18조의2·시행령 제17조의2·국토부 「표시·광고 명시사항 세부기준」(2025.1.1. 시행)에 맞춰 배포 때 자동으로 점검합니다.
- **사무소 정보**(명칭·소재지·연락처·등록번호·대표자)가 하나라도 비면 **배포가 중단**됩니다. 연락처는 등록관청에 신고한 번호만 쓰세요.
- **가격은 단일 금액**이어야 합니다. "비공개"·"협의"·범위 표시는 위반입니다(2026.8. 헌재 합헌 결정).
- 필수 항목이 빠진 매물, `"sample": true` 매물, `"계약완료"` 매물은 **배포본에서 자동 제외**됩니다.
  (계약 통보 후 3일 안에 광고를 내려야 합니다 — 유튜브 영상도 **비공개**로 돌리세요. '일부 공개'는 계속 보일 수 있습니다.)
- 자동으로 확인하는 형식: 읍·면은 **리까지**, 입주가능일은 **'즉시입주'·날짜·'11월 중순'**,
  정액 관리비가 **월 10만원 이상이면 일반관리비·사용료로 나눠** 적기.
- 사무소 원칙: **지번은 비공개**(리까지 표시 — 고시상 의뢰인이 원하지 않으면 읍·면·동·리까지 표시 가능),
  **방향은 건물이 바라보는 방향**으로 적고 '(건물 정면 기준)'이 자동으로 붙습니다(`site.json` 의 `policy.directionBasis`).
  고시는 주택은 거실·안방 등 주실, 그 밖의 건물은 주출입구를 방향 기준으로 들고 있으니, 건물 정면과 거실 방향이 다른 매물은
  '남동향(거실 기준)'처럼 직접 적어 주세요.
- 제외된 매물의 번호(`매물번호 1005`)를 설명란에 쓴 유튜브 영상도 홈페이지에서 자동으로 빠집니다.
  매물을 목록에서 아예 지웠다면 그 번호를 `site.json` 의 `"closedListingNos": [1005]` 에 적어 두세요.
- 점검 결과는 GitHub Actions 실행 화면의 경고(⚠)로 보입니다.
- 법령·고시는 바뀔 수 있으니 등록관청(양평군청) 안내를 우선하세요.

### 미리보기 (내 컴퓨터)
```bash
python3 scripts/build.py           # 샘플 포함 전체 미리보기
python3 -m http.server -d public 8000   # → http://localhost:8000
python3 scripts/build.py --prod    # 실제 배포본(dist/) 확인
```

### 공유 미리보기 이미지
카카오톡·문자로 링크를 보낼 때 보이는 이미지는 `public/images/og.png` 입니다(1200×630).
매물 상세 링크는 그 매물의 첫 사진 → 첫 영상 썸네일 순으로 자동 사용합니다.
문구를 바꾸려면 `scripts/og-template.html` 을 고쳐 브라우저에서 1200×630 으로 캡처하세요.
