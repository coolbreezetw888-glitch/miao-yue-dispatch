// 客戶端第 1 批(C1):公開預約頁純函式測試。
//   C1-A05 預估時長 / 金額(含數量 ×2、×3)、至少一項主要服務、24 小時上限、數量 1~20
//   C1-A06 服務人員篩選(沒設對應 = 全會;有設對應只看主要項目)
//   C1-A07 日期 / 時間排版、摘要文字、「下一週」停用規則
//   C1-A08 欄位驗證
//   C1-A04 聯絡按鈕

import { describe, expect, it } from "vitest";

import {
  formNextStepHint,
  step5Name,
  stepLabels,
  addDays,
  buildPublicServiceTabs,
  computeSelectionTotals,
  dayStateLabel,
  eligibleStaff,
  formatEndTime,
  formatSlotSummary,
  formatWeekHeading,
  groupTimes,
  isNextWeekDisabled,
  merchantLogoText,
  resolveContactLinks,
  serviceStepBlockedReason,
  staffAvatarText,
  stepSelection,
  taipeiToday,
  toggleSelection,
  validateCustomerForm,
  weekdayLabel,
} from "./publicBookingLogic";
import type { PublicServiceItem, PublicStaff } from "./types";

const ITEMS: PublicServiceItem[] = [
  {
    id: "indoor",
    category_id: "split",
    name: "室內機清洗",
    description: null,
    price: 2500,
    duration_minutes: 90,
    item_type: "primary",
  },
  {
    id: "outdoor",
    category_id: "split",
    name: "室外機清洗",
    description: null,
    price: 1200,
    duration_minutes: 60,
    item_type: "primary",
  },
  {
    id: "window",
    category_id: "window",
    name: "窗型冷氣",
    description: null,
    price: 1800,
    duration_minutes: 75,
    item_type: "primary",
  },
  {
    id: "loose",
    category_id: null,
    name: "沒有分類的項目",
    description: null,
    price: 100,
    duration_minutes: 10,
    item_type: "primary",
  },
  {
    id: "addon-1",
    category_id: "split",
    name: "抗菌塗層",
    description: null,
    price: 300.5,
    duration_minutes: 15,
    item_type: "addon",
  },
];

describe("C1-A05 選服務", () => {
  it("分類頁籤:主要項目依分類(順序照分類清單),沒有分類放「未分類」,加購項目獨立放最後", () => {
    const tabs = buildPublicServiceTabs(ITEMS, [
      { id: "split", name: "分離式冷氣" },
      { id: "window", name: "窗型冷氣" },
      { id: "empty", name: "沒有項目的分類" },
    ]);
    expect(tabs.map((t) => t.label)).toEqual(["分離式冷氣", "窗型冷氣", "未分類", "加購項目"]);
    expect(tabs[0]!.items.map((i) => i.id)).toEqual(["indoor", "outdoor"]);
    expect(tabs[3]!.items.map((i) => i.id)).toEqual(["addon-1"]);
  });

  it("預估時長 = Σ(工時 × 數量)、預估金額 = Σ(價格 × 數量)(數量 ×2、×3)", () => {
    let sel = toggleSelection(new Map(), "indoor");
    sel = stepSelection(sel, "indoor", 1); // ×2
    sel = toggleSelection(sel, "outdoor");
    sel = stepSelection(sel, "outdoor", 1);
    sel = stepSelection(sel, "outdoor", 1); // ×3
    const totals = computeSelectionTotals(sel, ITEMS);
    expect(totals.itemCount).toBe(2);
    expect(totals.unitCount).toBe(5);
    expect(totals.totalMinutes).toBe(90 * 2 + 60 * 3);
    expect(totals.totalPrice).toBe(2500 * 2 + 1200 * 3);
  });

  it("小數價格不會有浮點誤差", () => {
    let sel = toggleSelection(new Map(), "addon-1");
    sel = stepSelection(sel, "addon-1", 1);
    sel = stepSelection(sel, "addon-1", 1);
    expect(computeSelectionTotals(sel, ITEMS).totalPrice).toBe(901.5);
  });

  it("數量 1~20:− 到 1 停、+ 到 20 停;沒勾選時按 + 會勾起來、按 − 不會", () => {
    let sel = stepSelection(new Map(), "indoor", -1);
    expect(sel.has("indoor")).toBe(false);
    sel = stepSelection(sel, "indoor", 1);
    expect(sel.get("indoor")).toBe(1);
    sel = stepSelection(sel, "indoor", -1);
    expect(sel.get("indoor")).toBe(1);
    for (let i = 0; i < 30; i += 1) sel = stepSelection(sel, "indoor", 1);
    expect(sel.get("indoor")).toBe(20);
  });

  it("下一步的條件:沒選 / 只選加購 / 超過 24 小時 ⇒ 擋下並說原因", () => {
    expect(serviceStepBlockedReason(computeSelectionTotals(new Map(), ITEMS))).toBe(
      "請先選擇要預約的服務。",
    );
    const addonOnly = toggleSelection(new Map(), "addon-1");
    expect(serviceStepBlockedReason(computeSelectionTotals(addonOnly, ITEMS))).toBe(
      "請至少選一項主要服務。",
    );
    const ok = toggleSelection(addonOnly, "indoor");
    expect(serviceStepBlockedReason(computeSelectionTotals(ok, ITEMS))).toBeNull();
    const tooLong = new Map([["indoor", 17]]); // 90 × 17 = 1530 分鐘 > 1440
    expect(serviceStepBlockedReason(computeSelectionTotals(tooLong, ITEMS))).toBe(
      "選的服務太多，請聯絡店家。",
    );
    const exactly24h = new Map([["indoor", 16]]); // 1440 分鐘 = 剛好 24 小時,可以
    expect(serviceStepBlockedReason(computeSelectionTotals(exactly24h, ITEMS))).toBeNull();
  });
});

describe("C1-A06 服務人員篩選", () => {
  const staff: PublicStaff[] = [
    {
      id: "all",
      display_name: "全能",
      avatar_url: null,
      intro: null,
      primary_service_item_ids: null,
    },
    {
      id: "split-only",
      display_name: "阿明",
      avatar_url: null,
      intro: null,
      primary_service_item_ids: ["indoor", "outdoor"],
    },
    {
      id: "indoor-only",
      display_name: "小陳",
      avatar_url: null,
      intro: null,
      primary_service_item_ids: ["indoor"],
    },
  ];

  it("沒設對應的人一定出現;有設對應但缺一個主要項目的人不出現", () => {
    const sel = new Map([
      ["indoor", 1],
      ["outdoor", 1],
    ]);
    expect(eligibleStaff(staff, sel, ITEMS).map((s) => s.id)).toEqual(["all", "split-only"]);
  });

  it("只缺加購項目的人仍出現(加購不列入檢查)", () => {
    const sel = new Map([
      ["indoor", 1],
      ["addon-1", 1],
    ]);
    expect(eligibleStaff(staff, sel, ITEMS).map((s) => s.id)).toEqual([
      "all",
      "split-only",
      "indoor-only",
    ]);
  });

  it("頭像文字:服務人員取名字最後一個字;店家取店名前兩個字", () => {
    expect(staffAvatarText("阿明")).toBe("明");
    expect(staffAvatarText("小陳")).toBe("陳");
    expect(merchantLogoText("涼風工匠")).toBe("涼風");
    expect(merchantLogoText("A")).toBe("A");
  });
});

describe("C1-A07 日期與時間", () => {
  it("台北時間的今天:UTC 16:30 = 台北隔天 00:30", () => {
    expect(taipeiToday(new Date("2026-10-07T16:30:00Z"))).toBe("2026-10-08");
    expect(taipeiToday(new Date("2026-10-07T15:59:00Z"))).toBe("2026-10-07");
  });

  it("日期加減、星期", () => {
    expect(addDays("2026-10-08", 7)).toBe("2026-10-15");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(weekdayLabel("2026-10-08")).toBe("四");
    expect(weekdayLabel("2026-10-11")).toBe("日");
  });

  it("月份標題:跨月 / 跨年", () => {
    expect(formatWeekHeading("2026-10-08")).toBe("2026年10月");
    expect(formatWeekHeading("2026-10-29")).toBe("2026年10月～11月");
    expect(formatWeekHeading("2026-12-29")).toBe("2026年12月～2027年1月");
  });

  it("日期格子下方文字:公休 / 已滿 / 今天", () => {
    expect(dayStateLabel("closed", true)).toBe("公休");
    expect(dayStateLabel("full", false)).toBe("已滿");
    expect(dayStateLabel("open", true)).toBe("今天");
    expect(dayStateLabel("open", false)).toBe("");
    expect(dayStateLabel("out_of_range", false)).toBe("");
  });

  it("上午 / 下午 / 晚上分組(晚上沒有時段就不出現)", () => {
    expect(groupTimes(["09:00", "11:30", "12:00", "17:30"]).map((g) => g.label)).toEqual([
      "上午",
      "下午",
    ]);
    expect(groupTimes(["18:00", "20:30"])).toEqual([{ label: "晚上", times: ["18:00", "20:30"] }]);
  });

  it("摘要文字(全形標點)與跨午夜的完成時間", () => {
    expect(formatSlotSummary("2026-10-13", "10:00", 240)).toBe(
      "10月13日（二）10:00 開始，預計 14:00 左右完成（共約 4 小時）。",
    );
    expect(formatSlotSummary("2026-10-13", "09:30", 90)).toBe(
      "10月13日（二）09:30 開始，預計 11:00 左右完成（共約 1 小時 30 分鐘）。",
    );
    expect(formatEndTime("23:00", 120)).toBe("隔天 01:00");
  });

  it("下一週停用:看過範圍內的日子 + 這一頁最後一天是範圍外 ⇒ 停用", () => {
    expect(isNextWeekDisabled({ weekOffset: 0, lastDayState: "open", everInRange: true })).toBe(
      false,
    );
    expect(
      isNextWeekDisabled({ weekOffset: 8, lastDayState: "out_of_range", everInRange: true }),
    ).toBe(true);
    // 最少提前很多天:第一週整週都在範圍外,還沒看過範圍內的日子 ⇒ 可以繼續往後翻
    expect(
      isNextWeekDisabled({ weekOffset: 0, lastDayState: "out_of_range", everInRange: false }),
    ).toBe(false);
    // 保險上限
    expect(isNextWeekDisabled({ weekOffset: 52, lastDayState: "open", everInRange: true })).toBe(
      true,
    );
  });
});

describe("C1-A08 欄位驗證", () => {
  it("姓名去頭尾空白後 1~50 字", () => {
    expect(validateCustomerForm({ name: "   ", address: "", note: "" }, false).name).toBe(
      "請填寫姓名。",
    );
    expect(validateCustomerForm({ name: "王小明", address: "", note: "" }, false)).toEqual({});
    expect(validateCustomerForm({ name: "字".repeat(51), address: "", note: "" }, false).name).toBe(
      "姓名最多 50 個字。",
    );
    expect(
      validateCustomerForm({ name: ` ${"字".repeat(50)} `, address: "", note: "" }, false),
    ).toEqual({});
  });

  it("地址:到府才必填(1~200 字);到店不檢查", () => {
    expect(validateCustomerForm({ name: "王", address: "", note: "" }, true).address).toBe(
      "請填寫服務地址。",
    );
    expect(
      validateCustomerForm({ name: "王", address: "", note: "" }, false).address,
    ).toBeUndefined();
    expect(
      validateCustomerForm({ name: "王", address: "路".repeat(201), note: "" }, true).address,
    ).toBe("服務地址最多 200 個字。");
  });

  it("備註最多 500 字", () => {
    expect(validateCustomerForm({ name: "王", address: "", note: "a".repeat(500) }, false)).toEqual(
      {},
    );
    expect(
      validateCustomerForm({ name: "王", address: "", note: "a".repeat(501) }, false).note,
    ).toBe("備註最多 500 個字。");
  });
});

describe("C1-A04 聯絡按鈕", () => {
  it("四種組合", () => {
    expect(
      resolveContactLinks({ line_friend_url: "https://lin.ee/abc", phone: "02-1234-5678" }),
    ).toEqual({ lineUrl: "https://lin.ee/abc", telHref: "tel:0212345678" });
    expect(resolveContactLinks({ line_friend_url: "https://lin.ee/abc", phone: null })).toEqual({
      lineUrl: "https://lin.ee/abc",
      telHref: null,
    });
    expect(resolveContactLinks({ line_friend_url: null, phone: "0912345678" })).toEqual({
      lineUrl: null,
      telHref: "tel:0912345678",
    });
    expect(resolveContactLinks({ line_friend_url: null, phone: "  " })).toEqual({
      lineUrl: null,
      telHref: null,
    });
  });

  it("不是 https:// 開頭的連結一律不顯示(javascript: 之類不會進 href)", () => {
    expect(
      resolveContactLinks({ line_friend_url: "javascript:alert(1)", phone: null }).lineUrl,
    ).toBeNull();
    expect(
      resolveContactLinks({ line_friend_url: "http://line.me/x", phone: null }).lineUrl,
    ).toBeNull();
  });
});

describe("2026-10-09 使用者新增:步驟條 5 步 + 填資料頁下一步提示", () => {
  it("步驟條文字:1~4 步講下一步;第 5 步名稱依登入狀態;最後一步", () => {
    expect(stepLabels(1, step5Name(false))).toEqual({
      current: "步驟 1／5\u3000選服務",
      next: "下一步：選服務人員",
    });
    expect(stepLabels(4, step5Name(false))).toEqual({
      current: "步驟 4／5\u3000填資料",
      next: "下一步：登入／電話",
    });
    expect(stepLabels(4, step5Name(true)).next).toBe("下一步：確認送出");
    expect(stepLabels(5, step5Name(true))).toEqual({
      current: "步驟 5／5\u3000確認送出",
      next: "最後一步",
    });
  });

  it("姓名欄上方的提示句(依店家設定與登入狀態)", () => {
    const hint = (lineLoginEnabled: boolean, allowGuest: boolean, linked = false) =>
      formNextStepHint({ lineLoginEnabled, allowGuest, linked });
    expect(hint(true, true)).toBe("下一步會請您用 LINE 登入或填寫電話。");
    expect(hint(true, false)).toBe("下一步會請您用 LINE 登入。");
    expect(hint(false, true)).toBe("下一步會請您填寫電話。");
    expect(hint(false, false)).toBeNull();
    expect(hint(true, true, true)).toBeNull();
    expect(hint(true, false, true)).toBeNull();
  });
});
