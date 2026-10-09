// SPECS-INDEX #811~#817(規格書 .project/specs/行事曆拖拉改時間與轉派.md §四資料流、§五互動細節、§八手機)。
// 行事曆「拖拉改時間 / 轉派」的**接線層**:把 bookingDragMove.ts 的純邏輯(模式判定、落點計算、手勢狀態機)
// 接到真的 DOM 事件、殘影、toast、復原、確認框與 api.ts 的 moveBooking()。
//
// 為什麼獨立成一個檔案而不是直接寫進 CalendarPage.tsx:
//   CalendarPage.tsx 已經 2000 多行,而且整頁渲染要 mock 一大堆 context / react-query;把「色塊的事件綁定」
//   (DraggableBookingBlock)跟「拖拉控制器」(useCalendarBookingDrag)抽到這裡,元件測試
//   (calendarBookingDrag.test.tsx)就能用一個小小的假格線渲染**同一份**元件與 hook,測到的事件綁定跟
//   CalendarPage 實際用的是同一份程式碼,不是另外仿一份。
//
// 所有型別與判定邏輯都 import bookingDragMove.ts,這裡**不**重新宣告、**不**重新實作任何一條規則。
//
// =========================================================================
// 🔴 第 2 批 engineer 留下的 8 條坑,各自在哪裡處理(主腦複查用,每一條都有對應的程式碼位置):
//   1. touch-action: none 在手勢中才設是沒用的 → 見 setGridRoot():用原生 addEventListener("touchmove", h,
//      { passive: false }),handler 裡**只有** phase === "dragging" 才 preventDefault();其餘一律放行。
//      (React 的 onTouchMove 是 passive,preventDefault 會被忽略,所以一定要原生掛。)
//   2. pointerup 會發生在色塊外 → 見 onBlockPointerDown():e.currentTarget.setPointerCapture(e.pointerId)。
//   3. 色塊舊的 onClick 要拿掉 → 見 DraggableBookingBlock:可拖的色塊**沒有** onClick,開詳情改由 hook 的
//      onClick(≤ 閾值就放開)觸發;不可拖(已完成/已取消)的色塊才保留 onClick,因為 hook 對它們不進入 pressing。
//   4. 拖助手時 expectedStaffId 是主服務人員 → 見 describeDrop():mainStaffId 來自 indexBookingParticipants(),
//      expectedStaffId = mainStaffId,draggedStaffId = 色塊所在欄位(助手)。
//   5. timeChanged 用「吸附後 startMin」vs「timeToMinutes(isoToTaipeiTime(b.start_at))」比 → 見 describeDrop()。
//   6. 長按會觸發系統 context menu / iOS callout → DraggableBookingBlock 上 onContextMenu preventDefault +
//      靜態 CSS select-none 與 [-webkit-touch-callout:none](靜態 CSS 不影響捲動,可以無條件設)。
//   7. onDrop 回 Promise 時 hook 會停在 committing 直到 settle → handleDrop 是 async,整段 await;
//      §5.9 的 pointer-events-none 綁 phase === "committing"(見 isCommitting)。
//   8. 格線常數與閾值由呼叫端傳入 → CalendarBookingDragParams 的 slotMinutes / slotPx / thresholdPx。
// =========================================================================

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { toast } from "sonner";

// ui-v1-full 第 2 批(2026-09-29,盤點 #31):確認框改用 ui-overlay-patterns 的小卡窗純確認殼。
import {
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
} from "@/components/patterns";
import { cn } from "@/lib/utils";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { moveBooking, type MoveBookingNotifyContext } from "./api";
import { BookingBlockContent } from "./BookingBlockContent";
import { BOOKING_BLOCK_GAP_TOP_PX } from "./bookingBlockLayout";
import {
  buildUndoInput,
  canDrag,
  computeDropTarget,
  formatMoveHint,
  indexBookingParticipants,
  isDropInPast,
  resolveMoveMode,
  useBookingDragState,
  type DragSource,
  type DropColumnRect,
  type DropPayload,
  type DropTarget,
  type MoveBookingInput,
  type MoveBookingResult,
  type MoveModeResolution,
} from "./bookingDragMove";
import { buildTaipeiIso, isoToTaipeiTime, timeToMinutes } from "./dateUtils";
import type { BookingParticipantRole, DayScheduleOwnBooking, DayScheduleStaffBlock } from "./types";

/** SPECS-INDEX #873:詳情是從哪一張色塊打開的(主服務人員卡 / 「(協助)」卡 + 那一欄是誰)。 */
export interface BookingDetailOpener {
  role: BookingParticipantRole;
  staffId: string;
}

/** §4.5:成功 toast 存活多久,「復原」只在這段時間內提供。 */
export const UNDO_TOAST_DURATION_MS = 8000;
/** §5.11:游標離捲動容器左右邊緣多近就開始自動橫向捲動,以及每次移動捲多少 px。 */
const AUTO_SCROLL_EDGE_PX = 40;
const AUTO_SCROLL_STEP_PX = 16;
/** 落點在格線外時,殘影跟著游標走的預設寬度(格線內的殘影寬度 = 目標欄位寬)。 */
const OFF_GRID_GHOST_WIDTH_PX = 120;

const EMPTY_STAFF_BLOCKS: readonly DayScheduleStaffBlock[] = [];

export interface CalendarBookingDragParams {
  /** 目前顯示的那一天(YYYY-MM-DD),組 targetStartAt 用。 */
  dateKey: string;
  /** get_merchant_day_schedule 回傳的 staff[](含每欄的 bookings 與 on_leave)。 */
  staffBlocks: readonly DayScheduleStaffBlock[] | undefined;
  staffNameById: ReadonlyMap<string, string>;
  /** 第 0 格代表的「當天第幾分鐘」。 */
  gridStartMin: number;
  slotCount: number;
  /** 坑 8:由 CalendarPage 傳 SLOT_MINUTES / SLOT_PX / SLOT_TAP_VS_DRAG_THRESHOLD_PX,這裡不另外定義數字。 */
  slotMinutes: number;
  slotPx: number;
  thresholdPx: number;
  /**
   * #986 第 9 批(9-10、9-11):放開時吸附到幾分鐘 = 商家「建單時間間隔」。不傳 = 吸附到格線(跟改版前一樣)。
   * 格線、空白格選單、建單預帶時間都不受影響。
   */
  snapMinutes?: number | undefined;
  /**
   * SPECS-INDEX #1049:格線改成 00:00~24:00 之後,拖拉只能落在這段時間(= 營業時間,分鐘數),
   * 落點超出就夾回來(跟改版前「格線 = 營業時間、超出夾到邊界」相同)。不傳 = 整條格線。
   */
  dropRange?: { startMin: number; endMin: number } | undefined;
  /** ≤ 閾值就放開 = 點擊 → 開詳情(取代色塊原本的 onClick)。
   * SPECS-INDEX #873:第二個參數告訴詳情「是從哪一張色塊打開的」(主 / 協助 + 那一欄的服務人員),
   * 從「(協助)」色塊打開時,詳情要給「移除協助人員」而不是「取消預約」(原本兩張色塊都只傳 booking id,
   * 從協助卡按取消會把主服務人員的單一起取消)。 */
  onOpenDetail: (bookingId: string, opener: BookingDetailOpener) => void;
  /** 移動成功、或收到 40001(畫面過期)之後呼叫 → CalendarPage 傳 refetchAll(invalidateQueries)。 */
  onMoved: () => void;
  /**
   * SPECS-INDEX #977 第 7 批(2026-10-07):真正打 RPC 的那一支。不傳 = 商家端 moveBooking(行為不變);
   * 服務人員端時間軸傳 staffMoveBooking(只改時間、不能轉派,後端 staff_move_booking 再擋一次)。
   * 閾值、長按 500ms、吸附、過去時間確認、40001 重新整理、復原 8 秒這些規則都還是這支 hook 的,一條都不另寫。
   */
  moveFn?: (input: MoveBookingInput, ctx: MoveBookingNotifyContext) => Promise<MoveBookingResult>;
}

export interface DragGhostModel {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 殘影本體的樣式(沿用來源色塊的狀態顏色)。 */
  blockStyle: CSSProperties;
  label: string;
  /** 殘影旁的小字(formatMoveHint 的結果、或「移動中…」、或落在格線外的提示);null = 不顯示。 */
  hint: string | null;
  forbidden: boolean;
  /** 手機長按進入的拖拉:色塊「浮起」(放大 + 陰影)。 */
  lifted: boolean;
  committing: boolean;
}

export interface PastDropConfirmRequest {
  customerName: string;
  /** 吸附後的 "HH:MM"。 */
  time: string;
}

interface DropDescription {
  booking: DayScheduleOwnBooking;
  mainStaffId: string;
  target: DropTarget | null;
  resolution: MoveModeResolution | null;
  hint: string | null;
  ghost: Omit<DragGhostModel, "blockStyle" | "label" | "lifted" | "committing">;
}

function blockKey(staffId: string, bookingId: string): string {
  return `${staffId}::${bookingId}`;
}

/** 從格線根節點讀出每一欄(data-drag-column)的視窗座標;格線頂端 = 第一欄的 top。 */
function readColumnGeometry(root: HTMLElement | null): {
  rects: (DropColumnRect & { width: number })[];
  gridTop: number;
  /** sticky 時間欄視覺上蓋住的區域右邊界(見 computeDropTarget 的 occludedLeftClientX)。 */
  occludedLeft: number | undefined;
} | null {
  if (!root) return null;
  const nodes = root.querySelectorAll<HTMLElement>("[data-drag-column]");
  const rects: (DropColumnRect & { width: number })[] = [];
  let gridTop: number | null = null;
  nodes.forEach((node) => {
    const staffId = node.dataset["dragColumn"];
    if (!staffId) return;
    const r = node.getBoundingClientRect();
    rects.push({ staffId, left: r.left, right: r.right, width: r.width });
    if (gridTop === null) gridTop = r.top;
  });
  if (rects.length === 0 || gridTop === null) return null;
  // #846:左邊的 sticky 時間欄橫向捲動後會蓋在欄位上面,那一段 x 不可以算成底下那一欄的落點。
  // 讀的是 CalendarPage 標在左上角那一格上的 data-drag-time-gutter(時間欄與名字列的交叉格,
  // 它跟時間欄本體同寬、同一個 sticky left)。找不到就不傳,行為跟改版前一樣。
  const gutter = root.querySelector<HTMLElement>("[data-drag-time-gutter]");
  const occludedLeft = gutter ? gutter.getBoundingClientRect().right : undefined;
  return { rects, gridTop, occludedLeft };
}

function readErrorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/** §5.10 成功 toast 文案:帶客戶姓名 + 結果。 */
export function formatMoveSuccessMessage(
  result: MoveBookingResult,
  customerName: string,
  staffNameById: ReadonlyMap<string, string>,
): string {
  const nameOf = (id: string | null) =>
    id ? (staffNameById.get(id) ?? "這位服務人員") : "這位服務人員";
  const time = isoToTaipeiTime(result.next.start_at);
  if (result.mode === "time") return `已把 ${customerName} 的預約改到 ${time}`;
  if (result.mode === "reassign_assistant")
    return `${customerName} 預約的助手已改為 ${nameOf(result.next.assistant_staff_id)}`;
  const staff = nameOf(result.next.staff_id);
  return result.time_changed
    ? `已把 ${customerName} 的預約轉派給 ${staff}，並改到 ${time}`
    : `已把 ${customerName} 的預約轉派給 ${staff}`;
}

export function useCalendarBookingDrag(params: CalendarBookingDragParams) {
  const {
    dateKey,
    staffNameById,
    gridStartMin,
    slotCount,
    slotMinutes,
    slotPx,
    thresholdPx,
    snapMinutes,
    onOpenDetail,
    onMoved,
    moveFn,
  } = params;
  const staffBlocks = params.staffBlocks ?? EMPTY_STAFF_BLOCKS;
  // #1049:物件每次 render 都是新的 ⇒ 拆成兩個數字放進依賴陣列,避免拖拉中的計算函式每次都換身分。
  const dropRangeStartMin = params.dropRange?.startMin;
  const dropRangeEndMin = params.dropRange?.endMin;

  // --- 索引:每顆色塊的資料(依 欄位 + 訂單)、每筆訂單的主服務人員與助手清單(坑 4)、每欄是否整天休假。
  const blockIndex = useMemo(() => {
    const map = new Map<string, DayScheduleOwnBooking>();
    for (const s of staffBlocks) for (const b of s.bookings) map.set(blockKey(s.staff_id, b.id), b);
    return map;
  }, [staffBlocks]);
  const participantIndex = useMemo(() => indexBookingParticipants(staffBlocks), [staffBlocks]);
  const onLeaveStaffIds = useMemo(
    () => new Set(staffBlocks.filter((s) => s.on_leave).map((s) => s.staff_id)),
    [staffBlocks],
  );

  // --- 捲動容器(= 格線根節點):原生 touchmove 攔截(坑 1)與自動橫向捲動(§5.11)都掛在它身上。
  const rootRef = useRef<HTMLElement | null>(null);
  const phaseRef = useRef<"idle" | "pressing" | "dragging" | "committing">("idle");
  const touchMoveHandlerRef = useRef((e: TouchEvent) => {
    // 🔴 坑 1:只有真的在拖(長按之後)才擋原生捲動;pressing(長按前)與 idle 一律放行,#641 的
    // 「手指滑動 = 捲動」才不會壞。這裡不能用 React 的 onTouchMove(passive,preventDefault 無效)。
    if (phaseRef.current === "dragging" && e.cancelable) e.preventDefault();
  });
  const setGridRoot = useCallback((node: HTMLElement | null) => {
    const prev = rootRef.current;
    if (prev === node) return;
    if (prev) prev.removeEventListener("touchmove", touchMoveHandlerRef.current);
    rootRef.current = node;
    if (node) node.addEventListener("touchmove", touchMoveHandlerRef.current, { passive: false });
  }, []);
  useEffect(() => () => setGridRoot(null), [setGridRoot]);

  // --- 過去時間確認框(Q3=B):handleDrop 在這裡 await 使用者的答案。
  const [pastConfirm, setPastConfirm] = useState<PastDropConfirmRequest | null>(null);
  const pastResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const askPastConfirm = useCallback((request: PastDropConfirmRequest) => {
    return new Promise<boolean>((resolve) => {
      pastResolverRef.current = resolve;
      setPastConfirm(request);
    });
  }, []);
  const resolvePastConfirm = useCallback((ok: boolean) => {
    const resolve = pastResolverRef.current;
    pastResolverRef.current = null;
    setPastConfirm(null);
    resolve?.(ok);
  }, []);

  // --- committing 期間殘影停在目標格(§四 [3]),資料放在這裡(dragging 期間的殘影是每次 render 現算的)。
  const [committingGhost, setCommittingGhost] = useState<DragGhostModel | null>(null);
  const blockStyleRef = useRef<CSSProperties>({});

  /** 把「這顆色塊 + 目前游標位置」翻譯成 落點 / 模式 / 殘影位置(坑 4、坑 5 都在這裡)。 */
  const describeDrop = useCallback(
    (
      source: DragSource,
      pointer: { x: number; y: number },
      grabOffsetY: number,
    ): DropDescription | null => {
      const booking = blockIndex.get(blockKey(source.staffId, source.bookingId));
      if (!booking) return null;
      const participants = participantIndex.get(booking.id);
      const mainStaffId =
        participants?.mainStaffId ?? (source.role === "main" ? source.staffId : null);

      const bStartMin = timeToMinutes(isoToTaipeiTime(booking.start_at));
      const bEndMin = timeToMinutes(isoToTaipeiTime(booking.end_at));
      const durationMin = Math.max(0, bEndMin - bStartMin);
      const height = Math.max(slotPx / 2, (durationMin / slotMinutes) * slotPx);

      const geometry = readColumnGeometry(rootRef.current);
      const target = geometry
        ? computeDropTarget({
            pointerClientX: pointer.x,
            pointerClientY: pointer.y,
            grabOffsetY,
            gridTopClientY: geometry.gridTop,
            gridStartMin,
            slotMinutes,
            slotPx,
            slotCount,
            durationMin,
            columnRects: geometry.rects,
            occludedLeftClientX: geometry.occludedLeft,
            snapMinutes,
            dropRange:
              dropRangeStartMin != null && dropRangeEndMin != null
                ? { startMin: dropRangeStartMin, endMin: dropRangeEndMin }
                : undefined,
          })
        : null;

      if (!geometry || !target) {
        // 落在格線外(左邊時間軸 / 最右欄以外):殘影跟著游標走,放開 = 取消(§5.7)。
        return {
          booking,
          mainStaffId: mainStaffId ?? source.staffId,
          target: null,
          resolution: null,
          hint: "放開會取消",
          ghost: {
            left: pointer.x - OFF_GRID_GHOST_WIDTH_PX / 2,
            top: pointer.y - grabOffsetY,
            width: OFF_GRID_GHOST_WIDTH_PX,
            height,
            hint: "放開會取消",
            forbidden: false,
          },
        };
      }

      const targetStaffName = staffNameById.get(target.staffId) ?? "這位服務人員";
      // 坑 4:助手色塊要知道主服務人員是誰;整天的排程裡找不到主服務人員就不讓拖(送不出正確的 expectedStaffId)。
      const resolution: MoveModeResolution = mainStaffId
        ? resolveMoveMode({
            draggedRole: source.role,
            draggedStaffId: source.staffId,
            mainStaffId,
            assistantStaffIds: participants?.assistantStaffIds ?? [],
            targetStaffId: target.staffId,
            // 坑 5:跟「吸附後的 startMin」比;10:10 這種不在格線上的單,放回原位也會是 true(§七,預期行為)。
            timeChanged: target.startMin !== bStartMin,
            targetStaffName,
          })
        : { kind: "forbidden", reason: "找不到這筆預約的主服務人員，請重新整理" };

      let hint = formatMoveHint(resolution, { targetStaffName, startTime: target.startTime });
      // §四 [1]:整天休假的欄位在拖拉中顯示為不可放置(後端才是真正擋下的那一層,這裡只是提示)。
      if (resolution.kind === "move" && onLeaveStaffIds.has(target.staffId)) {
        hint = `⚠️ ${targetStaffName} 這天休假，放開會被擋下`;
      }

      const column = geometry.rects.find((c) => c.staffId === target.staffId) ?? geometry.rects[0]!;
      // Q2 衍生邊界 2:助手色塊斜拖時,殘影吸附回**原本的時間高度**、只換欄位,讓人看得出時間沒動。
      const ghostTop =
        source.role === "assistant"
          ? geometry.gridTop + ((bStartMin - gridStartMin) / slotMinutes) * slotPx
          : // #986 第 9 批:用吸附後的 startMin 換算(落點可能在格子中間);沒吸附間隔時 = slotIndex × slotPx,跟改版前相同。
            geometry.gridTop + ((target.startMin - gridStartMin) / slotMinutes) * slotPx;
      const viewportWidth =
        typeof window !== "undefined" ? window.innerWidth : Number.POSITIVE_INFINITY;
      return {
        booking,
        mainStaffId: mainStaffId ?? source.staffId,
        target,
        resolution,
        hint,
        ghost: {
          left: Math.max(0, Math.min(column.left, viewportWidth - column.width)),
          top: ghostTop,
          width: column.width,
          height,
          hint,
          forbidden: resolution.kind === "forbidden",
        },
      };
    },
    [
      blockIndex,
      participantIndex,
      onLeaveStaffIds,
      staffNameById,
      gridStartMin,
      slotCount,
      slotMinutes,
      slotPx,
      snapMinutes,
      dropRangeStartMin,
      dropRangeEndMin,
    ],
  );

  /** 真的打 RPC:成功 → refetch + toast(帶復原);失敗 → toast「無法移動」+ 後端原文;40001 額外 refetch。 */
  const executeMove = useCallback(
    async (input: MoveBookingInput, customerName: string, undoOf: MoveBookingResult | null) => {
      const targetStaffName = staffNameById.get(input.targetStaffId) ?? null;
      try {
        const result = await (moveFn ?? moveBooking)(input, { targetStaffName });
        onMoved();
        if (undoOf) {
          toast.success("已復原");
          return;
        }
        toast.success(formatMoveSuccessMessage(result, customerName, staffNameById), {
          duration: UNDO_TOAST_DURATION_MS,
          action: {
            label: "復原",
            // §四 [7]:復原 = 用 buildUndoInput 再呼叫一次 move_booking(會重新驗證、也會再送推播)。
            onClick: () => {
              void executeMove(buildUndoInput(result), customerName, result);
            },
          },
        });
      } catch (err) {
        const message = getErrorMessage(err);
        if (readErrorCode(err) === "40001") {
          // §四 [6]:畫面過期 → warning + 把別人改過的最新狀態抓回來。
          toast.warning(message);
          onMoved();
          return;
        }
        toast.error(undoOf ? "無法復原" : "無法移動", { description: message });
      }
    },
    [onMoved, staffNameById, moveFn],
  );

  const handleDrop = useCallback(
    async (payload: DropPayload) => {
      const info = describeDrop(payload.source, payload.pointer, payload.grabOffsetY);
      // §5.7 格線外 / 找不到色塊 → 取消,不打 RPC、不 toast。
      if (!info || !info.target || !info.resolution) return;
      // §5.8 / 對照表列 1、列 6:無操作 → 不打 RPC、不 toast(列 6 給一個很輕的提示)。
      if (info.resolution.kind === "noop") {
        if (info.resolution.hint) toast.info(info.resolution.hint);
        return;
      }
      // forbidden:拖拉中殘影旁已經顯示 ❌ 原因,放開就靜默回彈(§四 [3])。
      if (info.resolution.kind === "forbidden") return;

      const input: MoveBookingInput = {
        bookingId: info.booking.id,
        draggedStaffId: payload.source.staffId,
        targetStaffId: info.target.staffId,
        targetStartAt: buildTaipeiIso(dateKey, info.target.startTime),
        expectedStartAt: info.booking.start_at,
        // 🔴 坑 4:一律是主服務人員(拖助手時也是),不是被拖的那一欄。
        expectedStaffId: info.mainStaffId,
      };

      setCommittingGhost({
        ...info.ghost,
        blockStyle: blockStyleRef.current,
        label: info.booking.customer_name,
        lifted: false,
        hint: "移動中…",
        forbidden: false,
        committing: true,
      });
      try {
        // Q3=B:拖到過去的時間 → 先跳確認框,取消就回彈、不打 RPC。
        if (isDropInPast(info.resolution, input.targetStartAt)) {
          const ok = await askPastConfirm({
            customerName: info.booking.customer_name,
            time: info.target.startTime,
          });
          if (!ok) return;
        }
        await executeMove(input, info.booking.customer_name, null);
      } finally {
        setCommittingGhost(null);
      }
    },
    [askPastConfirm, dateKey, describeDrop, executeMove],
  );

  const drag = useBookingDragState({
    thresholdPx,
    onClick: (source) =>
      onOpenDetail(source.bookingId, { role: source.role, staffId: source.staffId }),
    onDrop: handleDrop,
  });
  phaseRef.current = drag.phase;

  // §5.4:拖拉期間 body 不可選取文字(用 inline style,不依賴某個 class 有沒有被 Tailwind 產出)。
  const isDragging = drag.isDragging;
  useEffect(() => {
    if (!isDragging || typeof document === "undefined") return;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = previous;
    };
  }, [isDragging]);

  // --- dragging 期間的即時預覽(殘影位置 / 小字 / 欄位高亮),每次 pointer 更新就重算。
  const livePreview = useMemo(() => {
    if (drag.phase !== "dragging" || !drag.drag) return null;
    return describeDrop(drag.drag.source, drag.drag.pointer, drag.drag.grabOffsetY);
  }, [describeDrop, drag.phase, drag.drag]);

  const ghost: DragGhostModel | null = useMemo(() => {
    if (drag.phase === "committing") return committingGhost;
    if (!livePreview || !drag.drag) return null;
    return {
      ...livePreview.ghost,
      blockStyle: blockStyleRef.current,
      label: livePreview.booking.customer_name,
      lifted: drag.drag.viaLongPress,
      committing: false,
    };
  }, [committingGhost, drag.drag, drag.phase, livePreview]);

  // §5.4:游標下方的欄位加 ring(只在 dragging 期間;committing 期間殘影已停在目標格,不再高亮)。
  const highlightedStaffId =
    drag.phase === "dragging" ? (livePreview?.target?.staffId ?? null) : null;
  const highlightForbidden = livePreview?.resolution?.kind === "forbidden";

  // --- 色塊的事件綁定(DraggableBookingBlock 用)。hook 回傳的 handler 本身是穩定的 useCallback,
  //     這裡只取用它們,不把整個 drag 物件放進 deps。
  const { onPointerDown: dragPointerDown, onPointerMove: dragPointerMove } = drag;
  const onBlockPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, source: DragSource, blockStyle: CSSProperties) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // 🔴 坑 2:把後續的 pointermove / pointerup 綁在這顆色塊上,游標離開色塊(甚至離開欄位)也收得到。
      //    jsdom 沒有這個方法,所以用可選呼叫 + try/catch(測試裡會另外 stub 它來斷言有被呼叫)。
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        // 某些瀏覽器在 pointer 已經結束時會丟例外,忽略即可。
      }
      blockStyleRef.current = blockStyle;
      dragPointerDown(
        { pointerType: e.pointerType, clientX: e.clientX, clientY: e.clientY, button: e.button },
        source,
      );
    },
    [dragPointerDown],
  );

  const onBlockPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      dragPointerMove({ pointerType: e.pointerType, clientX: e.clientX, clientY: e.clientY });
      // §5.11:拖拉中游標接近捲動容器左右邊緣 → 自動橫向捲動(只在游標移動時推進,不做 rAF 迴圈)。
      const root = rootRef.current;
      if (phaseRef.current === "dragging" && root && root.scrollWidth > root.clientWidth) {
        const r = root.getBoundingClientRect();
        if (e.clientX < r.left + AUTO_SCROLL_EDGE_PX) root.scrollLeft -= AUTO_SCROLL_STEP_PX;
        else if (e.clientX > r.right - AUTO_SCROLL_EDGE_PX) root.scrollLeft += AUTO_SCROLL_STEP_PX;
      }
    },
    [dragPointerMove],
  );

  return {
    phase: drag.phase,
    isDragging,
    /** §5.9:committing 期間整個格線 pointer-events-none。 */
    isCommitting: drag.phase === "committing",
    /** 目前被拖的那顆色塊(原位留 opacity-40 佔位)。 */
    activeSource: drag.drag?.source ?? null,
    highlightedStaffId,
    highlightForbidden,
    ghost,
    pastConfirm,
    resolvePastConfirm,
    setGridRoot,
    openDetail: onOpenDetail,
    onBlockPointerDown,
    onBlockPointerMove,
    onBlockPointerUp: drag.onPointerUp,
    onBlockPointerCancel: drag.onPointerCancel,
  };
}

export type CalendarBookingDragController = ReturnType<typeof useCalendarBookingDrag>;

// ---------------------------------------------------------------------------
// 色塊:CalendarPage 原本的 <button> 搬到這裡,加上手勢綁定。
// ---------------------------------------------------------------------------

export interface DraggableBookingBlockProps {
  booking: DayScheduleOwnBooking;
  /** 這顆色塊所在的欄位(= draggedStaffId)。 */
  staffId: string;
  /** top / height / 狀態顏色,由 CalendarPage 算好傳進來(跟改版前一模一樣)。 */
  style: CSSProperties;
  controller: Pick<
    CalendarBookingDragController,
    | "activeSource"
    | "openDetail"
    | "onBlockPointerDown"
    | "onBlockPointerMove"
    | "onBlockPointerUp"
    | "onBlockPointerCancel"
  >;
}

export function DraggableBookingBlock({
  booking: b,
  staffId,
  style,
  controller,
}: DraggableBookingBlockProps) {
  // §5.1:只有 pending_confirmation / accepted 可拖(cursor-grab);已完成/已取消 cursor-default、不進入 pressing。
  const draggable = canDrag(b.status);
  const isSource =
    controller.activeSource !== null &&
    controller.activeSource.bookingId === b.id &&
    controller.activeSource.staffId === staffId;

  return (
    <button
      type="button"
      data-testid={`booking-block-${b.id}-${b.role}`}
      data-booking-id={b.id}
      data-role={b.role}
      data-staff-id={staffId}
      data-drag-source={isSource ? "true" : undefined}
      // SPECS-INDEX #982:手機下拉刷新碰到可拖的色塊一律不觸發(長按 0.5 秒後是拖拉改時間)。
      // 判斷在 src/lib/pullToRefresh.ts 的 OPT_OUT_SELECTOR。
      data-booking-draggable={draggable ? "true" : undefined}
      className={cn(
        // 坑 6:select-none + -webkit-touch-callout:none 是靜態 CSS,不影響捲動,無條件設。
        // 🔴 z-10 是行事曆層級階梯的**最低**一層,不要往上調(2026-09-30 使用者實機巡檢修正):
        //      訂單色塊 z-10 < 服務人員名字列 z-20 < 時間欄 z-30 < 左上角那一格 z-40
        //    色塊只需要蓋住它底下的背景格線(那些格子沒有 z-index),但**必須被兩個 sticky 固定欄
        //    蓋住** —— 往下捲時名字列要蓋住它,往右捲時時間欄要蓋住它。原本名字列也是 z-10,
        //    同級 ⇒ DOM 順序後畫的色塊蓋住名字列,把服務人員名字整排蓋掉。
        //    完整的階梯表寫在 CalendarPage.tsx 時間欄那一段的註解裡(搜 "層級階梯")。
        // #1012 追加(第 18 批):inset-x-[3px] = 左右各內縮 3px(BOOKING_BLOCK_INSET_X_PX),相鄰兩位服務人員
        //    的卡片之間留約 7px(含 1px 欄線)看得到欄底色。服務人員端用 inline style 的 left / right 蓋過。
        "absolute inset-x-[3px] z-10 select-none overflow-hidden rounded-sm border p-1 text-left text-[11px] leading-tight shadow-sm [-webkit-touch-callout:none]",
        draggable ? "cursor-grab" : "cursor-default",
        // §5.4:dragging 期間原色塊 opacity-40 留在原位當佔位。
        isSource && "opacity-40",
      )}
      style={style}
      // 🔴 坑 3:可拖的色塊**沒有** onClick——放開 ≤ 閾值時由 hook 的 onClick 開詳情;
      //    否則拖完放開瀏覽器補發的那個 click 會把詳情彈出來。不可拖的色塊 hook 不會進入 pressing,
      //    所以保留原本的 onClick 讓它照舊可以點開詳情。
      onClick={draggable ? undefined : () => controller.openDetail(b.id, { role: b.role, staffId })}
      onPointerDown={
        draggable
          ? (e) =>
              controller.onBlockPointerDown(
                e,
                {
                  bookingId: b.id,
                  role: b.role,
                  staffId,
                  status: b.status,
                  // #1012 追加:卡片畫的位置往下內縮了 GAP_TOP,這裡加回去 = 時間格的上緣,落點計算不受影響。
                  blockTopClientY:
                    e.currentTarget.getBoundingClientRect().top - BOOKING_BLOCK_GAP_TOP_PX,
                },
                style,
              )
          : undefined
      }
      onPointerMove={draggable ? controller.onBlockPointerMove : undefined}
      onPointerUp={draggable ? controller.onBlockPointerUp : undefined}
      onPointerCancel={draggable ? controller.onBlockPointerCancel : undefined}
      // 坑 6:長按不要跳出系統右鍵選單 / iOS 文字選取 callout。
      onContextMenu={draggable ? (e) => e.preventDefault() : undefined}
    >
      {/* #1005(第 14 批):卡片內容改成「時間標籤 / 虛線 / 名字」,半小時卡片一行(商家端、服務人員端共用)。 */}
      <BookingBlockContent
        startAt={b.start_at}
        name={`${b.customer_name}${b.role === "assistant" ? "(協助)" : ""}`}
        height={typeof style.height === "number" ? style.height : undefined}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// 殘影:position: fixed 跟著游標並吸附到格線(§5.4),旁邊一行模式小字(§5.5)。
// ---------------------------------------------------------------------------

export function BookingDragGhost({ ghost }: { ghost: DragGhostModel | null }) {
  if (!ghost) return null;
  return (
    <div
      data-testid="booking-drag-ghost"
      data-drag-committing={ghost.committing ? "true" : undefined}
      aria-hidden="true"
      className="pointer-events-none fixed z-50"
      style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height }}
    >
      <div
        className={cn(
          "h-full w-full overflow-hidden rounded-sm border-2 p-1 text-left text-[11px] leading-tight shadow-lg transition-transform",
          ghost.forbidden ? "border-destructive" : "border-brand",
          ghost.lifted && "scale-[1.03]",
          ghost.committing && "opacity-70",
        )}
        style={ghost.blockStyle}
      >
        <p className="truncate font-medium">{ghost.label}</p>
      </div>
      {ghost.hint ? (
        <div
          data-testid="booking-drag-hint"
          className={cn(
            "absolute left-0 top-full mt-1 max-w-[70vw] truncate rounded px-2 py-0.5 text-[11px] shadow",
            ghost.forbidden
              ? "bg-destructive text-destructive-foreground"
              : "bg-foreground text-background",
          )}
        >
          {ghost.hint}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Q3=B:拖到過去的時間,放開前先確認。
// ---------------------------------------------------------------------------

export function PastDropConfirmDialog({
  request,
  onResolve,
}: {
  request: PastDropConfirmRequest | null;
  onResolve: (ok: boolean) => void;
}) {
  return (
    // 小卡窗純確認(skill 三):移到過去的時間是可以再拖回來的可逆動作 ⇒ 確認鈕用主要樣式、不標紅。
    <CardAlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onResolve(false);
      }}
    >
      <CardAlertDialogContent data-testid="booking-drag-past-confirm">
        <CardAlertDialogHeader>
          <CardAlertDialogTitle>要移到已經過去的時間嗎？</CardAlertDialogTitle>
          <CardAlertDialogDescription>
            你正在把 {request?.customerName ?? ""} 的預約移到已經過去的 {request?.time ?? ""}
            ，確定嗎？
          </CardAlertDialogDescription>
        </CardAlertDialogHeader>
        <CardAlertDialogFooter>
          <CardAlertDialogCancel onClick={() => onResolve(false)}>取消</CardAlertDialogCancel>
          <CardAlertDialogAction onClick={() => onResolve(true)}>確定移動</CardAlertDialogAction>
        </CardAlertDialogFooter>
      </CardAlertDialogContent>
    </CardAlertDialog>
  );
}
