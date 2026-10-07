// 第 11 批 F #993:料錢「選擇料錢」整頁 + 摘要的純邏輯(materialCostSelection.ts)。
import { describe, expect, it } from "vitest";

import { itemQuantityError, ITEM_QUANTITY_MAX } from "./itemQuantity";
import {
  buildMaterialCostPayload,
  buildMaterialPickerItems,
  buildMaterialSummary,
  formatMaterialAmount,
  materialBaselinePrice,
  materialLimitError,
  materialSummaryFooter,
  type LoadedMaterialCosts,
} from "./materialCostSelection";
import {
  initPickerDraft,
  pickerCustomPriceErrors,
  pickerQuantityErrors,
  pickerSubtotalErrors,
  setPickerCustomPrice,
  setPickerCustomPriceEnabled,
  setPickerQuantityText,
  stepPickerQuantity,
  togglePickerItem,
} from "./serviceItemPickerLogic";

const ACTIVE = [
  { id: "a", name: "冷媒", amount: 200 },
  { id: "b", name: "銅管", amount: 600 },
];
const LOADED: LoadedMaterialCosts = {
  a: { price: 150, name: "冷媒" },
  off: { price: 12.5, name: "舊銅管" },
};

describe("materialBaselinePrice(F-3 原價)", () => {
  it("單上原有 = 單價快照;新加 = 現價;取消後再勾回的已下架品項 = 開啟時快照;查不到 = null", () => {
    expect(materialBaselinePrice("a", LOADED, ACTIVE, LOADED)).toBe(150);
    expect(materialBaselinePrice("b", LOADED, ACTIVE, LOADED)).toBe(600);
    expect(materialBaselinePrice("a", {}, ACTIVE, LOADED)).toBe(200);
    expect(materialBaselinePrice("off", {}, ACTIVE, LOADED)).toBe(12.5);
    expect(materialBaselinePrice("x", {}, ACTIVE, LOADED)).toBeNull();
  });
});

describe("buildMaterialPickerItems(整頁要列哪些)", () => {
  it("功能開:上架中 + 單上原有的已下架(標 inactive);沒在單上的已下架不列", () => {
    const items = buildMaterialPickerItems({ enabled: true, activeItems: ACTIVE, loaded: LOADED });
    expect(items.map((i) => [i.id, i.inactive ?? false])).toEqual([
      ["a", false],
      ["b", false],
      ["off", true],
    ]);
    expect(items.every((i) => i.category_id === null && i.duration_minutes === 0)).toBe(true);
  });

  it("功能關:只列單上原有的(不能新增)", () => {
    const items = buildMaterialPickerItems({ enabled: false, activeItems: ACTIVE, loaded: LOADED });
    expect(items.map((i) => i.id)).toEqual(["a", "off"]);
    expect(items.find((i) => i.id === "a")?.inactive).toBe(false);
  });
});

describe("buildMaterialSummary(F-4 / F-6)", () => {
  const baseline = (id: string) => materialBaselinePrice(id, LOADED, ACTIVE, LOADED);

  it("小計 = 單價 × 數量;合計含已下架;自訂單價 / 已下架旗標", () => {
    const { rows, total } = buildMaterialSummary({
      ids: ["a", "b", "off"],
      quantities: { a: "3", b: "1", off: "2" },
      unitPrices: { a: "150", b: "12.5", off: "12.5" },
      activeItems: ACTIVE,
      loaded: LOADED,
      baselinePrice: baseline,
    });
    expect(rows).toEqual([
      {
        id: "a",
        name: "冷媒",
        quantity: 3,
        unitPrice: 150,
        subtotal: 450,
        customUnitPrice: false,
        inactive: false,
      },
      {
        id: "b",
        name: "銅管",
        quantity: 1,
        unitPrice: 12.5,
        subtotal: 12.5,
        customUnitPrice: true,
        inactive: false,
      },
      {
        id: "off",
        name: "舊銅管",
        quantity: 2,
        unitPrice: 12.5,
        subtotal: 25,
        customUnitPrice: false,
        inactive: true,
      },
    ]);
    expect(total).toBe(487.5);
  });

  it("小數:33.33 × 3 = 99.99(不會出現浮點尾巴)", () => {
    const { total } = buildMaterialSummary({
      ids: ["b"],
      quantities: { b: "3" },
      unitPrices: { b: "33.33" },
      activeItems: ACTIVE,
      loaded: {},
      baselinePrice: (id) => materialBaselinePrice(id, {}, ACTIVE, {}),
    });
    expect(total).toBe(99.99);
  });

  it("單價空白 / 填錯 ⇒ 用原價;數量空白 ⇒ 1", () => {
    const { rows } = buildMaterialSummary({
      ids: ["b"],
      quantities: { b: "" },
      unitPrices: { b: "abc" },
      activeItems: ACTIVE,
      loaded: {},
      baselinePrice: (id) => materialBaselinePrice(id, {}, ACTIVE, {}),
    });
    expect(rows[0]).toMatchObject({ quantity: 1, unitPrice: 600, subtotal: 600 });
  });
});

describe("送出格式 / 顯示文字", () => {
  it("buildMaterialCostPayload:{品項, 數量, 單價};找不到原價又沒填 ⇒ 單價 null(交給後端)", () => {
    expect(
      buildMaterialCostPayload({
        ids: ["a", "x"],
        quantities: { a: "2" },
        unitPrices: { a: "12.5" },
        baselinePrice: (id) => (id === "a" ? 200 : null),
      }),
    ).toEqual([
      { materialCostItemId: "a", quantity: 2, unitPrice: 12.5 },
      { materialCostItemId: "x", quantity: 1, unitPrice: null },
    ]);
  });

  it("formatMaterialAmount 保留小數(最多兩位)、千分位", () => {
    expect(formatMaterialAmount(1512.5)).toBe("$1,512.5");
    expect(formatMaterialAmount(600)).toBe("$600");
    expect(formatMaterialAmount(99.99)).toBe("$99.99");
  });

  it("摘要最下一行逐字(括號半形)", () => {
    expect(materialSummaryFooter(2, 1512.5)).toBe(
      "已選 2 項，料錢合計 $1,512.5(僅供操作者參考，不代表訂單金額)",
    );
  });
});

describe("數量上限 999(F-1,服務項目與料錢共用)", () => {
  it("itemQuantityError:999 可以;1000 擋「數量最多 999」;1.5 擋;空白 / 0 當 1 不算錯", () => {
    expect(ITEM_QUANTITY_MAX).toBe(999);
    expect(itemQuantityError("999")).toBeNull();
    expect(itemQuantityError("1000")).toBe("數量最多 999");
    expect(itemQuantityError("1.5")).toBe("數量只能填整數");
    expect(itemQuantityError("")).toBeNull();
    expect(itemQuantityError("0")).toBeNull();
  });

  it("stepPickerQuantity:+ 到 999 就停;pickerQuantityErrors 抓手打超過的", () => {
    let draft = setPickerQuantityText(
      togglePickerItem({ order: [], entries: {} }, "a"),
      "a",
      "999",
    );
    draft = stepPickerQuantity(draft, "a", 1);
    expect(draft.entries["a"]?.quantity).toBe("999");
    expect(pickerQuantityErrors(draft)).toEqual({});
    draft = setPickerQuantityText(draft, "a", "1200");
    expect(pickerQuantityErrors(draft)).toEqual({ a: "數量最多 999" });
    draft = stepPickerQuantity(draft, "a", -1);
    expect(draft.entries["a"]?.quantity).toBe("999");
  });

  it("自訂單價規則(料錢):上限 99,999,999.99、小數兩位;不傳規則 = 服務項目原本行為", () => {
    let draft = togglePickerItem({ order: [], entries: {} }, "a");
    draft = setPickerCustomPriceEnabled(draft, "a", true, 200);
    draft = setPickerCustomPrice(draft, "a", "12.345");
    expect(pickerCustomPriceErrors(draft)).toEqual({});
    expect(pickerCustomPriceErrors(draft, { maxDecimals: 2 })).toEqual({
      a: "最多只能填到小數點後 2 位",
    });
    draft = setPickerCustomPrice(draft, "a", "100000000");
    expect(pickerCustomPriceErrors(draft, { max: 99_999_999.99 })).toEqual({
      a: "不能大於 99999999.99",
    });
  });

  it("編輯帶入(F-7):單價 ≠ 原價 ⇒ 自訂開關亮著、帶入單價", () => {
    const draft = initPickerDraft({
      serviceItemIds: ["a"],
      itemQuantities: { a: "2" },
      itemUnitPrices: { a: "88" },
      baselinePrice: () => 150,
    });
    expect(draft.entries["a"]).toEqual({
      quantity: "2",
      customPriceEnabled: true,
      customPrice: "88",
    });
  });
});

describe("主腦裁決(防溢位):單一小計 ≤ 1,000,000、合計 ≤ 9,999,999.99", () => {
  it("materialLimitError:剛好等於上限可以;超過一點擋", () => {
    expect(materialLimitError({ rows: [{ subtotal: 1_000_000 }], total: 1_000_000 })).toBeNull();
    expect(materialLimitError({ rows: [{ subtotal: 1_000_000.01 }], total: 1_000_000.01 })).toBe(
      "單一料錢小計不能超過 $1,000,000",
    );
    expect(materialLimitError({ rows: [{ subtotal: 1 }], total: 9_999_999.99 })).toBeNull();
    expect(materialLimitError({ rows: [{ subtotal: 1 }], total: 10_000_000 })).toBe(
      "料錢合計不能超過 $9,999,999.99，請調整單價或數量",
    );
  });

  it("pickerSubtotalErrors:自訂單價 / 原價 × 數量 超過才擋;不傳規則 = 不檢查", () => {
    const rule = { max: 1_000_000, message: "單一料錢小計不能超過 $1,000,000" };
    let draft = togglePickerItem({ order: [], entries: {} }, "a");
    draft = setPickerCustomPriceEnabled(draft, "a", true, 200);
    draft = setPickerQuantityText(draft, "a", "2");
    draft = setPickerCustomPrice(draft, "a", "500000");
    expect(pickerSubtotalErrors(draft, () => 200, rule)).toEqual({});
    draft = setPickerCustomPrice(draft, "a", "500000.01");
    expect(pickerSubtotalErrors(draft, () => 200, rule)).toEqual({ a: rule.message });
    expect(pickerSubtotalErrors(draft, () => 200, undefined)).toEqual({});
    // 自訂關掉 ⇒ 用原價:1,001.01 × 999 = 1,000,008.99 ⇒ 擋
    draft = setPickerCustomPriceEnabled(draft, "a", false, 200);
    draft = setPickerQuantityText(draft, "a", "999");
    expect(pickerSubtotalErrors(draft, () => 1001.01, rule)).toEqual({ a: rule.message });
  });
});
