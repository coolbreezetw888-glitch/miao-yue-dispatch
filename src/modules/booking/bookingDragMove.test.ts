// SPECS-INDEX #820(規格書 .project/specs/行事曆拖拉改時間與轉派.md §9.2)。
// 行事曆拖拉的前端純邏輯測試:模式判定 / 落點計算 / 復原輸入 / Q3 守門 / 手勢狀態機(含手機長按)。
//
// =========================================================================
// 🔴【resolveMoveMode 的案例 = 對照表的 9 列,一對一】
// 下面「一、resolveMoveMode」那組測試,每一條的標題都標了「列 N」,對應
// `.project/specs/行事曆拖拉_模式判定對照表.md` §二的第 N 列。
// **這張表跟 pgTAP `supabase/tests/database/calendar_drag_01_move_booking.sql` 用的是同一份**
// (後端 `public.move_booking` 由那支 pgTAP 逐列釘住,前端由這裡逐列釘住)。
// 這是防止「前後端裁決套錯 → 畫面說轉派、資料庫改了時間」(規格書 §十二 風險 1)的唯一機制;
// 要改任何一列,兩邊要一起改,而且要先改對照表。
// =========================================================================
//
// 【故障注入紀錄(automated-testing 第四節,2026-09-28 實際跑過,每次注入後用備份還原、cmp 確認一致)】
//   1. computeDropTarget 的 Math.round 改成 Math.floor → 2 條轉紅(47 綠):
//      「四捨五入到最近格…(不是 floor)」:AssertionError: expected 1 to be 2
//      「兩個不同的 grabOffsetY 得到不同結果」:也紅(2.67 被 floor 成 2,expected slotIndex 3)
//   2. computeDropTarget 忽略 grabOffsetY(blockTop = pointerClientY)→ 只有 1 條轉紅(48 綠):
//      「兩個不同的 grabOffsetY 得到不同結果」:- "slotIndex": 3 / + "slotIndex": 4、
//      - "startTime": "10:30" / + "startTime": "11:00"(兩個 offset 算出同一格 = 變成以游標為準)
//   3. useBookingDragState 的長按門檻改成 0ms(setTimeout(..., 0))→ 4 條轉紅(45 綠):
//      「① 長按前移動 > 閾值 = 捲動」:expected 'dragging' to be 'pressing'(0ms 一到就進拖拉,
//        捲動守門失效 —— 這正是 #641 會被弄壞的症狀)
//      「② 按住不動滿 500ms」:expected 'dragging' to be 'pressing'(499ms 時就已經在拖了)
//      「觸控點一下 = 點擊」:expected "spy" to be called 1 times, but got 0 times(點一下變成拖拉,onClick 沒被呼叫)
//      「自訂 longPressMs 生效(300ms)」:expected 'dragging' to be 'pressing'
//   4. resolveMoveMode 把列 4 的斜拖改回 Q1=A(timeChanged 強制 false)→ 只有 1 條轉紅(48 綠):
//      「列 4(Q1=B 斜拖)」:expected { kind: 'move', …(3) } to deeply equal { kind: 'move', …(3) }
//   全部還原後 npm run test:unit 全綠(含 touchTapVsDragOpen.test.ts 的 8 條)。

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildUndoInput,
  canDrag,
  computeDropTarget,
  formatMoveHint,
  indexBookingParticipants,
  isDropInPast,
  resolveMoveMode,
  TOUCH_LONG_PRESS_MS,
  useBookingDragState,
  type DragSource,
  type DropColumnRect,
  type MoveBookingResult,
  type ResolveMoveModeInput,
} from "./bookingDragMove";

// 跟 pgTAP fixture 同一組角色:A 主、B 助手、C 第三人;D 只在列 9(第二位助手)出現。
const A = "staff-a";
const B = "staff-b";
const C = "staff-c";
const D = "staff-d";

function mainDrag(over: Partial<ResolveMoveModeInput>): ResolveMoveModeInput {
  return {
    draggedRole: "main",
    draggedStaffId: A,
    mainStaffId: A,
    assistantStaffIds: [B],
    targetStaffId: A,
    timeChanged: false,
    ...over,
  };
}

function assistantDrag(over: Partial<ResolveMoveModeInput>): ResolveMoveModeInput {
  return {
    draggedRole: "assistant",
    draggedStaffId: B,
    mainStaffId: A,
    assistantStaffIds: [B],
    targetStaffId: C,
    timeChanged: false,
    ...over,
  };
}

// ===========================================================================
// 一、resolveMoveMode —— 對照表 §二 的 9 列
// ===========================================================================
describe("resolveMoveMode(對照表 §二,跟 pgTAP calendar_drag_01 同一張表)", () => {
  it("列 1:main、staffChanged 否、timeChanged 否(放開在原位)→ 無操作,不顯示提示", () => {
    const r = resolveMoveMode(mainDrag({ targetStaffId: A, timeChanged: false }));
    expect(r).toEqual({ kind: "noop", hint: null });
  });

  it("列 2:main、同一欄、timeChanged 是 → mode=time(staffChanged=false)", () => {
    const r = resolveMoveMode(mainDrag({ targetStaffId: A, timeChanged: true }));
    expect(r).toEqual({ kind: "move", mode: "time", timeChanged: true, staffChanged: false });
  });

  it("列 3:main、別人(非助手)、同一時間 → mode=reassign_main(timeChanged=false)", () => {
    const r = resolveMoveMode(mainDrag({ targetStaffId: C, timeChanged: false }));
    expect(r).toEqual({
      kind: "move",
      mode: "reassign_main",
      timeChanged: false,
      staffChanged: true,
    });
  });

  it("列 4(Q1=B 斜拖):main、別人、不同時間 → mode 仍是 reassign_main,但 timeChanged=true(不是第四個 mode)", () => {
    const r = resolveMoveMode(mainDrag({ targetStaffId: C, timeChanged: true }));
    expect(r).toEqual({
      kind: "move",
      mode: "reassign_main",
      timeChanged: true,
      staffChanged: true,
    });
    // 只有三個 mode:任何回傳都不會出現 "time_and_reassign" 之類的值。
    expect(["time", "reassign_main", "reassign_assistant"]).toContain((r as { mode: string }).mode);
  });

  it("列 5(Q5=A):main 拖到本單既有助手 → forbidden,時間有沒有變都一樣擋", () => {
    const same = resolveMoveMode(
      mainDrag({ targetStaffId: B, timeChanged: false, targetStaffName: "小美" }),
    );
    const diag = resolveMoveMode(
      mainDrag({ targetStaffId: B, timeChanged: true, targetStaffName: "小美" }),
    );
    expect(same).toEqual({ kind: "forbidden", reason: "小美已經是助手,請先用編輯改掉" });
    expect(diag).toEqual(same);
  });

  it("列 6(Q2 衍生邊界 1):assistant 拖回自己那一欄,不論時間 → 無操作 + 輕提示", () => {
    const same = resolveMoveMode(assistantDrag({ targetStaffId: B, timeChanged: false }));
    const moved = resolveMoveMode(assistantDrag({ targetStaffId: B, timeChanged: true }));
    expect(same).toEqual({ kind: "noop", hint: "助手沒有自己的時間,要改時間請拖主服務人員的色塊" });
    // 時間維度完全忽略:助手同欄改時間跟放回原位是同一個結果(pgTAP #12)。
    expect(moved).toEqual(same);
  });

  it("列 7(Q2):assistant 拖到別人 → mode=reassign_assistant,timeChanged 一律 false(斜拖也是)", () => {
    const same = resolveMoveMode(assistantDrag({ targetStaffId: C, timeChanged: false }));
    const diag = resolveMoveMode(assistantDrag({ targetStaffId: C, timeChanged: true }));
    expect(same).toEqual({
      kind: "move",
      mode: "reassign_assistant",
      timeChanged: false,
      staffChanged: true,
    });
    // pgTAP #8b:助手斜拖 → time_changed = false。
    expect(diag).toEqual(same);
  });

  it("列 8:assistant 拖到本單主服務人員 → forbidden「已經在這筆預約裡了」", () => {
    const r = resolveMoveMode(assistantDrag({ targetStaffId: A, timeChanged: false }));
    expect(r).toEqual({ kind: "forbidden", reason: "這位已經在這筆預約裡了" });
  });

  it("列 9:assistant 拖到本單另一位助手 → forbidden,跟列 8 同一句話", () => {
    const r = resolveMoveMode(
      assistantDrag({ assistantStaffIds: [B, D], targetStaffId: D, timeChanged: true }),
    );
    expect(r).toEqual({ kind: "forbidden", reason: "這位已經在這筆預約裡了" });
  });

  it("正向對照:同一組輸入只要換 draggedRole,結果就不同(證明 role 真的有被讀到)", () => {
    // 主 A 拖到 C 是轉派;把同一顆當成助手拖到 C,是換助手。兩者都不是 forbidden。
    const asMain = resolveMoveMode(mainDrag({ targetStaffId: C }));
    const asAssistant = resolveMoveMode({
      ...mainDrag({ targetStaffId: C }),
      draggedRole: "assistant",
    });
    expect(asMain).toMatchObject({ mode: "reassign_main" });
    expect(asAssistant).not.toEqual(asMain);
  });
});

describe("formatMoveHint(對照表 §二「前端提示」欄)", () => {
  const ctx = { targetStaffName: "王大明", startTime: "14:30" };

  it("列 2 time → 「改時間 → 14:30」", () => {
    expect(
      formatMoveHint({ kind: "move", mode: "time", timeChanged: true, staffChanged: false }, ctx),
    ).toBe("改時間 → 14:30");
  });

  it("列 3 / 列 4:純轉派與斜拖的文案不同,斜拖要把時間也講出來", () => {
    expect(
      formatMoveHint(
        { kind: "move", mode: "reassign_main", timeChanged: false, staffChanged: true },
        ctx,
      ),
    ).toBe("轉派給 王大明");
    expect(
      formatMoveHint(
        { kind: "move", mode: "reassign_main", timeChanged: true, staffChanged: true },
        ctx,
      ),
    ).toBe("轉派給 王大明,並改時間 → 14:30");
  });

  it("列 7 reassign_assistant → 「助手改為 王大明」(不提時間)", () => {
    expect(
      formatMoveHint(
        { kind: "move", mode: "reassign_assistant", timeChanged: false, staffChanged: true },
        ctx,
      ),
    ).toBe("助手改為 王大明");
  });

  it("forbidden 加 ❌ 前綴;noop 直接回 hint(列 1 是 null = 不顯示)", () => {
    expect(formatMoveHint({ kind: "forbidden", reason: "這位已經在這筆預約裡了" }, ctx)).toBe(
      "❌ 這位已經在這筆預約裡了",
    );
    expect(formatMoveHint({ kind: "noop", hint: null }, ctx)).toBeNull();
    expect(formatMoveHint({ kind: "noop", hint: "輕提示" }, ctx)).toBe("輕提示");
  });
});

describe("indexBookingParticipants(從整天排程建出每筆單的主 / 助手名單)", () => {
  it("同一筆單在主欄 role=main、助手欄 role=assistant → 對應到正確的 staff_id", () => {
    const booking = (id: string, role: "main" | "assistant") => ({
      id,
      start_at: "2026-10-06T02:00:00+00:00",
      end_at: "2026-10-06T03:00:00+00:00",
      status: "accepted" as const,
      customer_name: "客戶",
      customer_phone: "0900000000",
      notes: null,
      role,
      service_items: [],
    });
    const index = indexBookingParticipants([
      { staff_id: A, bookings: [booking("t1", "main")] },
      { staff_id: B, bookings: [booking("t1", "assistant")] },
      { staff_id: C, bookings: [booking("t2", "main")] },
      { staff_id: D, bookings: [booking("t1", "assistant")] },
    ]);
    expect(index.get("t1")).toEqual({ mainStaffId: A, assistantStaffIds: [B, D] });
    expect(index.get("t2")).toEqual({ mainStaffId: C, assistantStaffIds: [] });
    expect(index.get("t3")).toBeUndefined();
  });
});

// ===========================================================================
// 二、computeDropTarget
// ===========================================================================
describe("computeDropTarget(以色塊頂端為準、round 到最近格、上下 clamp、X 在格線外 → null)", () => {
  // 三欄:A 100–200、B 210–310、C 320–420(欄位之間各留 10px 縫隙);時間軸在 0–100。
  const columns: DropColumnRect[] = [
    { staffId: A, left: 100, right: 200 },
    { staffId: B, left: 210, right: 310 },
    { staffId: C, left: 320, right: 420 },
  ];
  // 格線從 09:00(540 分)開始,每格 30 分 / 30px,共 20 格(09:00–19:00),頂端在視窗 Y=100。
  const base = {
    gridTopClientY: 100,
    gridStartMin: 540,
    slotMinutes: 30,
    slotPx: 30,
    slotCount: 20,
    columnRects: columns,
  };

  it("🔴 兩個不同的 grabOffsetY 得到不同結果(以色塊頂端為準,不是游標所在格)", () => {
    // 游標在 Y=225(格線內 125px)。抓在色塊頂端(offset 0)→ 125/30=4.17 → 第 4 格 11:00;
    // 抓在色塊往下 45px 處(offset 45)→ 色塊頂端在 80px → 2.67 → 第 3 格 10:30。
    const grabbedAtTop = computeDropTarget({
      ...base,
      pointerClientX: 150,
      pointerClientY: 225,
      grabOffsetY: 0,
    });
    const grabbedLower = computeDropTarget({
      ...base,
      pointerClientX: 150,
      pointerClientY: 225,
      grabOffsetY: 45,
    });
    expect(grabbedAtTop).toEqual({ staffId: A, slotIndex: 4, startMin: 660, startTime: "11:00" });
    expect(grabbedLower).toEqual({ staffId: A, slotIndex: 3, startMin: 630, startTime: "10:30" });
    expect(grabbedLower!.slotIndex).not.toBe(grabbedAtTop!.slotIndex);
  });

  it("四捨五入到最近格:半格以上跳下一格,半格以下留在這一格(不是 floor)", () => {
    // 色塊頂端在格線內 44px → 1.47 → 第 1 格;46px → 1.53 → 第 2 格(floor 兩個都會是 1)。
    const below = computeDropTarget({
      ...base,
      pointerClientX: 150,
      pointerClientY: 144,
      grabOffsetY: 0,
    });
    const above = computeDropTarget({
      ...base,
      pointerClientX: 150,
      pointerClientY: 146,
      grabOffsetY: 0,
    });
    expect(below!.slotIndex).toBe(1);
    expect(above!.slotIndex).toBe(2);
  });

  it("超出格線上緣 → 夾到第 0 格;超出下緣 → 夾到最後一格", () => {
    const tooHigh = computeDropTarget({
      ...base,
      pointerClientX: 150,
      pointerClientY: -500,
      grabOffsetY: 0,
    });
    const tooLow = computeDropTarget({
      ...base,
      pointerClientX: 150,
      pointerClientY: 5000,
      grabOffsetY: 0,
    });
    expect(tooHigh).toMatchObject({ slotIndex: 0, startTime: "09:00" });
    expect(tooLow).toMatchObject({ slotIndex: 19, startTime: "18:30" });
  });

  it("有帶時長時,clamp 讓色塊尾端也留在格線內(60 分的色塊最多到第 18 格 18:00–19:00)", () => {
    const r = computeDropTarget({
      ...base,
      pointerClientX: 150,
      pointerClientY: 5000,
      grabOffsetY: 0,
      durationMin: 60,
    });
    expect(r).toMatchObject({ slotIndex: 18, startTime: "18:00" });
    // 90 分(3 格)→ 最多第 17 格。
    const r90 = computeDropTarget({
      ...base,
      pointerClientX: 150,
      pointerClientY: 5000,
      grabOffsetY: 0,
      durationMin: 90,
    });
    expect(r90).toMatchObject({ slotIndex: 17, startTime: "17:30" });
  });

  it("X 落在欄位之間的縫隙 → 取最近的欄位", () => {
    // 204 離 A 的右緣(200)4px、離 B 的左緣(210)6px → A。
    const nearA = computeDropTarget({
      ...base,
      pointerClientX: 204,
      pointerClientY: 100,
      grabOffsetY: 0,
    });
    // 207 離 B 較近 → B。
    const nearB = computeDropTarget({
      ...base,
      pointerClientX: 207,
      pointerClientY: 100,
      grabOffsetY: 0,
    });
    expect(nearA!.staffId).toBe(A);
    expect(nearB!.staffId).toBe(B);
  });

  it("X 落在左邊時間軸(最左欄以左)或最右欄以右 → null(取消)", () => {
    expect(
      computeDropTarget({ ...base, pointerClientX: 50, pointerClientY: 150, grabOffsetY: 0 }),
    ).toBeNull();
    expect(
      computeDropTarget({ ...base, pointerClientX: 421, pointerClientY: 150, grabOffsetY: 0 }),
    ).toBeNull();
    // 正向對照:同一個 Y,X 放進欄位裡就不是 null。
    expect(
      computeDropTarget({ ...base, pointerClientX: 350, pointerClientY: 150, grabOffsetY: 0 }),
    ).toMatchObject({
      staffId: C,
    });
  });

  it("沒有任何欄位 → null", () => {
    expect(
      computeDropTarget({
        ...base,
        columnRects: [],
        pointerClientX: 150,
        pointerClientY: 150,
        grabOffsetY: 0,
      }),
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // #846:sticky 時間欄蓋住的那一段 x(2026-09-30 QA 抓到的 0~72px 誤判帶)
  // -------------------------------------------------------------------------
  describe("occludedLeftClientX —— 被 sticky 時間欄蓋住的那一段 x 不算落點", () => {
    // 情境重現:捲動之後,A 欄的 rect 仍然是 100–200,但視覺上最左 72px(視窗 x 0–72)被
    // sticky 時間欄蓋住;時間欄的右邊界 = 172(= 容器左緣 100 + 時間欄寬 72 …這裡直接用
    // 「A 欄被蓋掉一半」的數字,方便一眼看出邊界兩側的差別)。
    // 🔴 誤判帶是**完整的 0~72px**(整段被蓋住的區域),不是只有 40~72px 那 32px。
    // (2026-09-30 修正:這裡原本寫成「AUTO_SCROLL_EDGE_PX = 40 會先吃掉最左 40px,真正的
    //  誤判帶是 40px 之後」——那是錯的。AUTO_SCROLL_EDGE_PX 只動 scrollLeft,**不抑制落點
    //  計算**:手指停在最左 20px 時畫面會自動捲動,同時照樣每一幀重算落點。所以那 40px 的
    //  落點也得靠 occludedLeftClientX 擋,實作也確實是整段都擋。)
    const occluded = { ...base, occludedLeftClientX: 172 };

    it("🔴 x 在時間欄底下(140:看起來按在時間欄上)→ null,不可以算進被蓋住的 A 欄", () => {
      expect(
        computeDropTarget({
          ...occluded,
          pointerClientX: 140,
          pointerClientY: 150,
          grabOffsetY: 0,
        }),
      ).toBeNull();
    });

    it("🔴 誤判帶的右界(171,差 1px)仍然是 null", () => {
      expect(
        computeDropTarget({
          ...occluded,
          pointerClientX: 171,
          pointerClientY: 150,
          grabOffsetY: 0,
        }),
      ).toBeNull();
    });

    it("🔴 誤判帶的左半段(自動捲動那 40px 裡面,x=110)也是 null —— 整段 0~72px 都擋", () => {
      // 這一條就是「32px」寫法會漏掉的情況:x=110 距離容器左緣 100 只有 10px,
      // 落在 AUTO_SCROLL_EDGE_PX 的自動捲動區裡,但它一樣被時間欄蓋住,一樣不能算落點。
      expect(
        computeDropTarget({
          ...occluded,
          pointerClientX: 110,
          pointerClientY: 150,
          grabOffsetY: 0,
        }),
      ).toBeNull();
    });

    it("正向對照:同一個位置,沒有固定欄遮擋時會算進 A 欄(證明這條擋的是遮擋、不是別的)", () => {
      expect(
        computeDropTarget({ ...base, pointerClientX: 140, pointerClientY: 150, grabOffsetY: 0 }),
      ).toMatchObject({ staffId: A });
    });

    it("正向對照:剛好在時間欄右邊界(172)就算進 A 欄,不是整欄都被吃掉", () => {
      expect(
        computeDropTarget({
          ...occluded,
          pointerClientX: 172,
          pointerClientY: 150,
          grabOffsetY: 0,
        }),
      ).toMatchObject({ staffId: A });
    });

    it("沒捲動時(時間欄右邊界 = 第一欄 left)行為跟改版前完全一樣", () => {
      const notScrolled = { ...base, occludedLeftClientX: 100 };
      expect(
        computeDropTarget({
          ...notScrolled,
          pointerClientX: 150,
          pointerClientY: 150,
          grabOffsetY: 0,
        }),
      ).toMatchObject({ staffId: A });
      // 時間軸上(50)照舊是 null。
      expect(
        computeDropTarget({
          ...notScrolled,
          pointerClientX: 50,
          pointerClientY: 150,
          grabOffsetY: 0,
        }),
      ).toBeNull();
    });

    it("遮擋不影響右邊的欄位", () => {
      expect(
        computeDropTarget({
          ...occluded,
          pointerClientX: 350,
          pointerClientY: 150,
          grabOffsetY: 0,
        }),
      ).toMatchObject({ staffId: C });
    });

    it("不傳 occludedLeftClientX 時完全不改變原本的行為", () => {
      expect(
        computeDropTarget({ ...base, pointerClientX: 105, pointerClientY: 150, grabOffsetY: 0 }),
      ).toMatchObject({ staffId: A });
    });
  });
});

// ===========================================================================
// 三、buildUndoInput —— 對照表 §三「復原輸入」(pgTAP pg_temp.undo_move 是同一張表)
// ===========================================================================
describe("buildUndoInput(對照表 §三)", () => {
  const prevStart = "2026-10-06T02:00:00+00:00"; // 10:00 台北
  const prevEnd = "2026-10-06T03:00:00+00:00";
  const nextStart = "2026-10-06T05:00:00+00:00"; // 13:00 台北
  const nextEnd = "2026-10-06T06:00:00+00:00";

  function result(over: Partial<MoveBookingResult>): MoveBookingResult {
    return {
      mode: "time",
      booking: { id: "t1" },
      previous: { start_at: prevStart, end_at: prevEnd, staff_id: A, assistant_staff_id: B },
      next: { start_at: nextStart, end_at: nextEnd, staff_id: A, assistant_staff_id: B },
      time_changed: true,
      staff_changed: false,
      ...over,
    };
  }

  it("time:dragged=next.staff_id、target=previous.staff_id、targetStart=previous.start_at、expected 用 next", () => {
    expect(buildUndoInput(result({ mode: "time" }))).toEqual({
      bookingId: "t1",
      draggedStaffId: A,
      targetStaffId: A,
      targetStartAt: prevStart,
      expectedStartAt: nextStart,
      expectedStaffId: A,
    });
  });

  it("reassign_main(含斜拖):dragged=next.staff_id(新主)、target=previous.staff_id(舊主)、targetStart=previous.start_at", () => {
    const r = result({
      mode: "reassign_main",
      next: { start_at: nextStart, end_at: nextEnd, staff_id: C, assistant_staff_id: B },
      time_changed: true,
      staff_changed: true,
    });
    expect(buildUndoInput(r)).toEqual({
      bookingId: "t1",
      draggedStaffId: C,
      targetStaffId: A,
      targetStartAt: prevStart,
      expectedStartAt: nextStart,
      expectedStaffId: C,
    });
  });

  it("reassign_assistant:dragged=next.assistant、target=previous.assistant、targetStart=next.start_at、expectedStaff=next.staff_id(主)", () => {
    const r = result({
      mode: "reassign_assistant",
      previous: { start_at: prevStart, end_at: prevEnd, staff_id: A, assistant_staff_id: B },
      next: { start_at: prevStart, end_at: prevEnd, staff_id: A, assistant_staff_id: C },
      time_changed: false,
      staff_changed: true,
    });
    expect(buildUndoInput(r)).toEqual({
      bookingId: "t1",
      draggedStaffId: C,
      targetStaffId: B,
      targetStartAt: prevStart,
      expectedStartAt: prevStart,
      expectedStaffId: A,
    });
  });

  it("reassign_assistant 缺 assistant_staff_id → 丟錯,不要送出一個殘缺的復原請求", () => {
    const r = result({
      mode: "reassign_assistant",
      next: { start_at: prevStart, end_at: prevEnd, staff_id: A, assistant_staff_id: null },
    });
    expect(() => buildUndoInput(r)).toThrow();
  });
});

// ===========================================================================
// Q3 守門:isDropInPast
// ===========================================================================
describe("isDropInPast(Q3=B:只有真的會改時間、而且目標比現在早,才需要跳確認框)", () => {
  const now = new Date("2026-10-06T06:00:00+00:00"); // 台北 14:00
  const past = "2026-10-06T01:00:00+08:00";
  const future = "2026-10-06T16:00:00+08:00";

  it("time / 斜拖到過去 → true;到未來 → false", () => {
    const time = { kind: "move", mode: "time", timeChanged: true, staffChanged: false } as const;
    const diag = {
      kind: "move",
      mode: "reassign_main",
      timeChanged: true,
      staffChanged: true,
    } as const;
    expect(isDropInPast(time, past, now)).toBe(true);
    expect(isDropInPast(diag, past, now)).toBe(true);
    expect(isDropInPast(time, future, now)).toBe(false);
  });

  it("純轉派 / 換助手(時間沒動)即使落點在過去也不問;noop / forbidden 也不問", () => {
    expect(
      isDropInPast(
        { kind: "move", mode: "reassign_main", timeChanged: false, staffChanged: true },
        past,
        now,
      ),
    ).toBe(false);
    expect(
      isDropInPast(
        { kind: "move", mode: "reassign_assistant", timeChanged: false, staffChanged: true },
        past,
        now,
      ),
    ).toBe(false);
    expect(isDropInPast({ kind: "noop", hint: null }, past, now)).toBe(false);
    expect(isDropInPast({ kind: "forbidden", reason: "x" }, past, now)).toBe(false);
  });
});

// ===========================================================================
// 四、useBookingDragState —— 手勢狀態機
// ===========================================================================
const THRESHOLD = 10;

function source(over: Partial<DragSource> = {}): DragSource {
  return {
    bookingId: "t1",
    role: "main",
    staffId: A,
    status: "accepted",
    blockTopClientY: 180,
    ...over,
  };
}

function setup(over: Partial<Parameters<typeof useBookingDragState>[0]> = {}) {
  const onClick = vi.fn();
  const onDragStart = vi.fn();
  const onDrop = vi.fn();
  const onCancel = vi.fn();
  const hook = renderHook(() =>
    useBookingDragState({
      thresholdPx: THRESHOLD,
      onClick,
      onDragStart,
      onDrop,
      onCancel,
      ...over,
    }),
  );
  return { ...hook, onClick, onDragStart, onDrop, onCancel };
}

describe("useBookingDragState —— 滑鼠", () => {
  it("按下後移動 ≤ 閾值就放開 = 點擊 → onClick(開詳情),不 onDrop", () => {
    const h = setup();
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    expect(h.result.current.phase).toBe("pressing");
    act(() => h.result.current.onPointerMove({ pointerType: "mouse", clientX: 103, clientY: 202 }));
    expect(h.result.current.phase).toBe("pressing");
    act(() => h.result.current.onPointerUp());
    expect(h.result.current.phase).toBe("idle");
    expect(h.onClick).toHaveBeenCalledTimes(1);
    expect(h.onClick).toHaveBeenCalledWith(source());
    expect(h.onDrop).not.toHaveBeenCalled();
  });

  it("剛好等於閾值不算拖;超過才進 dragging(跟 #641 的邊界一致)", () => {
    const h = setup();
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    act(() => h.result.current.onPointerMove({ pointerType: "mouse", clientX: 110, clientY: 200 }));
    expect(h.result.current.phase).toBe("pressing");
    act(() => h.result.current.onPointerMove({ pointerType: "mouse", clientX: 111, clientY: 200 }));
    expect(h.result.current.phase).toBe("dragging");
  });

  it("移動 > 閾值 → dragging(onDragStart、viaLongPress=false、grabOffsetY=游標−色塊頂端);放開 → committing → onDrop → idle", async () => {
    let resolveDrop!: () => void;
    const onDrop = vi.fn(() => new Promise<void>((res) => (resolveDrop = res)));
    const h = setup({ onDrop });

    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    act(() => h.result.current.onPointerMove({ pointerType: "mouse", clientX: 100, clientY: 240 }));
    expect(h.result.current.phase).toBe("dragging");
    expect(h.result.current.isDragging).toBe(true);
    expect(h.onDragStart).toHaveBeenCalledTimes(1);
    expect(h.result.current.drag).toMatchObject({
      grabOffsetY: 20, // 200 − 180
      viaLongPress: false,
      pointer: { x: 100, y: 240 },
    });

    act(() => h.result.current.onPointerMove({ pointerType: "mouse", clientX: 260, clientY: 300 }));
    expect(h.result.current.drag!.pointer).toEqual({ x: 260, y: 300 });

    act(() => h.result.current.onPointerUp());
    expect(h.result.current.phase).toBe("committing");
    expect(onDrop).toHaveBeenCalledWith({
      source: source(),
      grabOffsetY: 20,
      pointer: { x: 260, y: 300 },
      viaLongPress: false,
    });
    expect(h.onClick).not.toHaveBeenCalled();

    await act(async () => {
      resolveDrop();
    });
    expect(h.result.current.phase).toBe("idle");
  });

  it("committing 期間忽略新的 pointerdown(5.9);onDrop 被拒絕也要回 idle", async () => {
    let rejectDrop!: (e: unknown) => void;
    const onDrop = vi.fn(() => new Promise<void>((_res, rej) => (rejectDrop = rej)));
    const h = setup({ onDrop });

    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    act(() => h.result.current.onPointerMove({ pointerType: "mouse", clientX: 100, clientY: 240 }));
    act(() => h.result.current.onPointerUp());
    expect(h.result.current.phase).toBe("committing");

    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    expect(h.result.current.phase).toBe("committing");

    await act(async () => {
      rejectDrop(new Error("後端擋下"));
    });
    expect(h.result.current.phase).toBe("idle");
    // 回 idle 之後可以重新開始。
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    expect(h.result.current.phase).toBe("pressing");
  });

  it("onDrop 同步丟錯 → 回 idle,不會卡在 committing", () => {
    const h = setup({
      onDrop: () => {
        throw new Error("boom");
      },
    });
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    act(() => h.result.current.onPointerMove({ pointerType: "mouse", clientX: 100, clientY: 240 }));
    act(() => h.result.current.onPointerUp());
    expect(h.result.current.phase).toBe("idle");
  });

  it("滑鼠非左鍵按下 → 不進入 pressing", () => {
    const h = setup();
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200, button: 2 },
        source(),
      ),
    );
    expect(h.result.current.phase).toBe("idle");
    // 正向對照:同一個事件把 button 改成 0 就進 pressing。
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200, button: 0 },
        source(),
      ),
    );
    expect(h.result.current.phase).toBe("pressing");
  });

  it("Escape(hook 的 onKeyDown)→ 取消:回 idle、onCancel('dragging')、不 onDrop", () => {
    const h = setup();
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    act(() => h.result.current.onPointerMove({ pointerType: "mouse", clientX: 100, clientY: 240 }));
    act(() => h.result.current.onKeyDown({ key: "Escape" }));
    expect(h.result.current.phase).toBe("idle");
    expect(h.onCancel).toHaveBeenCalledWith("dragging");
    act(() => h.result.current.onPointerUp());
    expect(h.onDrop).not.toHaveBeenCalled();
    expect(h.onClick).not.toHaveBeenCalled();
  });

  it("Escape(window keydown 事件)→ 取消;非 Escape 的按鍵不影響", () => {
    const h = setup();
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    act(() => h.result.current.onPointerMove({ pointerType: "mouse", clientX: 100, clientY: 240 }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    });
    expect(h.result.current.phase).toBe("dragging");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(h.result.current.phase).toBe("idle");
    expect(h.onCancel).toHaveBeenCalledWith("dragging");
  });

  it("pointercancel → 取消(pressing 階段也算)", () => {
    const h = setup();
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    act(() => h.result.current.onPointerCancel());
    expect(h.result.current.phase).toBe("idle");
    expect(h.onCancel).toHaveBeenCalledWith("pressing");
  });

  it("視窗失焦(window blur)→ 取消", () => {
    const h = setup();
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    act(() => h.result.current.onPointerMove({ pointerType: "mouse", clientX: 100, clientY: 240 }));
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(h.result.current.phase).toBe("idle");
    expect(h.onCancel).toHaveBeenCalledWith("dragging");
  });

  it("idle 時 Escape / blur / cancel() 什麼都不做(不會誤呼叫 onCancel)", () => {
    const h = setup();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      window.dispatchEvent(new Event("blur"));
      h.result.current.cancel();
    });
    expect(h.result.current.phase).toBe("idle");
    expect(h.onCancel).not.toHaveBeenCalled();
  });
});

describe("useBookingDragState —— canDrag(5.1)", () => {
  it("只有 pending_confirmation / accepted 可拖", () => {
    expect(canDrag("pending_confirmation")).toBe(true);
    expect(canDrag("accepted")).toBe(true);
    expect(canDrag("completed")).toBe(false);
    expect(canDrag("cancelled")).toBe(false);
    expect(canDrag("pending_reply")).toBe(false);
    expect(canDrag("dispatching")).toBe(false);
  });

  it("已完成 / 已取消的色塊按下 → 不進入 pressing,移動也不會變 dragging", () => {
    const h = setup();
    expect(h.result.current.canDrag("completed")).toBe(false);
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "mouse", clientX: 100, clientY: 200 },
        source({ status: "completed" }),
      ),
    );
    expect(h.result.current.phase).toBe("idle");
    act(() => h.result.current.onPointerMove({ pointerType: "mouse", clientX: 100, clientY: 300 }));
    expect(h.result.current.phase).toBe("idle");
    act(() => h.result.current.onPointerUp());
    expect(h.onClick).not.toHaveBeenCalled();
    expect(h.onDrop).not.toHaveBeenCalled();
  });
});

describe("useBookingDragState —— 觸控長按(Q4=B,#817)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("🔴 ① 長按前移動 > 閾值 = 捲動:不進 dragging,就算之後時間到了也不會進;放開既不是點擊也不是拖拉", () => {
    const h = setup();
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "touch", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    expect(h.result.current.phase).toBe("pressing");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    // 手指橫向滑了 40px(這是 #641 定義的「捲動」手勢)。
    act(() => h.result.current.onPointerMove({ pointerType: "touch", clientX: 140, clientY: 202 }));
    expect(h.result.current.phase).toBe("pressing");
    expect(h.onDragStart).not.toHaveBeenCalled();

    // 就算把時間撥過長按門檻,也不能因為「手指還按著」就進拖拉。
    act(() => {
      vi.advanceTimersByTime(TOUCH_LONG_PRESS_MS + 100);
    });
    expect(h.result.current.phase).toBe("pressing");
    expect(h.result.current.isDragging).toBe(false);
    expect(h.onDragStart).not.toHaveBeenCalled();

    act(() => h.result.current.onPointerUp());
    expect(h.result.current.phase).toBe("idle");
    expect(h.onClick).not.toHaveBeenCalled();
    expect(h.onDrop).not.toHaveBeenCalled();
  });

  it("🔴 ② 按住不動滿 500ms → 進 dragging(viaLongPress=true、vibrate(10));之後移動 = 拖色塊;放開 → onDrop", () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, "vibrate", {
      value: vibrate,
      configurable: true,
      writable: true,
    });
    const h = setup();

    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "touch", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    // 手指微微抖動 3px(≤ 閾值)不算捲動。
    act(() => h.result.current.onPointerMove({ pointerType: "touch", clientX: 102, clientY: 203 }));

    act(() => {
      vi.advanceTimersByTime(TOUCH_LONG_PRESS_MS - 1);
    });
    expect(h.result.current.phase).toBe("pressing");
    expect(h.onDragStart).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(h.result.current.phase).toBe("dragging");
    expect(h.result.current.drag).toMatchObject({
      viaLongPress: true,
      pointer: { x: 102, y: 203 },
    });
    expect(h.onDragStart).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(10);

    // 長按之後同樣的 40px 移動,現在是「拖色塊」而不是捲動。
    act(() => h.result.current.onPointerMove({ pointerType: "touch", clientX: 142, clientY: 260 }));
    expect(h.result.current.phase).toBe("dragging");
    expect(h.result.current.drag!.pointer).toEqual({ x: 142, y: 260 });

    act(() => h.result.current.onPointerUp());
    expect(h.onDrop).toHaveBeenCalledWith({
      source: source(),
      grabOffsetY: 20,
      pointer: { x: 142, y: 260 },
      viaLongPress: true,
    });
    expect(h.onClick).not.toHaveBeenCalled();
  });

  it("navigator.vibrate 不存在時不會丟錯,照樣進 dragging", () => {
    Object.defineProperty(navigator, "vibrate", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const h = setup();
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "touch", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    act(() => {
      vi.advanceTimersByTime(TOUCH_LONG_PRESS_MS);
    });
    expect(h.result.current.phase).toBe("dragging");
  });

  it("觸控點一下(500ms 內放開、沒移動)= 點擊 → onClick,長按計時器被清掉", () => {
    const h = setup();
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "touch", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    act(() => {
      vi.advanceTimersByTime(120);
    });
    act(() => h.result.current.onPointerUp());
    expect(h.result.current.phase).toBe("idle");
    expect(h.onClick).toHaveBeenCalledTimes(1);
    // 放開之後時間再走,也不會莫名進 dragging。
    act(() => {
      vi.advanceTimersByTime(TOUCH_LONG_PRESS_MS * 2);
    });
    expect(h.result.current.phase).toBe("idle");
    expect(h.onDragStart).not.toHaveBeenCalled();
  });

  it("長按前瀏覽器發 pointercancel(原生捲動接手)→ 回 idle,計時器不會事後把它變成拖拉", () => {
    const h = setup();
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "touch", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    act(() => h.result.current.onPointerCancel());
    expect(h.result.current.phase).toBe("idle");
    act(() => {
      vi.advanceTimersByTime(TOUCH_LONG_PRESS_MS * 2);
    });
    expect(h.result.current.phase).toBe("idle");
    expect(h.onDragStart).not.toHaveBeenCalled();
  });

  it("自訂 longPressMs 生效(300ms)", () => {
    const h = setup({ longPressMs: 300 });
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "touch", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(h.result.current.phase).toBe("pressing");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(h.result.current.phase).toBe("dragging");
  });

  it("觸控筆(pen)走跟 touch 一樣的長按路徑,不會像滑鼠一移動就拖", () => {
    const h = setup();
    act(() =>
      h.result.current.onPointerDown({ pointerType: "pen", clientX: 100, clientY: 200 }, source()),
    );
    act(() => h.result.current.onPointerMove({ pointerType: "pen", clientX: 150, clientY: 200 }));
    expect(h.result.current.phase).toBe("pressing");
    expect(h.onDragStart).not.toHaveBeenCalled();
  });

  it("卸載時清掉長按計時器(不會在元件消失後還呼叫 onDragStart)", () => {
    const h = setup();
    act(() =>
      h.result.current.onPointerDown(
        { pointerType: "touch", clientX: 100, clientY: 200 },
        source(),
      ),
    );
    h.unmount();
    act(() => {
      vi.advanceTimersByTime(TOUCH_LONG_PRESS_MS * 2);
    });
    expect(h.onDragStart).not.toHaveBeenCalled();
  });
});
