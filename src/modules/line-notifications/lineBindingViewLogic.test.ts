// 模組 11(LINE 通知)—「我的 LINE 綁定」卡片純判斷邏輯的單元測試。
//
// 為什麼這份測試是硬要求:2026-09-24 線上發生過「雙重身分的人完全進不去服務人員端」的故障,
// 根因是這類狀態判斷寫死在元件裡沒辦法被測。這裡把每一條分支(尤其是 fail-closed 的那幾條)
// 都釘住。

import { describe, expect, it } from "vitest";

import {
  buildLineAddFriendUrl,
  formatBindingCodeCountdown,
  resolveLineBindingViewState,
  toFriendlyLineBindingErrorMessage,
  type LineBindingViewStateInput,
} from "./lineBindingViewLogic";

/** 一組「已載入完成、商家已串接、我還沒綁定」的基準輸入,各測試只覆寫自己關心的欄位。 */
function baseInput(overrides: Partial<LineBindingViewStateInput> = {}): LineBindingViewStateInput {
  return {
    bindingStatusLoading: false,
    lineBound: false,
    merchantInfoLoading: false,
    merchantInfoFailed: false,
    merchantConnected: true,
    ...overrides,
  };
}

describe("resolveLineBindingViewState", () => {
  it("一切就緒且未綁定時是 unbound(可以顯示產生綁定碼按鈕)", () => {
    expect(resolveLineBindingViewState(baseInput())).toBe("unbound");
  });

  it("自己那一列還在查詢中時一律是 loading —— 連商家已串接也不例外", () => {
    expect(resolveLineBindingViewState(baseInput({ bindingStatusLoading: true }))).toBe("loading");
  });

  it("已綁定時是 bound", () => {
    expect(resolveLineBindingViewState(baseInput({ lineBound: true }))).toBe("bound");
  });

  it("已綁定時不等商家資訊查詢 —— 商家資訊還在載入也直接顯示 bound(解除綁定跟商家串接無關)", () => {
    expect(
      resolveLineBindingViewState(
        baseInput({ lineBound: true, merchantInfoLoading: true, merchantConnected: null }),
      ),
    ).toBe("bound");
  });

  it("已綁定時即使商家資訊查詢失敗,仍然顯示 bound(不能讓使用者失去解除綁定的入口)", () => {
    expect(
      resolveLineBindingViewState(
        baseInput({ lineBound: true, merchantInfoFailed: true, merchantConnected: null }),
      ),
    ).toBe("bound");
  });

  it("已綁定時即使商家後來解除了 LINE 串接,仍然顯示 bound", () => {
    expect(
      resolveLineBindingViewState(baseInput({ lineBound: true, merchantConnected: false })),
    ).toBe("bound");
  });

  it("查詢已結束但拿不到自己那一列(lineBound = null)時是 no_access,不是 unbound", () => {
    expect(resolveLineBindingViewState(baseInput({ lineBound: null }))).toBe("no_access");
  });

  it("商家資訊還在查詢中時是 loading(不先閃一下按鈕)", () => {
    expect(
      resolveLineBindingViewState(
        baseInput({ merchantInfoLoading: true, merchantConnected: null }),
      ),
    ).toBe("loading");
  });

  it("商家資訊查詢被後端擋下(42501)時是 no_access", () => {
    expect(
      resolveLineBindingViewState(baseInput({ merchantInfoFailed: true, merchantConnected: null })),
    ).toBe("no_access");
  });

  it("商家還沒完成 LINE 串接時是 merchant_not_connected(不顯示按了必定沒用的按鈕)", () => {
    expect(resolveLineBindingViewState(baseInput({ merchantConnected: false }))).toBe(
      "merchant_not_connected",
    );
  });

  it("fail-closed:既沒載入中、也沒失敗、也沒拿到商家資料時退回 loading,絕不預設成 unbound", () => {
    expect(resolveLineBindingViewState(baseInput({ merchantConnected: null }))).toBe("loading");
  });

  it("merchantConnected 只認嚴格的 true —— 任何不是 true 的值都不會變成 unbound", () => {
    // 刻意用 as 繞過型別,模擬後端回傳形狀不如預期(例如字串 "true")時的行為。
    const weird = baseInput({ merchantConnected: "true" as unknown as boolean });
    expect(resolveLineBindingViewState(weird)).toBe("loading");
  });
});

describe("buildLineAddFriendUrl", () => {
  it("沒有 @ 前綴時正確組出連結", () => {
    expect(buildLineAddFriendUrl("miaoyue")).toBe("https://line.me/R/ti/p/@miaoyue");
  });

  it("已經帶 @ 前綴時不會變成 @@(這是既有寫法會產生壞連結的情況)", () => {
    expect(buildLineAddFriendUrl("@miaoyue")).toBe("https://line.me/R/ti/p/@miaoyue");
  });

  it("多個 @ 前綴也只留一個", () => {
    expect(buildLineAddFriendUrl("@@miaoyue")).toBe("https://line.me/R/ti/p/@miaoyue");
  });

  it("前後有空白時會去掉", () => {
    expect(buildLineAddFriendUrl("  miaoyue  ")).toBe("https://line.me/R/ti/p/@miaoyue");
  });

  it("null / undefined / 空字串 / 只有 @ 一律回傳 null", () => {
    expect(buildLineAddFriendUrl(null)).toBeNull();
    expect(buildLineAddFriendUrl(undefined)).toBeNull();
    expect(buildLineAddFriendUrl("")).toBeNull();
    expect(buildLineAddFriendUrl("   ")).toBeNull();
    expect(buildLineAddFriendUrl("@")).toBeNull();
  });
});

describe("formatBindingCodeCountdown", () => {
  it("整分鐘與帶秒數都正確補零", () => {
    expect(formatBindingCodeCountdown(10 * 60 * 1000)).toBe("10:00");
    expect(formatBindingCodeCountdown(9 * 60 * 1000 + 5 * 1000)).toBe("9:05");
    expect(formatBindingCodeCountdown(59 * 1000)).toBe("0:59");
  });

  it("已經過期(負數)時顯示 0:00,不顯示負數", () => {
    expect(formatBindingCodeCountdown(-1)).toBe("0:00");
    expect(formatBindingCodeCountdown(-60_000)).toBe("0:00");
  });

  it("不是有效數字時當成 0", () => {
    expect(formatBindingCodeCountdown(Number.NaN)).toBe("0:00");
  });
});

describe("toFriendlyLineBindingErrorMessage", () => {
  const fallback = "產生綁定碼失敗,請稍後再試";

  it("我們自己 raise 的中文白話訊息原樣顯示(那才是最有用的資訊)", () => {
    expect(
      toFriendlyLineBindingErrorMessage(
        { message: "你不是這間商家目前在職、且已開通登入的服務人員" },
        fallback,
      ),
    ).toBe("你不是這間商家目前在職、且已開通登入的服務人員");
  });

  it("純英文的原始錯誤訊息換成白話 fallback", () => {
    expect(
      toFriendlyLineBindingErrorMessage(
        { message: "permission denied for function generate_own_staff_line_binding_code" },
        fallback,
      ),
    ).toBe(fallback);
  });

  it("網路層的 Failed to fetch 換成白話 fallback", () => {
    expect(toFriendlyLineBindingErrorMessage(new Error("Failed to fetch"), fallback)).toBe(
      fallback,
    );
  });

  it("夾了中文但仍然是資料庫原始訊息(命中特徵)時也換成 fallback", () => {
    expect(
      toFriendlyLineBindingErrorMessage(
        { message: '新增失敗:duplicate key value violates unique constraint "xxx_pkey"' },
        fallback,
      ),
    ).toBe(fallback);
  });

  it("完全拿不到訊息(null / 空字串 / 沒有 message 欄位)時用 fallback", () => {
    expect(toFriendlyLineBindingErrorMessage(null, fallback)).toBe(fallback);
    expect(toFriendlyLineBindingErrorMessage({ message: "" }, fallback)).toBe(fallback);
    expect(toFriendlyLineBindingErrorMessage({ message: "   " }, fallback)).toBe(fallback);
    expect(toFriendlyLineBindingErrorMessage({ code: "42501" }, fallback)).toBe(fallback);
  });
});
