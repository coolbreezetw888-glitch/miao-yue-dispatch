// 模組 5:行事曆與預約核心引擎 — 日期/時間輔助函式
// 抽成獨立檔案是為了讓這些純函式可以獨立寫 Vitest(不用整個渲染 CalendarPage.tsx)。
//
// 时区說明:系統目前假設所有商家都在 Asia/Taipei(規格書「本模組明確不做的事」),這裡的日期/時間
// 一律以 Asia/Taipei 的日曆日/時鐘時間為準,送往後端的 start_at 一律明確帶 +08:00 偏移量,
// 不依賴瀏覽器本機時區(避免使用者瀏覽器時區設定不是台灣時導致算錯)。

/** 取得「現在」對應到 Asia/Taipei 的日曆日期,回傳的 Date 物件用本機 getter(getFullYear 等)
 * 讀出來就是 Taipei 當地的年/月/日,方便後續用一般的 Date 運算做加減天數。 */
export function getTaipeiNow(): Date {
  const taipeiString = new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" });
  return new Date(taipeiString);
}

export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - copy.getDay());
  return copy;
}

/** 把 timestamptz(ISO 字串,含時區資訊)轉成 Asia/Taipei 的日曆日期字串(YYYY-MM-DD)。 */
export function isoToTaipeiDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

/** 把 timestamptz 轉成 Asia/Taipei 的時鐘時間字串(HH:mm)。 */
export function isoToTaipeiTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 組出送往後端的 timestamptz 字串,明確帶 +08:00 偏移量。 */
export function buildTaipeiIso(dateKey: string, time: string): string {
  return `${dateKey}T${time}:00+08:00`;
}

export function timeToMinutes(time: string): number {
  const parts = time.slice(0, 5).split(":");
  const h = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 0);
  return h * 60 + m;
}

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

// ---------------------------------------------------------------------------
// 建單功能擴充 1.1:月檢視用的輔助函式。
// ---------------------------------------------------------------------------

/** 該日期所在月份的第一天(當地日曆日,時分秒歸零)。 */
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** 該日期所在月份的下個月第一天(用來當作「不含」的查詢上界,或算天數)。 */
export function startOfNextMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

export function addMonths(d: Date, months: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + months, 1);
}

/**
 * 產生月曆格線需要的完整日期陣列:從「該月第一天所在那一週的週日」開始,
 * 到「該月最後一天所在那一週的週六」結束,確保格線永遠是完整的 7 欄。
 * 月份前後補進來的日期會標記 inCurrentMonth=false,畫面上用來做淡化樣式,
 * 但一樣可以點擊查看/建立當天的排程(比照多數行事曆 UI 慣例)。
 */
export interface MonthGridDay {
  date: Date;
  inCurrentMonth: boolean;
}

export function buildMonthGrid(monthAnchor: Date): MonthGridDay[] {
  const firstOfMonth = startOfMonth(monthAnchor);
  const firstOfNextMonth = startOfNextMonth(monthAnchor);
  const gridStart = startOfWeek(firstOfMonth);
  // 月曆最後一天所在週的週六:從下個月第一天往前一天(=本月最後一天),再找它那一週的週六。
  const lastOfMonth = addDays(firstOfNextMonth, -1);
  const gridEnd = addDays(startOfWeek(lastOfMonth), 6);

  const days: MonthGridDay[] = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    days.push({ date: cursor, inCurrentMonth: cursor.getMonth() === monthAnchor.getMonth() });
    cursor = addDays(cursor, 1);
  }
  return days;
}
