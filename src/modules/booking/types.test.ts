// 建單與訂單管理介面優化 §2:稅金說明文字依商家稅金模式(比例/固定金額)切換的邏輯測試。
// 模組 9(支付方式)v2 §5.2/§5.3/§8.2:付款方式快照顯示文字、下拉選單選項組成邏輯測試。
// 建單與訂單管理介面優化 §十 10.5(SPECS-INDEX #620/#621):訂單狀態顏色套用邏輯測試。
// SPECS-INDEX #598(訂單管理.md §9.2):建單表單服務項目分類篩選邏輯測試。

import { describe, expect, it } from "vitest";

import {
  bookingBlockStyle,
  bookingCardAccentBorderStyle,
  buildPaymentMethodOptions,
  DEFAULT_BOOKING_STATUS_COLORS,
  filterServiceItemsByCategory,
  getBookingStatusColor,
  getPaymentMethodLabel,
  getTaxModeHelperText,
  hexToRgba,
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

describe("getBookingStatusColor(建單與訂單管理介面優化 §10.5,SPECS-INDEX #620/#621)", () => {
  const colors = {
    pendingConfirmation: "#111111",
    accepted: "#222222",
    completed: "#333333",
    cancelled: "#444444",
  };

  it("依狀態值挑出對應色碼:completed/pending_confirmation/cancelled 各自對應", () => {
    expect(getBookingStatusColor(colors, "completed")).toBe("#333333");
    expect(getBookingStatusColor(colors, "pending_confirmation")).toBe("#111111");
    expect(getBookingStatusColor(colors, "cancelled")).toBe("#444444");
  });

  it("accepted 對應 accepted 色碼", () => {
    expect(getBookingStatusColor(colors, "accepted")).toBe("#222222");
  });

  it("其餘狀態值(pending_reply/dispatching,顏色表沒有涵蓋)沿用 accepted 的顏色", () => {
    expect(getBookingStatusColor(colors, "pending_reply")).toBe("#222222");
    expect(getBookingStatusColor(colors, "dispatching")).toBe("#222222");
  });
});

describe("hexToRgba", () => {
  it("6 碼 hex(含 # 前綴)正確轉成指定透明度的 rgba() 字串", () => {
    expect(hexToRgba("#1ea25d", 0.16)).toBe("rgba(30, 162, 93, 0.16)");
  });

  it("6 碼 hex(不含 # 前綴)也能正確轉換", () => {
    expect(hexToRgba("1ea25d", 0.5)).toBe("rgba(30, 162, 93, 0.5)");
  });

  it("不是合法 6 碼 hex 時(商家輸入 rgb()/顏色名稱等其他合法 CSS color),原樣回傳,不噴錯", () => {
    expect(hexToRgba("rgb(30, 162, 93)", 0.16)).toBe("rgb(30, 162, 93)");
    expect(hexToRgba("tomato", 0.16)).toBe("tomato");
  });
});

describe("bookingBlockStyle/bookingCardAccentBorderStyle(§10.5:CalendarPage.tsx/OrdersPage.tsx 改讀動態顏色表)", () => {
  it("bookingBlockStyle 回傳柔和背景(半透明)+ 實色文字/邊框,套用對應狀態的色碼", () => {
    const style = bookingBlockStyle(DEFAULT_BOOKING_STATUS_COLORS, "completed");
    expect(style.color).toBe(DEFAULT_BOOKING_STATUS_COLORS.completed);
    expect(style.backgroundColor).toContain("rgba(");
    expect(style.borderColor).toContain("rgba(");
  });

  it("bookingCardAccentBorderStyle 只回傳 borderLeftColor 這一個屬性,對應狀態色碼", () => {
    expect(
      bookingCardAccentBorderStyle(DEFAULT_BOOKING_STATUS_COLORS, "pending_confirmation"),
    ).toEqual({
      borderLeftColor: DEFAULT_BOOKING_STATUS_COLORS.pendingConfirmation,
    });
  });

  it("商家自訂顏色(非預設值)時,兩支函式都正確套用自訂色碼,不是繼續顯示預設值", () => {
    const custom = {
      pendingConfirmation: "#abc123",
      accepted: "#def456",
      completed: "#111222",
      cancelled: "#333444",
    };
    expect(bookingCardAccentBorderStyle(custom, "completed")).toEqual({
      borderLeftColor: "#111222",
    });
    expect(bookingBlockStyle(custom, "cancelled").color).toBe("#333444");
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
