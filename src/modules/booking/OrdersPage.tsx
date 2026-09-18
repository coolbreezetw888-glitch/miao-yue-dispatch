// 模組 6(訂單管理)§1:訂單管理頁——獨立於行事曆(CalendarPage.tsx)的列表視圖,讓客服/管理員
// 用篩選條件瀏覽訂單,不是取代行事曆,是行事曆之外的第二種檢視方式(規格書名詞對照)。
//
// 沿用既有的 useMerchantBookings 對外介面查詢(模組 5 對外介面 5.4),不新增查詢邏輯,只是換一種
// 呈現方式跟預設篩選條件,並擴充回傳欄位納入 final_amount_snapshot(欄位本身已經在
// bookings 資料表上,useMerchantBookings 回傳整列,不需要額外處理)。
// 點擊任一列開啟既有的預約詳情彈窗(BookingDetailDialog,沿用模組 5 擴充既有元件,不重做),
// 需要編輯時複用 CalendarPage.tsx 已經 export 出來的 BookingFormDialog,不重做一份幾乎一樣的表單。

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { cn } from "@/lib/utils";
import { useCurrentMerchant } from "@/modules/merchant/context";
import type { IndustryType } from "@/modules/merchant/types";
import { useMerchantStaffList } from "@/modules/staff-agent/context";

import { BookingDetailDialog } from "./BookingDetailDialog";
import { BookingFormDialog } from "./CalendarPage";
import { useMerchantBookings } from "./context";
import { addDays, buildTaipeiIso, getTaipeiNow, startOfWeek, toDateKey } from "./dateUtils";
import { formatAmount } from "./orderAmount";
import { RequireBookingAccess } from "./RequireBookingAccess";
import { BOOKING_STATUS_LABELS, type BookingStatus } from "./types";

// 1.2:這次開放篩選的四種狀態(待確認/已確認/已完成/已取消)——pending_reply/dispatching 是
// 預留給未來智慧建單/客戶自助預約流程的狀態值,這次系統不會真的產生,篩選清單不需要列出來,
// 避免客服看到兩個永遠不會有資料、點了也沒反應的選項。
const FILTERABLE_STATUSES: BookingStatus[] = [
  "pending_confirmation",
  "accepted",
  "completed",
  "cancelled",
];

function bookingStatusBadgeVariant(status: BookingStatus): "default" | "secondary" | "outline" {
  if (status === "completed") return "secondary";
  if (status === "cancelled") return "outline";
  return "default";
}

interface OrderFilters {
  statuses: BookingStatus[];
  dateFrom: string; // dateKey,空字串代表不限
  dateTo: string; // dateKey,空字串代表不限
  staffId: string; // 空字串代表不限
  customerKeyword: string;
}

const EMPTY_FILTERS: OrderFilters = {
  statuses: [],
  dateFrom: "",
  dateTo: "",
  staffId: "",
  customerKeyword: "",
};

/** 1.3 狀態卡片對應的快速篩選條件(點擊套用)。 */
interface StatusCardDef {
  key: string;
  label: string;
  filters: Partial<OrderFilters>;
}

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

  const [filters, setFilters] = useState<OrderFilters>(EMPTY_FILTERS);
  const [detailBookingId, setDetailBookingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingBookingId, setEditingBookingId] = useState<string | null>(null);

  const todayKey = toDateKey(getTaipeiNow());
  const weekStartKey = toDateKey(startOfWeek(getTaipeiNow()));
  const weekEndKey = toDateKey(addDays(startOfWeek(getTaipeiNow()), 7));

  // 1.3:狀態卡片——數字是即時查詢結果(各自獨立呼叫 useMerchantBookings,不是拿主列表的
  // 快取資料算,避免主列表篩選條件套用後卡片數字連動跟著變動,失去「快速套用」的意義)。
  const todayPendingQuery = useMerchantBookings(merchantId, {
    status: ["pending_confirmation"],
    startAt: buildTaipeiIso(todayKey, "00:00"),
    endAt: buildTaipeiIso(toDateKey(addDays(getTaipeiNow(), 1)), "00:00"),
  });
  const todayAcceptedQuery = useMerchantBookings(merchantId, {
    status: ["accepted"],
    startAt: buildTaipeiIso(todayKey, "00:00"),
    endAt: buildTaipeiIso(toDateKey(addDays(getTaipeiNow(), 1)), "00:00"),
  });
  const weekCompletedQuery = useMerchantBookings(merchantId, {
    status: ["completed"],
    startAt: buildTaipeiIso(weekStartKey, "00:00"),
    endAt: buildTaipeiIso(weekEndKey, "00:00"),
  });

  const statusCards: (StatusCardDef & { count: number | undefined })[] = [
    {
      key: "today-pending",
      label: "今日待確認",
      filters: {
        statuses: ["pending_confirmation"],
        dateFrom: todayKey,
        dateTo: todayKey,
      },
      count: todayPendingQuery.data?.length,
    },
    {
      key: "today-accepted",
      label: "今日已確認",
      filters: {
        statuses: ["accepted"],
        dateFrom: todayKey,
        dateTo: todayKey,
      },
      count: todayAcceptedQuery.data?.length,
    },
    {
      key: "week-completed",
      label: "本週已完成",
      filters: {
        statuses: ["completed"],
        dateFrom: weekStartKey,
        dateTo: toDateKey(addDays(startOfWeek(getTaipeiNow()), 6)),
      },
      count: weekCompletedQuery.data?.length,
    },
  ];

  const { data: bookings, isLoading } = useMerchantBookings(merchantId, {
    ...(filters.statuses.length > 0 ? { status: filters.statuses } : {}),
    ...(filters.staffId ? { staffId: filters.staffId } : {}),
    ...(filters.dateFrom ? { startAt: buildTaipeiIso(filters.dateFrom, "00:00") } : {}),
    ...(filters.dateTo
      ? {
          endAt: buildTaipeiIso(
            toDateKey(addDays(new Date(`${filters.dateTo}T00:00:00`), 1)),
            "00:00",
          ),
        }
      : {}),
    ...(filters.customerKeyword ? { customerKeyword: filters.customerKeyword } : {}),
  });

  function toggleStatus(status: BookingStatus) {
    setFilters((prev) => ({
      ...prev,
      statuses: prev.statuses.includes(status)
        ? prev.statuses.filter((s) => s !== status)
        : [...prev.statuses, status],
    }));
  }

  function applyStatusCard(card: StatusCardDef) {
    setFilters((prev) => ({
      ...EMPTY_FILTERS,
      customerKeyword: prev.customerKeyword,
      ...card.filters,
    }));
  }

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
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">訂單管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">「{merchant!.name}」的訂單列表與篩選</p>
      </div>

      {/* 1.3:狀態卡片。 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {statusCards.map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={() => applyStatusCard(card)}
            className="text-left"
          >
            <Card className="transition-colors hover:border-brand hover:bg-brand-soft/40">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {card.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-foreground">{card.count ?? "…"}</p>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>

      {/* 1.2:篩選功能,全部可疊加使用。 */}
      <Card>
        <CardContent className="grid grid-cols-1 gap-4 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label>狀態(可多選)</Label>
            <div className="mt-2 space-y-1.5">
              {FILTERABLE_STATUSES.map((status) => (
                <label key={status} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={filters.statuses.includes(status)}
                    onCheckedChange={() => toggleStatus(status)}
                  />
                  <span>{BOOKING_STATUS_LABELS[status]}</span>
                </label>
              ))}
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
          <div>
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
                <SelectItem value="__all__">不限</SelectItem>
                {(staffList ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="orders-customer-keyword">客戶關鍵字(姓名或電話)</Label>
            <Input
              id="orders-customer-keyword"
              className="mt-2"
              placeholder="輸入姓名或電話"
              value={filters.customerKeyword}
              onChange={(e) => setFilters((prev) => ({ ...prev, customerKeyword: e.target.value }))}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFilters(EMPTY_FILTERS)}
            >
              清除篩選
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 1.1:訂單列表。 */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      ) : !bookings || bookings.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          目前沒有符合條件的訂單。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-surface text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">客戶姓名</th>
                <th className="px-3 py-2 text-left">預約時間</th>
                <th className="px-3 py-2 text-left">服務人員</th>
                <th className="px-3 py-2 text-left">訂單狀態</th>
                <th className="px-3 py-2 text-right">訂單金額</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr
                  key={b.id}
                  className="cursor-pointer border-t border-border hover:bg-muted/50"
                  onClick={() => setDetailBookingId(b.id)}
                >
                  <td className="px-3 py-2">{b.customer_name}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {new Date(b.start_at).toLocaleString("zh-TW", {
                      timeZone: "Asia/Taipei",
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </td>
                  <td className="px-3 py-2">{staffNameById.get(b.staff_id) ?? "(未知人員)"}</td>
                  <td className="px-3 py-2">
                    <Badge variant={bookingStatusBadgeVariant(b.status as BookingStatus)}>
                      {BOOKING_STATUS_LABELS[b.status as BookingStatus]}
                    </Badge>
                  </td>
                  <td className={cn("px-3 py-2 text-right font-medium text-foreground")}>
                    {formatAmount(b.final_amount_snapshot)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

export default function OrdersPage() {
  return (
    <RequireBookingAccess>
      <OrdersPageInner />
    </RequireBookingAccess>
  );
}
