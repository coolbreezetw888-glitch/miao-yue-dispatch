// 模組 3:人員與權限管理 — 型別定義
// 對應規格書第一節資料表。其他模組若需要用到服務人員/客服相關型別,一律從這個檔案或
// context.tsx 匯出的 hooks 取得,不要直接 import Supabase 產生的 Tables<'merchant_staff'> 等型別
// (呼應規格書第五節「對外介面」的模組獨立性設計)。

import type { Tables } from "@/integrations/supabase/types";

export type MerchantStaff = Tables<"merchant_staff">;
export type MerchantAgent = Tables<"merchant_agents">;
export type MerchantAgentPermission = Tables<"merchant_agent_permissions">;

export type StaffStatus = "active" | "removed";
export type AgentStatus = "invited" | "active" | "removed";

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  invited: "邀請信已寄出",
  active: "已啟用",
  removed: "已移除",
};

/** 5.1 對外介面:目前使用者在某間商家的角色。
 * 模組 14(服務人員端)規格書規則 2.10 擴充新增 'staff' 這個值——判斷順序:admin > agent > staff,
 * 同一人身兼多重角色時一律顯示較高權限角色對應的完整既有介面,不會被限縮成服務人員視角。 */
export type MerchantRole = "admin" | "agent" | "staff" | null;

/** 模組 14(服務人員端)規格書 1.1/規則 2.1:服務人員登入身份進度,跟 StaffStatus(是否仍是
 * 有效服務人員名錄項目)完全脫鉤獨立記錄,兩者互不影響。 */
export type StaffLoginStatus = "not_invited" | "invited" | "active";

export const STAFF_LOGIN_STATUS_LABELS: Record<StaffLoginStatus, string> = {
  not_invited: "尚未開通",
  invited: "邀請信已寄出",
  active: "已開通登入",
};

/** 1.1.1 權限功能開關欄位,對應規格表「服務人員-權限功能」逐條(白話文字給 4.2 畫面使用)。 */
export interface StaffPermissionFieldDef {
  key: keyof Pick<
    MerchantStaff,
    | "advance_booking_days"
    // booking_window_min_days 這個欄位已於 2026-09-24 從資料庫移除
    // (migration 20260924040200,見下方 STAFF_NUMBER_PERMISSION_FIELDS 的裁決註解),
    // 所以不在這個聯集裡,也不要再加回來。
    | "booking_window_max_days"
    | "no_time_slot_limit"
    | "unlimited_backend_edit"
    | "direct_accept_after_merchant_confirm"
    | "auto_accept_booking"
    | "show_member_info"
    | "google_calendar_sync_enabled"
    | "can_create_edit_orders"
    | "can_upload_construction_photos"
  >;
  label: string;
  description: string;
  type: "boolean" | "number";
}

export const STAFF_BOOLEAN_PERMISSION_FIELDS: StaffPermissionFieldDef[] = [
  {
    key: "no_time_slot_limit",
    label: "無時段限制",
    description: "開啟後,客戶預約這位服務人員時不受時段限制。",
    type: "boolean",
  },
  {
    key: "unlimited_backend_edit",
    label: "後台編輯無限制時段",
    description: "開啟後,商家後台編輯這位服務人員的行程時不受時段限制。",
    type: "boolean",
  },
  {
    key: "direct_accept_after_merchant_confirm",
    label: "商家確認後直接接單",
    description: "開啟後,商家確認訂單後,這位服務人員不需要再次確認即可接單。",
    type: "boolean",
  },
  {
    key: "auto_accept_booking",
    label: "預約自動接受",
    description: "開啟後,客戶預約這位服務人員時系統自動接受,不需要人工確認。",
    type: "boolean",
  },
  {
    key: "show_member_info",
    label: "顯示會員資料",
    description: "開啟後,這位服務人員可以看到預約客戶的會員資料。",
    type: "boolean",
  },
  {
    key: "google_calendar_sync_enabled",
    label: "Google 日曆同步",
    description: "開啟後,這位服務人員的行程會同步到 Google 日曆(實際串接留給之後的模組)。",
    type: "boolean",
  },
  {
    key: "can_create_edit_orders",
    label: "新增編輯訂單",
    description: "開啟後,這位服務人員可以自行新增/編輯訂單。",
    type: "boolean",
  },
  {
    key: "can_upload_construction_photos",
    label: "施工圖片上傳",
    description: "開啟後,這位服務人員可以上傳施工圖片。",
    type: "boolean",
  },
];

// 2026-09-24 使用者裁決(「預約天數」三個欄位改成兩個):使用者原話「同意,只保留這兩個欄位即可」,
// 並把這兩個欄位的意義釐清成「一個為須提前幾天預約?另一個是最遠可以預約到什麼時候?」。
// 改動的三件事:
//  1. advance_booking_days 的語意「反過來」了。原本描述寫「客戶最多可以提前幾天預約」,跟使用者
//     要的「最少要提前幾天」完全相反(前者是上限、後者是下限),描述照使用者的定義重寫。
//     ⚠️ 已用唯讀 SELECT 查證正式資料庫:merchant_staff 共 125 列,這三個欄位「全部都是 null」
//     (非 null 筆數各為 0),所以語意反轉「沒有任何資料遷移問題」,直接沿用同一個欄位即可。
//  2. booking_window_min_days 整個廢掉。使用者原本以為它是效能保護,查證後確認不是,是規劃階段的
//     殘留;「下限」的角色現在由 advance_booking_days 擔任。
//     ✅ 這個欄位已於 2026-09-24 從資料庫移除(migration 20260924040200 drop column),
//     前端(api.ts 的 UpsertMerchantStaffInput、StaffListPage.tsx 的表單狀態)也已一併清空,
//     不要再加回來。
//  3. booking_window_max_days 沿用,改成承載「最遠可以預約到幾天後」。
// ⚠️ 這兩個欄位到目前為止仍然是「只存值、後端沒有任何邏輯在讀」的狀態(使用者已知),所以
//    StaffListPage.tsx 區塊上方那句「這些開關目前先存值,對應的功能上線後才會實際生效」要保留。
// ✅ 資料庫端的配合已經完成(2026-09-24,由負責 supabase/ 的工程師實作):
//    booking_window_max_days 原本帶著 20260916100000_staff_agent_schema.sql 留下的
//    `check (... between 3 and 180)` 約束,會把使用者自己舉例的「填 365」直接擋下,現在已經
//    放寬成 `between 1 and 3650`,並正在進一步放寬成 `between 0 and 3650`(見下方
//    MIN_BOOKING_DAYS_AHEAD_LIMIT 的說明);advance_booking_days 原本完全沒有約束(打 -5 會被靜默存進去),
//    現在補上了 `>= 0`。前端的驗證範圍跟這兩條約束一致,見下方常數與
//    staffListLogic.ts 的 validateStaffBookingDays()。
//
// 2026-09-24 使用者追加裁決(「最遠可以預約到幾天後」留空的意義):使用者原話「這個『最遠可以預約
// 到幾天後』如果沒有填寫則預設 180 天(半年)」。所以這個欄位的 null 語意是「套用 180 天預設」,
// 不是「不限制」——原本寫的「留空代表不限制」是錯的,已改掉。
//
// 2026-09-24 主腦裁決(兩欄留空語意的句型統一,零行為變動):上面那條裁決一度讓兩個欄位變成
// 「一個講不限制、另一個講預設值」兩套講法。但對 advance_booking_days 來說,「留空=不限制」跟
// 「留空=預設 0 天」是**完全同一個行為**(不限制當天可約 = 最少提前 0 天),沒有任何實際差別。
// 所以兩欄的說明一律統一成「留空時系統會用哪個數字」這一種句型,使用者只要記一套心智模型:
//      advance_booking_days    留空 = 0 天(當天就能預約)
//      booking_window_max_days 留空 = 180 天(半年)
// 這只是文案句型調整,沒有改動任何行為、也不牽動資料庫。兩欄留空各自會套用的數字都寫成下面的
// 具名常數,而不是只留在文案裡——理由見那兩個常數自己的註解。
// 另外在 StaffListPage.tsx 的輸入框用 placeholder 把留空時的值直接顯示在空白格子裡(「留空 = 0 天」
// /「留空 = 180 天」),同一個句型,說明文字被略過時也還看得到。
//
// 2026-09-24 使用者最終規格(以這份為準,取代上面所有關於這兩欄「範圍/例子」的較早描述):
//   欄位一 advance_booking_days:可填 0 以上的整數。使用者原話「設定提前預約天數可以是 0,代表
//     一定要當天預約當天完成/可以設其他值例如 3,代表至少要提前 3 天預約」。所以說明文字改成
//     直接用使用者自己舉的 0 跟 3 當例子——0 的意義最容易被誤解(很容易被讀成「不能預約」),
//     一定要寫出「不需要提前,當天預約、當天服務也可以」這句白話。
//   欄位二 booking_window_max_days:0~3650。使用者原話「預設是 180 天,代表客戶或客服可以預約
//     最遠的時間是從當天的時間往後推 180 天(或依照設定的天數範圍到更遠去)」——「從當天往後推」
//     這個基準點要寫進說明,否則商家不知道是從哪一天開始算。
//     ⚠️ 最小值 2026-09-24 從 1 改成 0(使用者澄清,原話:「『提前預約天數可以是 0,代表一定要
//     當天預約當天完成』這句話有錯誤,應該是最遠可預約到幾天後設置為 0 才是代表一定要當天預約
//     當天完成(但這種情況應該幾乎為 0 不過就預留這個可能性)」)。所以 0 是合法值,意義是
//     「最遠只能約到今天」=只接受當天預約當天服務。使用者明講這種設定幾乎不會用到,但要預留。
//
// ⚠️⚠️ 這兩個欄位的「0」意思完全不同,而且連使用者自己一度都講反了,商家更容易混淆,所以兩邊的
//      說明文字都必須把自己那個 0 的意義整句寫出來,不能只寫「可以填 0」:
//        欄位一(最少要提前幾天)填 0 = 「不需要提前」,當天約當天做也可以(它是下限,不是強制)
//        欄位二(最遠可以預約到幾天後)填 0 = 「最遠只能約到今天」,只接受當天預約當天服務(這是上限)
//      欄位二的說明還額外加一句跟欄位一對比的提醒,因為它是比較反直覺的那一個。
export const STAFF_NUMBER_PERMISSION_FIELDS: StaffPermissionFieldDef[] = [
  {
    key: "advance_booking_days",
    label: "最少要提前幾天預約",
    description:
      "客戶至少要提前幾天才能預約這位服務人員。填 0 代表不需要提前,當天預約、當天服務也可以;填 3 代表至少要提前 3 天才能預約。留空時系統會用 0 天,也就是不需要提前。",
    type: "number",
  },
  {
    key: "booking_window_max_days",
    label: "最遠可以預約到幾天後",
    description:
      "客戶或客服最遠可以預約到幾天後,從當天往後推算。填 0 代表最遠只能約到今天,也就是只接受當天預約、當天服務;填 1 代表最遠只能約到明天,後天就約不到了;填 365 代表最遠可以約到一年後。留空時系統會用 180 天,也就是最遠可以約到半年後。最多可以填 3650 天(大約 10 年)。注意這一欄的 0 跟上面「最少要提前幾天預約」的 0 意思不一樣:上面填 0 是「不需要提前」,這裡填 0 是「只能約今天」。",
    type: "number",
  },
];

// =========================================================================
// 「預約天數」兩個欄位留空時各自要套用的預設值。
//
// 為什麼要把這兩個數字放成具名常數,而不是只寫在說明文字裡:這兩個欄位目前還是「只存值、後端
// 沒有任何邏輯在讀」的狀態,真正實作「擋掉超出範圍的預約」那段邏輯的人(未來的 booking 模組)
// 必須知道 null 各自要換算成什麼,否則很可能自己另外挑一個數字、或誤把 null 當成「不限制」,
// 那就違背使用者的裁決了。所以這裡先把契約用程式碼寫下來,而不是只留在註解/UI 文案裡。
//
// ⚠️ 兩個欄位都刻意「不」在前端把 null 就地換算成預設值 —— 儲存時一律維持存 null,讓「使用者
//    沒填」跟「使用者真的填了那個數字」在資料上仍然分得出來(之後如果要改預設值,只留空過的
//    商家會自動跟著改,已經明確填過數字的商家則維持自己填的值)。換算是「讀取端/判斷端」的
//    責任,不是「寫入端」的責任。
// =========================================================================

/** 「最少要提前幾天預約」(advance_booking_days)留空時套用的值 = 0 天,也就是當天就能預約。
 * 2026-09-24 主腦裁決:這個欄位原本的文案講「留空 = 不限制」,跟「留空 = 預設 0 天」是完全同一
 * 個行為(不限制當天可約 = 最少提前 0 天),為了讓兩個欄位共用同一種句型而統一成後者,零行為變動。 */
export const DEFAULT_MIN_ADVANCE_BOOKING_DAYS = 0;

/** 「最遠可以預約到幾天後」(booking_window_max_days)留空時套用的值 = 180 天(半年)。
 * 2026-09-24 使用者追加裁決,原話「如果沒有填寫則預設 180 天(半年)」。注意這個欄位的 null
 * 語意「不是」不限制。 */
export const DEFAULT_MAX_BOOKING_DAYS_AHEAD = 180;

/** 2026-09-24:「最遠可以預約到幾天後」允許填入的下限 = 0 天。
 * 0 的意義是「最遠只能約到今天」=只接受當天預約、當天服務(使用者澄清後的定義,見上方
 * STAFF_NUMBER_PERMISSION_FIELDS 的裁決註解)。使用者明講這種設定幾乎不會用到,但要預留可能性。
 * ⚠️ 這個下限原本是 1,2026-09-24 放寬成 0,要跟資料庫端的 CHECK 約束同步。
 * ✅ 資料庫端已同步完成:merchant_staff_booking_window_max_days_check 現在是
 * `booking_window_max_days is null or (booking_window_max_days between 0 and 3650)`
 * (migration 20260924040200 §3,已套用到正式環境),前後端範圍一致,沒有空窗期。 */
export const MIN_BOOKING_DAYS_AHEAD_LIMIT = 0;

/** 2026-09-24:「最遠可以預約到幾天後」允許填入的上限 = 3650 天(大約 10 年)。
 * 這個數字要跟資料庫端的約束一致——資料庫工程師已把 booking_window_max_days 的舊約束
 * (between 3 and 180,會擋掉使用者自己舉例的 365)放寬成 `between 0 and 3650`,3650 純粹是
 * 防打錯字用的(避免有人多打幾個 0 變成 99999 天),不是產品上真有人要預約 10 年後。
 * 前端擋在同一個範圍,商家才不會看到資料庫的原始錯誤訊息(很醜、看不懂)。
 * ⚠️ 這個值改動時要跟資料庫的 CHECK 約束一起改,兩邊必須同步。 */
export const MAX_BOOKING_DAYS_AHEAD_LIMIT = 3650;

/** 2026-09-24:「最少要提前幾天預約」(advance_booking_days)允許填入的下限 = 0(當天可約)。
 * 資料庫工程師這次主動補上了 `advance_booking_days >= 0` 的防呆約束——原本這個欄位完全沒有
 * 約束,使用者打 -5 會被靜默存進資料庫,之後實作預約邏輯的人就會拿到一個荒謬的值。
 * 前端擋在同一個範圍,理由同上。 */
export const MIN_ADVANCE_BOOKING_DAYS_LIMIT = 0;

/** 1.4 section_key 初稿清單(不做強制白名單,只是前端自動完成/預設勾選項目)。 */
export interface AgentPermissionSectionDef {
  key: string;
  label: string;
  description: string;
  /** ⚠️ true = 這個權限開關「刻意不顯示在客服權限設定畫面上」,不是被刪掉。
   *
   * 為什麼要有這個旗標而不是直接把那一項從陣列裡刪掉:被隱藏的那個功能之後可能會還原,
   * 而 key/label/description 這些文字重寫一次很容易寫錯(描述文字都很長、寫的是權限邊界);
   * 留在原地加一個旗標,還原時只要把旗標拿掉,文字一個字都不會變。
   *
   * ⚠️ 這**不是**安全邊界,只是畫面上不列出來:
   *   ・資料庫裡既有的授權紀錄完全不動(還原後原本開通過的客服依然是開通狀態);
   *   ・對應的 useAgentPermission(key) 判斷、RLS/SECURITY DEFINER 檢查全部照常運作。
   * 換句話說隱藏的只有「商家管理員能不能在畫面上撥這個開關」。 */
  hidden?: boolean;
}

/** 畫面上真的要列出來的權限項目(AgentPermissionsPage.tsx 用這個,不要直接用
 * AGENT_PERMISSION_SECTIONS —— 那份是完整定義,包含被刻意隱藏的項目)。 */
export function visibleAgentPermissionSections(): AgentPermissionSectionDef[] {
  return AGENT_PERMISSION_SECTIONS.filter((section) => !section.hidden);
}

export const AGENT_PERMISSION_SECTIONS: AgentPermissionSectionDef[] = [
  {
    key: "staff_management",
    label: "服務人員管理",
    // 2026-09-24:補上兩件原本沒寫進來的事實——(1)服務人員個別的每週可預約時段是在這頁的編輯
    // 畫面設定的,歸這把鑰匙,不是歸「營業時間設定」(那條的舊描述誤植了,已一併修正);
    // (2)除了「真正刪除」,「邀請服務人員登入」「指派服務人員權限」也同樣永遠只給商家管理員
    // (見 StaffListPage.tsx 2026-09-23 使用者決策那段註解與各自的 isAdmin 判斷)。
    description:
      "開放後客服可以新增/編輯/軟刪除服務人員、指派可承接的服務項目,以及設定服務人員個別的每週可預約時段(對應模組 3)。注意:「真正刪除」(硬刪除已移除的服務人員)、「邀請服務人員登入」、「指派服務人員權限」這三個帳號/敏感操作永遠只有商家管理員能做,不受這個開關影響。",
  },
  {
    key: "service_items",
    label: "服務項目管理",
    description:
      "開放後客服可以新增/編輯/上下架服務項目與服務分類(對應模組 4 規則 2.5,這個開關同時涵蓋服務項目跟服務分類兩者)。",
  },
  {
    key: "orders",
    label: "訂單管理",
    description: "開放後客服可以在行事曆建立新預約、取消預約、把預約標記為完成。",
  },
  {
    key: "billing",
    label: "帳務管理",
    description:
      "開放後客服可以查看店家端帳務報表(對應模組 8 薪資與帳務)。這把鑰匙也「連帶」讓客服可以查看服務人員報表(服務人員報表檢查的權限範圍比較寬,billing 或 staff_report 任一即可),但反過來不成立——只開 staff_report 不能看帳務報表。",
  },
  {
    key: "team_leave",
    label: "團隊休假",
    description:
      "開放後客服可以新增/編輯/下架商家自訂的假別清單,以及登記/取消月薪制服務人員的請假紀錄(對應模組 7 排班與休假管理)。「建單時因為服務人員請假被擋下」不需要這個權限,那是「訂單管理」的範圍。",
  },
  {
    key: "members",
    label: "會員管理",
    // 2026-09-24 使用者裁決(紅利點數管理頁權限分離):使用者的原始理解「客服可以處理會員管理內的
    // 資料包含紅利點數異動等等,但無權限去設定紅利點數管理的規則」被確認為正確。所以「紅利點數
    // 管理」頁從此由兩把鑰匙共管:點數的「交易」(餘額總覽/手動調整/登記兌換/異動歷史)留在這把
    // members,點數的「規則」(核發獎勵資格條件/啟用開關/消費點數比例/推薦獎勵/生日贈點)搬去下面
    // 新增的 member_points。這條描述原本完全沒提到它其實還涵蓋點數規則,分離後照實改寫。
    description:
      "開放後客服可以新增/編輯/下架會員資料、標記電話已驗證,以及在「紅利點數管理」頁查看點數餘額總覽、查看點數異動歷史、登記兌換點數(對應模組 10 會員與紅利)。注意:(1) 這把鑰匙只涵蓋點數的「交易」,不涵蓋點數的「規則」——核發獎勵資格條件、啟用紅利點數功能、消費點數比例、推薦獎勵、生日贈點這些設定歸下面「紅利點數管理」那把獨立的鑰匙,只給這把鑰匙的客服打得開那一頁,但看不到也改不了那些規則設定。(2) 手動調整會員點數這個敏感操作永遠只有商家管理員能做,不受這個開關影響。(3) 建單時選擇/快速建立會員不需要這個權限,只要有「訂單管理」權限即可。",
  },
  {
    key: "member_points",
    label: "紅利點數管理",
    // 2026-09-24 使用者裁決:這是這次新增的一把鑰匙,對應資料庫端的
    // private.can_manage_member_points(p_merchant_id uuid),鎖住 merchant_member_settings 的五個
    // 「規則」欄位:reward_condition_mode / points_feature_enabled / points_earn_rate /
    // referral_bonus_points / birthday_bonus_points。
    // 說明文字刻意寫成「給了這把鑰匙會發生什麼事」而不是「這把鑰匙叫什麼名字」——商家管理員在權限
    // 勾選畫面上要能一眼看懂「勾了這個,這位客服就能改動點數的核發規則」,不必自己去推敲。
    description:
      "開放後客服可以改動「紅利點數管理」頁上半部的點數核發「規則」:核發獎勵資格條件(什麼樣的會員才拿得到點數)、啟用/停用紅利點數功能、消費點數比例、推薦獎勵點數、生日贈點(對應模組 10 會員與紅利)。白話說:給了這把鑰匙,這位客服就能決定「客人要怎樣才拿得到點數、一次拿多少點」,會直接影響之後每一筆訂單實際發出去的點數,也能整個關掉點數功能讓系統不再自動發點,請只給真的需要調這些規則的人。注意:這把鑰匙「不」涵蓋點數的日常交易(餘額總覽、手動調整、登記兌換、異動歷史),那些歸上面「會員管理」那把鑰匙;而且客服要能打開「紅利點數管理」這一頁本身,也還是必須有「會員管理」權限——只給這把鑰匙、沒給「會員管理」的話,對方連這一頁都進不去。",
  },
  {
    key: "staff_report",
    // 2026-09-24 使用者指定改名:「師傅報表」→「服務人員報表」。這個 label 是客服權限設定頁上實際顯示的
    // 開關名稱,要跟 appLayoutLogic.ts 的頁首標題、ManagePage.tsx 的功能卡片 label 用同一個詞。
    label: "服務人員報表",
    description:
      "開放後客服可以查看個別服務人員的抽成/薪資報表(對應模組 8 薪資與帳務)。注意:重新計算已完成訂單抽成金額這個敏感操作永遠只有商家管理員能做,不受這個開關影響。",
  },
  {
    key: "scheduling",
    label: "排班一覽",
    description:
      "開放後客服可以檢視跨服務人員的每週時段/單日例外/請假彙整總覽頁(對應模組 7 排班與休假管理),是純唯讀檢視權限,跟「團隊休假」(有寫入行為)是兩把獨立的鑰匙。",
    // ⚠️ 2026-09-24 使用者指示:「排班一覽這個功能可以先拔掉(隱藏起來),對應的權限開關也要跟著
    //    拔掉(隱藏起來)。」——這是刻意隱藏,不是遺漏。**還原就把下面這一行刪掉**(或改成 false),
    //    這個開關就會重新出現在客服權限設定頁上。
    //    一起要改回來的另一處:src/routes/ManagePage.tsx 的 SCHEDULING_FEATURE_HIDDEN(功能卡片),
    //    那裡有完整的還原說明。資料庫裡既有的 scheduling 授權紀錄一列都不用動。
    hidden: true,
  },
  {
    key: "business_hours",
    label: "營業時間設定",
    // 2026-09-24:原本這條寫的「服務人員個別可預約時段」其實不歸這把鑰匙——那是在服務人員編輯
    // 畫面(StaffListPage.tsx,整頁走 RequireStaffManagementAccess)裡設定的,屬於
    // staff_management。反過來,行事曆上的「開啟/關閉時段」(單日例外)確實歸這把鑰匙
    // (見 CalendarPage.tsx canManageDayOverride),原本卻沒寫進來。兩邊都照實修正。
    description:
      "開放後客服可以調整商家整體每週營業時間、嚴格工時衝突檢查開關,以及在行事曆上開啟/關閉個別日期的時段(單日例外)。注意:「服務人員個別可預約時段」不在這把鑰匙的範圍內,那是在服務人員編輯畫面裡設定的,屬於「服務人員管理」那把鑰匙。",
  },
  {
    key: "commission_settings",
    label: "抽成設定",
    description:
      "開放後客服可以調整商家抽成基準/預設比例、月折算天數、抽成制服務人員個人抽成比例覆寫、月薪制服務人員薪資設定、假別扣款規則(對應模組 8 薪資與帳務)。注意:重新計算已完成訂單抽成金額這個敏感操作永遠只有商家管理員能做,不受這個開關影響。",
  },
  {
    key: "line_notification",
    label: "LINE 通知設定",
    description:
      "開放後客服可以調整每類事件要不要通知、通知誰、文案內容,以及查看發送記錄(對應模組 11 LINE 通知)。",
  },
  {
    key: "push_notification",
    label: "推播通知設定",
    description:
      "開放後客服可以設定服務人員手機/瀏覽器推播要不要開、文案內容(對應模組 15 服務人員推播通知)。",
  },
  {
    key: "payment_methods",
    label: "支付方式設定",
    description:
      "開放後客服可以新增/編輯/下架商家自訂的付款方式清單,也可以設定稅金設定(商家端三項調整規格書 §一 1.2/1.3,原本歸在「營業時間設定」底下,這次搬過來)。建單/編輯時選擇既有付款方式不需要這個權限,只要有「訂單管理」權限即可。",
  },
  {
    key: "report_export",
    label: "下載報表",
    description:
      "開放後客服可以打開報表匯出中心(對應模組 12 資料匯入與報表匯出)。這個開關只控制「能不能打開這個畫面、按下匯出按鈕」，實際能匯出到什麼資料範圍，完全由訂單/會員/抽成/請假各自來源模組的既有權限決定，不會讓客服多看到原本看不到的資料。",
  },
  {
    key: "member_settings",
    label: "會員系統設定",
    // 2026-09-24:原本這條列的「電話驗證政策、消費點數比例、推薦獎勵點數、生日贈點」四項現在
    // 全都不在會員系統設定頁了(電話驗證政策 #618 整個移除;點數三個欄位 #642 搬去紅利點數管理;
    // 核發獎勵資格條件 2026-09-24 也搬去紅利點數管理),照這把鑰匙目前實際開放的範圍改寫。
    description:
      "開放後客服可以調整會員系統設定頁的兩個區塊:會員政策(啟用開關與政策內容)、會員等級清單(新增/編輯/下架/重新上架)(對應模組 10 會員與紅利)。注意:紅利點數相關設定(啟用開關、核發獎勵資格條件、消費點數比例、推薦獎勵、生日贈點)已經全部集中到「紅利點數管理」頁,不在這把鑰匙的範圍內——2026-09-24 起那一頁由兩把鑰匙共管:要打得開那一頁要有「會員管理」,要改得動上面那些規則設定則另外要有「紅利點數管理」。",
  },
  {
    key: "material_costs",
    label: "料錢成本管理",
    description:
      "開放後客服可以新增/編輯/下架料錢成本品項清單(對應建單功能擴充規格書 2.3 決策記錄 4),也可以設定料錢成本功能開關(商家端三項調整規格書 §一 1.2/1.3,原本歸在「營業時間設定」底下,這次搬過來)。建單/編輯時勾選既有品項不需要這個權限,只要有「訂單管理」權限即可。",
  },
];
