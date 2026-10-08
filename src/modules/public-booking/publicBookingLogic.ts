// 客戶端第 1 批(C1):公開預約頁的純函式。畫面上「會算數字、會決定要不要顯示什麼」的邏輯都放這裡,
// 元件只負責呈現,vitest 才能逐條驗。
//
// 🔴 這裡**不判斷時段規則**(營業時間、請假、已有訂單、提前天數⋯)—— 那些一律由資料庫函式
//    get_public_available_slots 決定(C1-A07「前端不自己判斷時段規則」)。這裡只做:
//    預估時長 / 金額的即時顯示、服務人員「會不會做這些服務」的篩選(資料庫送出時會再檢查一次)、
//    欄位格式檢查、日期與時間的排版。

import { buildPickerTabs, formatPickerDuration } from "@/modules/booking/serviceItemPickerLogic";
import { UNCATEGORIZED_LABEL } from "@/modules/service-items/types";

import type {
  PublicCategory,
  PublicDayState,
  PublicSelectedItem,
  PublicServiceItem,
  PublicStaff,
} from "./types";

// =========================================================================
// ② 選服務
// =========================================================================

/** C1-A05:每個項目數量 1~20(客人這邊沒有自訂金額、自訂工時)。 */
export const PUBLIC_ITEM_QUANTITY_MIN = 1;
export const PUBLIC_ITEM_QUANTITY_MAX = 20;
/** C1-A05:預估時長超過 24 小時就不能下一步。 */
export const PUBLIC_MAX_TOTAL_MINUTES = 24 * 60;

export const ADDON_TAB_KEY = "__addon__";
export const ADDON_TAB_LABEL = "加購項目";

export interface PublicServiceTab {
  key: string;
  label: string;
  items: PublicServiceItem[];
}

/**
 * C1-A05 分類頁籤:主要項目依分類分頁(排序同後台建單選擇頁,沒有分類的放「未分類」——
 * 沿用後台 buildPickerTabs 的做法);加購項目不分分類,全部放最後一個「加購項目」頁籤。
 */
export function buildPublicServiceTabs(
  items: PublicServiceItem[],
  categories: PublicCategory[],
): PublicServiceTab[] {
  const primary = items.filter((i) => i.item_type === "primary");
  const addons = items.filter((i) => i.item_type === "addon");
  const byId = new Map(primary.map((i) => [i.id, i]));
  const tabs: PublicServiceTab[] = buildPickerTabs(
    primary.map((i) => ({
      id: i.id,
      name: i.name,
      price: i.price,
      duration_minutes: i.duration_minutes,
      category_id: i.category_id,
      description: i.description,
    })),
    categories,
    UNCATEGORIZED_LABEL,
  ).map((tab) => ({
    key: tab.key,
    label: tab.label,
    items: tab.items.map((i) => byId.get(i.id)).filter((i): i is PublicServiceItem => !!i),
  }));
  if (addons.length > 0) {
    tabs.push({ key: ADDON_TAB_KEY, label: ADDON_TAB_LABEL, items: addons });
  }
  return tabs;
}

/** 已選項目:id → 數量。用 Map 保留勾選順序(摘要「室內機清洗 ×2、室外機清洗 ×1」照這個順序)。 */
export type PublicSelection = ReadonlyMap<string, number>;

export function clampQuantity(n: number): number {
  if (!Number.isFinite(n)) return PUBLIC_ITEM_QUANTITY_MIN;
  return Math.min(PUBLIC_ITEM_QUANTITY_MAX, Math.max(PUBLIC_ITEM_QUANTITY_MIN, Math.trunc(n)));
}

export function toggleSelection(selection: PublicSelection, id: string): Map<string, number> {
  const next = new Map(selection);
  if (next.has(id)) next.delete(id);
  else next.set(id, PUBLIC_ITEM_QUANTITY_MIN);
  return next;
}

/** 按 + / −:沒勾選時按 + 會順手勾起來(同後台整頁選擇);− 到 1 就停。 */
export function stepSelection(
  selection: PublicSelection,
  id: string,
  delta: 1 | -1,
): Map<string, number> {
  const next = new Map(selection);
  const current = next.get(id);
  if (current === undefined) {
    if (delta > 0) next.set(id, PUBLIC_ITEM_QUANTITY_MIN);
    return next;
  }
  next.set(id, clampQuantity(current + delta));
  return next;
}

export interface SelectionTotals {
  /** 已選幾項(項目種類數)。 */
  itemCount: number;
  /** 共幾台 / 幾份(數量加總)。 */
  unitCount: number;
  /** Σ(工時 × 數量)。 */
  totalMinutes: number;
  /** Σ(價格 × 數量)。 */
  totalPrice: number;
  hasPrimary: boolean;
}

export function computeSelectionTotals(
  selection: PublicSelection,
  items: PublicServiceItem[],
): SelectionTotals {
  const byId = new Map(items.map((i) => [i.id, i]));
  let itemCount = 0;
  let unitCount = 0;
  let totalMinutes = 0;
  let totalPrice = 0;
  let hasPrimary = false;
  for (const [id, quantity] of selection) {
    const item = byId.get(id);
    if (!item) continue;
    itemCount += 1;
    unitCount += quantity;
    totalMinutes += item.duration_minutes * quantity;
    // 分為單位加總,避免 0.1 + 0.2 這種浮點誤差。
    totalPrice += Math.round(item.price * 100) * quantity;
    if (item.item_type === "primary") hasPrimary = true;
  }
  return { itemCount, unitCount, totalMinutes, totalPrice: totalPrice / 100, hasPrimary };
}

/** ② 不能按「下一步」的原因(null = 可以下一步)。 */
export function serviceStepBlockedReason(totals: SelectionTotals): string | null {
  if (totals.itemCount === 0) return "請先選擇要預約的服務。";
  if (!totals.hasPrimary) return "請至少選一項主要服務。";
  if (totals.totalMinutes > PUBLIC_MAX_TOTAL_MINUTES) return "選的服務太多，請聯絡店家。";
  return null;
}

/** 送給時段函式的項目清單(只帶 id 與數量,工時由伺服器重算)。 */
export function selectionToItems(selection: PublicSelection): PublicSelectedItem[] {
  return [...selection].map(([service_item_id, quantity]) => ({ service_item_id, quantity }));
}

/** 「大約 4 小時 30 分鐘」(沿用後台整頁選擇的寫法)。0 分鐘回空字串。 */
export function formatDurationApprox(minutes: number): string {
  return formatPickerDuration(minutes) ?? "";
}

/** 「NT$ 6,200」。 */
export function formatPublicPrice(price: number): string {
  return `NT$ ${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

// =========================================================================
// ③ 選服務人員
// =========================================================================

/**
 * C1-A06 規則 2:這位服務人員會不會做剛剛選的服務。
 * 沒有任何對應(null)= 什麼都會做;有對應 ⇒ 只檢查**主要項目**,加購項目不列入檢查。
 * (上架 / 在職的篩選資料庫已經做了 —— staff 清單裡本來就只有上架中的人。)
 */
export function staffCanServe(
  staff: Pick<PublicStaff, "primary_service_item_ids">,
  selection: PublicSelection,
  items: PublicServiceItem[],
): boolean {
  if (staff.primary_service_item_ids === null) return true;
  const allowed = new Set(staff.primary_service_item_ids);
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const id of selection.keys()) {
    const item = byId.get(id);
    if (item?.item_type === "primary" && !allowed.has(id)) return false;
  }
  return true;
}

export function eligibleStaff(
  staff: PublicStaff[],
  selection: PublicSelection,
  items: PublicServiceItem[],
): PublicStaff[] {
  return staff.filter((s) => staffCanServe(s, selection, items));
}

/** 頭像沒有圖時顯示的字:名字的最後一個字(預覽圖「阿明 → 明」「小陳 → 陳」)。 */
export function staffAvatarText(displayName: string): string {
  const chars = [...displayName.trim()];
  return chars[chars.length - 1] ?? "";
}

/** 店家 Logo 沒有圖時顯示的字:店名前兩個字(C1-A03)。 */
export function merchantLogoText(name: string): string {
  return [...name.trim()].slice(0, 2).join("");
}

// =========================================================================
// ④ 選日期時間
// =========================================================================

export const SLOT_DAYS_PER_PAGE = 7;
/** 「下一週」最多翻幾次的保險上限(避免資料異常時可以一直往後翻)。 */
export const MAX_WEEK_OFFSET = 52;

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

/** 台北時間的今天(YYYY-MM-DD)。 */
export function taipeiToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts; // en-CA = YYYY-MM-DD
}

/** YYYY-MM-DD 加 n 天(純日曆運算,不受時區影響)。 */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function parseDateParts(date: string): { month: number; day: number; weekday: number } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return { month: m, day: d, weekday: t.getUTCDay() };
}

export function weekdayLabel(date: string): string {
  return WEEKDAY_LABELS[parseDateParts(date).weekday] ?? "";
}

export function dayOfMonth(date: string): number {
  return parseDateParts(date).day;
}

/** 「2026年10月」(這一頁第一天所在的月份;跨月時寫「2026年10月～11月」)。 */
export function formatWeekHeading(from: string): string {
  const to = addDays(from, SLOT_DAYS_PER_PAGE - 1);
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  if (fy === ty && fm === tm) return `${fy}年${fm}月`;
  if (fy === ty) return `${fy}年${fm}月～${tm}月`;
  return `${fy}年${fm}月～${ty}年${tm}月`;
}

/** 日期格子下面那一行字。 */
export function dayStateLabel(state: PublicDayState, isToday: boolean): string {
  if (state === "closed") return "公休";
  if (state === "full") return "已滿";
  if (isToday) return "今天";
  return "";
}

export interface TimeGroup {
  label: "上午" | "下午" | "晚上";
  times: string[];
}

/** C1-A07:上午(12:00 前)/ 下午(12:00~17:59)/ 晚上(18:00 以後,有時段才顯示)。 */
export function groupTimes(times: string[]): TimeGroup[] {
  const morning: string[] = [];
  const afternoon: string[] = [];
  const evening: string[] = [];
  for (const t of times) {
    const hour = Number(t.slice(0, 2));
    if (hour < 12) morning.push(t);
    else if (hour < 18) afternoon.push(t);
    else evening.push(t);
  }
  const groups: TimeGroup[] = [];
  if (morning.length > 0) groups.push({ label: "上午", times: morning });
  if (afternoon.length > 0) groups.push({ label: "下午", times: afternoon });
  if (evening.length > 0) groups.push({ label: "晚上", times: evening });
  return groups;
}

/** 「10月13日（二）」 */
export function formatDateWithWeekday(date: string): string {
  const { month, day } = parseDateParts(date);
  return `${month}月${day}日（${weekdayLabel(date)}）`;
}

/** 「共約 4 小時」「共約 1 小時 30 分鐘」「共約 45 分鐘」 */
export function formatDurationTotal(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours > 0 && rest > 0) return `共約 ${hours} 小時 ${rest} 分鐘`;
  if (hours > 0) return `共約 ${hours} 小時`;
  return `共約 ${rest} 分鐘`;
}

/** 開始時間 + 工時 = 預計完成時間;跨過午夜寫「隔天 01:00」。 */
export function formatEndTime(start: string, minutes: number): string {
  const [h, m] = start.split(":").map(Number) as [number, number];
  const total = h * 60 + m + minutes;
  const dayOffset = Math.floor(total / (24 * 60));
  const inDay = total % (24 * 60);
  const hh = String(Math.floor(inDay / 60)).padStart(2, "0");
  const mm = String(inDay % 60).padStart(2, "0");
  if (dayOffset === 0) return `${hh}:${mm}`;
  if (dayOffset === 1) return `隔天 ${hh}:${mm}`;
  return `${dayOffset} 天後 ${hh}:${mm}`;
}

/** C1-A07 摘要:「10月13日（二）10:00 開始，預計 14:00 左右完成（共約 4 小時）。」 */
export function formatSlotSummary(date: string, time: string, minutes: number): string {
  return `${formatDateWithWeekday(date)}${time} 開始，預計 ${formatEndTime(time, minutes)} 左右完成（${formatDurationTotal(minutes)}）。`;
}

/**
 * 「下一週」要不要停用。
 * 資料庫不回傳「最遠可以約到哪一天」(C1-C01 刻意不給),所以用這一頁的結果推:
 * 已經看過可預約範圍內的日子(everInRange),而這一頁最後一天是「範圍外」⇒ 後面不會再有能約的日子。
 * 還沒看過範圍內的日子(例:最少提前 10 天,第一週整週都在範圍外)⇒ 繼續可以往後翻。
 * 另有 MAX_WEEK_OFFSET 保險上限。
 */
export function isNextWeekDisabled(input: {
  weekOffset: number;
  lastDayState: PublicDayState | null;
  everInRange: boolean;
}): boolean {
  if (input.weekOffset >= MAX_WEEK_OFFSET) return true;
  return input.everInRange && input.lastDayState === "out_of_range";
}

// =========================================================================
// ⑤ 填資料
// =========================================================================

export const CUSTOMER_NAME_MAX = 50;
export const CUSTOMER_ADDRESS_MAX = 200;
export const CUSTOMER_NOTE_MAX = 500;

export interface CustomerFormValues {
  name: string;
  address: string;
  note: string;
}

export interface CustomerFormErrors {
  name?: string;
  address?: string;
  note?: string;
}

/** 字數用「看得到的字」算(emoji 算一個字),跟 [...str].length 一致。 */
export function countChars(value: string): number {
  return [...value].length;
}

/** C1-A08:姓名去頭尾空白後 1~50 字;地址(到府才要)1~200 字;備註最多 500 字。 */
export function validateCustomerForm(
  values: CustomerFormValues,
  requireAddress: boolean,
): CustomerFormErrors {
  const errors: CustomerFormErrors = {};
  const name = values.name.trim();
  if (name.length === 0) errors.name = "請填寫姓名。";
  else if (countChars(name) > CUSTOMER_NAME_MAX)
    errors.name = `姓名最多 ${CUSTOMER_NAME_MAX} 個字。`;

  if (requireAddress) {
    const address = values.address.trim();
    if (address.length === 0) errors.address = "請填寫服務地址。";
    else if (countChars(address) > CUSTOMER_ADDRESS_MAX)
      errors.address = `服務地址最多 ${CUSTOMER_ADDRESS_MAX} 個字。`;
  }

  if (countChars(values.note) > CUSTOMER_NOTE_MAX)
    errors.note = `備註最多 ${CUSTOMER_NOTE_MAX} 個字。`;
  return errors;
}

// =========================================================================
// 聯絡按鈕(C1-A04)
// =========================================================================

export interface ContactLinks {
  lineUrl: string | null;
  telHref: string | null;
}

/**
 * 有 LINE 好友連結 ⇒「LINE 聯絡店家」;有電話 ⇒「撥打電話」。
 * LINE 連結資料庫已經擋過格式(https:// 開頭),這裡再保險一次:不是 https:// 開頭的一律不顯示,
 * 避免 javascript: 之類的連結被放進 href。
 */
export function resolveContactLinks(merchant: {
  line_friend_url: string | null;
  phone: string | null;
}): ContactLinks {
  const line = merchant.line_friend_url?.trim() ?? "";
  const phone = merchant.phone?.trim() ?? "";
  const telDigits = phone.replace(/[^\d+#*,]/g, "");
  return {
    lineUrl: /^https:\/\//i.test(line) ? line : null,
    telHref: telDigits.length > 0 ? `tel:${telDigits}` : null,
  };
}
