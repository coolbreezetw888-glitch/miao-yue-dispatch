// 第 6 批(SPECS-INDEX #849,PROGRESS「併入 #849 的待辦」第 3 點):點數欄位的錯誤訊息不可以說「金額」。
//
// 背景:parseAmountInput 原本是給金額欄位用的,預設訊息是「請輸入金額」「金額不能是負數」。它後來被拿去驗
// 點數欄位,點數欄位下面就出現「請輸入金額」——讀起來像系統搞錯了自己在驗哪一格。parseAmountInput 已經有
// `noun` 選項(parseAmountInput.test.ts 驗過函式本身),這支測試釘住的是**每一個點數欄位的呼叫點**:
//   ① 真的呼叫進去之後,訊息講的是「點數」(或「比例」),不是「金額」;
//   ② 原始碼掃描:點數相關檔案裡每一次 parseAmountInput( 呼叫都有傳 noun(新增使用點忘了傳就會紅)。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validatePointsOverride } from "@/modules/booking/bookingPointsLogic";

import { parsePointsField, validateRedeemDraft } from "./memberPointsSettingsLogic";

function errorOf(result: { ok: boolean; error?: string }): string {
  expect(result.ok).toBe(false);
  return result.error as string;
}

describe("點數欄位的錯誤訊息講「點數」,不講「金額」", () => {
  it("紅利設定的點數欄位(parsePointsField):留空 / 負數 / 亂打", () => {
    expect(errorOf(parsePointsField(""))).toBe("請輸入點數");
    expect(errorOf(parsePointsField("-1"))).toBe("點數不能是負數");
    expect(errorOf(parsePointsField("abc"))).toBe("請輸入數字點數，只能填數字和小數點");
    for (const raw of ["", "-1", "abc", "1.5", "1e3"]) {
      expect(errorOf(parsePointsField(raw))).not.toContain("金額");
    }
  });

  it("點數使用分頁的「最高折抵比例」講「比例」", () => {
    const result = validateRedeemDraft({ pointsUnit: "0", amountUnit: "0", maxRatioPercent: "" });
    expect(result.maxRatioPercent.ok).toBe(false);
    const error = (result.maxRatioPercent as { error: string }).error;
    expect(error).toBe("請輸入比例");
    expect(error).not.toContain("金額");
  });

  it("建單表單的「本單點數」覆寫欄位:留空 / 負數", () => {
    expect(errorOf(validatePointsOverride(""))).toBe("請輸入點數");
    expect(errorOf(validatePointsOverride("-3"))).toBe("點數不能是負數");
    for (const raw of ["", "-3", "abc", "1.5"]) {
      expect(errorOf(validatePointsOverride(raw))).not.toContain("金額");
    }
  });
});

describe("原始碼掃描:點數相關檔案裡的 parseAmountInput( 呼叫一律有傳 noun", () => {
  // 會員詳情頁的手動調整 / 登記兌換是元件內的 handleSubmit,用掃原始碼的方式釘住。
  // ⚠️ memberPointsSettingsLogic.ts 的 parseMoneyField 是**金額**欄位(折抵金額單位),刻意不傳 noun,
  //    所以這份清單只放「整支檔案的每一次呼叫都是點數/比例」的檔案。
  const FILES = ["modules/members/MemberPointsPanel.tsx", "modules/booking/bookingPointsLogic.ts"];

  for (const rel of FILES) {
    it(`${rel}:每一次呼叫都帶 noun`, () => {
      const source = readFileSync(resolve(__dirname, "../..", rel), "utf8");
      const calls = [...source.matchAll(/parseAmountInput\(([^)]*)\)/g)].map((m) => m[1] as string);
      expect(calls.length, "正向對照:這支檔案確實有呼叫 parseAmountInput").toBeGreaterThan(0);
      for (const args of calls) {
        expect(args, `這個呼叫沒傳 noun:parseAmountInput(${args})`).toMatch(
          /noun:\s*"(點數|比例)"/,
        );
      }
    });
  }
});
