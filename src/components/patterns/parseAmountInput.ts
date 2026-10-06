/**
 * 金額字串解析 —— ui-overlay-patterns skill 二之七(表單欄位)的配套。
 *
 * ## 為什麼需要這支函式(2026-09-30 QA 抓到 + 主腦裁決)
 *
 * ui-v1-full 把金額欄位從原生 `<input type="number" min={0} step="1">` 換成
 * `FieldAmountInput`(實際是 `type="text" inputMode="decimal"`,為了左側 `$` 前綴、靠右對齊、
 * 以及避開手機數字鍵盤與滑鼠滾輪誤觸)。**換掉之後,原生的 `min` / `step` 約束就消失了**:
 *
 *   - 原本 `step="1"` 的欄位(每天扣固定金額、月薪)從此存得進小數
 *   - `Number()` 吃得下、但原生 number 欄位會擋掉的字串會整個過關:
 *     `"1e3"` → 1000、`"0x10"` → 16、`"Infinity"` → Infinity、`" "`(只有空白)→ 0
 *
 * 🔴 **主腦裁決:不改回 `type="number"`**(手機鍵盤與滾輪誤觸是刻意避開的),
 * 改成由這支共用函式在送出前做嚴格解析。**所有用 `FieldAmountInput` 收金額的地方都要用它**,
 * 不要各自寫 `Number(x)` + `Number.isNaN` —— 那個組合正是上面那串字串過關的原因。
 *
 * ## 規則
 *
 *   - 只接受**純十進位數字**:可有前後空白、可有一個小數點、可有一個正負號
 *   - 🔴 明確拒絕:空字串 / 只有空白 / `1e3` 科學記號 / `0x10` 十六進位 / `Infinity` / `NaN` /
 *     千分位逗號 `1,000` / 全形數字 / `12.` / `.5` / 兩個小數點
 *   - `integerOnly: true` 給原本 `step="1"` 的欄位用(每天扣固定金額、月薪):有小數點就擋下
 *   - `noun`(預設 `"金額"`)換掉訊息裡的名詞:**點數欄位要傳 `"點數"`**,否則點數欄位下面會
 *     出現「請輸入金額」「金額不能是負數」(2026-09-30 使用者實機巡檢抓到)
 *   - 回傳的錯誤訊息是**給非工程師看的白話**,呼叫端直接丟進 `FormField error=` / `FieldError`,
 *     不要自己再組字串,也不要把原始錯誤吐出去
 *
 * 對應的驗證測試:`parseAmountInput.test.ts`(上面每一種被拒絕的輸入都有一條)。
 */

export interface ParseAmountInputOptions {
  /** 原本 `step="1"` 的欄位設 true:不允許小數。預設 false(允許到小數點後任意位)。 */
  integerOnly?: boolean | undefined;
  /** 允許的最小值,預設 0(金額不能是負數)。 */
  min?: number | undefined;
  /** 允許的最大值,預設不限。 */
  max?: number | undefined;
  /**
   * 錯誤訊息裡要用的名詞,預設 `"金額"`。
   *
   * 🔴 2026-09-30(使用者實機巡檢):這支函式後來也被拿去驗**點數**欄位(紅利點數的推薦獎勵、
   * 生日贈點、手動調整、登記兌換),結果點數欄位下面出現「請輸入金額」「金額不能是負數」——
   * 讀起來像系統搞錯了自己在驗哪一格。傳 `noun: "點數"` 就會變成「請輸入點數」「點數不能是負數」。
   *
   * 📌 **預設值刻意維持「金額」**,所以既有的呼叫端一個都不用改,訊息也一個字都沒變。
   *    新增非金額欄位的使用點時記得傳這個,不要為了省事讓使用者看到不對的名詞。
   */
  noun?: string | undefined;
}

export type ParseAmountInputResult =
  { ok: true; value: number } | { ok: false; value: null; error: string };

/**
 * 只接受純十進位寫法。刻意**不用** `Number()` 判斷,因為 `Number()` 認得
 * `1e3` / `0x10` / `0b11` / `Infinity` / `""`,那些正是要擋掉的東西。
 */
const DECIMAL_PATTERN = /^[+-]?\d+(\.\d+)?$/;

export function parseAmountInput(
  raw: string,
  options: ParseAmountInputOptions = {},
): ParseAmountInputResult {
  const { integerOnly = false, min = 0, max, noun = "金額" } = options;
  const text = raw.trim();

  if (text === "") {
    return { ok: false, value: null, error: `請輸入${noun}` };
  }
  if (!DECIMAL_PATTERN.test(text)) {
    // 一句話講完就好:使用者不需要知道「科學記號」「十六進位」這些名詞。
    return { ok: false, value: null, error: `請輸入數字${noun}，只能填數字和小數點` };
  }
  if (integerOnly && text.includes(".")) {
    return { ok: false, value: null, error: "這個欄位只能填整數，不能有小數點" };
  }

  const value = Number(text);
  // 走到這裡一定是有限數(pattern 已經擋掉 Infinity / NaN),這行是防呆,不是主要防線。
  if (!Number.isFinite(value)) {
    return { ok: false, value: null, error: `請輸入數字${noun}，只能填數字和小數點` };
  }
  if (value < min) {
    return {
      ok: false,
      value: null,
      error: min === 0 ? `${noun}不能是負數` : `不能小於 ${min}`,
    };
  }
  if (max !== undefined && value > max) {
    return { ok: false, value: null, error: `不能大於 ${max}` };
  }

  return { ok: true, value };
}
