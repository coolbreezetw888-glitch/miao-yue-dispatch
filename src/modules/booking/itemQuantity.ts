// 服務項目「數量」輸入框的共用解析函式。
//
// ─── 為什麼需要這支(2026-09-24 稽核抓到的真實對帳風險)───────────────────────────
// 建單表單的數量是「可以自由清空」的 <input type="number">,onChange 直接把 e.target.value
// 存進狀態,所以使用者把格子清空(想改成 2,先按 Backspace 再打字)的那一瞬間,狀態值是 ""。
//
// 過去 CalendarPage.tsx 裡有三個地方各自把這個字串轉成數字,而且 fallback 不一致:
//   工時加總    Number(itemQuantities[id] ?? "1") || 1   → "" 會變成 1
//   金額預覽    Number(itemQuantities[id] ?? "1") || 0   → "" 會變成 0  ← 就是這裡不一致
//   實際送出    Number(itemQuantities[id] ?? "1") || 1   → "" 會變成 1
//
// 造成的實際災情:客服勾了「洗剪吹 1,500 元」,把數量清空還沒打新數字就直接按「建立預約」,
// 畫面上的「小計 / 最終金額」顯示 $0,後端卻收到 quantity=1、訂單存成 1,500 元。
// 後端 private.validate_booking_selection 只擋 quantity < 1,不會擋下這個情況,訂單會成功建立,
// 客服看到 $0 卻存進 1,500,對帳時完全對不上。
//
// ─── 規則 ────────────────────────────────────────────────────────────────────
// 「畫面上顯示的數量」跟「真正送出的數量」必須是同一個數字,所以一律走這支函式:
// 空字串 / 空白 / NaN / 小於 1 一律回 1(跟後端「quantity 最小為 1」的規則對齊),
// 其他情況原封不動回傳數字本身(不做四捨五入/取整,維持既有行為)。
//
// 任何新的地方要把 itemQuantities 的字串轉成數字時,請一律 import 這支,不要再各自寫一份。

/**
 * 把數量輸入框的原始字串轉成實際要用的數量。
 *
 * @param raw 輸入框目前的字串值(可能是 undefined:還沒初始化;或 "":使用者清空了)
 * @returns 一定是 >= 1 的有限數字
 */
export function parseItemQuantity(raw: string | null | undefined): number {
  // undefined/null 代表「這個項目剛勾選、狀態還沒初始化」,預設就是 1(跟 toggleServiceItem 一致)。
  const parsed = Number(raw ?? "1");
  // Number("") 是 0、Number("   ") 也是 0、Number("abc") 是 NaN,三種都會落進下面這個判斷。
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}
