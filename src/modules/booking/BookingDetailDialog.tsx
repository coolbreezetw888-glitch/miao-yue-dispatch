// 模組 6(訂單管理)§3.1/§3.2/§3.3:預約詳情彈窗。
// 原本這顆彈窗定義在 CalendarPage.tsx 內部、不對外匯出;這次抽成獨立檔案,讓「訂單管理頁」
// (OrdersPage.tsx)也能直接複用同一顆彈窗——規格書 §1.1 明講「點擊任一列開啟既有的預約詳情
// 彈窗(BookingDetailDialog,沿用模組 5 擴充既有元件,不重做)」,抽檔案是達成「不重做」的必要
// 前提(CalendarPage.tsx 原本沒有 export 這個元件,兩個頁面沒辦法共用)。
//
// 除了抽檔案,這次同時疊加三項新內容:
//   §3.1 金額明細顯示改用快照(quantity × unit_price_snapshot,取代原本的即時查價)、
//        新增小計/折扣/稅金/最終金額 breakdown。
//   §3.2 付款方式顯示(沒有選擇時顯示「尚未設定」)。
//   §3.3 「相關訂單」按鈕:點擊後在同一顆彈窗裡切換顯示同一位客戶的歷史訂單清單,
//        點清單裡任一筆會直接切換成該筆的詳情(不重新開一顆彈窗)。
// 其餘既有邏輯(狀態徽章、確認/完成/編輯/取消按鈕、建立/修改追蹤資訊列)原封不動搬過來,不變動行為。

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { INDUSTRY_REQUIRES_CUSTOMER_ADDRESS, type IndustryType } from "@/modules/merchant/types";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

// ui-v1-full 階段一(2026-09-29):這顆彈窗是全站 55 個彈窗統一改版的「全頁層」範本(盤點 A11)。
// 外殼從 Sheet(底部 92vh)換成 ui-overlay-patterns 的 FullPageLayer(手機滿版 / 電腦置中面板),
// 內容改用明細列(DetailSection / DetailRow / 可點的電話與地址 / 兩種備註)、狀態標籤(StatusTag)、
// 底部等寬動作列(ActionBar)。**只動外觀與版面,不動任何行為**:按鈕顯示條件、點擊後做什麼、
// 資料查詢、權限判斷全部維持原樣。
import {
  ActionBar,
  AlertNote,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  CardAlertDialogTrigger,
  CustomerNote,
  DetailAddressRow,
  DetailDivider,
  DetailLinkRow,
  DetailLinkRows,
  DetailPhoneRow,
  DetailRow,
  DetailSection,
  EmptyState,
  FullPageLayer,
  FullPageLayerContent,
  InternalNote,
  ListCard,
  LoadingSkeleton,
  StatusTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { ConfirmBookingLineDialog } from "@/modules/line-notifications/ConfirmBookingLineDialog";
import {
  dispatchLineNotification,
  usePendingLineNotificationPreview,
} from "@/modules/line-notifications/api";
import type { PendingLineNotificationTarget } from "@/modules/line-notifications/types";

import {
  cancelBooking,
  cancelCompletedBooking,
  completeBooking,
  confirmBooking,
  fetchCompletedBookingReversalPreview,
  getBooking,
  getBookingPointsLedger,
  getCustomerRelatedBookings,
  removeBookingAssistant,
  revertCompletedBooking,
} from "./api";
import type { AssistantRemovedInfo } from "./assistantRemovalLogic";
import { cancelReasonText } from "./cancelReasonDisplay";
// #844 批次 4:已完成訂單的「還原完成 / 取消訂單」確認子畫面(§五 5.1~5.4)。
import {
  AGENT_CANNOT_REVERSE_NOTE,
  REVERSAL_PREVIEW_QUERY_SEGMENT,
  REVERSAL_SUCCESS_TOAST,
  REVERSAL_TITLES,
  buildCompletedBookingReversalView,
  invalidateAfterCompletedBookingReversal,
  isReversalStateChangedError,
  normalizeReversalReason,
  reversalConfirmDisabledReason,
  reversalReasonError,
  reversalShortfallNotice,
  type ReversalShortfallNotice,
} from "./completedBookingReversal";
import {
  CompletedBookingReversalContent,
  CompletedBookingReversalFooter,
} from "./CompletedBookingReversalView";
// 紅利系統重構 批次 7(§4.7):訂單詳情的紅利那幾行。只看這張訂單自己的欄位,不看商家目前的開關。
import { describeBookingDetailPoints } from "./bookingPointsLogic";
import { useBookingStatusChangeLogs } from "./context";
import { BackToDetailLink, StatusChangeLogsView } from "./StatusChangeLogsView";
import { isoToTaipeiDateTimeWithSeconds, isoToTaipeiTime } from "./dateUtils";
import { formatAmount } from "./orderAmount";
import { formatMaterialAmount } from "./materialCostSelection";
import { CancelBookingConfirmButton } from "./CancelBookingConfirmButton";
import { CustomerBookingSourceTag } from "./CustomerBookingSourceTag";
import { customerBookingSourceKind, GUEST_BOOKING_BACKEND_HINT } from "./customerBookingSource";
// #996 第 11 批 K:已完成訂單的「服務人員抽成」區塊 + 「重新計算抽成」按鈕。
import { BookingCommissionSection } from "./BookingCommissionSection";
import {
  AMOUNT_ADJUSTMENT_MODE_LABELS,
  BOOKING_STATUS_LABELS,
  bookingStatusTone,
  getPaymentMethodLabel,
  type BookingStatus,
  type CompletedBookingReversalAction,
  type CustomerRelatedBooking,
} from "./types";

// ---------------------------------------------------------------------------
// §3.3:相關訂單清單畫面,套用在同一顆 Dialog 裡(不另外疊一層彈窗)。
// ---------------------------------------------------------------------------
function RelatedBookingsView({
  loading,
  bookings,
  onBack,
  onSelect,
}: {
  loading: boolean;
  bookings: CustomerRelatedBooking[];
  onBack: () => void;
  onSelect: (bookingId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <BackToDetailLink onBack={onBack} />
      {loading ? (
        <LoadingSkeleton variant="cards" rows={3} />
      ) : bookings.length === 0 ? (
        <EmptyState
          title="這位客戶目前沒有其他訂單紀錄"
          description="之後這位客戶再預約，會自動列在這裡，方便對照上次做過什麼。"
          action={
            <Button type="button" variant="neutral" size="touch" onClick={onBack}>
              返回訂單詳情
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {bookings.map((b) => (
            <li key={b.id}>
              <ListCard
                onClick={() => onSelect(b.id)}
                title={
                  <span className="tabular-nums">{isoToTaipeiDateTimeWithSeconds(b.startAt)}</span>
                }
                tags={
                  <StatusTag tone={bookingStatusTone(b.status)}>
                    {BOOKING_STATUS_LABELS[b.status]}
                  </StatusTag>
                }
                meta={
                  <>
                    <span className="break-words">
                      {b.serviceItemNames.length > 0
                        ? b.serviceItemNames.join("、")
                        : "(無服務項目資料)"}
                    </span>
                    <span className="ml-2 font-medium text-foreground">
                      {formatAmount(b.finalAmountSnapshot)}
                    </span>
                  </>
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BookingDetailDialog({
  bookingId,
  staffNameById,
  open,
  onOpenChange,
  onChanged,
  onEdit,
  openedAsAssistantStaffId = null,
  onAssistantRemoved,
}: {
  bookingId: string | null;
  staffNameById: Map<string, string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  onEdit: (bookingId: string) => void;
  /** SPECS-INDEX #873:從行事曆「(協助)」色塊打開時,那一欄的服務人員 id;其他入口(主卡、訂單管理)不傳。
   *  有值時底部最左那顆從「取消預約」換成「移除協助人員」—— 只移除這一位,不取消整張單。 */
  openedAsAssistantStaffId?: string | null;
  /** SPECS-INDEX #873:移除成功後呼叫,由呼叫端跳「維持現狀 / 再加助手」的擋流程提示。 */
  onAssistantRemoved?: (info: AssistantRemovedInfo) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // §3.3:目前顯示中的訂單 id——預設等於傳進來的 bookingId,點擊「相關訂單」清單裡的項目時
  // 切換成該筆訂單的 id,同一顆彈窗直接顯示對應詳情,不用另外開一顆彈窗。
  const [viewingBookingId, setViewingBookingId] = useState<string | null>(bookingId);
  const [showRelated, setShowRelated] = useState(false);
  // 模組 6 §9.1(SPECS-INDEX #597):操作記錄的顯示狀態,跟 showRelated 互斥(同一時間只顯示
  // 其中一種子畫面),比照「相關訂單」既有的互動模式。
  const [showLogs, setShowLogs] = useState(false);
  // #844 §5.2:第三個子畫面「確認還原 / 取消已完成訂單」,跟上面兩個子畫面互斥。null = 不在這個子畫面。
  const [reversalAction, setReversalAction] = useState<CompletedBookingReversalAction | null>(null);
  const [reversalReason, setReversalReason] = useState("");
  // 動過原因欄才在欄位下顯示紅字(一打開就紅字不友善);按鈕上方的黃色 `!` 一直都在。
  const [reversalReasonTouched, setReversalReasonTouched] = useState(false);
  // §3.7 / Q2 定案 C:取消已完成訂單「預設不通知」。
  const [reversalNotify, setReversalNotify] = useState(false);
  // §5.4:差額 > 0 時的小卡窗內容(關掉之後才關全頁層)。
  const [shortfallNotice, setShortfallNotice] = useState<ReversalShortfallNotice | null>(null);
  // QA 打回 1:差額小卡窗開窗時焦點要落在「知道了」(Radix AlertDialog 預設找 Cancel 鈕,這顆窗沒有)。
  const shortfallAckRef = useRef<HTMLButtonElement>(null);
  // #965:「差額小卡窗已經要開、還沒收尾」的同步旗標。小卡窗剛插入畫面的頭一兩幀,Radix 還沒把它登記成
  // 最上層,這時按 Esc 會被下面的全頁層接走(關錯層)⇒ finishReversal 沒跑、列表沒重抓。全頁層的
  // onOpenChange(見 handleLayerOpenChange)看到這個旗標就改走 finishReversal。用 ref 不用 state:
  // 從 RPC 回來到 React 真的重新渲染之間也有空窗,ref 在 setShortfallNotice 的同一刻就立起來。
  const shortfallPendingRef = useRef(false);
  // QA 打回 3:成功 / 狀態已改變後要呼叫 onChanged(),但必須等確認子畫面真的關掉(reversalAction 變 null、
  // 預覽查詢 disabled)之後 —— 否則呼叫端讓 ["booking-module"] 整組過期時,預覽查詢還是 active,會多打一次
  // 預覽 RPC,而這張單已經不是已完成 ⇒ 400「狀態已經改變」紅字。
  const [pendingChangedNotify, setPendingChangedNotify] = useState(false);
  // #996 第 11 批 K-6:重新計算抽成送出中 ⇒ 預約詳情(全頁層)也不能關。
  const [commissionBusy, setCommissionBusy] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (open) {
      setViewingBookingId(bookingId);
      setReason("");
      setShowRelated(false);
      setShowLogs(false);
      setReversalAction(null);
      setReversalReason("");
      setReversalReasonTouched(false);
      setReversalNotify(false);
      setShortfallNotice(null);
      shortfallPendingRef.current = false;
    }
  }, [open, bookingId]);

  const { data: booking, isLoading } = useQuery({
    queryKey: ["booking-module", "booking-detail", viewingBookingId],
    queryFn: () => getBooking(viewingBookingId as string),
    enabled: open && Boolean(viewingBookingId),
  });

  // 紅利系統重構 §4.7:查「已入帳 / 已收回」(分類帳要 members 鑰匙,所以走
  // get_booking_points_ledger,orders 鑰匙即可;只回這一張單的入帳 / 收回點數)。
  // #844 §4.8:還原後的已確認、取消後的已取消也可能入帳過又被收回 ⇒ 條件從「已完成」放寬成
  // 「不是待確認(待確認的單一定還沒完成過)」。
  // #844 批次 4(批次 3 QA 觀察 ①):**不再要求派點 > 0** —— 還原後改單把派點改成 0 的單,分類帳上仍有
  // 上一輪的入帳 / 收回 / 差額,要看得到;派點條件只決定「預定派點」那一行,不決定要不要查分類帳。
  const { data: pointsLedger } = useQuery({
    queryKey: ["booking-module", "points-ledger", viewingBookingId],
    queryFn: () => getBookingPointsLedger(viewingBookingId as string),
    enabled:
      open &&
      Boolean(viewingBookingId) &&
      booking !== undefined &&
      booking !== null &&
      booking.status !== "pending_confirmation",
  });
  const detailPoints = booking ? describeBookingDetailPoints(booking, pointsLedger ?? null) : null;

  // 模組 10(會員與紅利)§4.5:判斷目前使用者是否也擁有 members 權限,決定會員姓名要不要做成
  // 可點擊連結。這裡完全不需要額外的權限檢查/API 呼叫(一之二節方向一)——member_name_snapshot
  // 已經隨著 bookings_select 政策一起讀到,純粹是前端顯示層的判斷。
  const { data: merchantRole } = useCurrentMerchantRole();
  const { data: canManageMembers } = useAgentPermission("members");
  const canViewMemberProfile = merchantRole === "admin" || canManageMembers === true;
  // #996 第 11 批 K-4:「服務人員抽成」區塊只給管理員,或有「抽成與薪資設定」的客服(讀取中 = undefined ⇒ 不顯示)。
  const { data: canManageCommission } = useAgentPermission("commission_settings");
  const canSeeCommission =
    merchantRole === "admin" || (merchantRole === "agent" && canManageCommission === true);

  // 2026-09-24 使用者裁決(任務 2):商家切成「到店服務」之後,既有訂單的客戶地址要隱藏。
  // industry_type 現在可以隨時切換(見 merchant/api.ts 2026-09-23 的說明,資料庫層鎖定的
  // trigger 已經拿掉),所以顯示條件必須看「商家**目前**的產業設定需不需要地址」,不能只看
  // 「這筆訂單有沒有地址值」——不然到府派工時期建立的舊訂單,切成到店服務之後客戶住家地址
  // 還是會出現在預約詳情裡。判斷一律用 INDUSTRY_REQUIRES_CUSTOMER_ADDRESS 這份共用對照表
  // (建單表單 CalendarPage.tsx 判斷「要不要顯示客戶地址欄位」用的是同一份),不要在這裡自己
  // 寫死產業判斷式。
  //
  // 刻意只改「顯示」不動資料:資料庫裡的 bookings.customer_address 值完全保留,所以商家如果
  // 再切回「到府派工」,舊訂單的地址會重新顯示出來——這是使用者要的行為(他說的是「隱藏」,
  // 不是刪除),不是漏改。
  const { merchant } = useCurrentMerchant();
  const showCustomerAddress =
    merchant !== null &&
    INDUSTRY_REQUIRES_CUSTOMER_ADDRESS[merchant.industry_type as IndustryType] === true;

  const { data: relatedBookings, isLoading: relatedLoading } = useQuery({
    queryKey: [
      "booking-module",
      "related-bookings",
      booking?.merchant_id,
      booking?.customer_phone,
      viewingBookingId,
    ],
    queryFn: () =>
      getCustomerRelatedBookings(booking!.merchant_id, booking!.customer_phone, viewingBookingId),
    enabled: open && showRelated && Boolean(booking),
  });

  // 模組 6 §9.1(SPECS-INDEX #597):操作記錄查詢,只在打開這個子畫面時才查(比照「相關訂單」
  // 既有的 enabled 條件寫法),不用等使用者點開按鈕就預先撈。
  const { data: statusChangeLogs, isLoading: statusChangeLogsLoading } = useBookingStatusChangeLogs(
    viewingBookingId,
    open && showLogs,
  );

  // 模組 11(LINE 通知)規則 2.5/§4.8:確認訂單前先預覽會不會通知任何人——沒有目標就直接確認,
  // 有目標才彈出 Yes/No 對話框,兩個選項都會執行 confirm_booking(),差別只在於「是」之後才呼叫
  // dispatchLineNotification。
  const { refetch: refetchLinePreview } = usePendingLineNotificationPreview(
    booking?.id,
    "booking_confirmed",
  );
  const [showLineDialog, setShowLineDialog] = useState(false);
  const [lineDialogTargets, setLineDialogTargets] = useState<PendingLineNotificationTarget[]>([]);

  async function doConfirm(shouldNotify: boolean) {
    if (!booking) return;
    setBusy(true);
    try {
      await confirmBooking(booking.id);
      if (shouldNotify) {
        dispatchLineNotification({
          merchantId: booking.merchant_id,
          bookingId: booking.id,
          eventType: "booking_confirmed",
        });
      }
      toast.success("已確認訂單");
      setShowLineDialog(false);
      onOpenChange(false);
      onChanged();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!booking) return;
    setBusy(true);
    try {
      const { data: preview } = await refetchLinePreview();
      if (preview?.hasAnyTarget) {
        setLineDialogTargets(preview.targets);
        setShowLineDialog(true);
        setBusy(false);
        return;
      }
      await doConfirm(false);
    } catch (err) {
      // 規則 2.5 的預覽本身失敗不應該擋住確認訂單這個核心業務操作——退回成「視為沒有通知對象」
      // 直接確認,不彈窗(這是本模組沒有明文規定、由 engineer 補上的保守假設,已在回報中提出
      // 請主腦/使用者確認是否認同這個 fallback 行為)。
      console.error("[preview_line_notification_targets] 呼叫失敗,略過通知彈窗", err);
      await doConfirm(false);
    }
  }

  async function handleComplete() {
    if (!booking) return;
    setBusy(true);
    try {
      await completeBooking(booking.id);
      toast.success("已標記完成");
      onOpenChange(false);
      onChanged();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // #844 §5.2~§5.4:還原完成 / 取消已完成訂單
  // -------------------------------------------------------------------------
  const reversalPreviewQuery = useQuery({
    queryKey: ["booking-module", REVERSAL_PREVIEW_QUERY_SEGMENT, viewingBookingId],
    queryFn: () => fetchCompletedBookingReversalPreview(viewingBookingId as string),
    enabled: open && reversalAction !== null && Boolean(viewingBookingId),
    // 每次進子畫面都重算(數字會因別人剛改過餘額而變),不用快取、不自動重試(42501 / 狀態已改變重試也沒用)。
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const reversalView =
    reversalAction && reversalPreviewQuery.data
      ? buildCompletedBookingReversalView(reversalPreviewQuery.data, reversalAction)
      : null;
  const reversalPreviewError = reversalPreviewQuery.isError
    ? getErrorMessage(reversalPreviewQuery.error)
    : null;
  const reversalDisabledReason = reversalConfirmDisabledReason(reversalView, reversalReason);

  function openReversal(action: CompletedBookingReversalAction) {
    // 丟掉上一次的預覽結果(含錯誤狀態),確保進子畫面一定先看到骨架、再看到這一次重算的數字。
    queryClient.removeQueries({
      queryKey: ["booking-module", REVERSAL_PREVIEW_QUERY_SEGMENT, viewingBookingId],
    });
    setReversalAction(action);
    setReversalReason("");
    setReversalReasonTouched(false);
    setReversalNotify(false);
  }

  function refreshAfterReversal(id: string) {
    // 這支 helper 本身排除了預覽查詢;呼叫端的 onChanged() 不會排除,所以延後到 effect 裡(見下方)。
    void invalidateAfterCompletedBookingReversal(queryClient, id);
    setPendingChangedNotify(true);
  }

  useEffect(() => {
    if (pendingChangedNotify && reversalAction === null) {
      setPendingChangedNotify(false);
      onChanged();
    }
  }, [pendingChangedNotify, reversalAction, onChanged]);

  function finishReversal() {
    shortfallPendingRef.current = false;
    const id = booking?.id ?? viewingBookingId;
    setShortfallNotice(null);
    setReversalAction(null);
    onOpenChange(false);
    if (id) refreshAfterReversal(id);
  }

  async function handleReversalConfirm() {
    if (!booking || !reversalAction || reversalDisabledReason !== null) return;
    const action = reversalAction;
    const reasonToSend = normalizeReversalReason(reversalReason);
    setBusy(true);
    try {
      const result =
        action === "revert"
          ? await revertCompletedBooking(booking.id, reasonToSend)
          : await cancelCompletedBooking(booking.id, reasonToSend, { notify: reversalNotify });
      toast.success(REVERSAL_SUCCESS_TOAST[action]);
      const notice = reversalShortfallNotice(result);
      if (notice) {
        // §5.4:差額不用 toast 帶過,改用小卡窗;關掉後才關全頁層、重抓。
        shortfallPendingRef.current = true;
        setShortfallNotice(notice);
      } else {
        finishReversal();
      }
    } catch (err) {
      const message = getErrorMessage(err);
      if (isReversalStateChangedError(message)) {
        // §3.11:兩個人同時按 / 別人剛處理過。停在確認畫面沒有意義(數字已經不對),回到預約詳情並重抓,
        // 讓畫面直接顯示最新狀態。
        toast.error("操作失敗", {
          description:
            "這筆訂單的狀態已經改變(可能有其他人剛處理過)，畫面已重新整理，請確認後再操作。",
        });
        setReversalAction(null);
        refreshAfterReversal(booking.id);
      } else {
        // §5.4 / 邊界 17:其他失敗(整筆已回滾)停在確認畫面,原因欄內容保留。
        toast.error("操作失敗", { description: message });
      }
    } finally {
      setBusy(false);
    }
  }

  function retryReversalPreview() {
    if (reversalPreviewError !== null && isReversalStateChangedError(reversalPreviewError)) {
      // 預覽說狀態已經改變 ⇒「重新整理」= 回到預約詳情並重抓。
      setReversalAction(null);
      if (viewingBookingId) refreshAfterReversal(viewingBookingId);
      return;
    }
    void reversalPreviewQuery.refetch();
  }

  async function handleCancel() {
    if (!booking) return;
    setBusy(true);
    try {
      await cancelBooking(booking.id, reason.trim() ? reason.trim() : null);
      toast.success("已取消預約");
      onOpenChange(false);
      onChanged();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  // SPECS-INDEX #873:只移除這一位協助人員(remove_booking_assistant),訂單本身與主服務人員的單完全不動。
  // 不發任何通知(訂單沒有取消)。成功後關掉詳情,交給呼叫端跳擋流程二選一提示。
  async function handleRemoveAssistant() {
    if (!booking || !openedAsAssistantStaffId) return;
    const fallbackName =
      booking.assistants.find((a) => a.staffId === openedAsAssistantStaffId)?.staffName ??
      staffNameById.get(openedAsAssistantStaffId) ??
      "協助人員";
    setBusy(true);
    try {
      const result = await removeBookingAssistant(booking.id, openedAsAssistantStaffId);
      onOpenChange(false);
      onChanged();
      onAssistantRemoved?.({
        bookingId: booking.id,
        assistantNames: [result.removed_staff_name ?? fallbackName],
        primaryName:
          result.primary_staff_name ?? staffNameById.get(booking.staff_id) ?? "(未知人員)",
      });
    } catch (err) {
      toast.error("移除協助人員失敗", { description: getErrorMessage(err) });
      // 40001(這位已經不在單上 / 畫面過期):關掉詳情並重抓,讓行事曆直接顯示最新狀態。
      if ((err as { code?: string } | null)?.code === "40001") {
        onOpenChange(false);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  if (!bookingId) return null;

  // 5.2 第 3 點:操作按鈕依狀態調整(這幾個按鈕只對「目前傳入的這一筆」有效,切去看相關訂單時
  // 不顯示,避免誤操作到剛剛切換過去查看的另一筆訂單)。
  const isViewingOriginal = viewingBookingId === bookingId;
  const showConfirm = isViewingOriginal && booking?.status === "pending_confirmation";
  const showComplete = isViewingOriginal && booking?.status === "accepted";
  const showEditAndCancel =
    isViewingOriginal &&
    (booking?.status === "pending_confirmation" || booking?.status === "accepted");
  // #844 §5.1:已完成訂單 —— 商家管理員看到「取消訂單」「還原完成」兩顆;其他人(客服)看到一行常駐 `!`。
  // 前端只是體驗,後端 private.is_merchant_admin 才是安全邊界。角色還在讀取中(undefined)兩者都不顯示。
  const isCompletedOriginal = isViewingOriginal && booking?.status === "completed";
  const showReversalButtons = isCompletedOriginal && merchantRole === "admin";
  const showAgentReversalNote =
    isCompletedOriginal && merchantRole !== undefined && merchantRole !== "admin";
  // SPECS-INDEX #873:從「(協助)」色塊打開的(只看原本那一筆;切去看相關訂單時不算)。
  const openedAsAssistant = isViewingOriginal && Boolean(openedAsAssistantStaffId);
  const openedAssistantName = openedAsAssistantStaffId
    ? (booking?.assistants.find((a) => a.staffId === openedAsAssistantStaffId)?.staffName ??
      staffNameById.get(openedAsAssistantStaffId) ??
      "協助人員")
    : "";
  const primaryStaffName = booking ? (staffNameById.get(booking.staff_id) ?? "(未知人員)") : "";

  // ui-v1-full 階段一:外殼改用 FullPageLayer(skill 三、全頁層:手機滿版 / 電腦置中面板、標題列與
  // 按鈕列固定、只有中間捲動)。操作按鈕依 skill 二之三搬到底部固定動作列並三顆等寬(取消預約 /
  // 編輯 / 確認訂單或標記完成),**顯示條件與點擊行為跟原本一模一樣**;取消預約的二次確認改用小卡窗
  // 殼 CardAlertDialog(疊在全頁層之上,skill 三、兩層重疊),內容與 handleCancel 不變。
  // 狀態標籤搬到標題列右側(titleExtra),原本內容區第一列的「訂單狀態」因此拿掉,資訊沒有少。
  const isReversalView = reversalAction !== null;
  const isDetailView = !showRelated && !showLogs && !isReversalView;
  const showActionBar =
    Boolean(booking) &&
    isDetailView &&
    (showConfirm || showComplete || showEditAndCancel || showReversalButtons);

  // #965:全頁層要關(Esc / 右上角關閉)時,如果差額小卡窗已經要開、還沒收尾,一律改走 finishReversal
  // (等同按「知道了」:小卡窗與全頁層一起關、重抓列表),不讓收尾被跳過。
  function handleLayerOpenChange(next: boolean) {
    // #996 第 11 批 K-6:重新計算抽成送出中,詳情不能關(等 RPC 回來)。
    if (!next && commissionBusy) return;
    if (!next && shortfallPendingRef.current) {
      finishReversal();
      return;
    }
    onOpenChange(next);
  }

  return (
    <>
      <FullPageLayer open={open} onOpenChange={handleLayerOpenChange}>
        <FullPageLayerContent
          // 第 11 批 J(#995 J-14):一般詳情是檢視型(Esc / 上方空白直接關);只有在「還原 / 取消已完成訂單」
          // 子畫面、原因欄有填字時才算「填過資料」⇒ 先問「確定放棄這次輸入？」。
          // 🔴 送出中、或已送出成功跳出差額小卡窗時不算(那時原因已經存進去了):#965 要求這時按 Esc
          //    一律走 handleLayerOpenChange → finishReversal(等同「知道了」),不能被放棄確認攔下來。
          dirty={
            reversalAction !== null &&
            reversalReason.trim() !== "" &&
            !busy &&
            shortfallNotice === null
          }
          title={
            reversalAction
              ? REVERSAL_TITLES[reversalAction]
              : showRelated
                ? "相關訂單"
                : showLogs
                  ? "操作記錄"
                  : "預約詳情"
          }
          titleExtra={
            booking && isDetailView ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <StatusTag tone={bookingStatusTone(booking.status as BookingStatus)}>
                  {BOOKING_STATUS_LABELS[booking.status as BookingStatus]}
                </StatusTag>
                {/* 客戶端第 3 批(C3-E01):客人自己線上預約的單。 */}
                <CustomerBookingSourceTag booking={booking} />
              </span>
            ) : null
          }
          footer={
            reversalAction ? (
              <CompletedBookingReversalFooter
                view={reversalView}
                disabledReason={reversalDisabledReason}
                busy={busy}
                onBack={() => setReversalAction(null)}
                onConfirm={() => void handleReversalConfirm()}
              />
            ) : booking && showActionBar ? (
              <ActionBar>
                {/* SPECS-INDEX #873:從「(協助)」色塊打開時,最左那顆換成「移除協助人員」。
                    可以再加回來 ⇒ 不是不可逆 ⇒ 不標紅(skill 二之三);二次確認一樣用小卡窗。 */}
                {showEditAndCancel && openedAsAssistant ? (
                  <CardAlertDialog>
                    <CardAlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="neutral"
                        size="touch"
                        disabled={busy}
                        data-testid="remove-assistant-button"
                      >
                        移除協助人員
                      </Button>
                    </CardAlertDialogTrigger>
                    <CardAlertDialogContent>
                      <CardAlertDialogHeader>
                        <CardAlertDialogTitle>
                          確定要把 {openedAssistantName} 從這張訂單移除嗎？
                        </CardAlertDialogTitle>
                        <CardAlertDialogDescription>
                          只會移除這位協助人員，主服務人員 {primaryStaffName}{" "}
                          的訂單維持不變，不會取消。
                        </CardAlertDialogDescription>
                      </CardAlertDialogHeader>
                      <CardAlertDialogFooter>
                        <CardAlertDialogCancel>再想想</CardAlertDialogCancel>
                        <CardAlertDialogAction onClick={() => void handleRemoveAssistant()}>
                          確定移除
                        </CardAlertDialogAction>
                      </CardAlertDialogFooter>
                    </CardAlertDialogContent>
                  </CardAlertDialog>
                ) : null}
                {/* #977 第 7 批:取消的二次確認小卡窗抽成 CancelBookingConfirmButton(服務人員端共用),畫面一字未改。 */}
                {showEditAndCancel && !openedAsAssistant ? (
                  <CancelBookingConfirmButton
                    disabled={busy}
                    reason={reason}
                    onReasonChange={setReason}
                    onConfirm={() => void handleCancel()}
                  />
                ) : null}
                {showEditAndCancel ? (
                  <Button
                    type="button"
                    variant="neutral"
                    size="touch"
                    disabled={busy}
                    onClick={() => onEdit(booking.id)}
                  >
                    編輯
                  </Button>
                ) : null}
                {showConfirm ? (
                  <Button
                    type="button"
                    variant="primary"
                    size="touch"
                    onClick={handleConfirm}
                    disabled={busy}
                  >
                    確認訂單
                  </Button>
                ) : null}
                {showComplete ? (
                  <Button
                    type="button"
                    variant="primary"
                    size="touch"
                    onClick={handleComplete}
                    disabled={busy}
                  >
                    標記完成
                  </Button>
                ) : null}
                {/* #844 §5.1:兩顆等寬,都不直接執行,點下去切到確認子畫面;沒有實心主要鈕
                    (兩個反轉動作都不該是最好按的那顆)。取消 = 危險(白底紅字),還原 = 次要(白底灰框)。 */}
                {showReversalButtons ? (
                  <Button
                    type="button"
                    variant="danger"
                    size="touch"
                    disabled={busy}
                    onClick={() => openReversal("cancel")}
                  >
                    取消訂單
                  </Button>
                ) : null}
                {showReversalButtons ? (
                  <Button
                    type="button"
                    variant="neutral"
                    size="touch"
                    disabled={busy}
                    onClick={() => openReversal("revert")}
                  >
                    還原完成
                  </Button>
                ) : null}
              </ActionBar>
            ) : null
          }
        >
          {reversalAction ? (
            <CompletedBookingReversalContent
              action={reversalAction}
              loading={reversalPreviewQuery.isLoading}
              errorMessage={reversalPreviewError}
              stateChanged={
                reversalPreviewError !== null && isReversalStateChangedError(reversalPreviewError)
              }
              view={reversalView}
              reason={reversalReason}
              onReasonChange={(value) => {
                setReversalReason(value);
                setReversalReasonTouched(true);
              }}
              reasonError={reversalReasonTouched ? reversalReasonError(reversalReason) : null}
              notify={reversalNotify}
              onNotifyChange={setReversalNotify}
              busy={busy}
              onBack={() => setReversalAction(null)}
              onRetry={retryReversalPreview}
            />
          ) : showLogs ? (
            <StatusChangeLogsView
              loading={statusChangeLogsLoading}
              logs={statusChangeLogs ?? []}
              onBack={() => setShowLogs(false)}
            />
          ) : showRelated ? (
            <RelatedBookingsView
              loading={relatedLoading}
              bookings={relatedBookings ?? []}
              onBack={() => setShowRelated(false)}
              onSelect={(id) => {
                setViewingBookingId(id);
                setShowRelated(false);
              }}
            />
          ) : isLoading || !booking ? (
            // skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。
            <LoadingSkeleton variant="lines" rows={8} />
          ) : (
            // skill 二之六 明細列:分組 + 組間留白、金額整組色塊、最重要的值放大、標籤淡值粗、
            // 數字 tabular-nums、電話/地址可點擊各佔一行、兩種備註分開。
            <div className="flex min-w-0 flex-col gap-5">
              {/* #844 §5.1 / Q4 定案 A:客服最可能是誤按完成的人,會去找「取消」找不到 ⇒ 常駐講清楚。 */}
              {/* SPECS-INDEX #873:從協助卡打開時,「取消預約」不在這裡 ⇒ 常駐 `!` 講清楚去哪裡取消整張單。 */}
              {openedAsAssistant && showEditAndCancel ? (
                <AlertNote data-testid="opened-as-assistant-note">
                  這是從協助人員 {openedAssistantName} 的卡片打開的。「移除協助人員」只會移除{" "}
                  {openedAssistantName}；要取消整張訂單，請點主服務人員 {primaryStaffName} 的卡片。
                </AlertNote>
              ) : null}
              {showAgentReversalNote ? (
                <AlertNote data-testid="agent-cannot-reverse-note">
                  {AGENT_CANNOT_REVERSE_NOTE}
                </AlertNote>
              ) : null}
              <div className="flex flex-col gap-1">
                <DetailRow label="預約時間" size="lg">
                  {isoToTaipeiTime(booking.start_at)} – {isoToTaipeiTime(booking.end_at)}
                </DetailRow>
                {/* 模組 6 §3.1/§4.3:自訂工時開啟時,工時旁邊註明,避免管理員誤以為是逐項
                    加總算出來的。 */}
                {booking.custom_duration_enabled ? (
                  <p className="text-right text-[11px] text-muted-foreground">
                    已套用自訂工時 {booking.custom_duration_minutes} 分鐘
                  </p>
                ) : null}
              </div>
              {/* C4-D07:已取消的單顯示取消原因(有填才顯示;純文字、長文字換行)。 */}
              {cancelReasonText(booking) ? (
                <p
                  className="whitespace-pre-line break-words text-[13.5px] leading-relaxed text-muted-foreground"
                  data-testid="booking-cancel-reason"
                >
                  {cancelReasonText(booking)}
                </p>
              ) : null}

              <DetailDivider />

              <DetailSection label="人員">
                <DetailRow label="服務人員">
                  {staffNameById.get(booking.staff_id) ?? "(未知人員)"}
                </DetailRow>
                {booking.assistants.length > 0 ? (
                  <DetailRow label="助手">
                    {booking.assistants.map((a) => a.staffName).join("、")}
                  </DetailRow>
                ) : null}
                <DetailRow label="預約客服" size="sm">
                  {booking.createdByName}
                </DetailRow>
              </DetailSection>

              {/* 模組 6 §3.1:金額明細改用快照(quantity × unitPriceSnapshot),取代原本的即時查價。 */}
              <DetailSection label="金額" tone="amount">
                {booking.serviceItems.map((i) => (
                  <DetailRow key={i.id} label={`${i.name} × ${i.quantity}`}>
                    {formatAmount(i.lineTotal)}
                  </DetailRow>
                ))}
                <DetailRow
                  label={`服務金額小計${booking.custom_total_amount_enabled ? "(已套用自訂總金額)" : ""}`}
                  size="sm"
                >
                  {formatAmount(booking.subtotal_amount_snapshot)}
                </DetailRow>
                {booking.discount_enabled ? (
                  <DetailRow
                    label={`折扣(${
                      booking.discount_mode
                        ? AMOUNT_ADJUSTMENT_MODE_LABELS[
                            booking.discount_mode as "fixed" | "percentage"
                          ]
                        : ""
                    })`}
                    size="sm"
                  >
                    -{formatAmount(booking.discount_amount_snapshot)}
                  </DetailRow>
                ) : null}
                {booking.tax_enabled ? (
                  <DetailRow
                    label={`稅金(${
                      booking.tax_mode_snapshot
                        ? AMOUNT_ADJUSTMENT_MODE_LABELS[
                            booking.tax_mode_snapshot as "fixed" | "percentage"
                          ]
                        : ""
                    })`}
                    size="sm"
                  >
                    +{formatAmount(booking.tax_amount_snapshot)}
                  </DetailRow>
                ) : null}
                <DetailDivider className="bg-brand/20" />
                <DetailRow label="最終金額" size="xl">
                  {formatAmount(booking.final_amount_snapshot)}
                </DetailRow>
                {/* 紅利系統重構 §4.7 / §2.11:有折抵時多兩行;「最終金額」那一行不改、仍是折抵前金額,
                    實付只在顯示層相減(資料庫不多存一欄)。放在金額組裡,客服收錢時一眼看得到。 */}
                {detailPoints?.redeemText ? (
                  <>
                    <DetailRow label="紅利點數折抵" size="sm">
                      {detailPoints.redeemText}
                    </DetailRow>
                    <DetailRow label="實付" size="lg">
                      {formatAmount(detailPoints.paidAmount)}
                    </DetailRow>
                  </>
                ) : null}
                {/* 模組 9(支付方式)v2:直接顯示快照文字,沒有選擇時顯示「尚未設定」。 */}
                <DetailRow label="付款方式" size="sm">
                  {getPaymentMethodLabel(booking.payment_method_name_snapshot)}
                </DetailRow>
              </DetailSection>

              {booking.materialCosts.length > 0 ? (
                <DetailSection label="料錢成本">
                  {/* 第 11 批 F #993:名稱 × 數量、小計 = 單價快照 × 數量(允許小數單價,不四捨五入到整數)。 */}
                  {booking.materialCosts.map((c) => (
                    <DetailRow key={c.materialCostItemId} label={`${c.name} × ${c.quantity ?? 1}`}>
                      {formatMaterialAmount(
                        Math.round(Number(c.amountSnapshot) * (c.quantity ?? 1) * 100) / 100,
                      )}
                    </DetailRow>
                  ))}
                </DetailSection>
              ) : null}

              {/* #996 第 11 批 K-4:料錢成本之後、記錄之前(這裡排在客戶 / 紅利 / 備註之前,緊接料錢區)。 */}
              {isCompletedOriginal && canSeeCommission ? (
                <BookingCommissionSection
                  bookingId={booking.id}
                  onBusyChange={setCommissionBusy}
                  onStateChanged={() => {
                    void queryClient.invalidateQueries({
                      queryKey: ["booking-module", "booking-detail", booking.id],
                    });
                    onChanged();
                  }}
                />
              ) : null}

              {/* 客戶端第 3 批(C3-E01):訪客預約 ⇒ 常駐提醒店家自己打電話確認(第七章)。 */}
              {customerBookingSourceKind(booking) === "guest" ? (
                <AlertNote data-testid="guest-booking-hint">{GUEST_BOOKING_BACKEND_HINT}</AlertNote>
              ) : null}

              <DetailSection label="客戶">
                <p className="min-w-0 break-words text-base font-semibold text-foreground">
                  {booking.customer_name}
                </p>
                {/* 模組 10(會員與紅利)§4.5:member_name_snapshot 有值才顯示這一列。有
                    members 權限(或管理員)才做成可點擊連結,否則只顯示純文字。 */}
                {booking.member_name_snapshot ? (
                  <DetailRow label="會員">
                    {canViewMemberProfile && booking.member_id ? (
                      <Link
                        to={`/app/members/${booking.member_id}`}
                        className="text-brand hover:underline"
                      >
                        {booking.member_name_snapshot}
                      </Link>
                    ) : (
                      booking.member_name_snapshot
                    )}
                  </DetailRow>
                ) : null}
                {/* skill 二之六:電話 tel: 直接撥號、地址開地圖導航,各佔一行不並排。 */}
                <DetailPhoneRow phone={booking.customer_phone} />
                {/* 任務 2:商家目前的產業需要地址(showCustomerAddress)且這筆訂單真的有
                    地址值,才顯示這一列——切成「到店服務」之後舊訂單的地址一律不顯示。 */}
                {showCustomerAddress && booking.customer_address ? (
                  <DetailAddressRow address={booking.customer_address} />
                ) : null}
              </DetailSection>

              {/* 紅利系統重構 §4.7:預定派點 / 已入帳。只看這張訂單自己的欄位(points_planned > 0 或
                  points_redeemed > 0),功能關閉後歷史紀錄仍要看得到。completed 之後純顯示。 */}
              {detailPoints?.show && detailPoints.plannedText ? (
                <DetailSection label="紅利點數">
                  <DetailRow label="預定派點">{detailPoints.plannedText}</DetailRow>
                  {detailPoints.earnedText ? (
                    <DetailRow label="入帳狀態">{detailPoints.earnedText}</DetailRow>
                  ) : booking.status !== "completed" ? (
                    <p className="text-right text-[12px] text-muted-foreground">訂單完成後才入帳</p>
                  ) : null}
                </DetailSection>
              ) : null}

              {booking.customer_notes || booking.notes ? (
                <DetailSection label="備註">
                  {booking.customer_notes ? (
                    <CustomerNote>{booking.customer_notes}</CustomerNote>
                  ) : null}
                  {/* SPECS-INDEX #854:🔒 標記要說實話 —— 這一筆勾了「不讓服務人員看到」時,
                      標記文字要從「客戶看不到,服務人員看得到」改成「客戶與服務人員都看不到」。
                      不改的話客服會看著詳情頁以為自己明明藏起來的備註服務人員還是看得到。 */}
                  {booking.notes ? (
                    <InternalNote
                      audience={booking.hide_notes_from_staff ? "staff-hidden" : "staff-visible"}
                    >
                      {booking.notes}
                    </InternalNote>
                  ) : null}
                </DetailSection>
              ) : null}

              <DetailSection label="記錄">
                <DetailRow label="建單時間" size="sm">
                  {isoToTaipeiDateTimeWithSeconds(booking.created_at)}
                </DetailRow>
                {booking.lastModifiedByName && booking.last_modified_at ? (
                  <DetailRow label="最後修改" size="sm">
                    {booking.lastModifiedByName} ・{" "}
                    {isoToTaipeiDateTimeWithSeconds(booking.last_modified_at)}
                  </DetailRow>
                ) : null}
              </DetailSection>

              {/* 模組 6 §3.3:相關訂單。§9.1(SPECS-INDEX #597):操作記錄。skill 二之六第 6 點:
                  「去別的地方看」做成可點的列 + ›,不是整條寬的按鈕。 */}
              <DetailLinkRows>
                <DetailLinkRow label="相關訂單" onClick={() => setShowRelated(true)} />
                <DetailLinkRow label="操作記錄" onClick={() => setShowLogs(true)} />
              </DetailLinkRows>
            </div>
          )}
        </FullPageLayerContent>
      </FullPageLayer>

      {/* 模組 11(LINE 通知)§4.8/規則 2.5:有實際會被通知的對象時才顯示,兩個選項都會執行
        confirm_booking(),差別只在於要不要額外呼叫 dispatchLineNotification。刻意放在 Sheet
        外層(獨立的 Radix AlertDialog root),避免巢狀在同一個 Sheet root 底下互相干擾。 */}
      <ConfirmBookingLineDialog
        open={showLineDialog}
        targets={lineDialogTargets}
        busy={busy}
        onOpenChange={setShowLineDialog}
        onChoice={(shouldNotify) => void doConfirm(shouldNotify)}
      />

      {/* #844 §5.4:差額 > 0 的小卡窗(只有一段文字 + 一顆「知道了」)。疊在全頁層之上(skill 三、兩層重疊)。
          關法(QA 實測):按「知道了」或按 Esc 都會關(Esc 等同「知道了」,走同一條 onOpenChange(false));
          點遮罩關不掉(Radix AlertDialog)。開窗焦點放在「知道了」,Enter 即可關。
          shortfall_hint 原文純文字顯示、保留換行,不做成連結(v1.2:提示裡沒有訂單 ID)。
          關掉之後才關全頁層並重抓。 */}
      <CardAlertDialog
        open={shortfallNotice !== null}
        onOpenChange={(next) => {
          // #965:旗標已經被全頁層那條路徑收掉(同一次 Esc 兩層都收到)就不再跑第二次,避免 onChanged 兩次。
          if (!next && shortfallPendingRef.current) finishReversal();
        }}
      >
        <CardAlertDialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            shortfallAckRef.current?.focus();
          }}
        >
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>{shortfallNotice?.title ?? ""}</CardAlertDialogTitle>
            <CardAlertDialogDescription
              className="whitespace-pre-line break-words"
              data-testid="reversal-shortfall-hint"
            >
              {shortfallNotice?.hint ?? ""}
            </CardAlertDialogDescription>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            {/* 不另外掛 onClick:Action 會關窗並觸發上面的 onOpenChange(false) → finishReversal,掛了會跑兩次。 */}
            <CardAlertDialogAction ref={shortfallAckRef}>知道了</CardAlertDialogAction>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>
    </>
  );
}
