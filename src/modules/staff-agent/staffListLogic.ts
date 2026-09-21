// 對應規格書「服務人員管理優化與硬刪除」§2:服務人員管理頁(StaffListPage.tsx)人員名單
// 狀態篩選用到的純函式邏輯。抽成獨立檔案(不寫進 StaffListPage.tsx 裡)是為了讓分類篩選邏輯
// 可以直接寫 Vitest,不用整個渲染頁面元件(比照 booking/ordersPageLogic.ts 既有的抽離慣例)。
// 這支檔案刻意不 import 任何會建立 supabase client 的模組(api.ts/context.tsx),只依賴
// types.ts 這個純型別檔案,確保 Vitest 匯入時不會意外觸發 supabase client 初始化。

import type { MerchantStaff } from "./types";

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
