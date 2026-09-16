// 對應 ARCHITECTURE.md 第八節第 5 條要補的坑第 2 項的其中一半(純函式部分)。
// 完整背景見 src/modules/merchant/context.tsx 檔案開頭的說明:localStorage 的
// 「目前操作中商家 id」原本是全域 key,不分帳號,同一瀏覽器換帳號會讀到上一個帳號存的值。
// 這裡只驗證 key 產生函式本身:不同使用者一定要拿到不同的 key,同一使用者每次都拿到一樣的 key。
import { describe, expect, it } from "vitest";

import { CURRENT_MERCHANT_STORAGE_KEY_PREFIX, getCurrentMerchantStorageKey } from "./constants";

describe("getCurrentMerchantStorageKey()", () => {
  it("不同使用者 id 產生不同的 localStorage key", () => {
    const keyA = getCurrentMerchantStorageKey("user-a");
    const keyB = getCurrentMerchantStorageKey("user-b");

    expect(keyA).not.toBe(keyB);
  });

  it("同一個使用者 id 每次都產生相同的 key(可重現、可用來讀回上次存的值)", () => {
    const first = getCurrentMerchantStorageKey("user-a");
    const second = getCurrentMerchantStorageKey("user-a");

    expect(first).toBe(second);
  });

  it("key 帶有共用前綴,且包含使用者 id 本身,不是把 id 弄丟的固定字串", () => {
    const key = getCurrentMerchantStorageKey("user-a");

    expect(key.startsWith(CURRENT_MERCHANT_STORAGE_KEY_PREFIX)).toBe(true);
    expect(key).toContain("user-a");
  });
});
