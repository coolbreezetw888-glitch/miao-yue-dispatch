// 對應規格書「服務人員管理優化與硬刪除」§2:服務人員管理頁(StaffListPage.tsx)人員名單
// 狀態篩選用到的純函式邏輯。抽成獨立檔案(不寫進 StaffListPage.tsx 裡)是為了讓分類篩選邏輯
// 可以直接寫 Vitest,不用整個渲染頁面元件(比照 booking/ordersPageLogic.ts 既有的抽離慣例)。
// 這支檔案刻意不 import 任何會建立 supabase client 的模組(api.ts/context.tsx),只依賴
// types.ts 這個純型別檔案,確保 Vitest 匯入時不會意外觸發 supabase client 初始化。

import {
  DEFAULT_MAX_BOOKING_DAYS_AHEAD,
  DEFAULT_MIN_ADVANCE_BOOKING_DAYS,
  MAX_BOOKING_DAYS_AHEAD_LIMIT,
  MIN_ADVANCE_BOOKING_DAYS_LIMIT,
  MIN_BOOKING_DAYS_AHEAD_LIMIT,
  type MerchantStaff,
} from "./types";

export type StaffListFilter = "all" | "unlisted" | "listed" | "removed";

export const STAFF_LIST_FILTER_TABS: { value: StaffListFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "unlisted", label: "未上架" },
  { value: "listed", label: "已上架" },
  { value: "removed", label: "已移除" },
];

/** §2.1:四個分類的判斷邏輯——「全部」不篩選;「未上架」/「已上架」限定 status=active,
 * 用 is_listed 再細分;「已移除」限定 status=removed。 */
export function matchesStaffListFilter(
  staff: Pick<MerchantStaff, "status" | "is_listed">,
  filter: StaffListFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "unlisted":
      return staff.status === "active" && !staff.is_listed;
    case "listed":
      return staff.status === "active" && staff.is_listed;
    case "removed":
      return staff.status === "removed";
    default:
      return true;
  }
}

/** §2.1 邊界情況:每個分類旁順手加上人數。回傳四個分類各自符合的筆數(all = 總筆數)。 */
export function countStaffByFilter(
  staffList: Pick<MerchantStaff, "status" | "is_listed">[],
): Record<StaffListFilter, number> {
  const counts: Record<StaffListFilter, number> = {
    all: staffList.length,
    unlisted: 0,
    listed: 0,
    removed: 0,
  };
  for (const staff of staffList) {
    if (matchesStaffListFilter(staff, "unlisted")) counts.unlisted += 1;
    if (matchesStaffListFilter(staff, "listed")) counts.listed += 1;
    if (matchesStaffListFilter(staff, "removed")) counts.removed += 1;
  }
  return counts;
}

// =========================================================================
// 2026-09-24:「預約天數」兩個欄位的送出前驗證。
//
// 為什麼抽成純函式放在這裡(而不是繼續寫在 StaffListPage.tsx 的 handleSubmit 裡):資料庫端這次
// 幫這兩個欄位補上了 CHECK 約束(advance_booking_days >= 0、booking_window_max_days between
// 1 and 3650),前端必須擋在同一個範圍,否則商家會看到資料庫的原始錯誤訊息。範圍邊界一多,
// 「負數/0/上限/留空/跨欄位」這些情況就值得用單元測試釘住,而不是靠人工點畫面試。抽出來之後
// 可以直接寫 Vitest,不用渲染整個頁面元件(沿用這個檔案開頭說明的既有抽離慣例)。
//
// ⚠️ 這裡的每一條範圍都必須跟資料庫的 CHECK 約束保持一致(常數都放在 types.ts,兩邊共用同一份)。
//    前端這一層只是為了給白話中文訊息,不是安全邊界——真正擋住寫入的是資料庫的約束。
// =========================================================================

export interface StaffBookingDaysInput {
  advanceBookingDays: number | null;
  bookingWindowMaxDays: number | null;
}

/** 回傳第一個發現的問題(白話中文訊息,可直接丟給 toast.error),全部合法時回傳 null。
 * 兩個欄位都允許留空(null)——留空各自代表套用 types.ts 裡定義的預設值,不是「沒設定」。 */
export function validateStaffBookingDays(input: StaffBookingDaysInput): string | null {
  const { advanceBookingDays: minDays, bookingWindowMaxDays: maxDays } = input;

  if (minDays !== null) {
    // Number.isInteger 同時擋掉小數點與 NaN(輸入框打了無法解析的內容時會是 NaN)。
    // 資料庫欄位是 integer,送 1.5 進去會得到一段看不懂的型別錯誤,所以前端先擋。
    if (!Number.isInteger(minDays)) {
      return "「最少要提前幾天預約」請填整數天數,不能有小數點";
    }
    if (minDays < MIN_ADVANCE_BOOKING_DAYS_LIMIT) {
      // 用語跟欄位說明文字對齊(2026-09-24 使用者最終規格:0 = 不需要提前,當天預約當天服務也可以)
      // ——訊息不只說「錯了」,也要順便告訴商家他想要的效果該怎麼填。
      return "「最少要提前幾天預約」不能是負數;不需要提前請填 0 或留空";
    }
  }

  if (maxDays !== null) {
    if (!Number.isInteger(maxDays)) {
      return "「最遠可以預約到幾天後」請填整數天數,不能有小數點";
    }
    // 2026-09-24 使用者澄清後,0 變成合法值(= 最遠只能約到今天,只接受當天預約當天服務),
    // 所以這裡只剩負數要擋,原本那句「至少要是 1 天」已經不成立。訊息比照欄位一的寫法,
    // 順便告訴商家「只接受當天預約」該怎麼填,不只說他錯了。
    if (maxDays < MIN_BOOKING_DAYS_AHEAD_LIMIT) {
      return `「最遠可以預約到幾天後」不能是負數;只接受當天預約請填 0,不確定要填多少請留空(留空 = ${DEFAULT_MAX_BOOKING_DAYS_AHEAD} 天)`;
    }
    if (maxDays > MAX_BOOKING_DAYS_AHEAD_LIMIT) {
      return `「最遠可以預約到幾天後」最多只能填 ${MAX_BOOKING_DAYS_AHEAD_LIMIT} 天(大約 10 年),請確認是不是多打了幾個 0`;
    }
  }

  // 跨欄位檢查:兩邊都用「實際生效值」(留空就換算成各自的預設值)來比,不是比欄位原始值。
  // 只比原始值會漏掉「最少提前 200 天 + 最遠留空」——留空的最遠天數會套用 180,生效區間變成
  // 200~180(空的),客戶還是永遠約不到。
  const effectiveMinDays = minDays ?? DEFAULT_MIN_ADVANCE_BOOKING_DAYS;
  const effectiveMaxDays = maxDays ?? DEFAULT_MAX_BOOKING_DAYS_AHEAD;
  if (effectiveMinDays > effectiveMaxDays) {
    return maxDays === null
      ? `「最少要提前幾天預約」不能大於 ${DEFAULT_MAX_BOOKING_DAYS_AHEAD} 天,否則客戶永遠約不到——「最遠可以預約到幾天後」留空 = ${DEFAULT_MAX_BOOKING_DAYS_AHEAD} 天,要約更遠請直接把那一欄填大一點`
      : "「最遠可以預約到幾天後」不能小於「最少要提前幾天預約」,否則客戶永遠約不到";
  }

  return null;
}
