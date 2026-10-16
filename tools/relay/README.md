# 매물 접수 → 사장님 휴대폰 문자 중계기 (시제품, 배포 안 됨)

> **NOT DEPLOYED — 시제품입니다.** 홈페이지(`public/sell.html`)는 아직 이 중계기를 부르지 않고,
> 이 폴더를 배포하는 GitHub Actions 작업도 없습니다. 조사 단계(2026-10-16)에서 만든 코드이며
> **검토가 필요**합니다. 실제 배포는 **사장님이 문자 발송 서비스(SOLAPI) 가입을 마친 뒤에만** 합니다.

## 왜 필요한가
사장님 결정(2026-10-16, "추천대로 해줘"): 손님이 홈페이지 매물 접수에서 **'보내기'를 누르면 사장님 휴대폰(010-3406-0071)으로
문자가 바로 온다**. 복사·붙여넣기, QR 코드는 쓰지 않는다(50대 이상 손님에게 번거로움 — 사장님이 거부).
홈페이지는 서버가 없는 정적 사이트라서, 문자 발송 API 키를 숨겨 둘 작은 중계기(Cloudflare Workers 무료 요금제)가 필요합니다.

중계기가 아직 없거나 실패할 때 홈페이지 쪽 대체 동작(기획 단계에서 확정 예정):
휴대폰 → 사장님 번호로 내용이 채워진 문자 앱 열기(`sms:`) / PC → 큰 글씨로 "전화로 말씀해 주세요 010-3406-0071". 입력한 내용은 지우지 않음.

## 구성
| 파일 | 내용 |
|---|---|
| `worker.js` | Cloudflare Worker (JavaScript 모듈, 외부 패키지 없음) |
| `wrangler.toml` | Worker 설정. 비밀값은 들어 있지 않음(이름만 주석에 있음) |
| `package.json` | `npm test` = `node --test test/worker.test.mjs` |
| `test/worker.test.mjs` | 오프라인 단위 테스트 26개 (가짜 fetch, 가짜 키 — 실제 비밀값 아님) |
| `test/sdk-crosscheck.mjs` | 공식 SOLAPI Node SDK가 만드는 인증 헤더·요청 본문과 비교(SDK 설치 경로를 인자로 줄 때만 실행, CI에서는 안 씀) |

### 동작 요약 (`worker.js`)
- `POST /intake` — 홈페이지가 보내는 JSON `{name, phone, region, type, deal, area, price, memo, from, v}` 을 검사해
  **받는 번호가 비밀값 `SMS_TO` 하나로 고정된** 문자 1통(SOLAPI REST v4, HMAC-SHA256 인증)을 보냄. 응답 `{ok:true}` / `{ok:false, reason}`.
- `GET /health` — `{ok:true, configured}` (개인정보 없음). `POST /selftest`, `GET /selftest/status` — 배포 직후 시험 문자(Bearer 토큰 필요).
- 막는 장치: 허용한 출처(Origin)만(`https://phg908-dot.github.io`, localhost), 숨은 칸(honeypot), 항목별 길이 제한·제어문자 제거·
  링크 주소 삭제, 같은 IP 하루 3건·30초 간격, **하루 전체 20건 상한**(Durable Object, 한국 시간 자정 초기화, 한도 저장소가 없으면 보내지 않음),
  선택: Cloudflare Turnstile, Workers Rate Limiting.
- 개인정보는 저장·기록하지 않음. 로그에는 결과 코드만. IP는 하루짜리 해시로만 다룸. Workers Logs 꺼 둠(`[observability] enabled = false`).
- 문자 내용: `[홈페이지 매물 접수]` + 성함·연락처·소재지·종류/거래·면적·희망가격·접수 위치·내용, 장문(LMS) 2,000바이트 안으로 자름.

### 비밀값 (저장소에 절대 넣지 않음 — Cloudflare/GitHub Secrets에만)
`SOLAPI_API_KEY`, `SOLAPI_API_SECRET`, `SMS_FROM`(사전 등록한 발신번호), `SMS_TO`(010-3406-0071), `SELFTEST_TOKEN`(배포 때 자동 생성), 선택 `TURNSTILE_SECRET`.
배포용: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## 테스트 결과
```bash
cd tools/relay && node --test test/worker.test.mjs
```
2026-10-16, Node v22.22.0, 네트워크 없이: **26개 모두 통과 (pass 26, fail 0)**.
`node test/sdk-crosscheck.mjs` 는 SDK 경로를 주지 않아 건너뜀("skip: solapi SDK 경로가 필요합니다") — 실제 SDK와의 대조는 아직 안 함.

## 배포 전에 남은 일 (검토 목록)
1. 코드 검토: 입력 항목·문구가 확정될 매물 접수 화면(`docs/plan/` 기획)과 맞는지, `from`/`v`(어느 영상을 보고 왔는지) 형식.
2. SOLAPI 요금·발신번호 사전등록(사장님 휴대폰 본인인증) 절차와 Cloudflare 무료 요금제의 Durable Object(SQLite) 사용 가능 여부를 공식 문서로 다시 확인.
3. `sdk-crosscheck.mjs` 를 실제 SDK로 한 번 실행해 인증 헤더 형식 확인.
4. 배포 작업(GitHub Actions): **비밀값이 모두 있을 때만** 배포하고, 배포 뒤 Worker 주소를 `public/data/site.json`(예: `intake.endpoint`)에 기록해
   홈페이지가 자동으로 켜지게. 시험 문자 1통으로 확인.
5. 홈페이지 쪽: `sell.html` 을 전화 우선 + 짧은 양식 + 큰 '보내기'로 바꾸고, 개인정보 수집·이용 안내와 처리방침 페이지 추가.
6. 사장님 1회 설정 안내(한국어, 번호 매긴 짧은 단계)를 확정: SOLAPI 가입 → 발신번호 등록 → 충전 → API 키 발급 →
   Cloudflare 가입 → API 토큰 → GitHub 저장소 Settings → Secrets and variables → Actions 에 붙여넣기.
   (하루 상한 20건이면 최악의 경우에도 하루 약 1,000원 수준이라는 계산이 `wrangler.toml` 주석에 있음 — 실제 단가는 가입 화면에서 확인.)
