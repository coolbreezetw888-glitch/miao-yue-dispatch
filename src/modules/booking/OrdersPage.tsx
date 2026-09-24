// 模組 6(訂單管理)§1:訂單管理頁——獨立於行事曆(CalendarPage.tsx)的列表視圖,讓客服/管理員
// 用篩選條件瀏覽訂單,不是取代行事曆,是行事曆之外的第二種檢視方式(規格書名詞對照)。
//
// 建單與訂單管理介面優化 §7:整頁重新設計,拿掉原本的統計卡片+核取方塊篩選+表格,改成
// 分頁籤(全部/待確認/已確認/已完成/已取消)+ 關鍵字搜尋框 + 篩選列(依建單時間/依預約時間切換
// + 日期區間 + 全部服務人員下拉)+ 統計列(共 N 筆訂單/本頁業績/總業績)+ 依日期分組的訂單卡片
// 列表(取代表格)。分頁籤篩選邏輯/關鍵字比對範圍/日期分組/業績加總這幾條純邏輯抽在
// ordersPageLogic.ts,方便寫 Vitest,不用整個渲染這個頁面元件。
//
// 沿用既有的 useMerchantBookings 對外介面查詢(模組 5 對外介面 5.4),只是擴充篩選參數
// (dateField/keyword,見 api.ts fetchMerchantBookings),不新增查詢邏輯的資料表/RLS/RPC。
// 點擊任一張卡片開啟既有的預約詳情彈窗(BookingDetailDialog,沿用模組 5 擴充既有元件,不重做),
// 需要編輯時複用 CalendarPage.tsx 已經 export 出來的 BookingFormDialog,不重做一份幾乎一樣的表單。
//
// 商家端調整批次(2026-09-22,.project/SPECS-INDEX.md #610,.project/specs/後台導覽外殼.md
// 該批次章節):這個頁面從「掛在 /app/manage 底下的一張卡片連結」改成 AppLayout 底部「訂單管理」
// 分頁籤直接可達,頁面內容/RLS/RPC 完全不變。原本用來擋未授權瀏覽的 RequireBookingAccess.tsx
// (「不符合就導回 /app」)不再適用——分頁籤規格明講「永遠顯示,沒有 orders 權限的客服點進來要
// 看到空狀態/無權限提示文字,不是導回其他頁面或報錯」,所以這裡改成下面的 OrdersTabAccessGate,
// 判斷邏輯(admin 一律放行、agent 要有 orders 權限)跟 RequireBookingAccess.tsx 完全一致,只是
// 「不放行」時改成原地渲染提示文字,不 navigate() 離開。刻意不改 RequireBookingAccess.tsx
// 本身——那支同時也是 CalendarPage.tsx(行事曆分頁籤)在用的守衛,行事曆這次沒有被要求改變行為,
// 保持模組獨立、改動範圍不外溢。
//
// 建單與訂單管理介面優化 §十(SPECS-INDEX #633):訂單狀態顏色「設定」UI(4 個色彩選擇器 +
// 儲存按鈕)原本掛在這個頁面(#620/#621),已搬到 MerchantSettingsPage.tsx(/app/settings,
// 商家層級設定的既有頁面)——顏色屬於商家設定而非日常訂單操作。這裡只留下「讀」的那一半:
// useMerchantBookingStatusColors 查詢 + effectiveStatusColors fallback,供下面 OrderCard
// 左側色條顯示用,資料表/RLS/RPC 完全不動,寫入邏輯(updateMerchantBookingStatusColors)一併
// 搬去 MerchantSettingsPage.tsx,不在這個檔案裡重複一份。

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { getVerifiedUser } from "@/lib/auth-guard";
import { cn } from "@/lib/utils";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { INDUSTRY_REQUIRES_CUSTOMER_ADDRESS, type IndustryType } from "@/modules/merchant/types";
import {
  useAgentPermission,
  useCurrentMerchantRole,
  useMerchantStaffList,
} from "@/modules/staff-agent/context";

import { BookingDetailDialog } from "./BookingDetailDialog";
import { BookingFormDialog } from "./CalendarPage";
import {
  useBookingCardExtras,
  useMerchantBookings,
  useMerchantBookingStatusColors,
} from "./context";
import { addDays, buildTaipeiIso, isoToTaipeiDateTimeWithSeconds, toDateKey } from "./dateUtils";
import { formatAmount } from "./orderAmount";
import {
  adjustPageForPageSizeChange,
  DEFAULT_ORDERS_PAGE_SIZE,
  formatCardDateTime,
  formatGroupDateHeading,
  groupBookingsByDateField,
  isOrdersPageSize,
  ORDER_STATUS_TABS,
  ORDERS_PAGE_SIZE_OPTIONS,
  readStoredOrdersPageSize,
  sliceBookingsForPage,
  sumBookingRevenue,
  tabToStatusFilter,
  writeStoredOrdersPageSize,
  type OrderDateFieldMode,
  type OrdersPageSize,
  type OrderStatusTab,
} from "./ordersPageLogic";
import {
  BOOKING_STATUS_LABELS,
  bookingCardAccentBorderStyle,
  bookingCardHoverBorderColor,
  DEFAULT_BOOKING_STATUS_COLORS,
  type Booking,
  type BookingStatus,
  type BookingStatusColorMap,
} from "./types";

function bookingStatusBadgeVariant(status: BookingStatus): "default" | "secondary" | "outline" {
  if (status === "completed") return "secondary";
  if (status === "cancelled") return "outline";
  return "default";
}

interface OrderFilters {
  keyword: string;
  dateFieldMode: OrderDateFieldMode;
  dateFrom: string; // dateKey,空字串代表不限
  dateTo: string; // dateKey,空字串代表不限
  staffId: string; // 空字串代表不限
}

// §7.3:預設「依預約時間」,沿用改版前既有行為(舊版日期區間篩選本來就是套用在 start_at 上),
// 減少既有使用者對預設篩選結果的意外變動。
const EMPTY_FILTERS: OrderFilters = {
  keyword: "",
  dateFieldMode: "start_at",
  dateFrom: "",
  dateTo: "",
  staffId: "",
};

function OrdersPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();
  const { data: staffList } = useMerchantStaffList(merchantId);

  const staffNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of staffList ?? []) map.set(s.id, s.name);
    return map;
  }, [staffList]);

  // §7.1:狀態分頁籤,獨立於下面篩選列的狀態(切換分頁籤不影響關鍵字/日期/服務人員篩選)。
  const [activeTab, setActiveTab] = useState<OrderStatusTab>("all");
  const [filters, setFilters] = useState<OrderFilters>(EMPTY_FILTERS);
  const [detailBookingId, setDetailBookingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingBookingId, setEditingBookingId] = useState<string | null>(null);

  // 目前登入的使用者 id,只用來當「每頁筆數」偏好設定的 localStorage key 的一部分(見下方)。
  // 沿用既有慣例:元件裡要知道自己是誰時,用 useEffect + getVerifiedUser() 取(比照
  // line-notifications/MyLineBindingCard.tsx 的既有寫法),不自己呼叫 supabase.auth.getUser()/
  // getSession()(理由見 src/lib/auth-guard.ts)。
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getVerifiedUser().then((user) => {
      if (!cancelled) setUserId(user?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 分頁狀態(2026-09-24 使用者裁決:渲染上限改成真正的分頁,見 ordersPageLogic.ts 的說明)。
  //
  // 每頁筆數依**帳號**記憶(2026-09-24 使用者裁決,見 ordersPageLogic.ts 的說明):A 帳號選 100
  // 不該讓同一台電腦上的 B 帳號從自己原本的 500 跳成 100。因為使用者身份是非同步取得的,
  // 第一次 render 時還不知道是誰,所以初始值一律是 DEFAULT_ORDERS_PAGE_SIZE(50,「所有人一開始
  // 的預設值」),等身份確定之後再讀那個帳號自己的設定套上去。
  const [pageSize, setPageSize] = useState<OrdersPageSize>(DEFAULT_ORDERS_PAGE_SIZE);
  useEffect(() => {
    // 依賴只有 userId:身份確定(或換成了另一個帳號)時才重讀一次,使用者在頁面上自己調整過的
    // 選擇不會被這個 effect 蓋掉。userId 還是 null 時讀回來就是預設值 50,等同不動。
    setPageSize(readStoredOrdersPageSize(userId));
  }, [userId]);
  const [page, setPage] = useState(1);
  // 換頁後把畫面捲回列表頂端——不然使用者按了底部的「下一頁」,畫面還停在原本的捲動位置,
  // 看起來像「按了沒反應」(實際上清單已經換成另一批訂單了)。
  const listTopRef = useRef<HTMLDivElement>(null);

  const statusFilter = tabToStatusFilter(activeTab);

  // 篩選條件(分頁籤/關鍵字/日期/服務人員)一改,筆數與頁數就整批換掉,一律回到第 1 頁,
  // 否則使用者會停在一個空白的第 5 頁。刻意做成「改篩選的同一個動作順手 setPage(1)」而不是用
  // useEffect 監看 filters——useEffect 會多一次渲染(先畫出停在舊頁碼的畫面再修正),也比較難
  // 看出「改這個欄位會連帶重設頁碼」這件事。
  function updateFilters(updater: (prev: OrderFilters) => OrderFilters) {
    setFilters(updater);
    setPage(1);
  }

  function changeTab(tab: OrderStatusTab) {
    setActiveTab(tab);
    setPage(1);
  }

  const { data: bookingsData, isLoading } = useMerchantBookings(merchantId, {
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(filters.staffId ? { staffId: filters.staffId } : {}),
    dateField: filters.dateFieldMode,
    ...(filters.dateFrom ? { startAt: buildTaipeiIso(filters.dateFrom, "00:00") } : {}),
    ...(filters.dateTo
      ? {
          endAt: buildTaipeiIso(
            toDateKey(addDays(new Date(`${filters.dateTo}T00:00:00`), 1)),
            "00:00",
          ),
        }
      : {}),
    ...(filters.keyword.trim() ? { keyword: filters.keyword.trim() } : {}),
    // 2026-09-24 深夜巡檢問題 1:這支查詢原本沒帶 unpaged,PostgREST 的 db.max_rows 上限
    // (這個專案設定 1000,見 supabase/config.toml)會讓一間累積超過 1000 筆訂單的商家,在
    // 「全部」分頁籤、不設日期區間時只拿到**最舊的 1000 筆**(查詢是 order by start_at
    // ascending),造成四個連鎖錯誤:①較新的訂單整個看不到(使用者以為訂單不見了)②統計列
    // 「共 N 筆訂單」固定卡在 1000 ③「總業績」只加總這 1000 筆,金額明顯少報 ④關鍵字搜尋是
    // 前端對撈回來的資料比對(api.ts fetchMerchantBookings),搜尋較新的客戶姓名/單號會搜不到。
    // 這裡改成帶 unpaged:true,直接複用 api.ts 既有的 .range() 分頁迴圈(原本只有模組 12 的
    // 報表匯出在用),把符合篩選條件的訂單全部撈完。
    //
    // 效能考量已經評估過:撈取不設上限、但**渲染**一次只畫一頁(見下方 pageSlice),所以
    // 「資料量大」影響的只有一次查詢的往返次數跟記憶體(每筆訂單是一列純欄位資料,幾千筆等級
    // 對瀏覽器沒有壓力),不會變成「一次畫出上萬張卡片」把瀏覽器卡死。
    unpaged: true,
  });

  const bookings = useMemo(() => bookingsData ?? [], [bookingsData]);

  // 撈全部(統計/搜尋才正確),但只渲染目前這一頁(畫面才不會爆,而且後面的訂單翻頁就看得到,
  // 不是被硬性截斷)。pageSlice.page 是「夾回合法範圍之後」的頁碼,下面的翻頁按鈕一律用它加減,
  // 所以就算資料變少(例如改了篩選、或別人取消了訂單)也不會停在超出範圍的空白頁。
  const pageSlice = useMemo(
    () => sliceBookingsForPage(bookings, filters.dateFieldMode, page, pageSize),
    [bookings, filters.dateFieldMode, page, pageSize],
  );
  const visibleBookings = pageSlice.bookings;

  // §7.5:卡片延伸資訊(服務項目名稱清單、建單客服姓名),批次查詢,不對每一筆訂單各自查一次。
  // 只對「真的會被渲染出來的那些訂單」查延伸資訊——沒被渲染的卡片不需要服務項目名稱,順便避免
  // 把上萬個 booking id 丟進 useBookingCardExtras 的 queryKey(那支會把 id 排序後串成字串)。
  const { data: cardExtras } = useBookingCardExtras(merchantId, visibleBookings);

  // 建單與訂單管理介面優化 §10.5(SPECS-INDEX #621):訂單卡片色條改讀商家自訂顏色表,查無資料/
  // 載入中時 fallback 成 DEFAULT_BOOKING_STATUS_COLORS(等同改版前寫死的顏色)。
  const { data: statusColors } = useMerchantBookingStatusColors(merchantId);
  const effectiveStatusColors = statusColors ?? DEFAULT_BOOKING_STATUS_COLORS;

  // §7.4:統計列——N 筆訂單就是目前篩選結果的陣列長度(取消的訂單如果符合目前篩選一樣算進來);
  // 業績加總排除已取消訂單。
  //
  // 「總業績」跟「本頁業績」是兩個不同意義的數字,畫面上必須看得出差別:
  //   總業績 = 符合篩選條件的**全部**訂單加總(全量統計,不受分頁影響,金額不能少報);
  //   本頁業績 = 目前這一頁實際畫出來的那些訂單加總(所以下面顯示時一定要附上「這一頁是第幾筆到
  //             第幾筆」,使用者才不會把它誤讀成全部)。
  // 只有一頁時兩者當然一樣。
  const totalCount = pageSlice.totalCount;
  const revenueTotal = useMemo(() => sumBookingRevenue(bookings), [bookings]);
  const visibleRevenue = useMemo(() => sumBookingRevenue(visibleBookings), [visibleBookings]);

  // 任務 2(2026-09-24 使用者裁決):商家切成「到店服務」之後,既有訂單的客戶地址要隱藏。
  // 判斷用商家**目前**的產業設定(industry_type 現在可以隨時切換,見 merchant/api.ts
  // 2026-09-23 的說明),不是只看「這筆訂單有沒有地址值」。
  // 資料庫裡的地址值刻意不動(使用者只說「隱藏」):所以商家如果再切回「到府派工」,舊訂單的
  // 地址會重新顯示出來——這是預期中的正確行為,不是漏改。
  const showCustomerAddress =
    INDUSTRY_REQUIRES_CUSTOMER_ADDRESS[merchant!.industry_type as IndustryType] === true;

  // §7.5:依 §7.3 選定的日期欄位分組,日期新到舊排序。
  const dateGroups = useMemo(
    () => groupBookingsByDateField(visibleBookings, filters.dateFieldMode),
    [visibleBookings, filters.dateFieldMode],
  );

  function refetchAll() {
    void queryClient.invalidateQueries({ queryKey: ["booking-module"] });
  }

  function goToPage(nextPage: number) {
    setPage(nextPage);
    // 捲回列表頂端。optional call:jsdom(Vitest)沒有實作 scrollIntoView,直接呼叫會丟錯。
    listTopRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  function changePageSize(nextPageSize: OrdersPageSize) {
    // 每頁筆數改變時,讓「目前這一頁的第一筆」在新的每頁筆數下仍然落在畫面上(見
    // adjustPageForPageSizeChange 的說明),不要把使用者彈回第 1 頁或彈到不相干的位置。
    setPage((prev) => adjustPageForPageSizeChange(prev, pageSize, nextPageSize));
    setPageSize(nextPageSize);
    // 依帳號存。身份還沒確認完(userId 還是 null)時這支會直接跳過不寫,只是這次選擇不會被記住,
    // 畫面行為完全不受影響。
    writeStoredOrdersPageSize(userId, nextPageSize);
  }

  function openEditForm(bookingId: string) {
    setDetailBookingId(null);
    setEditingBookingId(bookingId);
    setFormOpen(true);
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-5 py-10">
      {/* 建單與訂單管理介面優化 §九 9.1(SPECS-INDEX #599):固定導回 /app/manage(「功能」分頁籤
          主頁),不是瀏覽器上一頁(navigate(-1))——服務「從別處深層連結進到這裡」的情境,行為
          比照資料匯入(#600)、既有的 BusinessHoursPage.tsx/PaymentMethodsPage.tsx 同一顆按鈕。 */}
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">訂單管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">「{merchant!.name}」的訂單列表與篩選</p>
      </div>

      {/* §7.1:狀態分頁籤。h-auto + flex-wrap:手機寬度(375px)放不下五個分頁籤時自動換行,
          不用水平捲動,避免捲動容器超出畫面寬度。 */}
      <Tabs value={activeTab} onValueChange={(v) => changeTab(v as OrderStatusTab)}>
        <TabsList className="h-auto w-full flex-wrap justify-start gap-1 bg-muted p-1">
          {ORDER_STATUS_TABS.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* §7.2:關鍵字搜尋框,比對範圍見 ordersPageLogic.ts bookingMatchesKeyword。 */}
      <Input
        placeholder="搜尋姓名/手機/地址/單號/建單內容..."
        value={filters.keyword}
        onChange={(e) => updateFilters((prev) => ({ ...prev, keyword: e.target.value }))}
      />

      {/* §7.3:篩選列——依建單時間/依預約時間切換 + 日期區間 + 全部服務人員下拉。 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <Label>日期篩選依據</Label>
          <div className="mt-2 flex rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => updateFilters((prev) => ({ ...prev, dateFieldMode: "created_at" }))}
              className={cn(
                "flex-1 rounded px-2 py-1.5 text-sm transition-colors",
                filters.dateFieldMode === "created_at"
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              依建單時間
            </button>
            <button
              type="button"
              onClick={() => updateFilters((prev) => ({ ...prev, dateFieldMode: "start_at" }))}
              className={cn(
                "flex-1 rounded px-2 py-1.5 text-sm transition-colors",
                filters.dateFieldMode === "start_at"
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              依預約時間
            </button>
          </div>
        </div>
        <div>
          <Label>日期範圍</Label>
          <div className="mt-2 space-y-2">
            <input
              type="date"
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              value={filters.dateFrom}
              onChange={(e) => updateFilters((prev) => ({ ...prev, dateFrom: e.target.value }))}
            />
            <input
              type="date"
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              value={filters.dateTo}
              onChange={(e) => updateFilters((prev) => ({ ...prev, dateTo: e.target.value }))}
            />
          </div>
        </div>
        <div className="sm:col-span-2 lg:col-span-2">
          <Label>服務人員</Label>
          <Select
            value={filters.staffId || "__all__"}
            onValueChange={(v) =>
              updateFilters((prev) => ({ ...prev, staffId: v === "__all__" ? "" : v }))
            }
          >
            <SelectTrigger className="mt-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部服務人員</SelectItem>
              {(staffList ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* §7.4:統計列。金額加總不含已取消訂單。
          「總業績」一律是「符合篩選條件的全部訂單」的加總,完全不受分頁影響(這是 2026-09-24
          深夜巡檢問題 1 修好的重點,金額不能少報);「本頁業績」只算目前這一頁畫出來的那些訂單,
          所以刻意把「第幾筆到第幾筆」寫在同一行,避免使用者把它誤讀成全部訂單的業績。
          用半形斜線+括號,避免全形符號跟金額數字(formatAmount 產出的是半形字元)混排時不對齊。 */}
      <div className="space-y-0.5 text-sm text-muted-foreground">
        <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span>共 {totalCount} 筆訂單</span>
          <span>
            總業績 {formatAmount(revenueTotal)}(全部 {totalCount} 筆合計)
          </span>
        </p>
        {totalCount > 0 ? (
          <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span>
              本頁業績 {formatAmount(visibleRevenue)}(僅本頁第 {pageSlice.rangeStart}–
              {pageSlice.rangeEnd} 筆)
            </span>
            <span>
              第 {pageSlice.page} / {pageSlice.totalPages} 頁
            </span>
          </p>
        ) : null}
      </div>

      {/* 分頁控制項(上)。刻意放在一般文件流裡,不用 position: fixed —— 底部已經有分頁籤列跟
          動作列在搶那塊空間,見 src/lib/bottomFixedLayers.ts 記錄的實際事故(兩個各自寫死
          bottom-16 的元件互相蓋住),這裡不再往那堆裡加第三個。清單前後各放一組,使用者在頂端
          或看完整頁到底部都能直接翻頁,不必先捲動一長串卡片。 */}
      <div ref={listTopRef} className="scroll-mt-4">
        {totalCount > 0 ? (
          <OrdersPager
            page={pageSlice.page}
            totalPages={pageSlice.totalPages}
            pageSize={pageSize}
            onPageChange={goToPage}
            onPageSizeChange={changePageSize}
          />
        ) : null}
      </div>

      {/* §7.5:依日期分組的訂單卡片列表。 */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      ) : dateGroups.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          目前沒有符合篩選條件的訂單。
        </p>
      ) : (
        <div className="space-y-6">
          {dateGroups.map((group) => (
            <div key={group.dateKey} className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">
                {formatGroupDateHeading(group.dateKey)}
              </h2>
              <div className="space-y-2">
                {group.bookings.map((b) => (
                  <OrderCard
                    key={b.id}
                    booking={b}
                    merchantName={merchant!.name}
                    staffName={staffNameById.get(b.staff_id) ?? "(未知人員)"}
                    serviceItemNames={cardExtras?.get(b.id)?.serviceItemNames ?? []}
                    createdByName={cardExtras?.get(b.id)?.createdByName}
                    statusColors={effectiveStatusColors}
                    showCustomerAddress={showCustomerAddress}
                    onClick={() => setDetailBookingId(b.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 分頁控制項(下):看完這一頁的卡片之後,不用捲回頁首就能翻下一頁。 */}
      {totalCount > 0 ? (
        <OrdersPager
          page={pageSlice.page}
          totalPages={pageSlice.totalPages}
          pageSize={pageSize}
          onPageChange={goToPage}
          onPageSizeChange={changePageSize}
        />
      ) : null}

      <BookingDetailDialog
        bookingId={detailBookingId}
        staffNameById={staffNameById}
        open={detailBookingId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailBookingId(null);
        }}
        onChanged={refetchAll}
        onEdit={openEditForm}
      />

      <BookingFormDialog
        merchantId={merchantId}
        industryType={merchant!.industry_type as IndustryType}
        open={formOpen}
        onOpenChange={setFormOpen}
        prefill={{}}
        editingBookingId={editingBookingId}
        onSaved={refetchAll}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// 分頁控制項(2026-09-24 使用者裁決)。一組「每頁筆數下拉 + 上一頁/第 N / M 頁/下一頁」。
//
// 為什麼不用 src/components/ui/pagination.tsx:那份 shadcn 元件是「頁碼連結」式的(內部是
// <a>,PaginationPrevious/Next 的文字寫死英文 Previous/Next,要改文案就得改那支共用元件),
// 而且逐頁列出頁碼在 375px 寬度下很容易溢出(訂單上萬筆時會有幾十頁)。這裡改用專案既有的
// Button + Select 組出「上一頁/下一頁 + 目前頁碼」的精簡版,不新增樣式語言,也不改動那支
// 共用元件(它還有別的頁面可能會用到)。
//
// 手機(375px)不溢出的做法:整組用 flex-wrap,放不下時自動換行,不用水平捲動(比照本頁狀態
// 分頁籤既有的 h-auto + flex-wrap 做法);每頁筆數下拉固定一個小寬度;數字文字加 whitespace-nowrap
// 避免在數字中間斷行。刻意不用 position: fixed 貼在底部,見上面呼叫處的說明。
// ---------------------------------------------------------------------------
function OrdersPager({
  page,
  totalPages,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  pageSize: OrdersPageSize;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: OrdersPageSize) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
        <span className="whitespace-nowrap">每頁</span>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => {
            const next = Number(v);
            // 下拉的選項就是 ORDERS_PAGE_SIZE_OPTIONS,理論上不可能出現別的值;這裡仍然守一層,
            // 型別上也才不用硬轉(Radix 的 onValueChange 回傳的是 string)。
            if (isOrdersPageSize(next)) onPageSizeChange(next);
          }}
        >
          <SelectTrigger className="h-9 w-[5rem]" aria-label="每頁顯示筆數">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ORDERS_PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="whitespace-nowrap">筆</span>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="mr-0.5 h-4 w-4" />
          上一頁
        </Button>
        <span className="whitespace-nowrap px-1 text-sm text-muted-foreground">
          {page} / {totalPages}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          下一頁
          <ChevronRight className="ml-0.5 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §7.5:訂單卡片。左側色條建單與訂單管理介面優化 §10.5(SPECS-INDEX #621)改讀商家自訂顏色表
// (bookingCardAccentBorderStyle,types.ts export),內容由上到下:①服務項目+狀態徽章
// ②預約時間+建單時間+建單客服 ③服務人員+客戶姓名/電話/地址 ④商家名稱 ⑤訂單金額。
// 用 className 的 border-y/border-r(灰階)+ border-l-4(寬度)+ inline style 的
// borderLeftColor(狀態動態色)分開設定,確保色條顏色不會被灰階邊框蓋掉(§10.5 第 3 點)。
// ---------------------------------------------------------------------------
function OrderCard({
  booking,
  merchantName,
  staffName,
  serviceItemNames,
  createdByName,
  statusColors,
  showCustomerAddress,
  onClick,
}: {
  booking: Booking;
  merchantName: string;
  staffName: string;
  serviceItemNames: string[];
  createdByName: string | undefined;
  statusColors: BookingStatusColorMap;
  /** 任務 2:商家目前的產業需要地址時才顯示客戶地址(見呼叫處 showCustomerAddress 的說明)。 */
  showCustomerAddress: boolean;
  onClick: () => void;
}) {
  const status = booking.status as BookingStatus;
  return (
    <button type="button" onClick={onClick} className="block w-full text-left">
      <div
        className="min-w-0 rounded-md border-y border-r border-border border-l-4 bg-background p-3 shadow-sm transition-colors hover:border-[color:var(--order-card-hover-border)]"
        style={
          {
            ...bookingCardAccentBorderStyle(statusColors, status),
            "--order-card-hover-border": bookingCardHoverBorderColor(statusColors, status),
          } as CSSProperties
        }
      >
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {serviceItemNames.length > 0 ? serviceItemNames.join("、") : "(無服務項目資料)"}
          </p>
          <Badge variant={bookingStatusBadgeVariant(status)} className="shrink-0">
            {BOOKING_STATUS_LABELS[status]}
          </Badge>
        </div>
        <p className="mt-1 min-w-0 break-words text-xs text-muted-foreground">
          預約 {formatCardDateTime(booking.start_at)}・建單{" "}
          {isoToTaipeiDateTimeWithSeconds(booking.created_at)}
          {createdByName ? `・${createdByName}` : ""}
        </p>
        <p className="mt-1 min-w-0 break-words text-xs text-foreground">
          {staffName} ・ {booking.customer_name} ・ {booking.customer_phone}
          {/* 任務 2:商家切成「到店服務」後,既有訂單的客戶地址要隱藏——所以判斷條件是
              「商家目前的產業需要地址」且「這筆訂單真的有地址值」,不是只看有沒有值。
              資料庫裡的地址值沒有被刪除,切回「到府派工」會重新顯示(預期行為)。 */}
          {showCustomerAddress && booking.customer_address ? ` ・ ${booking.customer_address}` : ""}
        </p>
        <p className="mt-1 min-w-0 break-words text-xs text-muted-foreground">{merchantName}</p>
        <p className="mt-2 text-right text-base font-bold text-cta">
          {formatAmount(booking.final_amount_snapshot)}
        </p>
      </div>
    </button>
  );
}

/** 見檔案開頭 2026-09-22 說明:判斷邏輯比照 RequireBookingAccess.tsx(admin 一律放行、agent
 * 要有 orders 權限),但「不放行」時原地顯示空狀態文字,不 navigate() 離開——因為這個頁面現在是
 * 底部分頁籤直接可達的目的地,分頁籤規格要求「永遠顯示,沒有權限就看到提示文字」。這個元件只是
 * 體驗層的顯示邏輯,不是安全邊界——真正擋住未授權操作的是 private.can_manage_bookings 這支函式
 * 落實的 RLS/SECURITY DEFINER 函式權限檢查,即使有人繞過前端直接呼叫 API 也會被資料庫擋下。 */
function OrdersTabAccessGate({ children }: { children: ReactNode }) {
  const { merchant, isLoading: merchantLoading } = useCurrentMerchant();
  const { data: role, isLoading: roleLoading } = useCurrentMerchantRole();
  const { data: canManageBookings, isLoading: permissionLoading } = useAgentPermission("orders");

  const isAdmin = role === "admin";
  const isAuthorizedAgent = role === "agent" && canManageBookings === true;
  const stillLoadingAgentPermission = role === "agent" && permissionLoading;
  const loading = merchantLoading || roleLoading || stillLoadingAgentPermission;
  const allowed = isAdmin || isAuthorizedAgent;

  if (loading || !merchant) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-12">
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          尚未開放此功能,請洽商家管理員開通「訂單管理」權限。
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

export default function OrdersPage() {
  return (
    <OrdersTabAccessGate>
      <OrdersPageInner />
    </OrdersTabAccessGate>
  );
}
