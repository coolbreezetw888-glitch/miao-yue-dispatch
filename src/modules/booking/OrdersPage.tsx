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

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
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

import { cn } from "@/lib/utils";
import { useCurrentMerchant } from "@/modules/merchant/context";
import type { IndustryType } from "@/modules/merchant/types";
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
  formatCardDateTime,
  formatGroupDateHeading,
  groupBookingsByDateField,
  ORDER_STATUS_TABS,
  ORDERS_RENDER_LIMIT,
  sumBookingRevenue,
  tabToStatusFilter,
  takeLatestBookings,
  type OrderDateFieldMode,
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

  const statusFilter = tabToStatusFilter(activeTab);

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
    // 效能考量已經評估過:撈取不設上限、但**渲染**另外設上限(ORDERS_RENDER_LIMIT,見下方
    // visibleBookings),所以「資料量大」影響的只有一次查詢的往返次數跟記憶體(每筆訂單是一列
    // 純欄位資料,幾千筆等級對瀏覽器沒有壓力),不會變成「一次畫出上萬張卡片」把瀏覽器卡死。
    unpaged: true,
  });

  const bookings = useMemo(() => bookingsData ?? [], [bookingsData]);

  // 問題 1:撈全部(統計/搜尋才正確),但只渲染最新的 ORDERS_RENDER_LIMIT 筆(畫面才不會爆)。
  const visibleBookings = useMemo(
    () => takeLatestBookings(bookings, filters.dateFieldMode, ORDERS_RENDER_LIMIT),
    [bookings, filters.dateFieldMode],
  );
  const isTruncated = visibleBookings.length < bookings.length;

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
  // 問題 1 修正後,「本頁業績」跟「總業績」不再永遠是同一個值:總業績 = 符合篩選條件的**全部**
  // 訂單加總(這正是這次要修的重點,金額不能少報),本頁業績 = 目前這一頁實際畫出來的那些訂單
  // 加總。沒有超過渲染上限時兩者一樣,跟改版前的畫面完全一致。
  const totalCount = bookings.length;
  const revenueTotal = useMemo(() => sumBookingRevenue(bookings), [bookings]);
  const visibleRevenue = useMemo(() => sumBookingRevenue(visibleBookings), [visibleBookings]);

  // §7.5:依 §7.3 選定的日期欄位分組,日期新到舊排序。
  const dateGroups = useMemo(
    () => groupBookingsByDateField(visibleBookings, filters.dateFieldMode),
    [visibleBookings, filters.dateFieldMode],
  );

  function refetchAll() {
    void queryClient.invalidateQueries({ queryKey: ["booking-module"] });
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
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as OrderStatusTab)}>
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
        onChange={(e) => setFilters((prev) => ({ ...prev, keyword: e.target.value }))}
      />

      {/* §7.3:篩選列——依建單時間/依預約時間切換 + 日期區間 + 全部服務人員下拉。 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <Label>日期篩選依據</Label>
          <div className="mt-2 flex rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => setFilters((prev) => ({ ...prev, dateFieldMode: "created_at" }))}
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
              onClick={() => setFilters((prev) => ({ ...prev, dateFieldMode: "start_at" }))}
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
              onChange={(e) => setFilters((prev) => ({ ...prev, dateFrom: e.target.value }))}
            />
            <input
              type="date"
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              value={filters.dateTo}
              onChange={(e) => setFilters((prev) => ({ ...prev, dateTo: e.target.value }))}
            />
          </div>
        </div>
        <div className="sm:col-span-2 lg:col-span-2">
          <Label>服務人員</Label>
          <Select
            value={filters.staffId || "__all__"}
            onValueChange={(v) =>
              setFilters((prev) => ({ ...prev, staffId: v === "__all__" ? "" : v }))
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

      {/* §7.4:統計列。金額加總不含已取消訂單;總業績一律是「符合篩選條件的全部訂單」的加總
          (不受下方渲染上限影響),本頁業績是目前實際畫出來的那些訂單的加總。 */}
      <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground">
        <span>共 {totalCount} 筆訂單</span>
        <span>
          本頁業績 {formatAmount(visibleRevenue)} /(總業績 {formatAmount(revenueTotal)})
        </span>
        {/* 用半形斜線+括號,視覺上跟規格書的全形斜線/括號效果一致,避免全形符號跟金額數字
            混排時視覺上不對齊(既有慣例:formatAmount 產出的金額本身是半形字元)。 */}
      </p>
      {/* 問題 1:超過渲染上限時明確說出來,不要讓使用者以為「後面的訂單不見了」。上面的筆數/
          總業績本來就已經是全部訂單的數字,這行只說明「畫面上這份清單」被截到哪裡。 */}
      {isTruncated ? (
        <p className="text-sm text-muted-foreground">
          清單只顯示最新的 {ORDERS_RENDER_LIMIT} 筆(上方筆數與總業績仍為全部
          {totalCount} 筆的統計),要看更早的訂單請縮小日期範圍或加上其他篩選條件。
        </p>
      ) : null}

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
                    onClick={() => setDetailBookingId(b.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

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
  onClick,
}: {
  booking: Booking;
  merchantName: string;
  staffName: string;
  serviceItemNames: string[];
  createdByName: string | undefined;
  statusColors: BookingStatusColorMap;
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
          {booking.customer_address ? ` ・ ${booking.customer_address}` : ""}
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
