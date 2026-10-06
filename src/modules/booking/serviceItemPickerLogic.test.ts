// SPECS-INDEX #979:「選擇項目」整頁的草稿 / 頁籤 / 寫回表單。
import { describe, expect, it } from "vitest";

import {
  applyPickerDraft,
  buildPickerTabs,
  formatPickerDuration,
  formatPickerPrice,
  initPickerDraft,
  pickerCustomPriceErrors,
  resolveDefaultPickerTab,
  setPickerCustomPrice,
  setPickerCustomPriceEnabled,
  setPickerQuantityText,
  stepPickerQuantity,
  togglePickerItem,
  UNCATEGORIZED_TAB_KEY,
  type PickerItem,
} from "./serviceItemPickerLogic";

const items: PickerItem[] = [
  { id: "a1", name: "壁掛普通", price: 2200, duration_minutes: 60, category_id: "cA" },
  { id: "a2", name: "壁掛特殊", price: 2700, duration_minutes: 90, category_id: "cA" },
  { id: "b1", name: "吊隱", price: 3500, duration_minutes: 120, category_id: "cB" },
  { id: "u1", name: "到府場勘", price: 500, duration_minutes: 0, category_id: null },
  { id: "x1", name: "孤兒項目", price: 100, duration_minutes: 30, category_id: "deleted" },
];
const categories = [
  { id: "cA", name: "壁掛分離式" },
  { id: "cB", name: "吊隱式" },
  { id: "cEmpty", name: "沒有項目的分類" },
];
const price = (id: string) => items.find((i) => i.id === id)?.price ?? null;

describe("buildPickerTabs / resolveDefaultPickerTab", () => {
  const tabs = buildPickerTabs(items, categories, "未分類");
  it("沒有項目的分類不顯示頁籤;未分類(含分類已被刪的項目)放最後", () => {
    expect(tabs.map((t) => t.label)).toEqual(["壁掛分離式", "吊隱式", "未分類"]);
    expect(tabs[2]!.key).toBe(UNCATEGORIZED_TAB_KEY);
    expect(tabs[2]!.items.map((i) => i.id)).toEqual(["u1", "x1"]);
  });
  it("預設停在已選項目所在的分類;沒選就停在第一個", () => {
    expect(resolveDefaultPickerTab(tabs, ["b1"])).toBe("cB");
    expect(resolveDefaultPickerTab(tabs, [])).toBe("cA");
    expect(resolveDefaultPickerTab([], [])).toBeNull();
  });
});

describe("勾選 / 數量 / 自訂金額", () => {
  const empty = initPickerDraft({
    serviceItemIds: [],
    itemQuantities: {},
    itemUnitPrices: {},
    baselinePrice: price,
  });

  it("勾選 ⇒ 數量 1、自訂金額關閉;取消勾選 ⇒ 整筆拿掉(自訂金額一起清掉)", () => {
    let d = togglePickerItem(empty, "a1");
    d = setPickerCustomPriceEnabled(d, "a1", true, 2200);
    d = setPickerCustomPrice(d, "a1", "1800");
    expect(d.entries["a1"]).toEqual({
      quantity: "1",
      customPriceEnabled: true,
      customPrice: "1800",
    });
    d = togglePickerItem(d, "a1");
    expect(d.entries["a1"]).toBeUndefined();
    d = togglePickerItem(d, "a1");
    expect(d.entries["a1"]).toEqual({ quantity: "1", customPriceEnabled: false, customPrice: "" });
  });

  it("− 最少 1;+ 會順手勾起沒勾的項目", () => {
    let d = stepPickerQuantity(empty, "a2", 1);
    expect(d.entries["a2"]!.quantity).toBe("1");
    d = stepPickerQuantity(d, "a2", 1);
    expect(d.entries["a2"]!.quantity).toBe("2");
    d = stepPickerQuantity(stepPickerQuantity(d, "a2", -1), "a2", -1);
    expect(d.entries["a2"]!.quantity).toBe("1");
    d = setPickerQuantityText(d, "a2", "");
    expect(stepPickerQuantity(d, "a2", 1).entries["a2"]!.quantity).toBe("2");
  });

  it("打開自訂金額 ⇒ 預先帶入原價;關掉 ⇒ 清空", () => {
    let d = togglePickerItem(empty, "b1");
    d = setPickerCustomPriceEnabled(d, "b1", true, 3500);
    expect(d.entries["b1"]!.customPrice).toBe("3500");
    d = setPickerCustomPriceEnabled(d, "b1", false, 3500);
    expect(d.entries["b1"]).toMatchObject({ customPriceEnabled: false, customPrice: "" });
  });

  it("自訂金額打開但填錯 ⇒ 有錯誤(確認鈕要擋);關掉的不檢查", () => {
    let d = togglePickerItem(togglePickerItem(empty, "a1"), "b1");
    d = setPickerCustomPriceEnabled(d, "a1", true, 2200);
    d = setPickerCustomPrice(d, "a1", "abc");
    expect(Object.keys(pickerCustomPriceErrors(d))).toEqual(["a1"]);
    d = setPickerCustomPrice(d, "a1", "1e3");
    expect(Object.keys(pickerCustomPriceErrors(d))).toEqual(["a1"]);
    d = setPickerCustomPrice(d, "a1", "1999.5");
    expect(pickerCustomPriceErrors(d)).toEqual({});
  });
});

describe("applyPickerDraft:按「確認」寫回表單", () => {
  it("跨分類勾兩項、調數量、自訂金額 ⇒ 三份狀態正確(🔴 自訂金額一定要寫回單價)", () => {
    const start = initPickerDraft({
      serviceItemIds: [],
      itemQuantities: {},
      itemUnitPrices: {},
      baselinePrice: price,
    });
    let d = togglePickerItem(start, "a1");
    d = togglePickerItem(d, "b1");
    d = stepPickerQuantity(d, "a1", 1);
    d = setPickerCustomPriceEnabled(d, "b1", true, 3500);
    d = setPickerCustomPrice(d, "b1", " 3000 ");
    const applied = applyPickerDraft({
      draft: d,
      previousIds: [],
      previousQuantities: {},
      previousUnitPrices: {},
      hiddenSelectedIds: [],
      baselinePrice: price,
    });
    expect(applied.serviceItemIds).toEqual(["a1", "b1"]);
    expect(applied.itemQuantities).toEqual({ a1: "2", b1: "1" });
    expect(applied.itemUnitPrices).toEqual({ a1: "2200", b1: "3000" });
    expect(applied.removedIds).toEqual([]);
  });

  it("數量欄清空 ⇒ 寫回 1(跟表單原本的 parseItemQuantity 一致)", () => {
    let d = togglePickerItem(
      initPickerDraft({
        serviceItemIds: [],
        itemQuantities: {},
        itemUnitPrices: {},
        baselinePrice: price,
      }),
      "a2",
    );
    d = setPickerQuantityText(d, "a2", "");
    const applied = applyPickerDraft({
      draft: d,
      previousIds: [],
      previousQuantities: {},
      previousUnitPrices: {},
      hiddenSelectedIds: [],
      baselinePrice: price,
    });
    expect(applied.itemQuantities["a2"]).toBe("1");
  });

  it("編輯:原本單上的項目用快照當原價 ⇒ 打開時自訂金額關著,不動就寫回快照(#829 不誤判)", () => {
    const snapshotPrice = (id: string) => (id === "a1" ? 2000 : price(id));
    const d = initPickerDraft({
      serviceItemIds: ["a1"],
      itemQuantities: { a1: "3" },
      itemUnitPrices: { a1: "2000" },
      baselinePrice: snapshotPrice,
    });
    expect(d.entries["a1"]).toEqual({ quantity: "3", customPriceEnabled: false, customPrice: "" });
    const applied = applyPickerDraft({
      draft: d,
      previousIds: ["a1"],
      previousQuantities: { a1: "3" },
      previousUnitPrices: { a1: "2000" },
      hiddenSelectedIds: [],
      baselinePrice: snapshotPrice,
    });
    expect(applied.itemUnitPrices).toEqual({ a1: "2000" });
    expect(applied.itemQuantities).toEqual({ a1: "3" });
  });

  it("表單上單價本來就改過 ⇒ 打開時自訂金額是開的、帶入那個金額", () => {
    const d = initPickerDraft({
      serviceItemIds: ["a1"],
      itemQuantities: { a1: "1" },
      itemUnitPrices: { a1: "1500" },
      baselinePrice: price,
    });
    expect(d.entries["a1"]).toEqual({
      quantity: "1",
      customPriceEnabled: true,
      customPrice: "1500",
    });
  });

  it("取消勾選 ⇒ removedIds 列出(呼叫端要拿掉 #829 快照基準);看不到的已下架項目原封不動保留", () => {
    const d0 = initPickerDraft({
      serviceItemIds: ["gone", "a1"],
      itemQuantities: { gone: "2", a1: "1" },
      itemUnitPrices: { gone: "999", a1: "2200" },
      baselinePrice: (id) => (id === "gone" ? 999 : price(id)),
    });
    const d = togglePickerItem(d0, "a1");
    const applied = applyPickerDraft({
      draft: d,
      previousIds: ["gone", "a1"],
      previousQuantities: { gone: "2", a1: "1" },
      previousUnitPrices: { gone: "999", a1: "2200" },
      hiddenSelectedIds: ["gone"],
      baselinePrice: price,
    });
    expect(applied.serviceItemIds).toEqual(["gone"]);
    expect(applied.itemQuantities).toEqual({ gone: "2" });
    expect(applied.itemUnitPrices).toEqual({ gone: "999" });
    expect(applied.removedIds).toEqual(["a1"]);
  });
});

describe("顯示格式", () => {
  it("時長:有設定才顯示", () => {
    expect(formatPickerDuration(60)).toBe("大約 1 小時");
    expect(formatPickerDuration(90)).toBe("大約 1 小時 30 分鐘");
    expect(formatPickerDuration(45)).toBe("大約 45 分鐘");
    expect(formatPickerDuration(0)).toBeNull();
  });
  it("金額:NT$ + 千分位", () => {
    expect(formatPickerPrice(2200)).toBe("NT$ 2,200");
    expect(formatPickerPrice(1999.5)).toBe("NT$ 1,999.5");
  });
});
