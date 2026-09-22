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

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import type { IndustryType } from "@/modules/merchant/types";
import { useMerchantStaffList } from "@/modules/staff-agent/context";

import { BookingDetailDialog } from "./BookingDetailDialog";
import { BookingFormDialog } from "./CalendarPage";
import {
  updateMerchantBookingStatusColors,
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
  sumBookingRevenue,
  tabToStatusFilter,
  type OrderDateFieldMode,
  type OrderStatusTab,
} from "./ordersPageLogic";
import { RequireBookingAccess } from "./RequireBookingAccess";
import {
  BOOKING_STATUS_LABELS,
  bookingCardAccentBorderStyle,
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
  });

  const bookings = useMemo(() => bookingsData ?? [], [bookingsData]);

  // §7.5:卡片延伸資訊(服務項目名稱清單、建單客服姓名),批次查詢,不對每一筆訂單各自查一次。
  const { data: cardExtras } = useBookingCardExtras(merchantId, bookings);

  // 建單與訂單管理介面優化 §10.5(SPECS-INDEX #621):訂單卡片色條改讀商家自訂顏色表,查無資料/
  // 載入中時 fallback 成 DEFAULT_BOOKING_STATUS_COLORS(等同改版前寫死的顏色)。
  const { data: statusColors } = useMerchantBookingStatusColors(merchantId);
  const effectiveStatusColors = statusColors ?? DEFAULT_BOOKING_STATUS_COLORS;

  // §7.4:統計列——N 筆訂單就是目前篩選結果的陣列長度(取消的訂單如果符合目前篩選一樣算進來);
  // 業績加總排除已取消訂單。這次不做真正的分頁機制,「本頁業績」跟「總業績」永遠是同一個值。
  const totalCount = bookings.length;
  const revenueTotal = useMemo(() => sumBookingRevenue(bookings), [bookings]);

  // §7.5:依 §7.3 選定的日期欄位分組,日期新到舊排序。
  const dateGroups = useMemo(
    () => groupBookingsByDateField(bookings, filters.dateFieldMode),
    [bookings, filters.dateFieldMode],
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

      {/* §7.4:統計列。金額加總不含已取消訂單,這次不做真正分頁,本頁業績/總業績永遠同一個值。 */}
      <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground">
        <span>共 {totalCount} 筆訂單</span>
        <span>
          本頁業績 {formatAmount(revenueTotal)} /(總業績 {formatAmount(revenueTotal)})
        </span>
        {/* 用半形斜線+括號,視覺上跟規格書的全形斜線/括號效果一致,避免全形符號跟金額數字
            混排時視覺上不對齊(既有慣例:formatAmount 產出的金額本身是半形字元)。 */}
      </p>

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

      {/* 建單與訂單管理介面優化 §十 10.6(SPECS-INDEX #620/#621):訂單狀態顏色設定畫面。
          掛載在這個頁面(而不是另開路由/掛到 BusinessHoursPage.tsx)是刻意的:權限判斷
          (§10.3)跟這個頁面本身的 RequireBookingAccess 守衛剛好是同一支
          private.can_manage_bookings/orders section_key,不需要另外判斷可否操作——能看到
          這個頁面的人,就是能操作這個設定的人。 */}
      <BookingStatusColorsCard merchantId={merchantId} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// 建單與訂單管理介面優化 §十 10.6(SPECS-INDEX #620/#621):訂單狀態顏色設定畫面。
// 4 個狀態各自一個 <input type="color">(原生色彩選擇器,不需要額外安裝套件)+ 色碼文字輸入框
// + 即時預覽色塊,依 §10.3 權限判斷是否可操作(這個元件只在 RequireBookingAccess 通過後才會
// 渲染,不需要再重複判斷一次 useAgentPermission)。
// ---------------------------------------------------------------------------
const STATUS_COLOR_FIELDS: { key: keyof BookingStatusColorMap; label: string }[] = [
  { key: "pendingConfirmation", label: "待確認" },
  { key: "accepted", label: "已確認" },
  { key: "completed", label: "已完成" },
  { key: "cancelled", label: "已取消" },
];

function BookingStatusColorsCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const { data: colors, isLoading } = useMerchantBookingStatusColors(merchantId);
  const [form, setForm] = useState<BookingStatusColorMap>(DEFAULT_BOOKING_STATUS_COLORS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (colors) setForm(colors);
  }, [colors]);

  async function handleSave() {
    setSaving(true);
    try {
      await updateMerchantBookingStatusColors(merchantId, form);
      await queryClient.invalidateQueries({
        queryKey: ["booking-module", "merchant-booking-status-colors", merchantId],
      });
      toast.success("已更新訂單狀態顏色設定");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>訂單狀態顏色設定</CardTitle>
        <CardDescription>
          自訂 4 種訂單狀態在行事曆、訂單管理頁顯示的代表色。這次不強制檢查顏色搭配文字是否夠清楚,
          請自行參考右側的即時預覽色塊判斷。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : (
          <>
            {STATUS_COLOR_FIELDS.map(({ key, label }) => (
              <div
                key={key}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <span className="w-16 shrink-0 text-sm font-medium text-foreground">{label}</span>
                <input
                  type="color"
                  className="h-8 w-10 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
                  value={/^#[0-9a-fA-F]{6}$/.test(form[key]) ? form[key] : "#000000"}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                />
                <Input
                  className="w-32"
                  value={form[key]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                />
                {/* 即時預覽色塊,對應規格書 §10.5 第 4 點的「顏色選擇器旁邊即時顯示一個小色塊
                    預覽」邊界情況建議。 */}
                <span
                  className="ml-auto rounded-md border border-border px-3 py-1 text-xs font-medium"
                  style={{ backgroundColor: form[key], color: "#ffffff" }}
                >
                  預覽文字
                </span>
              </div>
            ))}
            <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
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
        className="min-w-0 rounded-md border-y border-r border-border border-l-4 bg-background p-3 shadow-sm transition-colors hover:border-brand/40"
        style={bookingCardAccentBorderStyle(statusColors, status)}
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

export default function OrdersPage() {
  return (
    <RequireBookingAccess>
      <OrdersPageInner />
    </RequireBookingAccess>
  );
}
