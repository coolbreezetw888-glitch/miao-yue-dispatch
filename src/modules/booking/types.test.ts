// 建單與訂單管理介面優化 §2:稅金說明文字依商家稅金模式(比例/固定金額)切換的邏輯測試。
// 模組 9(支付方式)v2 §5.2/§5.3/§8.2:付款方式快照顯示文字、下拉選單選項組成邏輯測試。
// SPECS-INDEX #598(訂單管理.md §9.2):建單表單服務項目分類篩選邏輯測試。

import { describe, expect, it } from "vitest";

import {
  buildPaymentMethodOptions,
  filterServiceItemsByCategory,
  getPaymentMethodLabel,
  getTaxModeHelperText,
} from "./types";

describe("getTaxModeHelperText", () => {
  it("比例模式顯示稅率百分比說明文字", () => {
    expect(getTaxModeHelperText("percentage")).toBe("依商家設定稅率百分比,數字可個別調整。");
  });

  it("固定金額模式顯示稅額說明文字,不提百分比", () => {
    const text = getTaxModeHelperText("fixed");
    expect(text).toBe("依商家設定稅額,金額可個別調整。");
    expect(text).not.toContain("%");
    expect(text).not.toContain("百分比");
  });
});

describe("getPaymentMethodLabel(模組 9 v2 §5.3)", () => {
  it("null 顯示「尚未設定」", () => {
    expect(getPaymentMethodLabel(null)).toBe("尚未設定");
  });

  it("undefined 顯示「尚未設定」", () => {
    expect(getPaymentMethodLabel(undefined)).toBe("尚未設定");
  });

  it("空字串顯示「尚未設定」", () => {
    expect(getPaymentMethodLabel("")).toBe("尚未設定");
  });

  it("只有空白字元的字串顯示「尚未設定」", () => {
    expect(getPaymentMethodLabel("   ")).toBe("尚未設定");
  });

  it("一般文字直接顯示原文字,不做任何代碼查表(v2 商家自訂名稱,存的就是要顯示的文字本身)", () => {
    expect(getPaymentMethodLabel("LINE Pay")).toBe("LINE Pay");
    expect(getPaymentMethodLabel("現場付款")).toBe("現場付款");
    expect(getPaymentMethodLabel("保固服務")).toBe("保固服務");
  });
});

describe("buildPaymentMethodOptions(模組 9 v2 §5.2/§8.2)", () => {
  const activeMethods = [
    { id: "m1", name: "現場付款" },
    { id: "m2", name: "匯款" },
  ];

  it("新建模式(editingCurrentId 為 null)只顯示商家目前上架中的選項", () => {
    const options = buildPaymentMethodOptions(activeMethods, null, null);
    expect(options).toEqual(activeMethods);
  });

  it("編輯模式且原本選的付款方式仍然上架中,不重複附加,選項清單不變", () => {
    const options = buildPaymentMethodOptions(activeMethods, "m1", "現場付款");
    expect(options).toEqual(activeMethods);
  });

  it("編輯模式且原本選的付款方式已經下架,選項清單多出這一筆並標示「(已下架)」", () => {
    const options = buildPaymentMethodOptions(activeMethods, "m3", "LINE Pay");
    expect(options).toEqual([
      ...activeMethods,
      { id: "m3", name: "LINE Pay(已下架)" },
    ]);
  });

  it("顯示文字用快照文字,不是目前的名字(商家可能已經改名,快照才是這筆訂單當初實際顯示過的內容)", () => {
    // 商家已經把 m3 改名成「LINE Pay(舊)」,但這筆訂單當初選用時的快照文字是「LINE Pay」,
    // 附加進清單的顯示文字必須用快照文字,不能重新查詢目前的名字。
    const options = buildPaymentMethodOptions(activeMethods, "m3", "LINE Pay");
    const appended = options.find((o) => o.id === "m3");
    expect(appended?.name).toBe("LINE Pay(已下架)");
  });

  it("下架付款方式的快照文字是 null 時(理論上不該發生,但防禦性處理),顯示「(已刪除的付款方式)」", () => {
    const options = buildPaymentMethodOptions(activeMethods, "m3", null);
    const appended = options.find((o) => o.id === "m3");
    expect(appended?.name).toBe("(已刪除的付款方式)(已下架)");
  });
});

describe("filterServiceItemsByCategory(SPECS-INDEX #598)", () => {
  const items = [
    { id: "i1", name: "洗髮", category_id: "c1" },
    { id: "i2", name: "剪髮", category_id: "c1" },
    { id: "i3", name: "染髮", category_id: "c2" },
    { id: "i4", name: "雜項服務", category_id: null },
  ];

  it("filter='all' 時顯示全部服務項目(預設值,等同既有行為)", () => {
    expect(filterServiceItemsByCategory(items, "all")).toEqual(items);
  });

  it("filter=某個分類 id 時,只顯示屬於該分類的項目", () => {
    const result = filterServiceItemsByCategory(items, "c1");
    expect(result.map((i) => i.id)).toEqual(["i1", "i2"]);
  });

  it("filter='uncategorized' 時,只顯示 category_id 為 null 的項目(§4.1 既有的「未分類」虛擬分類)", () => {
    const result = filterServiceItemsByCategory(items, "uncategorized");
    expect(result.map((i) => i.id)).toEqual(["i4"]);
  });

  it("查無符合分類的項目時回傳空陣列,不報錯", () => {
    expect(filterServiceItemsByCategory(items, "c-not-exist")).toEqual([]);
  });

  it("商家完全沒有使用分類功能(全部 category_id 皆為 null)時,filter='all' 顯示全部、'uncategorized' 也顯示全部", () => {
    const allUncategorized = [
      { id: "j1", name: "服務甲", category_id: null },
      { id: "j2", name: "服務乙", category_id: null },
    ];
    expect(filterServiceItemsByCategory(allUncategorized, "all")).toEqual(allUncategorized);
    expect(filterServiceItemsByCategory(allUncategorized, "uncategorized")).toEqual(allUncategorized);
  });
});
