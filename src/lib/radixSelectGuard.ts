// Radix Select「幽靈空值事件」共用防護。
//
// ─── 這個坑是什麼(2026-09-24 本專案真實踩過,花了很久才查到) ───────────────────────
// Radix 的 <Select> 為了跟原生表單相容,內部會偷偷再渲染一個隱藏的原生 <select>(見
// node_modules/@radix-ui/react-select/dist/index.mjs 的 BubbleSelect/nativeOptions 那一段)。
// 那個隱藏原生 select 的 <option> 清單,是 <SelectContent> 掛載後才在 effect 裡註冊進去的。
//
// 於是會出現這個時序問題:
//   1. 元件先以某個初始值掛載(常見是空字串,或還沒載入完的預設值)
//   2. 某個 useEffect 在掛載「之後」才把真正的值灌進受控的 value(例如從 prefill、從 API 回來的
//      資料、從網址參數帶進來的 id)
//   3. 這一刻隱藏原生 select 的 nativeOptions 可能還沒註冊完,瀏覽器找不到對應的 option,
//      就會對它補發一次 change 事件,把「空字串」回傳進 onValueChange
//   4. 結果:剛灌好的值當場被空字串洗掉,畫面上的下拉變回空白,使用者完全不知道發生什麼事
//
// 實際災情範例:商家設定頁的產業別會莫名變回未選;行事曆點某位服務人員的空格建單時,
// prefill.staffId 灌進去之後服務人員欄位又變空白,客服按送出才被擋下卻不知道哪裡沒選。
//
// ─── 怎麼用 ───────────────────────────────────────────────────────────────────
// 把原本直接傳給 onValueChange 的函式,用這支 helper 包起來:
//
//   // (A) 合法值是一份固定清單時 → 用白名單判斷(最嚴格,順便擋掉任何非預期的值)
//   <Select
//     value={mode}
//     onValueChange={guardPhantomEmptyChange<AmountAdjustmentMode>(
//       setMode,
//       (v) => v in AMOUNT_ADJUSTMENT_MODE_LABELS,
//     )}
//   >
//
//   // (B) 合法值是從資料庫來的動態清單(服務人員 id、付款方式 id、分類 id…)時
//   //     → 沒有白名單可比對,判斷條件就是「不是空字串」
//   <Select value={staffId} onValueChange={guardPhantomEmptyChange(setStaffId)}>
//
// ─── 為什麼做成 helper 而不是包一顆 <GuardedSelect> 元件 ─────────────────────────
// 1. src/components/ui/select.tsx 是 shadcn 產生的原樣元件,慣例上不在裡面加專案自己的邏輯,
//    之後重新產生/升級 shadcn 元件時才不會被覆蓋掉。
// 2. 專案裡的用法差異很大(有的要在 onValueChange 裡連帶做別的事,例如同步清掉助手名單、
//    立刻呼叫 API 存檔),包成元件反而要多開一堆 prop 才能表達;helper 直接包住既有的
//    inline arrow function,改動最小。
// 3. 純函式好測(見 radixSelectGuard.test.ts),不用渲染 React 就能驗證。
//
// ─── 新增 Select 的人請注意 ────────────────────────────────────────────────────
// 只要這個 Select 的 value 有可能「在掛載之後才被 useEffect/非同步資料灌進來」,就應該套這支。
// 一律套上也完全沒有副作用(使用者本來就不可能主動選到一個空字串的選項,因為 Radix 不允許
// <SelectItem value="">),所以新加 Select 時建議直接套,不用先判斷會不會踩到。

/**
 * 包住 Radix Select(或 RadioGroup)的 onValueChange,擋掉「幽靈空值事件」。
 *
 * @param onChange 真正要執行的 setter。只有通過檢查的值才會傳進去。
 * @param isValid  選填。合法值判斷:
 *                 - 不傳 → 只要不是空字串就放行(適用動態清單,例如資料庫來的 id)
 *                 - 傳入 → 除了非空字串,還要通過這個判斷才放行(適用固定常數白名單)
 * @returns 可以直接掛在 onValueChange 上的函式。
 */
export function guardPhantomEmptyChange<T extends string = string>(
  onChange: (value: T) => void,
  isValid?: (value: string) => boolean,
): (value: string) => void {
  return (value: string) => {
    // 幽靈事件的特徵就是空字串;使用者的正常操作不可能送出空字串
    // (Radix 本身就禁止 <SelectItem value="">,所以「空字串」一定不是真的使用者選取)。
    if (value === "") return;
    if (isValid && !isValid(value)) return;
    onChange(value as T);
  };
}
