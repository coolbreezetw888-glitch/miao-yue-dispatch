// SPECS-INDEX #811~#817、#820(規格書 .project/specs/行事曆拖拉改時間與轉派.md §3.3、§五、§八、§十一之〇)。
// 行事曆「拖拉改時間 / 轉派」的前端純邏輯:全部是不碰 DOM、不碰 react-query 的純函式 + 一支手勢 hook,
// 讓 Vitest(bookingDragMove.test.ts)可以直接餵物件測,不用整個渲染 CalendarPage。
//
// 這個檔案刻意**不 import CalendarPage.tsx**(第 3 批接線時 CalendarPage 會 import 這裡,反過來 import
// 會變成循環依賴)。所以格線常數(SLOT_MINUTES / SLOT_PX)與 #641 的閾值(SLOT_TAP_VS_DRAG_THRESHOLD_PX)
// 都**不在這裡重新定義數字**,而是由呼叫端當參數傳進來:
//   - computeDropTarget({ slotMinutes, slotPx, ... }) ← CalendarPage 傳 SLOT_MINUTES / SLOT_PX
//   - useBookingDragState({ thresholdPx, ... })      ← CalendarPage 傳 SLOT_TAP_VS_DRAG_THRESHOLD_PX
//
// =========================================================================
// 🔴【模式判定 —— 前後端必須用同一張表】
// 這裡的 resolveMoveMode() 跟資料庫函式 public.move_booking(supabase/migrations/20260928010000_move_booking.sql)
// 對 Q1 / Q2 / Q5 三個灰色地帶的判定,**逐格對齊** `.project/specs/行事曆拖拉_模式判定對照表.md` §二那 9 列;
// 後端由 pgTAP supabase/tests/database/calendar_drag_01_move_booking.sql 釘住,前端由 bookingDragMove.test.ts 釘住,
// 兩邊用的是同一張表(規格書 §十二 風險 1:只要有一邊套錯,就會出現「畫面說轉派、資料庫改了時間」)。
//
// 使用者裁決(2026-09-27,規格書 §十一之〇):
//   Q1 主色塊斜拖        = B:人跟時間一起改。mode 仍是 "reassign_main",靠 timeChanged=true 表達「時間也動了」。
//   Q2 拖助手色塊        = 使用者新規則:一律只換助手,時間維度完全忽略(助手的時間跟著主服務人員走)。
//                          助手拖回自己那一欄 = 換成自己 = 無操作(不打 RPC)。
//   Q3 拖到過去的時間    = B:允許,但放開前先跳確認框(isDropInPast() 是那個守門,不在 mode 判定裡)。
//   Q4 手機觸控          = B:這次一起做 —— 長按 TOUCH_LONG_PRESS_MS 才進入拖拉;長按前的手指移動一律是捲動(#641 不變)。
//   Q5 主轉派給既有助手  = A:擋下。
//
// 一句話記法:**主色塊控制「時間 + 主服務人員」,助手色塊只控制「誰是助手」。**
// =========================================================================

import { useCallback, useEffect, useRef, useState } from "react";

import { minutesToTime } from "./dateUtils";
import type { BookingParticipantRole, BookingStatus, DayScheduleStaffBlock } from "./types";

// ---------------------------------------------------------------------------
// 0. 跟後端 RPC 一一對應的型別(第 3 批的 api.ts moveBooking() 直接 import 這裡,不要再宣告一份)
// ---------------------------------------------------------------------------

/** `public.move_booking` 的六個參數(camelCase)。 */
export interface MoveBookingInput {
  bookingId: string;
  /** 被拖那顆色塊屬於哪位服務人員(後端用它判定是主還是助手)。 */
  draggedStaffId: string;
  /** 放開時落在哪位服務人員的欄位。 */
  targetStaffId: string;
  /** 放開時色塊頂端落在哪一格(ISO 字串,已吸附到格線或 #986 的建單時間間隔)。助手模式會被後端忽略,但仍要帶。 */
  targetStartAt: string;
  /** 畫面上「拖之前」看到的 bookings.start_at(畫面過期偵測)。 */
  expectedStartAt: string;
  /** 畫面上「拖之前」看到的 bookings.staff_id —— 注意是**主服務人員**,拖助手時也是帶主服務人員。 */
  expectedStaffId: string;
}

export type MoveBookingMode = "time" | "reassign_main" | "reassign_assistant";

export interface MoveBookingSnapshot {
  start_at: string;
  end_at: string;
  staff_id: string;
  assistant_staff_id: string | null;
}

/** `public.move_booking` 的回傳(對照表 §三)。`booking` 整列的欄位這裡用不到,所以只要求 `id`。 */
export interface MoveBookingResult {
  mode: MoveBookingMode;
  booking: { id: string } & Record<string, unknown>;
  previous: MoveBookingSnapshot;
  next: MoveBookingSnapshot;
  /** 斜拖(對照表列 4)mode 仍是 reassign_main,靠這個知道時間也動了。 */
  time_changed: boolean;
  /** reassign_assistant 一律 true;time 一律 false。 */
  staff_changed: boolean;
}

// ---------------------------------------------------------------------------
// 1. resolveMoveMode —— 三條規則 + Q1/Q2/Q5 的唯一前端實作位置
// ---------------------------------------------------------------------------

export interface ResolveMoveModeInput {
  /** 被拖那顆色塊的 `b.role`。 */
  draggedRole: BookingParticipantRole;
  /** 被拖那顆色塊所在欄位的 staff_id。 */
  draggedStaffId: string;
  /** 這筆單的 `bookings.staff_id`(主服務人員)。主色塊時等於 draggedStaffId;助手色塊時要另外查(見 indexBookingParticipants)。 */
  mainStaffId: string;
  /** 這筆單目前所有助手的 staff_id(schema 允許多位)。 */
  assistantStaffIds: readonly string[];
  /** 放開時所在欄位的 staff_id。 */
  targetStaffId: string;
  /** 吸附後的開始時間 ≠ 色塊原本的 start_at。 */
  timeChanged: boolean;
  /** 目標服務人員的姓名,只用來組提示文字;沒帶就用「這位服務人員」。 */
  targetStaffName?: string;
}

export type MoveModeResolution =
  /** 會真的打 RPC。`timeChanged` / `staffChanged` 跟後端回傳的兩個布林同義,第 3 批用它們算殘影小字與 toast 文案。 */
  | { kind: "move"; mode: MoveBookingMode; timeChanged: boolean; staffChanged: boolean }
  /** 不打 RPC、不 toast,色塊彈回原位;`hint` 可以當很輕的提示(對照表列 1 不顯示、列 6 顯示)。 */
  | { kind: "noop"; hint: string | null }
  /** 不打 RPC;殘影旁顯示 ❌ + reason。 */
  | { kind: "forbidden"; reason: string };

/**
 * 對照表 §二 的 9 列,一列一個分支(註解的「列 N」就是對照表的列號)。
 * 前端判斷只是為了在放開前就能給提示,不是安全邊界 —— RPC 端會再判一次。
 */
export function resolveMoveMode(input: ResolveMoveModeInput): MoveModeResolution {
  const {
    draggedRole,
    draggedStaffId,
    mainStaffId,
    assistantStaffIds,
    targetStaffId,
    timeChanged,
  } = input;
  const targetName = input.targetStaffName?.trim() || "這位服務人員";
  // 對照表 §一:staffChanged 是跟**主服務人員**比,不是跟 draggedStaffId 比。
  const staffChanged = targetStaffId !== mainStaffId;
  const targetIsAssistant = assistantStaffIds.includes(targetStaffId);

  if (draggedRole === "main") {
    // 列 1:放開在原位 → 無操作(不顯示提示)。
    if (!staffChanged && !timeChanged) return { kind: "noop", hint: null };

    // 列 5(Q5=A):主轉派給「已經是本單助手」的人 → 擋下。時間有沒有變都一樣擋(對照表「任意」)。
    if (staffChanged && targetIsAssistant) {
      return { kind: "forbidden", reason: `${targetName}已經是助手，請先用編輯改掉` };
    }

    // 列 2:同一欄、其他時間 → time。
    if (!staffChanged)
      return { kind: "move", mode: "time", timeChanged: true, staffChanged: false };

    // 列 3(同高度)/ 列 4(斜拖,Q1=B):都是 reassign_main,差別只在 timeChanged。
    return { kind: "move", mode: "reassign_main", timeChanged, staffChanged: true };
  }

  // 以下是助手色塊:時間維度完全忽略(Q2),所以下面每個分支都不看 timeChanged。

  // 列 6:助手拖回自己那一欄(不論時間)→ 無操作,給輕提示。
  if (targetStaffId === draggedStaffId) {
    return { kind: "noop", hint: "助手沒有自己的時間，要改時間請拖主服務人員的色塊" };
  }

  // 列 8:目標是本單主服務人員;列 9:目標是本單另一位助手 → 都擋下,同一句話。
  if (targetStaffId === mainStaffId || targetIsAssistant) {
    return { kind: "forbidden", reason: "這位已經在這筆預約裡了" };
  }

  // 列 7(Q2):別人 → reassign_assistant;timeChanged 一律回 false,跟後端 time_changed=false 一致。
  return { kind: "move", mode: "reassign_assistant", timeChanged: false, staffChanged: true };
}

/**
 * 殘影旁的小字(對照表 §二「前端提示」欄)。`startTime` 是吸附後的 "HH:MM"。
 * 回 null 代表不顯示(列 1)。
 */
export function formatMoveHint(
  resolution: MoveModeResolution,
  ctx: { targetStaffName: string; startTime: string },
): string | null {
  if (resolution.kind === "noop") return resolution.hint;
  if (resolution.kind === "forbidden") return `❌ ${resolution.reason}`;
  if (resolution.mode === "time") return `改時間 → ${ctx.startTime}`;
  if (resolution.mode === "reassign_assistant") return `助手改為 ${ctx.targetStaffName}`;
  return resolution.timeChanged
    ? `轉派給 ${ctx.targetStaffName}，並改時間 → ${ctx.startTime}`
    : `轉派給 ${ctx.targetStaffName}`;
}

/**
 * 從 get_merchant_day_schedule 的回傳,建出「每筆訂單的主服務人員是誰、助手有哪些」。
 * 畫面上每顆色塊只知道自己的 role 跟所在欄位,拖**助手**色塊時需要知道主服務人員(mainStaffId、
 * expectedStaffId 都要用它)跟其他助手(列 9),所以先掃一遍整天的排程建索引。
 */
export interface BookingParticipants {
  mainStaffId: string | null;
  assistantStaffIds: string[];
}

export function indexBookingParticipants(
  staffBlocks: readonly Pick<DayScheduleStaffBlock, "staff_id" | "bookings">[],
): Map<string, BookingParticipants> {
  const map = new Map<string, BookingParticipants>();
  for (const block of staffBlocks) {
    for (const b of block.bookings) {
      let entry = map.get(b.id);
      if (!entry) {
        entry = { mainStaffId: null, assistantStaffIds: [] };
        map.set(b.id, entry);
      }
      if (b.role === "main") entry.mainStaffId = block.staff_id;
      else if (!entry.assistantStaffIds.includes(block.staff_id))
        entry.assistantStaffIds.push(block.staff_id);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// 2. computeDropTarget —— 落點計算(以色塊頂端為準、round 到最近格、上下 clamp、X 在格線外 → null)
// ---------------------------------------------------------------------------

export interface DropColumnRect {
  staffId: string;
  /** 欄位在視窗座標的左右邊界(getBoundingClientRect 的 left/right)。 */
  left: number;
  right: number;
}

export interface ComputeDropTargetInput {
  pointerClientX: number;
  pointerClientY: number;
  /**
   * 🔴 被左邊固定欄(sticky 時間欄)**視覺上蓋住**的區域右邊界,視窗座標。沒有固定欄就不傳。
   *
   * 為什麼需要它(2026-09-30 QA 抓到的 sticky 副作用):時間欄是 `position: sticky`,橫向捲動之後
   * 它**蓋在**最左邊 72px 上面,但被蓋住那一欄的 `getBoundingClientRect()` 仍然涵蓋那段 x ——
   * 落點判定只看「x 在不在欄位 rect 內」,於是「手指看起來按在時間欄上,落點卻算進被蓋住的那一欄」。
   *
   * 🔴 **這條守門擋的是完整的 0~72px(整段被時間欄蓋住的區域),不是只擋 40~72px。**
   * (2026-09-30 修正:這段註解原本寫「`AUTO_SCROLL_EDGE_PX = 40` 吃掉最左 40px,剩下
   * 40~72px 這 32px 就是誤判帶」,會讓人以為守門只蓋 40~72 那一段。實作是
   * `x < occludedLeftClientX` ⇒ 一律 null,**整段 0~72px 都擋**。)
   * 📌 `AUTO_SCROLL_EDGE_PX = 40`(定義在 calendarBookingDrag.tsx)**只動 `scrollLeft`**
   * ——它讓最左 40px 觸發自動橫向捲動,**完全不抑制落點計算**。手指停在最左 20px 時,
   * 畫面會一邊自動往左捲,一邊照樣每一幀重算落點;所以那 40px 的落點也必須由這條守門擋下,
   * 不能指望自動捲動「順便」處理掉。
   *
   * x 落在這個邊界左邊一律視為「格線外」⇒ 回 null ⇒ 放開 = 取消,跟按在時間欄上看起來的意思一致。
   *
   * 📌 沒有捲動時這個值剛好等於第一欄的 left,行為跟改版前完全一樣(#641/#811 的手勢分工不受影響)。
   */
  occludedLeftClientX?: number | undefined;
  /** 按下當時「游標 Y − 色塊頂端 Y」。落點以色塊頂端所在格為準,不是游標所在格。 */
  grabOffsetY: number;
  /** 格線最上緣(第 0 格頂端)在視窗座標的 Y。 */
  gridTopClientY: number;
  /** 第 0 格代表的「當天第幾分鐘」(例如 09:00 → 540)。 */
  gridStartMin: number;
  /** 一格幾分鐘 / 幾 px:呼叫端傳 CalendarPage 的 SLOT_MINUTES / SLOT_PX,這裡不另外定義數字。 */
  slotMinutes: number;
  slotPx: number;
  /** 格線總共幾格。 */
  slotCount: number;
  /** 被拖色塊的時長(分鐘)。有帶時,clamp 會讓「色塊的尾端」也留在格線內,不只是頂端。 */
  durationMin?: number;
  columnRects: readonly DropColumnRect[];
  /**
   * #986 第 9 批(9-10、9-11):放開時吸附的分鐘數 = 商家的「建單時間間隔」(5 / 10 / 15 / 30)。
   * **沒帶 = 跟改版前逐位元相同**(吸附到格線 slotMinutes,走原本那段算法)。
   * 有帶時:色塊頂端換成「當天第幾分鐘」,以當天 00:00 為基準四捨五入到 snapMinutes 的倍數;
   * 最早 = 格線起點往上取到倍數、最晚 = 格線終點 − 色塊時長往下取到倍數。格線本身仍是 slotMinutes 一格,
   * 只是放開時可以落在格子中間。
   */
  snapMinutes?: number | undefined;
  /**
   * SPECS-INDEX #1049:時間軸改畫 00:00~24:00 之後,拖拉落點仍然只能落在這一段(= 營業時間,分鐘數)。
   * 色塊頂端不早於 startMin、尾端不晚於 endMin(超出就夾回來,跟原本「夾到格線邊界」同一個規則)。
   * 沒帶 = 整條格線(跟改版前逐位元相同)。
   */
  dropRange?: { startMin: number; endMin: number } | undefined;
}

export interface DropTarget {
  staffId: string;
  /**
   * 吸附後的第幾格(0 起算)。有帶 snapMinutes 時,落點可能在格子中間,這裡是「落點所在那一格」(往下取整);
   * 要算殘影位置請用 startMin(calendarBookingDrag.tsx 已改用 startMin 換算,殘影跟實際落點一定對得上)。
   */
  slotIndex: number;
  /** 吸附後的開始時間(當天第幾分鐘)。 */
  startMin: number;
  /** 同上,"HH:MM" 格式,可以直接餵 buildTaipeiIso(dateKey, startTime)。 */
  startTime: string;
}

/**
 * 回 null = 放在格線外(左邊時間軸、最右欄以外),視為取消。
 * Y 方向不會回 null,超出上下緣一律夾到邊界格(規格書 §3.3 第 2 點)。
 */
export function computeDropTarget(input: ComputeDropTargetInput): DropTarget | null {
  const { columnRects, slotMinutes, slotPx, slotCount } = input;
  if (columnRects.length === 0 || slotCount <= 0 || slotPx <= 0 || slotMinutes <= 0) return null;

  // --- X:找欄位。落在時間軸(最左欄以左)或最右欄以右 → null;落在欄位間的縫隙 → 取最近的欄位。
  const x = input.pointerClientX;
  const minLeft = Math.min(...columnRects.map((c) => c.left));
  const maxRight = Math.max(...columnRects.map((c) => c.right));
  if (x < minLeft || x > maxRight) return null;
  // 🔴 被固定欄蓋住的那一段 x:視覺上手指是按在時間欄上,不可以算進底下那一欄(見
  // occludedLeftClientX 的說明)。這條要放在「找最近欄位」之前,否則會被 fallback 救回來。
  if (input.occludedLeftClientX != null && x < input.occludedLeftClientX) return null;

  let column: DropColumnRect | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const c of columnRects) {
    if (x >= c.left && x <= c.right) {
      column = c;
      break;
    }
    const distance = x < c.left ? c.left - x : x - c.right;
    if (distance < bestDistance) {
      bestDistance = distance;
      column = c;
    }
  }
  if (!column) return null;

  // --- Y:以「色塊頂端」算格,round 到最近格(半格以上就跳下一格)。
  const blockTopClientY = input.pointerClientY - input.grabOffsetY;

  // #1049:可落點的範圍(分鐘)。沒帶 dropRange ⇒ 整條格線(改版前的行為)。
  const fullGridEndMin = input.gridStartMin + slotCount * slotMinutes;
  const rangeStartMin = input.dropRange
    ? Math.max(input.gridStartMin, input.dropRange.startMin)
    : input.gridStartMin;
  const rangeEndMin = input.dropRange
    ? Math.min(fullGridEndMin, input.dropRange.endMin)
    : fullGridEndMin;

  // #986 第 9 批:有帶 snapMinutes ⇒ 改用「當天第幾分鐘」吸附到建單時間間隔(沒帶 ⇒ 下面原本的算法,一字不改)。
  const snap = input.snapMinutes;
  if (snap != null && Number.isFinite(snap) && snap > 0) {
    const blockTopMin =
      input.gridStartMin + ((blockTopClientY - input.gridTopClientY) / slotPx) * slotMinutes;
    const blockMinutes =
      input.durationMin != null && input.durationMin > 0 ? input.durationMin : slotMinutes;
    const earliest = Math.ceil(rangeStartMin / snap) * snap;
    const latest = Math.max(earliest, Math.floor((rangeEndMin - blockMinutes) / snap) * snap);
    const snapped = Math.round(blockTopMin / snap) * snap;
    const snappedStartMin = Math.min(latest, Math.max(earliest, snapped));
    return {
      staffId: column.staffId,
      slotIndex: Math.floor((snappedStartMin - input.gridStartMin) / slotMinutes),
      startMin: snappedStartMin,
      startTime: minutesToTime(snappedStartMin),
    };
  }

  const rawIndex = Math.round((blockTopClientY - input.gridTopClientY) / slotPx);

  // --- clamp:頂端不早於第 0 格;有帶時長時,尾端也不超出最後一格的底。
  const durationSlots =
    input.durationMin != null && input.durationMin > 0 ? input.durationMin / slotMinutes : 1;
  // #1049:沒帶 dropRange 時 minIndex = 0、rangeSlots = slotCount,跟改版前一字不差的算法等價。
  const minIndex = Math.max(
    0,
    Math.ceil((rangeStartMin - input.gridStartMin) / slotMinutes - 1e-9),
  );
  const rangeEndIndex = (rangeEndMin - input.gridStartMin) / slotMinutes;
  const maxIndex = Math.max(minIndex, Math.floor(rangeEndIndex - durationSlots + 1e-9));
  const slotIndex = Math.min(maxIndex, Math.max(minIndex, rawIndex));

  const startMin = input.gridStartMin + slotIndex * slotMinutes;
  return { staffId: column.staffId, slotIndex, startMin, startTime: minutesToTime(startMin) };
}

// ---------------------------------------------------------------------------
// 3. buildUndoInput —— 復原的反向輸入(對照表 §三「復原輸入」那張表;pgTAP pg_temp.undo_move 是同一張表)
// ---------------------------------------------------------------------------

/**
 * | mode                    | draggedStaffId           | targetStaffId                | targetStartAt              | expectedStartAt | expectedStaffId |
 * |-------------------------|--------------------------|------------------------------|----------------------------|-----------------|-----------------|
 * | time / reassign_main    | next.staff_id            | previous.staff_id            | previous.start_at          | next.start_at   | next.staff_id   |
 * | reassign_assistant      | next.assistant_staff_id  | previous.assistant_staff_id  | next.start_at(會被忽略)  | next.start_at   | next.staff_id   |
 */
export function buildUndoInput(result: MoveBookingResult): MoveBookingInput {
  const { previous, next } = result;
  if (result.mode === "reassign_assistant") {
    if (!next.assistant_staff_id || !previous.assistant_staff_id) {
      throw new Error("reassign_assistant 的回傳缺少 assistant_staff_id,無法建立復原輸入");
    }
    return {
      bookingId: result.booking.id,
      draggedStaffId: next.assistant_staff_id,
      targetStaffId: previous.assistant_staff_id,
      targetStartAt: next.start_at,
      expectedStartAt: next.start_at,
      expectedStaffId: next.staff_id,
    };
  }
  return {
    bookingId: result.booking.id,
    draggedStaffId: next.staff_id,
    targetStaffId: previous.staff_id,
    targetStartAt: previous.start_at,
    expectedStartAt: next.start_at,
    expectedStaffId: next.staff_id,
  };
}

// ---------------------------------------------------------------------------
// Q3 守門:拖到過去的時間 → 允許,但放開前先跳確認框(在 resolveMoveMode 之後、打 RPC 之前)
// ---------------------------------------------------------------------------

/** 只有真的會改時間的落點才需要問(助手模式時間被忽略,不問;純轉派時間沒變,也不問)。 */
export function isDropInPast(
  resolution: MoveModeResolution,
  targetStartAt: Date | string,
  now: Date = new Date(),
): boolean {
  if (resolution.kind !== "move" || !resolution.timeChanged) return false;
  const t = typeof targetStartAt === "string" ? new Date(targetStartAt) : targetStartAt;
  return t.getTime() < now.getTime();
}

// ---------------------------------------------------------------------------
// 4. 手勢狀態機 useBookingDragState —— idle → pressing → dragging → committing → idle
// ---------------------------------------------------------------------------

/** 觸控(非滑鼠)要長按多久才進入拖拉模式(規格書 §八 / Q4=B)。 */
export const TOUCH_LONG_PRESS_MS = 500;

/** 5.1:只有這兩種狀態的色塊可拖,跟 update_booking / move_booking 的狀態限制一致。 */
export function canDrag(status: BookingStatus): boolean {
  return status === "pending_confirmation" || status === "accepted";
}

/** 跟 #641 的 MinimalPointerEvent 一樣只取用少數欄位,測試可以直接餵一般物件。`button` 沒帶視為左鍵。 */
export interface DragPointerEvent {
  pointerType: string;
  clientX: number;
  clientY: number;
  button?: number;
}

/** 按下時那顆色塊的身分。 */
export interface DragSource {
  bookingId: string;
  role: BookingParticipantRole;
  /** 色塊所在欄位的 staff_id(= draggedStaffId)。 */
  staffId: string;
  status: BookingStatus;
  /** 色塊頂端在視窗座標的 Y(getBoundingClientRect().top),用來算 grabOffsetY。 */
  blockTopClientY: number;
}

export type DragPhase = "idle" | "pressing" | "dragging" | "committing";

export interface ActiveDrag {
  source: DragSource;
  grabOffsetY: number;
  pointerType: string;
  /** 目前游標位置(dragging 期間每次 pointermove 更新;第 3 批拿它算殘影位置與 computeDropTarget)。 */
  pointer: { x: number; y: number };
  /** true = 這次是手機長按進入的拖拉(第 3 批據此做「浮起」視覺與設 touch-action: none)。 */
  viaLongPress: boolean;
}

export interface DropPayload {
  source: DragSource;
  grabOffsetY: number;
  pointer: { x: number; y: number };
  viaLongPress: boolean;
}

export interface UseBookingDragStateOptions {
  /** 拖曳 vs 點擊的閾值:呼叫端傳 CalendarPage 的 SLOT_TAP_VS_DRAG_THRESHOLD_PX,這裡不另外定義數字。 */
  thresholdPx: number;
  /** 觸控長按門檻,預設 TOUCH_LONG_PRESS_MS。 */
  longPressMs?: number;
  /** ≤ 閾值就放開 = 點擊(照舊開詳情)。 */
  onClick: (source: DragSource) => void;
  /** 進入 dragging 的那一刻(滑鼠:移動 > 閾值;觸控:長按到時)。第 3 批在這裡做浮起/震動以外的初始化。 */
  onDragStart?: (drag: ActiveDrag) => void;
  /** dragging 期間放開。回 Promise 時,hook 會停在 committing 直到它 settle(成功或失敗都回 idle)。 */
  onDrop: (payload: DropPayload) => void | Promise<void>;
  /** Escape / pointercancel / 視窗失焦 / 明確呼叫 cancel()。只有 pressing / dragging 期間會觸發。 */
  onCancel?: (phase: Exclude<DragPhase, "idle" | "committing">) => void;
}

interface InternalState {
  phase: DragPhase;
  drag: ActiveDrag | null;
  /** 按下的起點,量測是否超過閾值。 */
  origin: { x: number; y: number } | null;
  /** 觸控在長按前就移動超過閾值 = 這次是捲動,之後放開既不是點擊也不是拖拉。 */
  scrolled: boolean;
}

const IDLE: InternalState = { phase: "idle", drag: null, origin: null, scrolled: false };

function exceedsThreshold(
  origin: { x: number; y: number },
  e: DragPointerEvent,
  thresholdPx: number,
): boolean {
  // 跟 #641 一樣:x / y 任一方向「超過」閾值才算,剛好等於不算。
  return (
    Math.abs(e.clientX - origin.x) > thresholdPx || Math.abs(e.clientY - origin.y) > thresholdPx
  );
}

function vibrateIfSupported() {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function")
      navigator.vibrate(10);
  } catch {
    // 不支援或被瀏覽器拒絕就略過,不影響流程。
  }
}

/**
 * 狀態機:
 *   idle ──pointerdown(可拖的色塊)──▶ pressing
 *   pressing ──滑鼠移動 > 閾值──▶ dragging
 *   pressing ──觸控:長按到時(期間移動 ≤ 閾值)──▶ dragging(viaLongPress)
 *   pressing ──觸控:長按前移動 > 閾值──▶(標記為捲動,留在 pressing,放開後靜默回 idle;不呼叫 preventDefault,讓原生捲動接手)
 *   pressing ──放開(移動 ≤ 閾值、沒進 dragging)──▶ idle + onClick
 *   dragging ──放開──▶ committing + onDrop ──settle──▶ idle
 *   pressing / dragging ──Escape / pointercancel / blur / cancel()──▶ idle + onCancel
 *   committing ──任何 pointerdown──▶ 忽略(5.9)
 *
 * 🔴 這個 hook 本身**不呼叫 preventDefault、不設 touch-action**。長按之前的手指移動一律要讓瀏覽器捲動
 * (#641);只有 drag.viaLongPress 為 true 之後,第 3 批才可以對色塊設 touch-action: none / 攔 touchmove。
 */
export function useBookingDragState(options: UseBookingDragStateOptions) {
  const { thresholdPx, onClick, onDragStart, onDrop, onCancel } = options;
  const longPressMs = options.longPressMs ?? TOUCH_LONG_PRESS_MS;

  const [state, setState] = useState<InternalState>(IDLE);
  // handler 與 timer callback 都讀 ref,避免閉包拿到過期的 state。
  const stateRef = useRef<InternalState>(IDLE);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionsRef = useRef({ onClick, onDragStart, onDrop, onCancel });
  optionsRef.current = { onClick, onDragStart, onDrop, onCancel };

  const commit = useCallback((next: InternalState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const clearLongPressTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const enterDragging = useCallback(
    (pointer: { x: number; y: number }, viaLongPress: boolean) => {
      const cur = stateRef.current;
      if (cur.phase !== "pressing" || !cur.drag) return;
      const drag: ActiveDrag = { ...cur.drag, pointer, viaLongPress };
      commit({ ...cur, phase: "dragging", drag });
      if (viaLongPress) vibrateIfSupported();
      optionsRef.current.onDragStart?.(drag);
    },
    [commit],
  );

  const cancel = useCallback(() => {
    const cur = stateRef.current;
    clearLongPressTimer();
    if (cur.phase !== "pressing" && cur.phase !== "dragging") return;
    commit(IDLE);
    optionsRef.current.onCancel?.(cur.phase);
  }, [clearLongPressTimer, commit]);

  const onPointerDown = useCallback(
    (e: DragPointerEvent, source: DragSource) => {
      const cur = stateRef.current;
      // 5.9:committing 期間忽略新的按下;已經在 pressing / dragging 也不重入。
      if (cur.phase !== "idle") return;
      // 5.1:已完成 / 已取消不進入 pressing(讓 onClick 這條路留給 button 原本的 onClick 處理,所以這裡什麼都不做)。
      if (!canDrag(source.status)) return;
      // 滑鼠只認左鍵;`button` 沒帶視為左鍵(測試餵一般物件)。
      if (e.pointerType === "mouse" && (e.button ?? 0) !== 0) return;

      const pointer = { x: e.clientX, y: e.clientY };
      const drag: ActiveDrag = {
        source,
        grabOffsetY: e.clientY - source.blockTopClientY,
        pointerType: e.pointerType,
        pointer,
        viaLongPress: false,
      };
      commit({ phase: "pressing", drag, origin: pointer, scrolled: false });

      // 觸控 / 筆:長按到時才進入拖拉;滑鼠不用長按。
      if (e.pointerType !== "mouse") {
        clearLongPressTimer();
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          const now = stateRef.current;
          if (now.phase !== "pressing" || now.scrolled || !now.drag) return;
          enterDragging(now.drag.pointer, true);
        }, longPressMs);
      }
    },
    [clearLongPressTimer, commit, enterDragging, longPressMs],
  );

  const onPointerMove = useCallback(
    (e: DragPointerEvent) => {
      const cur = stateRef.current;
      const pointer = { x: e.clientX, y: e.clientY };

      if (cur.phase === "dragging" && cur.drag) {
        commit({ ...cur, drag: { ...cur.drag, pointer } });
        return;
      }
      if (cur.phase !== "pressing" || !cur.origin || !cur.drag) return;

      const moved = exceedsThreshold(cur.origin, e, thresholdPx);
      if (cur.drag.pointerType === "mouse") {
        if (moved) {
          enterDragging(pointer, false);
        }
        return;
      }

      // 觸控:長按之前移動超過閾值 = 捲動。取消長按計時、標記 scrolled,之後放開不算點擊也不算拖拉。
      // 這裡刻意**不**呼叫 preventDefault,讓原生橫向捲動照常進行(#641)。
      if (cur.scrolled) return;
      if (moved) {
        clearLongPressTimer();
        commit({ ...cur, scrolled: true });
        return;
      }
      // 沒超過閾值:記住最新位置,長按到時就從這個位置開始拖。
      commit({ ...cur, drag: { ...cur.drag, pointer } });
    },
    [clearLongPressTimer, commit, enterDragging, thresholdPx],
  );

  const onPointerUp = useCallback(() => {
    const cur = stateRef.current;
    clearLongPressTimer();

    if (cur.phase === "pressing" && cur.drag) {
      const source = cur.drag.source;
      const wasTap = !cur.scrolled;
      commit(IDLE);
      if (wasTap) optionsRef.current.onClick(source);
      return;
    }

    if (cur.phase === "dragging" && cur.drag) {
      const payload: DropPayload = {
        source: cur.drag.source,
        grabOffsetY: cur.drag.grabOffsetY,
        pointer: cur.drag.pointer,
        viaLongPress: cur.drag.viaLongPress,
      };
      commit({ ...cur, phase: "committing" });
      let result: void | Promise<void>;
      try {
        result = optionsRef.current.onDrop(payload);
      } catch {
        commit(IDLE);
        return;
      }
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).then(
          () => commit(IDLE),
          () => commit(IDLE),
        );
      } else {
        commit(IDLE);
      }
    }
  }, [clearLongPressTimer, commit]);

  const onPointerCancel = useCallback(() => {
    // 瀏覽器判定成原生捲動時會發 pointercancel(不會再有 pointerup)→ 取消。
    cancel();
  }, [cancel]);

  const onKeyDown = useCallback(
    (e: { key: string }) => {
      if (e.key === "Escape") cancel();
    },
    [cancel],
  );

  // 5.6:Escape 與視窗失焦 → 取消。只在 pressing / dragging 期間掛監聽,idle / committing 不掛。
  const active = state.phase === "pressing" || state.phase === "dragging";
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    const handleBlur = () => cancel();
    window.addEventListener("keydown", handleKey);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("blur", handleBlur);
    };
  }, [active, cancel]);

  // 卸載時清掉長按計時器。
  useEffect(() => () => clearLongPressTimer(), [clearLongPressTimer]);

  return {
    phase: state.phase,
    drag: state.drag,
    /** 方便第 3 批判斷「已進入拖拉模式」:dragging 或 committing 都算。 */
    isDragging: state.phase === "dragging" || state.phase === "committing",
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onKeyDown,
    cancel,
    canDrag,
  };
}
