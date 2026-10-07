// 第 11 批 G(#994):多選下拉的摘要文字與搜尋過濾。規格書 §14.5 G-5、G-9、§14.7。

import { describe, expect, it } from "vitest";

import {
  countSelectedOptions,
  filterMultiSelectOptions,
  formatMultiSelectSummary,
  MULTI_SELECT_NO_RESULT,
  MULTI_SELECT_REMOVED_DETAIL,
  MULTI_SELECT_REMOVED_HEADING,
  type FieldMultiSelectOption,
} from "./fieldMultiSelectLogic";

const OPTIONS: FieldMultiSelectOption[] = [
  { value: "a", label: "冷氣清洗", detail: "清洗類 ・ $1500", keywords: "清洗類" },
  { value: "b", label: "冷氣安裝", detail: "安裝類 ・ $3000", keywords: "安裝類" },
  { value: "c", label: "Deep Clean", detail: "Cleaning ・ $800", keywords: "Cleaning" },
  { value: "d", label: "舊款濾網", keywords: "耗材", removed: true },
];

describe("formatMultiSelectSummary(G-5)", () => {
  it("0 項 ⇒ null(呼叫端顯示灰字)", () => {
    expect(formatMultiSelectSummary(OPTIONS, new Set())).toBeNull();
    expect(formatMultiSelectSummary(OPTIONS, new Set(["不在清單裡"]))).toBeNull();
  });
  it("1 項", () => {
    expect(formatMultiSelectSummary(OPTIONS, new Set(["b"]))).toBe("已選 1 項：冷氣安裝");
  });
  it("3 項:名稱照清單順序(不是勾選順序),用全形「、」接", () => {
    expect(formatMultiSelectSummary(OPTIONS, new Set(["c", "a", "b"]))).toBe(
      "已選 3 項：冷氣清洗、冷氣安裝、Deep Clean",
    );
  });
  it("含已下架 ⇒ 名稱後面加 (已下架)", () => {
    expect(formatMultiSelectSummary(OPTIONS, new Set(["d", "a"]))).toBe(
      "已選 2 項：冷氣清洗、舊款濾網(已下架)",
    );
  });
  it("countSelectedOptions 只算在清單裡的", () => {
    expect(countSelectedOptions(OPTIONS, new Set(["a", "d", "zzz"]))).toBe(2);
  });
});

describe("filterMultiSelectOptions(G-9)", () => {
  it("空字串 / 只有空白 ⇒ 全部,順序不變", () => {
    expect(filterMultiSelectOptions(OPTIONS, "").map((o) => o.value)).toEqual(["a", "b", "c", "d"]);
    expect(filterMultiSelectOptions(OPTIONS, "   ").map((o) => o.value)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
  it("比對名稱", () => {
    expect(filterMultiSelectOptions(OPTIONS, "安裝").map((o) => o.value)).toEqual(["b"]);
  });
  it("忽略大小寫與前後空白", () => {
    expect(filterMultiSelectOptions(OPTIONS, "  deep CLEAN ").map((o) => o.value)).toEqual(["c"]);
  });
  it("比對分類名稱(keywords)", () => {
    expect(filterMultiSelectOptions(OPTIONS, "清洗類").map((o) => o.value)).toEqual(["a"]);
    expect(filterMultiSelectOptions(OPTIONS, "耗材").map((o) => o.value)).toEqual(["d"]);
  });
  it("沒結果 ⇒ 空陣列", () => {
    expect(filterMultiSelectOptions(OPTIONS, "不存在的項目")).toEqual([]);
  });
});

describe("文案(G-8 / G-9)", () => {
  it("逐字", () => {
    expect(MULTI_SELECT_REMOVED_DETAIL).toBe("已下架，取消勾選後就不能再選回來");
    expect(MULTI_SELECT_REMOVED_HEADING).toBe("已下架");
    expect(MULTI_SELECT_NO_RESULT).toBe("找不到符合的服務項目");
  });
  it("標點守門:中文句中不含半形 , : ; ! ?、不含全形 （ ） ／", () => {
    const texts = [
      MULTI_SELECT_REMOVED_DETAIL,
      MULTI_SELECT_REMOVED_HEADING,
      MULTI_SELECT_NO_RESULT,
      formatMultiSelectSummary(OPTIONS, new Set(["a", "d"]))!,
    ];
    expect(texts.filter((t) => /[,:;!?]|[（）／]/.test(t))).toEqual([]);
  });
});
