import { assertEquals } from "jsr:@std/assert@1";
import { errorCode } from "./safeLog.ts";
import { isValidCronSecret } from "./cronSecret.ts";

Deno.test("errorCode:只取代碼,不帶出 message / details 裡的欄位值", () => {
  assertEquals(
    errorCode({ code: "23505", message: "duplicate key", details: "Key (email)=(a@example.com) already exists." }),
    "23505",
  );
  assertEquals(errorCode({ status: 422, message: "User already registered: a@example.com" }), "status_422");
  assertEquals(errorCode(new TypeError("boom a@example.com")), "TypeError");
  assertEquals(errorCode({ code: "a@example.com 0912345678 有空白" }), "unknown");
  assertEquals(errorCode(null), "unknown");
  assertEquals(errorCode("plain string a@example.com"), "unknown");
});

Deno.test("isValidCronSecret:缺少 / 錯誤 / 長度不同都擋下,正確才放行;沒設定一律擋下", () => {
  const SECRET = "shared-cron-secret-value";
  assertEquals(isValidCronSecret(null, SECRET), false);
  assertEquals(isValidCronSecret("", SECRET), false);
  assertEquals(isValidCronSecret("wrong", SECRET), false);
  assertEquals(isValidCronSecret(SECRET + "x", SECRET), false);
  assertEquals(isValidCronSecret(SECRET.slice(0, -1), SECRET), false);
  assertEquals(isValidCronSecret(SECRET, SECRET), true);
  assertEquals(isValidCronSecret("", ""), false);
  assertEquals(isValidCronSecret(null, ""), false);
});
