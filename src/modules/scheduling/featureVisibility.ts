// 「排班一覽」功能隱藏開關(唯一一份)。
//
// ⚠️ 2026-09-24 使用者指示:「排班一覽這個功能可以先拔掉(隱藏起來),對應的權限開關也要跟著拔掉(隱藏起來)。」
// 關鍵字是**隱藏**,不是刪除,所以做成一個開關常數,不是把程式碼刪掉。
//
// SPECS-INDEX #976 第 3 批(2026-10-06,表 C-4):原本只藏了功能頁卡片與客服權限開關,開過權限的客服
// 直接打 /app/scheduling 仍進得去 ⇒ 這個常數從 ManagePage.tsx 搬到這裡,讓卡片與路由守衛
// (RequireSchedulingAccess)讀同一份:隱藏期間 /app/scheduling 對所有人(含商家管理員)一律導回功能頁。
//
// 🔁 還原方式:把下面改成 false,三處會一起恢復,不用改其他地方 ——
//   ① 功能頁「排班一覽」卡片(src/routes/ManagePage.tsx,恢復照 scheduling 權限顯示)
//   ② /app/scheduling 路由守衛(src/modules/scheduling/RequireSchedulingAccess.tsx,恢復照 scheduling 權限放行)
//   ③ 另外記得把 src/modules/staff-agent/types.ts 裡 key: "scheduling" 那一項的 hidden 旗標拿掉
//      (客服權限設定頁的開關;那邊是文字定義,沒有讀這個常數)。
// 資料庫裡既有的 scheduling 授權紀錄一列都不用動;後端 private.can_view_scheduling 照常運作。
export const SCHEDULING_FEATURE_HIDDEN = true;

/** 隱藏期間 /app/scheduling 導回的位置:功能頁(排班一覽卡片原本所在的頁面)。 */
export const SCHEDULING_HIDDEN_REDIRECT_TO = "/app/manage";
