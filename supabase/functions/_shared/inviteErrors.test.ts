import { assertEquals } from "jsr:@std/assert@1";
import { INVITE_SEND_FAILED_MESSAGE, inviteRecordErrorMessage, inviteSendErrorMessage } from "./inviteErrors.ts";

Deno.test("inviteRecordErrorMessage:已知的店家用句原樣回", () => {
  assertEquals(inviteRecordErrorMessage({ code: "P0001", message: "這個人已經是這間店的客服了" }, "寫入失敗"), "這個人已經是這間店的客服了");
});

Deno.test("inviteRecordErrorMessage:資料庫原文(可能帶欄位值)一律換成固定句", () => {
  assertEquals(
    inviteRecordErrorMessage({ code: "23505", message: 'duplicate key value violates unique constraint "x"', details: "Key (invited_email)=(a@example.com)" }, "寫入客服資料失敗，請稍後再試"),
    "寫入客服資料失敗，請稍後再試",
  );
  assertEquals(inviteRecordErrorMessage({ code: "P0001", message: "不合法的狀態：xxx" }, "寫入失敗"), "寫入失敗");
  assertEquals(inviteRecordErrorMessage(null, "寫入失敗"), "寫入失敗");
});

Deno.test("inviteSendErrorMessage:不含寄信服務原文,只用本專案的固定句", () => {
  const text = inviteSendErrorMessage(INVITE_SEND_FAILED_MESSAGE);
  assertEquals(text.startsWith("邀請信寄送失敗：目前無法寄出邀請信，請稍後再試。"), true);
  assertEquals(/[(),]/.test(text), false);
});
