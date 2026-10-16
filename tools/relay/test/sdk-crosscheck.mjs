// 공식 SOLAPI Node SDK(npm "solapi")가 실제로 만드는 인증 헤더·요청 본문과 worker.js 의 것을 비교한다.
// 사용: node test/sdk-crosscheck.mjs <solapi 패키지가 설치된 node_modules 상위 폴더>
// (저장소 CI 에서는 실행하지 않음: 외부 패키지가 필요하므로 개발자가 한 번 확인하는 용도)
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { solapiAuthorization, solapiSend } from "../worker.js";

const base = process.argv[2];
if (!base) {
  console.log("skip: solapi SDK 경로가 필요합니다");
  process.exit(0);
}
const require = createRequire(path.join(path.resolve(base), "noop.js"));
const { SolapiMessageService } = require("solapi");

const KEY = "NCSTESTKEY0000001";
const SECRET = "TESTSECRET0123456789ABCDEFGHIJKLMNOP";
const captured = [];
globalThis.fetch = async (url, init) => {
  captured.push({ url: String(url), init });
  return new Response(
    JSON.stringify({
      failedMessageList: [],
      groupInfo: {
        _id: "G4V", groupId: "G4V", status: "SENDING", isRefunded: false, accountId: "1", apiVersion: "4", sdkVersion: "x", osPlatform: "x",
        dateCreated: "2026-10-16T00:00:00.000Z", dateUpdated: "2026-10-16T00:00:00.000Z", dateSent: "", dateCompleted: "", scheduledDate: "",
        flagUpdated: false, prepaid: true, strict: false, masterAccountId: null, allowDuplicates: false, isMms: false, isRefundable: false,
        count: { total: 1, sentTotal: 0, sentFailed: 0, sentSuccess: 0, sentPending: 0, sentReplacement: 0, refund: 0, registeredFailed: 0, registeredSuccess: 1 },
        countForCharge: { sms: {}, lms: {}, mms: {}, ata: {}, cta: {}, cti: {}, nsa: {}, rcs_sms: {}, rcs_lms: {}, rcs_mms: {}, rcs_tpl: {} },
        balance: { requested: 0, replacement: 0, refund: 0, sum: 0 }, point: { requested: 0, replacement: 0, refund: 0, sum: 0 },
        app: { profit: { sms: 0, lms: 0, mms: 0, ata: 0, cta: 0, cti: 0, nsa: 0, rcs_sms: 0, rcs_lms: 0, rcs_mms: 0, rcs_tpl: 0 }, appId: null, version: null },
        log: [], price: {},
      },
      messageList: [{ messageId: "M4V1", statusCode: "2000", statusMessage: "ok" }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

const svc = new SolapiMessageService(KEY, SECRET);
try {
  await svc.send({ to: "01034060071", from: "01034060071", text: "시험", type: "LMS", subject: "홈페이지 매물 접수" }, { showMessageList: true });
} catch (e) {
  // 응답 스키마가 SDK 버전에 따라 달라 응답 해석에서 실패해도 요청은 이미 잡혔으므로 무시
}
assert.equal(captured.length >= 1, true, "SDK 가 요청을 보내지 않았습니다");
const sdk = captured[0];
const auth = sdk.init.headers.Authorization;
const m = auth.match(/^HMAC-SHA256 apiKey=(\S+), date=(\S+), salt=(\S+), signature=([0-9a-f]+)$/);
assert.ok(m, `예상과 다른 SDK 헤더: ${auth}`);
const mine = await solapiAuthorization(KEY, SECRET, { date: m[2], salt: m[3] });
assert.equal(mine, auth, "worker.js 서명이 SDK 서명과 다릅니다");
console.log("SDK URL      :", sdk.url);
console.log("SDK 헤더 형식:", auth.replace(/signature=\w+/, "signature=<64 hex>"));
console.log("SDK 본문     :", sdk.init.body);

// worker.js 가 보내는 본문과 비교
captured.length = 0;
await solapiSend(
  { SOLAPI_API_KEY: KEY, SOLAPI_API_SECRET: SECRET, SMS_FROM: "01034060071", SMS_TO: "01034060071" },
  { fetch: globalThis.fetch },
  { text: "시험", type: "LMS", subject: "홈페이지 매물 접수" }
);
const ours = captured[0];
console.log("worker URL   :", ours.url);
console.log("worker 본문  :", ours.init.body);
assert.equal(ours.url, sdk.url);
const a = JSON.parse(sdk.init.body);
const b = JSON.parse(ours.init.body);
assert.deepEqual(b.messages[0], { to: a.messages[0].to, from: a.messages[0].from, text: a.messages[0].text, type: a.messages[0].type, subject: a.messages[0].subject });
assert.equal(b.showMessageList, a.showMessageList);
console.log("OK: 인증 서명과 발송 요청 형식이 공식 SDK 와 같습니다");
