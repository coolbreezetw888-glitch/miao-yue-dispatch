// 模組 15(服務人員推播通知)— push-notify-reminder-dispatch 的 Deno 測試。對應規則 4.8
// (核心必測:缺少/錯誤的 X-Cron-Secret 被擋下;正確的密鑰可以通過)、第五節排程機制(台北時區
// 邊界計算)。

Deno.env.set("SUPABASE_URL", "http://localhost:55321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("VAPID_SUBJECT", "mailto:test@example.com");
Deno.env.set("VAPID_PUBLIC_KEY", "test-public-key");
Deno.env.set("VAPID_PRIVATE_KEY", "test-private-key");
Deno.env.set("PUSH_REMINDER_CRON_SECRET", "correct-secret-value");

import { assertEquals } from "jsr:@std/assert@1";
import { computeTaipeiTomorrowRange, isValidCronSecret } from "./index.ts";

Deno.test("isValidCronSecret(核心必測):缺少標頭被擋下", () => {
  assertEquals(isValidCronSecret(null, "correct-secret-value"), false);
});

Deno.test("isValidCronSecret(核心必測):錯誤的密鑰被擋下", () => {
  assertEquals(isValidCronSecret("wrong-secret", "correct-secret-value"), false);
});

Deno.test("isValidCronSecret(核心必測):正確的密鑰可以通過", () => {
  assertEquals(isValidCronSecret("correct-secret-value", "correct-secret-value"), true);
});

Deno.test(
  "isValidCronSecret:環境變數本身是空字串時一律擋下(避免忘記設定卻意外放行空字串比對空字串)",
  () => {
    assertEquals(isValidCronSecret("", ""), false);
    assertEquals(isValidCronSecret(null, ""), false);
  },
);

// =========================================================================
// computeTaipeiTomorrowRange:台北時區「明天」邊界計算。用固定時間戳測試,不依賴系統當下時間。
// =========================================================================
Deno.test(
  "computeTaipeiTomorrowRange: 台北時間 2026-09-22 上午 9 點觸發,查詢範圍應是台北時間 09-23 00:00~24:00",
  () => {
    // 2026-09-22 01:00:00 UTC = 2026-09-22 09:00:00 台北時間(UTC+8)。
    const nowUtcMs = Date.UTC(2026, 8, 22, 1, 0, 0);
    const range = computeTaipeiTomorrowRange(nowUtcMs);

    assertEquals(range.todayTaipeiDate, "2026-09-22");
    // 台北 09-23 00:00 = UTC 09-22 16:00。
    assertEquals(new Date(range.tomorrowStartUtcMs).toISOString(), "2026-09-22T16:00:00.000Z");
    // 台北 09-24 00:00 = UTC 09-23 16:00。
    assertEquals(new Date(range.tomorrowEndUtcMs).toISOString(), "2026-09-23T16:00:00.000Z");
  },
);

Deno.test("computeTaipeiTomorrowRange: 跨月邊界(台北時間月底觸發)正確進位", () => {
  // 2026-09-30 23:30:00 台北時間 = 2026-09-30 15:30:00 UTC。
  const nowUtcMs = Date.UTC(2026, 8, 30, 15, 30, 0);
  const range = computeTaipeiTomorrowRange(nowUtcMs);

  assertEquals(range.todayTaipeiDate, "2026-09-30");
  // 台北 10-01 00:00 = UTC 09-30 16:00。
  assertEquals(new Date(range.tomorrowStartUtcMs).toISOString(), "2026-09-30T16:00:00.000Z");
  assertEquals(new Date(range.tomorrowEndUtcMs).toISOString(), "2026-10-01T16:00:00.000Z");
});

Deno.test("computeTaipeiTomorrowRange: 剛好台北時間午夜觸發(邊界值)", () => {
  // 2026-09-22 00:00:00 台北時間 = 2026-09-21 16:00:00 UTC。
  const nowUtcMs = Date.UTC(2026, 8, 21, 16, 0, 0);
  const range = computeTaipeiTomorrowRange(nowUtcMs);

  assertEquals(range.todayTaipeiDate, "2026-09-22");
  assertEquals(new Date(range.tomorrowStartUtcMs).toISOString(), "2026-09-22T16:00:00.000Z");
});
