// SPECS-INDEX #1025 功能開關 第 2 批 FG2-T01:Edge Function 共用判斷(supabase/functions/_shared/featureGate.ts)。
//
// 這支 helper 刻意不 import 任何 Deno / supabase-js 的東西,前端 Vitest 可以直接測(各 Edge Function
// 「關 ⇒ 不呼叫 LINE / 推播 API」的整合情境另外寫在各自的 Deno 測試裡,`npm run test:edge`)。
//
//   1. 只有資料庫明確回 true 才算開著(false / null / 其他值 ⇒ 關)
//   2. 查詢出錯 / 丟例外 ⇒ "error"(呼叫端一律不發送:fail closed)
//   3. 呼叫的是 internal_merchant_has_feature,參數名正確
//   4. 快取:同一間店同一個功能只問一次;查詢失敗不快取

import { describe, expect, it, vi } from "vitest";

import {
  checkMerchantFeature,
  createMerchantFeatureCache,
  FEATURE_DISABLED_REASON,
  FEATURE_LINE_MARKETING,
  FEATURE_LINE_NOTIFICATIONS,
  FEATURE_PUSH_NOTIFICATIONS,
  MERCHANT_FEATURE_DISABLED_MESSAGE,
} from "../../supabase/functions/_shared/featureGate.ts";

function client(answer: () => Promise<{ data: unknown; error: unknown }>) {
  const rpc = vi.fn((_fn: string, _args: Record<string, unknown>) => answer());
  return { rpc };
}

describe("Edge Function 功能開關共用判斷(#1025 FG2)", () => {
  it("功能 key、訊息、原因代碼跟規格一致", () => {
    expect(FEATURE_LINE_NOTIFICATIONS).toBe("line_notifications");
    expect(FEATURE_LINE_MARKETING).toBe("line_marketing");
    expect(FEATURE_PUSH_NOTIFICATIONS).toBe("push_notifications");
    expect(MERCHANT_FEATURE_DISABLED_MESSAGE).toBe("這個功能目前沒有開放。");
    expect(FEATURE_DISABLED_REASON).toBe("feature_disabled");
  });

  it("呼叫 internal_merchant_has_feature,只有回 true 才算開著", async () => {
    const on = client(() => Promise.resolve({ data: true, error: null }));
    expect(await checkMerchantFeature(on, "m-1", "line_notifications")).toBe(true);
    expect(on.rpc).toHaveBeenCalledWith("internal_merchant_has_feature", {
      p_merchant_id: "m-1",
      p_feature_key: "line_notifications",
    });
    for (const data of [false, null, "true", 1, {}]) {
      const c = client(() => Promise.resolve({ data, error: null }));
      expect(await checkMerchantFeature(c, "m-1", "push_notifications")).toBe(false);
    }
  });

  it('查詢出錯或丟例外 ⇒ "error"(呼叫端不發送)', async () => {
    const err = client(() => Promise.resolve({ data: true, error: { message: "boom" } }));
    expect(await checkMerchantFeature(err, "m-1", "line_marketing")).toBe("error");
    const thrown = client(() => Promise.reject(new Error("network")));
    expect(await checkMerchantFeature(thrown, "m-1", "line_marketing")).toBe("error");
  });

  it("快取:同一間店同一個功能只問一次;不同店 / 不同功能分開問", async () => {
    const c = client(() => Promise.resolve({ data: false, error: null }));
    const check = createMerchantFeatureCache(c);
    expect(await check("m-1", "line_notifications")).toBe(false);
    expect(await check("m-1", "line_notifications")).toBe(false);
    expect(await check("m-2", "line_notifications")).toBe(false);
    expect(await check("m-1", "push_notifications")).toBe(false);
    expect(c.rpc).toHaveBeenCalledTimes(3);
  });

  it("快取:查詢失敗不快取,下一次會再問", async () => {
    let n = 0;
    const c = client(() =>
      Promise.resolve(
        n++ === 0 ? { data: null, error: { message: "boom" } } : { data: true, error: null },
      ),
    );
    const check = createMerchantFeatureCache(c);
    expect(await check("m-1", "line_notifications")).toBe("error");
    expect(await check("m-1", "line_notifications")).toBe(true);
    expect(c.rpc).toHaveBeenCalledTimes(2);
  });
});
