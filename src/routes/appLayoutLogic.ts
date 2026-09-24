// 後台導覽外殼的「純判斷邏輯」——從 AppLayout.tsx / HomePage.tsx / ManagePage.tsx 抽出來的
// 不含 React、不含 supabase、不含 react-query 的純函式,目的只有一個:讓「這個人該看到商家端還是
// 服務人員端」「底部要顯示哪一組分頁籤」「切換選項該不該出現」「角色還在載入時該怎麼辦」這四件事
// 能夠被單元測試釘死。
//
// 為什麼需要這個檔案(2026-09-24 線上故障的直接教訓):
//   雙重身分(同時是某商家的客服 + 同一間商家的服務人員)的使用者登入後完全進不去服務人員端,
//   底部選單被套成商家端,而他身為客服又沒有任何客服權限,於是「功能」頁是空的 —— 畫面上只剩
//   「目前沒有開放給你的功能,請聯絡商家管理員開通權限。」這句話,整個 App 對他而言等於壞掉。
//   根因是這段判斷邏輯當時整段寫在 AppLayout.tsx 的元件函式本體裡,沒有任何測試覆蓋,而唯一的
//   進入路徑(藏在商家切換器下拉選單最底部的一個選項)在實機上從來沒被驗證過。
//   ⇒ 這裡的每一條判斷都必須有對應的測試(見 appLayoutLogic.test.ts)。
//
// 檔案裡刻意「只有判斷」,沒有任何查詢/副作用:呼叫端(AppLayout.tsx)負責把 react-query 的結果
// (角色、自己的服務人員紀錄、載入狀態)攤平成單純的布林值/字串再傳進來。

import {
  CalendarDays,
  CalendarOff,
  FileBarChart,
  Home,
  LayoutGrid,
  Receipt,
  TrendingUp,
  UserRound,
} from "lucide-react";

/** useCurrentMerchantRole() 的 data 可能出現的所有值。
 * ⚠️ undefined 是「還沒解出來」(react-query 尚未有答案),null 是「解出來了,而且這個人跟這間店
 * 無關」—— 兩者語意完全不同,判斷式不可以混為一談(這正是這次故障的一部分)。 */
export type MerchantRoleValue = "admin" | "agent" | "staff" | null | undefined;

export interface TabDef {
  to: string;
  label: string;
  icon: typeof Home;
  isActive: (pathname: string) => boolean;
}

// =========================================================================
// 分頁籤定義
// =========================================================================

/** 服務人員端第 1 個分頁籤(路由 /app)。
 *
 * 2026-09-24 使用者指定:標籤從「首頁」改成「個人資料」,頁面內容是「個人資料卡片 + LINE 綁定」
 * (見 HomePage.tsx)。路由本身不變,所以既有的深連結/書籤都還通。 */
export const STAFF_PROFILE_TAB: TabDef = {
  to: "/app",
  label: "個人資料",
  icon: UserRound,
  isActive: (pathname) => pathname === "/app",
};

export const CALENDAR_TAB: TabDef = {
  to: "/app/calendar",
  label: "行事曆",
  icon: CalendarDays,
  isActive: (pathname) => pathname.startsWith("/app/calendar"),
};

/** 商家管理員/客服的 4 個分頁籤:功能/行事曆/訂單管理/店家報表。
 * 這次(2026-09-24)完全沒有改動,原封不動從 AppLayout.tsx 搬過來 —— 使用者這次指定的底部選單
 * 改版只針對服務人員端。 */
export const MERCHANT_TABS: TabDef[] = [
  {
    to: "/app/manage",
    label: "功能",
    icon: LayoutGrid,
    isActive: (pathname) =>
      pathname.startsWith("/app/manage") ||
      pathname.startsWith("/app/staff") ||
      pathname.startsWith("/app/agents") ||
      pathname.startsWith("/app/service-items") ||
      pathname.startsWith("/app/settings"),
  },
  CALENDAR_TAB,
  {
    to: "/app/orders",
    label: "訂單管理",
    icon: Receipt,
    isActive: (pathname) => pathname.startsWith("/app/orders"),
  },
  {
    to: "/app/billing-report",
    label: "店家報表",
    icon: TrendingUp,
    isActive: (pathname) => pathname.startsWith("/app/billing-report"),
  },
];

/** 服務人員的 4 個分頁籤。
 *
 * 2026-09-24 使用者指定的新順序與標籤:個人資料 / 行事曆 / 休假設定 / 薪資報表。
 * 改版前是:首頁 / 休假設定 / 薪資報表 / 行事曆(.project/specs/服務人員端.md §15.1)。
 * ⚠️ 這是使用者直接指定、覆寫 §15.1 原本規劃的順序與第一個分頁籤標籤,不是實作偏離。
 *
 * 「所有角色底部分頁籤數量一致」這條既有規則(§15.1/SPECS-INDEX #118)延續適用 —— 商家端 4 個、
 * 服務人員端 4 個,數量沒變,只有服務人員端的內容與順序變了。
 *
 * 「功能」(/app/manage)依使用者指示「隱藏掉(不刪除)」:這裡不放這個分頁籤,但 /app/manage
 * 這條路由、ManagePage.tsx 這個頁面、以及底下所有功能卡片完全保留不動。 */
export const STAFF_TABS: TabDef[] = [
  STAFF_PROFILE_TAB,
  CALENDAR_TAB,
  {
    to: "/app/my-availability",
    label: "休假設定",
    icon: CalendarOff,
    isActive: (pathname) => pathname.startsWith("/app/my-availability"),
  },
  {
    to: "/app/my-payroll",
    label: "薪資報表",
    icon: FileBarChart,
    isActive: (pathname) => pathname.startsWith("/app/my-payroll"),
  },
];

// =========================================================================
// 核心判斷
// =========================================================================

export interface StaffViewInput {
  /** useCurrentMerchantRole() 的 data。 */
  merchantRole: MerchantRoleValue;
  /** useActiveMyStaffRecord(目前商家) 是否真的拿到一筆「在職且已開通登入」的自己的服務人員紀錄。
   * ⚠️ 呼叫端要傳 `data != null`,不是 `data !== undefined` —— useActiveMyStaffRecord 在載入中
   * 與「不是有效服務人員」兩種情況都回傳 null。 */
  hasActiveStaffRecord: boolean;
  /** 雙重身分的人有沒有主動選擇「我現在要看服務人員端」。 */
  forcedStaffView: boolean;
}

/** 這個人除了解析出來的角色之外,是不是「也能」切到服務人員端。
 *
 * 為什麼不直接看 merchantRole === 'staff':useMerchantRole 的優先序是 管理員 → 客服 → 服務人員
 * (模組 3 context.tsx 規則 2.10),同一個人身兼多重角色時一律回傳較高權限的角色。所以一個
 * 「客服 + 服務人員」的人解析出來永遠是 'agent',永遠不會是 'staff'。要判斷他能不能切到服務人員端,
 * 必須另外直接查自己的 merchant_staff 紀錄。
 *
 * 邊界情況(這次特別確認過):同一個人在 A 店是「客服 + 服務人員」、在 B 店只是「客服」。
 * 切到 B 店時 hasActiveStaffRecord 為 false ⇒ 這裡回傳 false ⇒ 切換選項不出現。這是正確的
 * (他在 B 店根本沒有服務人員身分,沒有東西可以切過去),但對使用者來說會困惑,所以 ManagePage
 * 的空狀態文字要另外提示「你可能要先切換商家」(見 ManagePage.tsx)。 */
export function resolveIsDualRoleEligible(
  merchantRole: MerchantRoleValue,
  hasActiveStaffRecord: boolean,
): boolean {
  return (merchantRole === "admin" || merchantRole === "agent") && hasActiveStaffRecord;
}

/** 現在實際要顯示服務人員端內容嗎?
 *   ① 純服務人員(角色就是 staff)⇒ 永遠 true,不需要也不能被切換。
 *   ② 雙重身分 ⇒ 依他自己的選擇。
 *   ③ 其他(純管理員/純客服/角色還在載入中/角色是 null)⇒ false。 */
export function resolveIsStaffView({
  merchantRole,
  hasActiveStaffRecord,
  forcedStaffView,
}: StaffViewInput): boolean {
  if (merchantRole === "staff") return true;
  return resolveIsDualRoleEligible(merchantRole, hasActiveStaffRecord) && forcedStaffView;
}

/** 「切換商家端/服務人員端」這個入口該不該出現。
 * 跟 resolveIsDualRoleEligible 完全同義,分成兩個名字是為了讓呼叫端的意圖看得出來
 * (一個是「他有沒有雙重身分」,一個是「畫面上要不要長出切換入口」)。 */
export function shouldShowStaffViewSwitch(
  merchantRole: MerchantRoleValue,
  hasActiveStaffRecord: boolean,
): boolean {
  return resolveIsDualRoleEligible(merchantRole, hasActiveStaffRecord);
}

/** 底部要顯示哪一組分頁籤。數量永遠是 4,只有內容不同。 */
export function resolveTabs(isStaffView: boolean): TabDef[] {
  return isStaffView ? STAFF_TABS : MERCHANT_TABS;
}

// =========================================================================
// 載入競態
// =========================================================================

export interface ViewResolutionInput {
  /** 目前操作中的商家已經選定(currentMerchant != null)。
   * ⚠️ 必要條件:角色查詢跟服務人員紀錄查詢都是 `enabled: Boolean(merchantId)`,商家還沒選定時
   * 兩個查詢都是「停用」狀態 —— react-query 對停用的查詢回報 isLoading === false,所以只看
   * isLoading 會誤判成「已經解出來了,角色是 undefined」。 */
  hasCurrentMerchant: boolean;
  /** useCurrentMerchantRole().isLoading */
  roleLoading: boolean;
  /** useActiveMyStaffRecord().isLoading */
  staffRecordLoading: boolean;
}

/** 「該看商家端還是服務人員端」這件事,現在已經有確定答案了嗎?
 *
 * 2026-09-24 修正的競態:HomePage 原本寫 `if (!isStaffView) return <Navigate to="/app/manage" />`,
 * 完全沒有等角色載入完成。merchantRole 還是 undefined 時 isStaffView 就是 false,所以連
 * **純服務人員** 都會在角色解析完成之前先被彈到 /app/manage,然後 ManagePage 解出 staff 再把他
 * 彈回 /app —— 使用者看到的是一次商家端「功能」頁的閃爍(不是無限迴圈,但在手機/慢網路上很明顯,
 * 而且中間那一瞬間畫面上就是那句「目前沒有開放給你的功能」)。
 *
 * ⚠️ 這裡刻意用 isLoading(= isPending && isFetching)而不是 isPending:查詢失敗(重試用盡)時
 * isLoading 會變 false,不會讓畫面永遠卡在「載入中」。 */
export function isStaffViewResolved({
  hasCurrentMerchant,
  roleLoading,
  staffRecordLoading,
}: ViewResolutionInput): boolean {
  if (!hasCurrentMerchant) return false;
  return !roleLoading && !staffRecordLoading;
}

/** HomePage(/app)這次該做什麼。抽成純函式就能把上面那個閃爍情境直接寫成測試。 */
export type HomePageOutcome = "loading" | "redirect-to-manage" | "render-staff-home";

export function resolveHomePageOutcome(input: {
  isViewResolved: boolean;
  isStaffView: boolean;
}): HomePageOutcome {
  if (!input.isViewResolved) return "loading";
  return input.isStaffView ? "render-staff-home" : "redirect-to-manage";
}

// =========================================================================
// 頁首的「目前在哪個功能頁」標題
// =========================================================================
//
// 2026-09-24 使用者在手機上實機回報的兩件事之一:「頁首應該要顯示目前在哪個功能頁,現在不知道
// 自己在哪。」(另一件是頁首要吸頂,那件在 AppLayout.tsx / src/lib/fixedLayers.ts。)
//
// 為什麼這段一定要是純函式 + 有測試,而不是在 AppLayout.tsx 裡寫一串三元運算:
// 完全比照這個檔案開頭記錄的 2026-09-24 線上故障教訓 —— 「從 pathname 推導出畫面上該顯示什麼」
// 這類判斷寫在元件本體裡就沒辦法被測,而它漏掉一條路徑的後果是使用者在那一頁看到空白標題、
// 甚至字面的 "undefined"。路由有 34 條,靠肉眼一頁一頁點是不可能維持正確的。
//
// 標題文字的來源(**不是自己另創的名稱**):一律取各頁面元件自己 <h1> 裡現在畫面上顯示的文字,
// 讓頁首的標題跟頁面內文的標題永遠是同一個詞,使用者不會覺得是兩個不同的東西。
// 少數幾條例外(下面每一條都有註解說明):
//   ・帶參數的頁面(某人的權限設定、某位會員的資料)頁面內文顯示的是「{名字} 的權限設定」,
//     但頁首只拿得到 pathname、拿不到那個名字(要多一次查詢才知道,那就不是純函式了),
//     所以用該頁面自己在「資料還沒載入時」的 fallback 文字。
//   ・/app 在商家端會被導向 /app/manage,見下面 resolveAppHeaderTitle 的說明。

/** 一條路由 → 頁首標題。pattern 用 `:param` 表示「這一段吃任何值」,寫法跟 App.tsx 的
 * <Route path> 完全一致,方便兩邊對照有沒有漏。 */
interface AppHeaderTitleRule {
  pattern: string;
  title: string;
}

/** App.tsx 第 91 行 `<Route element={<AppLayout />}>` 底下的**所有**子路由,一條不漏。
 *
 * ⚠️ 維護規則:在 App.tsx 的那個區塊新增路由時,一定要同時在這裡加一列 —— 沒加的話那一頁的頁首
 * 標題會是空白(不會壞掉,但使用者就回到「不知道自己在哪」的原點)。
 * appLayoutLogic.test.ts 有一條測試會逐條比對這份清單,漏掉的話測試會直接指出是哪一條路徑。
 *
 * 刻意用「有序陣列 + 逐段比對」而不是 Record<string, string>:因為有 /app/staff/:staffId/permissions
 * 這種帶參數的路徑,物件的 key 沒辦法表達;也刻意不用正規表示式拼字串(容易寫錯又難讀)。
 * 順序上把固定字串的路徑放在帶參數的前面,雖然目前這 34 條的「段數 + 字面」組合沒有任何一組會
 * 互相撞到(例如 /app/members/:id 是 3 段、/app/member-points 是 2 段),但靠順序保證「固定字串
 * 先贏」比靠「剛好沒撞到」安全。 */
const APP_HEADER_TITLE_RULES: AppHeaderTitleRule[] = [
  // --- 底部分頁籤(商家端)---
  { pattern: "/app/manage", title: "功能" },
  { pattern: "/app/calendar", title: "行事曆" },
  { pattern: "/app/orders", title: "訂單管理" },
  { pattern: "/app/billing-report", title: "店家報表" },
  // --- 底部分頁籤(服務人員端)---
  // /app 不在這份清單裡,它要看 isStaffView,見 resolveAppHeaderTitle。
  { pattern: "/app/my-availability", title: "休假設定" },
  { pattern: "/app/my-payroll", title: "薪資報表" },
  // --- 商家設定 ---
  { pattern: "/app/settings", title: "商家設定" },
  // --- 人員與權限(模組 3)---
  { pattern: "/app/staff", title: "服務人員管理" },
  { pattern: "/app/agents", title: "客服管理" },
  // --- 服務項目(模組 4)---
  { pattern: "/app/service-items", title: "服務項目管理" },
  // --- 預約與訂單(模組 5/6)---
  { pattern: "/app/business-hours", title: "營業時間設定" },
  { pattern: "/app/material-costs", title: "料錢成本管理" },
  { pattern: "/app/payment-methods", title: "付款方式管理" },
  // --- 排班與休假(模組 7)---
  { pattern: "/app/leave-types", title: "假別設定" },
  { pattern: "/app/leave-records", title: "請假紀錄" },
  { pattern: "/app/scheduling", title: "排班一覽" },
  // --- 抽成與薪資(模組 8)---
  { pattern: "/app/payroll-settings", title: "抽成與薪資設定" },
  { pattern: "/app/staff-report", title: "師傅報表" },
  // --- 會員(模組 9/10)---
  { pattern: "/app/members", title: "會員管理" },
  { pattern: "/app/member-points", title: "紅利點數管理" },
  { pattern: "/app/member-settings", title: "會員系統設定" },
  // --- LINE 通知(模組 11)---
  { pattern: "/app/line-settings", title: "LINE 串接設定" },
  { pattern: "/app/line-events", title: "LINE 通知設定" },
  { pattern: "/app/line-logs", title: "LINE 發送記錄" },
  { pattern: "/app/line-marketing", title: "行銷通知" },
  // --- 推播通知(模組 15)---
  { pattern: "/app/push-events", title: "推播通知設定" },
  // --- 資料工具(模組 12/13)---
  // ⚠️ /app/data-import/history 是 3 段、/app/data-import 是 2 段,段數不同不會互相吃掉,
  //    但還是把比較長的那條寫在前面,維持「越具體越前面」的閱讀習慣。
  { pattern: "/app/data-import/history", title: "匯入紀錄" },
  { pattern: "/app/data-import", title: "資料匯入" },
  { pattern: "/app/reports", title: "報表匯出中心" },
  { pattern: "/app/industry-transfer", title: "產業轉移" },
  // --- 帶參數的路徑(固定字串的規則全部放完之後才輪到這些)---
  // 頁面內文是「{姓名} 的權限設定」(StaffPermissionsPage.tsx / AgentPermissionsPage.tsx),
  // 頁首拿不到姓名,所以用那兩頁自己在「資料還沒載入」時顯示的 fallback 文字「權限設定」。
  { pattern: "/app/staff/:staffId/permissions", title: "權限設定" },
  { pattern: "/app/agents/:agentId/permissions", title: "權限設定" },
  // 頁面內文是會員本人的姓名(MemberDetailPage.tsx),同理頁首改用通用名稱。
  { pattern: "/app/members/:id", title: "會員資料" },
];

/** 測試用:讓測試能逐條檢查這份清單有沒有跟 App.tsx 對齊,不用把 34 條路徑在測試裡再抄一遍。 */
export const APP_HEADER_TITLE_PATTERNS: readonly string[] = APP_HEADER_TITLE_RULES.map(
  (rule) => rule.pattern,
);

/** `/app` 在「商家端」時的標題。
 *
 * ⚠️ 商家端的 /app 實務上不會停留 —— HomePage.tsx 解出「不是服務人員檢視」之後就 <Navigate> 到
 * /app/manage(見 resolveHomePageOutcome)。但那一瞬間頁首還是會渲染一次,所以這裡**不能**回傳
 * undefined 或空字串:回 undefined 會讓 React 在畫面上印出字面的 "undefined",回空字串會讓標題
 * 那格閃一下空白。回傳「功能」= 使用者下一秒真的會到的那一頁,所以那一瞬間看起來不是閃爍,
 * 而是「標題先到、內容隨後」。 */
const MERCHANT_ROOT_TITLE = "功能";

/** `/app` 在「服務人員端」時的標題。對應 STAFF_PROFILE_TAB 的 label,兩邊要一致。 */
const STAFF_ROOT_TITLE = "個人資料";

/** 找不到對應規則時的標題。
 *
 * 刻意回空字串而不是「秒約」之類的通用字:一個認不出來的路徑代表「這份清單漏了」或「使用者走到
 * 一條已經不存在的舊連結」,這兩種情況下硬塞一個名字只會讓人更困惑;空字串會讓頁首中間那格單純
 * 留白(LOGO 跟登出按鈕照樣在),視覺上不會壞掉。
 * **絕對不能回 undefined** —— JSX 裡 `{undefined}` 什麼都不印沒問題,但只要中間有任何一次字串
 * 串接(例如之後有人寫 `${title} - 秒約`)就會在畫面上出現 "undefined"。 */
const UNKNOWN_ROUTE_TITLE = "";

/** 把 pathname 切成不含空字串的路徑段。順手處理結尾多一個斜線的情況
 * (`/app/orders/` 跟 `/app/orders` 要當成同一頁)。 */
function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/** 一條 pattern 吃不吃這個 pathname。段數必須一樣,每一段要嘛字面相同、要嘛 pattern 那段是 `:param`。 */
function matchesPattern(pattern: string, segments: string[]): boolean {
  const patternSegments = pathSegments(pattern);
  if (patternSegments.length !== segments.length) return false;
  return patternSegments.every(
    (patternSegment, index) => patternSegment.startsWith(":") || patternSegment === segments[index],
  );
}

export interface AppHeaderTitleInput {
  /** react-router 的 location.pathname(不含 query/hash)。 */
  pathname: string;
  /** 目前實際顯示的是服務人員端還是商家端內容(見 resolveIsStaffView)。
   * 只有 `/app` 這一條路徑的標題會因為它而不同。 */
  isStaffView: boolean;
}

/** 頁首中間那格要顯示的功能頁名稱。永遠回傳字串,認不出來的路徑回空字串(不會是 undefined)。 */
export function resolveAppHeaderTitle({ pathname, isStaffView }: AppHeaderTitleInput): string {
  const segments = pathSegments(pathname);

  // /app 是唯一一條「同一個路徑、兩種角色看到不同頁面」的路由(HomePage.tsx:服務人員端顯示
  // 自己的個人資料,商家端直接導去 /app/manage),所以特別處理,不放進上面那份清單。
  if (segments.length === 1 && segments[0] === "app") {
    return isStaffView ? STAFF_ROOT_TITLE : MERCHANT_ROOT_TITLE;
  }

  const rule = APP_HEADER_TITLE_RULES.find((candidate) =>
    matchesPattern(candidate.pattern, segments),
  );
  return rule?.title ?? UNKNOWN_ROUTE_TITLE;
}

// =========================================================================
// 雙重身分檢視選擇的記憶(localStorage)
// =========================================================================

/** 只需要 getItem/setItem/removeItem 這三個方法,方便測試直接餵一個假的物件進來,
 * 不用真的依賴 jsdom 的 window.localStorage。 */
export type SimpleStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STAFF_VIEW_PREFERENCE_KEY_PREFIX = "miaoyue.staffView";

/** 依「使用者 + 商家」分開存,比照 merchant/context.tsx 對「目前選定商家」的既有做法:
 *   ・同一台裝置換帳號登入,不會讀到上一個人的選擇。
 *   ・同一個人在 A 店選了服務人員端,不會把這個選擇誤套到 B 店(B 店不一定有他的服務人員身分)。
 * 任何一個 id 還沒解出來就回傳 null,代表「現在還不知道該讀/寫哪一把 key」。 */
export function staffViewPreferenceKey(
  userId: string | null | undefined,
  merchantId: string | null | undefined,
): string | null {
  if (!userId || !merchantId) return null;
  return `${STAFF_VIEW_PREFERENCE_KEY_PREFIX}.${userId}.${merchantId}`;
}

/** 讀回上次的選擇。讀不到/存的值不是 "1" 就一律當成 false(預設看商家端)。
 * localStorage 在部分瀏覽器設定(無痕、封鎖網站資料)下光是讀取就會丟例外,所以整段包 try/catch。 */
export function readStoredStaffViewPreference(
  storage: SimpleStorage | null | undefined,
  userId: string | null | undefined,
  merchantId: string | null | undefined,
): boolean {
  const key = staffViewPreferenceKey(userId, merchantId);
  if (!key || !storage) return false;
  try {
    return storage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeStoredStaffViewPreference(
  storage: SimpleStorage | null | undefined,
  userId: string | null | undefined,
  merchantId: string | null | undefined,
  value: boolean,
): void {
  const key = staffViewPreferenceKey(userId, merchantId);
  if (!key || !storage) return;
  try {
    if (value) storage.setItem(key, "1");
    else storage.removeItem(key);
  } catch {
    // 寫不進去(無痕模式/配額滿)只影響「下次進來要重新按一次切換」,不該讓畫面爆掉。
  }
}
