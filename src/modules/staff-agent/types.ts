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

/** 服務人員的計酬類型。資料庫欄位 merchant_staff.compensation_type,CHECK 只允許這兩個值。 */
export type StaffCompensationType = "monthly_salary" | "piece_rate";

/** 計酬類型的中文顯示用語(規格書「超級管理員商家詳情強化」#700)。
 *  ⚠️ 2026-09-24 用語統一:`piece_rate` 顯示「抽成制」(舊稱「按件計酬」,不要再用)。
 *     資料庫存的值仍然是英文 'piece_rate',只有中文顯示改。
 *  ⚠️ 這份用語目前在系統裡有第二處:StaffListPage.tsx 的 inline 三元運算式
 *     (`staff.compensation_type === "monthly_salary" ? "月薪制" : "抽成制"`)。
 *     這次刻意不動那一行(規格書明列「不要動 StaffListPage.tsx」),
 *     但之後有人動到那附近時,請順手改成 import 這份常數,把用語收成一處。 */
export const STAFF_COMPENSATION_TYPE_LABELS: Record<StaffCompensationType, string> = {
  monthly_salary: "月薪制",
  piece_rate: "抽成制",
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
  /**
   * SPECS-INDEX #977(2026-10-06):true = 名稱旁顯示一個小灰色「即將推出」標籤。
   * 🔴 只是標示「這個功能還沒正式上線」,**開關照常可以切換、照常存值,不鎖、不灰掉**
   *    (使用者先把想要的設定存好,功能上線後就直接生效)。
   */
  comingSoon?: boolean | undefined;
}

// 🔴 SPECS-INDEX #977(2026-10-06,第 1 批):改名、排序、改說明、加「即將推出」標籤。
// **只改文字與順序** —— key(資料庫欄位)、判斷邏輯一律不動。陣列順序 = 編輯服務人員畫面上的顯示順序。
// 「即將推出」= 對應的功能還沒正式上線(客戶線上預約頁、Google 日曆、服務人員建單、施工照片
// 都是之後的模組);沒標的三項(商家後台編輯無時段限制、商家後台確認後直接接單、服務人員是否顯示會員資料)是目前就有作用的。
// 📌 第 4 項「商家後台確認後直接接單」:#977 第 4 批(2026-10-06)起生效 —— 後台建單時主要服務人員開著這個開關,
//    新訂單直接是「已確認」(create_booking,migration 20261006140100);關閉時是「待確認」,由服務人員在自己的
//    行事曆按「確認接單」(staff_confirm_booking)。編輯訂單換主要服務人員時狀態不變。
// 📌 第 5 項「服務人員是否顯示會員資料」:說明是使用者 2026-10-02 裁決 H-13 定義的**正確行為**
//    (關閉 = 只看得到客戶姓名)。第 3 批(2026-10-06)已修:關閉時 get_my_booking_schedule 在後端就不回傳
//    客戶電話、地址(migration 20261006130300)。
// 📌 第 1 項「客戶預約無時段限制」(no_time_slot_limit):裁決 H-7 定義成「只管客戶線上預約」,所以標「即將推出」。
//    第 3 批(2026-10-06)起後台一律不看這個欄位(建單 / 改單 / 時間清單 / 行事曆 / 排班一覽,
//    migration 20261006130200);後台要放寬只看「商家後台編輯無時段限制」。
export const STAFF_BOOLEAN_PERMISSION_FIELDS: StaffPermissionFieldDef[] = [
  {
    key: "no_time_slot_limit",
    label: "客戶預約無時段限制",
    description: "開啟後，客戶線上預約這位服務人員時，可以選到他可預約時段以外的時間。",
    type: "boolean",
    comingSoon: true,
  },
  {
    key: "auto_accept_booking",
    label: "客戶預約自動接受",
    description: "開啟後，客戶線上預約這位服務人員的訂單會直接成立，不用等確認。",
    type: "boolean",
    comingSoon: true,
  },
  {
    key: "unlimited_backend_edit",
    label: "商家後台編輯無時段限制",
    // 已核對(裁決 H-11):private.check_staff_booking_slot 在 unlimited_backend_edit=true 時跳過營業時間 /
    // 每週時段 / 單日例外三層,請假判斷在那個區塊之外一律執行;重疊檢查是另一道(嚴格工時衝突檢查)。
    description:
      "開啟後，商家管理員或客服在後台幫這位服務人員建單、改單時，可以排在營業時間與他自己設定的可預約時段以外（例如他只開 9 點到 18 點，開啟後 18 點以後也能排）。請假時段仍然不能排；能不能和其他訂單時間重疊，依「營業時間設定」的嚴格工時衝突檢查決定。",
    type: "boolean",
  },
  {
    key: "direct_accept_after_merchant_confirm",
    label: "商家後台確認後直接接單",
    description:
      "開啟後，商家管理員或客服在後台建立訂單、指派這位服務人員為主要服務人員時，訂單會直接成為「已確認」，不用他再按確認。關閉時，新訂單是「待確認」，要等他在自己的行事曆按「確認接單」。",
    type: "boolean",
  },
  {
    key: "show_member_info",
    label: "服務人員是否顯示會員資料",
    description:
      "關閉時，這位服務人員在自己的預約詳情只看得到客戶姓名，看不到電話、地址等聯絡資料。",
    type: "boolean",
  },
  {
    key: "google_calendar_sync_enabled",
    label: "服務人員Google日曆同步",
    description: "開啟後，這位服務人員的行程會同步到他的 Google 日曆。",
    type: "boolean",
    comingSoon: true,
  },
  {
    key: "can_create_edit_orders",
    label: "服務人員新增編輯訂單",
    description:
      "開啟後，這位服務人員可以在自己的行事曆新增預約，並編輯、取消、完成指派給自己的訂單。",
    type: "boolean",
    comingSoon: true,
  },
  {
    key: "can_upload_construction_photos",
    label: "服務人員施工圖片上傳",
    description: "開啟後，這位服務人員可以在訂單上傳施工照片，商家端可以查看。",
    type: "boolean",
    comingSoon: true,
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
//    這兩欄在畫面上標「即將推出」(comingSoon,SPECS-INDEX #977;原本區塊上方那句「這些開關目前先存值」
//    常駐提醒已改成逐項標示)。
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
    // #977(2026-10-06):開頭加使用者指定的「只限制客戶線上預約…」;後面「0 的意思」那段是 2026-09-24
    // 使用者裁決要求一定要寫出來的(兩欄的 0 意思相反),保留不刪。
    description:
      "只限制客戶線上預約，商家管理員與客服在後台建單不受限。客戶至少要提前幾天才能預約這位服務人員。填 0 代表不需要提前，當天預約、當天服務也可以;填 3 代表至少要提前 3 天才能預約。留空時系統會用 0 天，也就是不需要提前。",
    type: "number",
    comingSoon: true,
  },
  {
    key: "booking_window_max_days",
    label: "最遠可以預約到幾天後",
    // #977(2026-10-06):同上;另照事實把「客戶或客服」改成「客戶」—— 裁決 H-9 定案只套用客戶端,後台不受限。
    description:
      "只限制客戶線上預約，商家管理員與客服在後台建單不受限。客戶最遠可以預約到幾天後，從當天往後推算。填 0 代表最遠只能約到今天，也就是只接受當天預約、當天服務;填 1 代表最遠只能約到明天，後天就約不到了;填 365 代表最遠可以約到一年後。留空時系統會用 180 天，也就是最遠可以約到半年後。最多可以填 3650 天(大約 10 年)。注意這一欄的 0 跟上面「最少要提前幾天預約」的 0 意思不一樣：上面填 0 是「不需要提前」，這裡填 0 是「只能約今天」。",
    type: "number",
    comingSoon: true,
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

// 🔴 SPECS-INDEX #976(2026-10-06,第 1 批)改名、改說明、排序。**key 一個都沒改**(資料庫的授權紀錄、
// useAgentPermission(key)、RLS/SECURITY DEFINER 檢查全部照舊),只動畫面上的 label / description 與陣列順序。
// 排序規則(使用者 2026-10-02 裁決 H-6):先照底部選單順序(訂單管理 → 店家報表),其餘照「功能」頁
// 卡片的順序(ManagePage.tsx 的 cards 陣列)。陣列順序 = 客服權限設定頁上的顯示順序。
// 說明文字裡「對應模組 N」這類內部用語已拿掉;每一條都對照過實際程式(核對結果寫在各項註解)。
export const AGENT_PERMISSION_SECTIONS: AgentPermissionSectionDef[] = [
  {
    key: "orders",
    label: "訂單管理",
    // 紅利系統重構(規格書 §3.14、第 4 題定案 A):建單時看系統建議派點、手動修改派點、用會員點數折抵
    // 都只要這把鑰匙(不需要會員管理 / 紅利點數),商家開權限時要看得到這件事。
    // #976:不在使用者的新說明表內 ⇒ 文字內容不動,只調順序;#976 補修(2026-10-06)半形標點改全形。
    description:
      "開放後客服可以在行事曆建立新預約、取消預約、把預約標記為完成。建單時可以看到系統建議派點、手動修改這筆訂單的派點，以及使用會員點數折抵（紅利點數功能開啟時）。",
  },
  {
    key: "billing",
    // #976:舊名「帳務管理」。頁面本身(BillingReportPage.tsx / 底部選單)早就叫「店家報表」。
    // 📌 舊說明寫「這把鑰匙也連帶讓客服可以查看服務人員報表」—— 畫面上不成立(RequireStaffReportAccess
    //    只看 staff_report),前後端不一致排在第 3 批處理(規劃檔 C-2),這裡照畫面實際行為寫。
    label: "店家報表",
    description: "開放後客服可以查看店家報表。",
  },
  {
    key: "staff_management",
    // #976:舊名「服務人員管理」。
    // 2026-09-24:(1)服務人員個別的每週可預約時段是在服務人員編輯畫面設定的,歸這把鑰匙;
    // (2)「真正刪除」「邀請服務人員登入」「指派服務人員權限」永遠只給商家管理員
    // (見 StaffListPage.tsx 各自的 isAdmin 判斷)。
    label: "服務人員",
    description:
      "開放後客服可以新增、編輯、軟刪除服務人員，指派可承接的服務項目，以及設定服務人員個別的每週可預約時段。注意：「真正刪除」（硬刪除已移除的服務人員）、「邀請服務人員登入」、「指派服務人員權限」這三個帳號／敏感操作永遠只有商家管理員能做，不受這個開關影響。",
  },
  {
    key: "service_items",
    // #976:舊名「服務項目管理」。
    label: "服務項目",
    description: "開放後客服可以新增、編輯、上下架服務項目與服務分類。",
  },
  {
    key: "business_hours",
    label: "營業時間設定",
    // #976 照事實修正:使用者的新說明只寫「每週營業時間、嚴格工時衝突檢查開關」,但這把鑰匙**也**
    // 控制行事曆上「開啟/關閉個別日期的時段」(CalendarPage.tsx 的 canManageBusinessHoursPermission →
    // canManageDayOverride),漏寫會讓商家以為關掉這個開關客服就碰不到時段,所以補回來。
    // 「服務人員個別可預約時段」不歸這把鑰匙(歸「服務人員」),舊說明的那句提醒拿掉以符合新版精簡寫法。
    description:
      "開放後客服可以調整商家整體每週營業時間、嚴格工時衝突檢查開關，以及在行事曆上開啟／關閉個別日期的時段（單日例外）。",
  },
  {
    key: "material_costs",
    label: "料錢成本管理",
    // 已核對:MaterialCostsPage.tsx 有品項清單 + MaterialCostEnabledToggle(功能開關),守衛 material_costs。
    description: "開放後客服可以新增、編輯、下架料錢成本品項清單，也可以設定料錢成本功能開關。",
  },
  {
    key: "payment_methods",
    // 第 1 批小修(主腦 2026-10-06):顯示名稱改「付款方式管理」,跟頁標題、功能卡片一致;key 不變。
    label: "付款方式管理",
    // 已核對:稅金設定在 PaymentMethodsPage.tsx(守衛 payment_methods)。
    description: "開放後客服可以新增、編輯、下架商家自訂的付款方式清單，也可以設定稅金。",
  },
  {
    key: "team_leave",
    // #976:舊名「團隊休假」。同一把鑰匙決定「月薪人員假別設定」「請假紀錄」兩張卡片
    // (ManagePage.tsx showTeamLeaveCards、RequireTeamLeaveAccess)。
    label: "月薪人員假別設定",
    description:
      "開放後會連同請假紀錄功能一起打開，客服可以新增、編輯、下架商家自訂的假別清單，以及登記／取消月薪制服務人員的請假紀錄。",
  },
  {
    key: "scheduling",
    label: "排班一覽",
    description:
      "開放後客服可以檢視跨服務人員的每週時段、單日例外、請假彙整總覽頁，是純唯讀檢視權限，跟「月薪人員假別設定」（有寫入行為）是兩把獨立的鑰匙。",
    // ⚠️ 2026-09-24 使用者指示:「排班一覽這個功能可以先拔掉(隱藏起來),對應的權限開關也要跟著
    //    拔掉(隱藏起來)。」——這是刻意隱藏,不是遺漏。**還原就把下面這一行刪掉**(或改成 false),
    //    這個開關就會重新出現在客服權限設定頁上。
    //    一起要改回來的另一處:src/modules/scheduling/featureVisibility.ts 的 SCHEDULING_FEATURE_HIDDEN(功能卡片 + 路由守衛,#976 第 3 批從 ManagePage.tsx 搬過去),
    //    那裡有完整的還原說明。資料庫裡既有的 scheduling 授權紀錄一列都不用動。
    // #976:隱藏中,只把說明裡引用的舊名「團隊休假」換成新名;#976 補修(2026-10-06)拿掉「對應模組 7」內部用語、標點改全形。
    hidden: true,
  },
  {
    key: "commission_settings",
    // #976:舊名「抽成設定」。
    // 照事實核對:「商家抽成基準」仍在(PayrollSettingsPage.tsx 的 MerchantPayrollSettingsCard「【抽成制】抽成基準」)
    // ⇒ 依規格書第三節規則 2 補回;「預設比例」「月折算天數」已刪除 ⇒ 不出現。
    // 假別扣款規則的按鈕在 LeaveTypesPage.tsx,要能進那一頁(team_leave)且有這把鑰匙(commission_settings)才看得到。
    label: "抽成與薪資設定",
    description:
      "開放後客服可以調整商家的抽成基準、抽成制服務人員的個人抽成比例、月薪制服務人員的薪資設定。假別扣款規則在「月薪人員假別設定」頁，需要同時開啟該權限才能修改。",
  },
  {
    key: "staff_report",
    // 2026-09-24 使用者指定改名:原本的舊稱報表名稱 →「服務人員報表」。這個 label 是客服權限設定頁上實際顯示的
    // 開關名稱,要跟 appLayoutLogic.ts 的頁首標題、ManagePage.tsx 的功能卡片 label 用同一個詞。
    // #976:不在使用者的新說明表內 ⇒ 只調順序;#976 補修(2026-10-06,使用者實機發現)拿掉「對應模組 8」內部用語、標點改全形。
    label: "服務人員報表",
    description:
      "開放後客服可以查看個別服務人員的抽成／薪資報表。注意：重新計算已完成訂單抽成金額這個敏感操作，永遠只有商家管理員能做，不受這個開關影響。",
  },
  {
    key: "members",
    label: "會員管理",
    // 2026-09-24 使用者裁決(紅利點數頁權限分離):點數的「交易」(查看餘額與異動歷史/登記兌換)歸這把
    // members,點數的「規則」歸 member_points;#830 之後「交易」那一半在會員詳情頁。
    // #976 照事實修正:使用者的新說明寫「也能進入「紅利點數」頁查看設定」—— 實際上只有 members、沒有
    // member_points 的客服打得開那一頁(RequireMemberPointsAccess 看 members),但規則卡片整組不渲染,
    // 只看到「你目前的權限看不到這頁的規則設定」(MemberPointsPage.tsx)。所以改寫成「進得去、但看不到規則」。
    description:
      "開放後客服可以新增、編輯、下架會員資料，標記電話已驗證，並可在會員詳情頁查看點數餘額與異動歷史、登記兌換點數，也能進入「紅利點數」頁，但看不到裡面的規則設定。要查看或修改紅利規則需另外開啟「紅利點數」權限；手動調整點數只有商家管理員能做。",
  },
  {
    key: "member_points",
    // #976:舊名「紅利點數管理」。對應資料庫端 private.can_manage_member_points。
    // #976 照事實補一句:這一頁本身的守衛(RequireMemberPointsAccess)看的是 members,只開這把、
    // 沒開「會員管理」的客服連頁面都進不去 —— 漏寫會讓商家以為只開這一個就夠。
    label: "紅利點數",
    description:
      "開放後客服可以改動「紅利點數」頁的核發獎勵資格條件、啟用／停用紅利點數功能、紅利計算、點數使用、推薦系統、生日獎勵。要同時開啟「會員管理」權限，客服才進得去這一頁。",
  },
  {
    key: "member_settings",
    label: "會員系統設定",
    description:
      "開放後客服可以調整會員系統設定頁的兩個區塊：會員政策（啟用開關與政策內容）、會員等級清單（新增／編輯／下架／重新上架）。",
  },
  {
    key: "line_notification",
    label: "LINE 通知設定",
    // 已核對:「LINE 發送記錄」卡片跟「LINE 通知設定」共用這把鑰匙(ManagePage.tsx showLineNotificationCards)。
    description: "開放後客服可以調整每類事件要不要通知、通知誰、文案內容，以及查看 LINE 發送記錄。",
  },
  {
    key: "line_marketing",
    // #976 第 3 批(2026-10-06):新增。排在「LINE 通知設定」之後、「推播通知設定」之前(照功能頁卡片順序,
    // ManagePage.tsx 的 line-marketing 卡片)。改前再行銷通知只給商家管理員。
    // 後端同一個判斷 private.can_send_line_marketing:可選名單 list_line_marketable_members、
    // Edge Function line-send-marketing(am_i_allowed_line_marketing)、會員等級篩選(merchant_member_tiers 讀取)。
    // 既有客服預設關閉:資料庫沒有這個 key 的授權列 = 沒開。
    label: "再行銷通知",
    description: "開放後客服可以挑選已綁定 LINE 的會員名單，發送一次性的自訂文字訊息。",
  },
  {
    key: "push_notification",
    label: "推播通知設定",
    // 已核對:「推播發送記錄」卡片跟「推播通知設定」共用這把鑰匙(ManagePage.tsx showPushNotificationCard)。
    description: "開放後會連同推播發送記錄一起打開，客服可以設定每一類事件要不要發推播、文案內容。",
  },
  {
    key: "report_export",
    // #976:舊名「下載報表」。
    label: "報表匯出中心",
    description: "開放後客服可以打開報表匯出中心並下載報表。",
  },
];
