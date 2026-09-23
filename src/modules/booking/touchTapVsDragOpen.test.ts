// SPECS-INDEX #641:手機版行事曆服務人員時間軸——橫向滑動誤觸建單/開關時段修復。
//
// 這裡直接測試從 CalendarPage.tsx 抽出來的 useTapVsDragOpenState(見該檔案 DaySlotCell
// 元件上方的完整背景說明),不整個渲染 CalendarPage(牽動大量 context/react-query mocking)。
// 驗證重點:
//   1. 觸控「點擊」(pointerdown 後幾乎沒有移動就 pointerup)→ 開啟選單。
//   2. 觸控「拖曳滑動」(pointerdown 後移動距離超過閾值)→ 不開啟選單,讓原生橫向捲動接手。
//   3. 瀏覽器把這次觸控判定成原生捲動而發 pointercancel(不會再有 pointerup)→ 不開啟選單。
//   4. 2026-09-24 使用者回報後擴大適用範圍:滑鼠(pointerType "mouse")現在跟觸控**行為一致**
//      ——按下不開啟、放開才開啟;按住拖曳超過閾值則完全不開啟(可以直接拖曳瀏覽時間軸)。
//      原本「滑鼠維持 Radix 按下就開啟」的設計已被使用者明確推翻。

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useTapVsDragOpenState } from "./CalendarPage";

describe("useTapVsDragOpenState(SPECS-INDEX #641)", () => {
  it("觸控點擊(幾乎沒有移動就放開)—— 開啟選單", () => {
    const { result } = renderHook(() => useTapVsDragOpenState());

    act(() => {
      result.current.onPointerDown({ pointerType: "touch", clientX: 100, clientY: 100 });
    });
    expect(result.current.open).toBe(false); // Radix 的自動開啟被攔下,先不開。

    act(() => {
      // 移動 2px,遠低於預設閾值(10px),仍視為點擊。
      result.current.onPointerMove({ pointerType: "touch", clientX: 102, clientY: 101 });
    });
    act(() => {
      result.current.onPointerUp();
    });

    expect(result.current.open).toBe(true);
  });

  it("觸控橫向拖曳滑動(移動距離超過閾值)—— 不開啟選單", () => {
    const { result } = renderHook(() => useTapVsDragOpenState());

    act(() => {
      result.current.onPointerDown({ pointerType: "touch", clientX: 100, clientY: 100 });
    });
    act(() => {
      // 橫向移動 40px,超過預設閾值(10px),視為拖曳滑動。
      result.current.onPointerMove({ pointerType: "touch", clientX: 140, clientY: 101 });
    });
    act(() => {
      result.current.onPointerUp();
    });

    expect(result.current.open).toBe(false);
  });

  it("縱向移動超過閾值同樣視為拖曳,不開啟選單(門檻對 x/y 兩個方向都適用)", () => {
    const { result } = renderHook(() => useTapVsDragOpenState());

    act(() => {
      result.current.onPointerDown({ pointerType: "touch", clientX: 100, clientY: 100 });
    });
    act(() => {
      result.current.onPointerMove({ pointerType: "touch", clientX: 101, clientY: 140 });
    });
    act(() => {
      result.current.onPointerUp();
    });

    expect(result.current.open).toBe(false);
  });

  it("瀏覽器判定成原生捲動改發 pointercancel(沒有 pointerup)—— 不開啟選單", () => {
    const { result } = renderHook(() => useTapVsDragOpenState());

    act(() => {
      result.current.onPointerDown({ pointerType: "touch", clientX: 100, clientY: 100 });
    });
    act(() => {
      result.current.onPointerCancel();
    });

    expect(result.current.open).toBe(false);

    // 重置後下一次觸控應該恢復正常,不會被上一次的狀態污染。
    act(() => {
      result.current.onPointerDown({ pointerType: "touch", clientX: 200, clientY: 200 });
    });
    act(() => {
      result.current.onPointerUp();
    });

    expect(result.current.open).toBe(true);
  });

  it("自訂閾值:剛好等於閾值不算拖曳,超過閾值才算", () => {
    const { result } = renderHook(() => useTapVsDragOpenState(20));

    act(() => {
      result.current.onPointerDown({ pointerType: "touch", clientX: 0, clientY: 0 });
    });
    act(() => {
      // 剛好 20px,沒有「超過」20,不算拖曳。
      result.current.onPointerMove({ pointerType: "touch", clientX: 20, clientY: 0 });
    });
    act(() => {
      result.current.onPointerUp();
    });

    expect(result.current.open).toBe(true);
  });

  it("滑鼠點擊:按下當下不開啟(攔下 Radix 的自動開啟),放開左鍵才開啟", () => {
    const { result } = renderHook(() => useTapVsDragOpenState());

    act(() => {
      result.current.onPointerDown({ pointerType: "mouse", clientX: 100, clientY: 100 });
    });
    // Radix 桌面版行為是 pointerdown 當下就呼叫 onOpenChange(true),這裡要被攔下來。
    act(() => {
      result.current.onOpenChange(true);
    });
    expect(result.current.open).toBe(false);

    act(() => {
      result.current.onPointerUp();
    });
    expect(result.current.open).toBe(true);
  });

  it("滑鼠按住拖曳超過閾值(左右橫移瀏覽時間軸)—— 放開時不開啟選單", () => {
    const { result } = renderHook(() => useTapVsDragOpenState());

    act(() => {
      result.current.onPointerDown({ pointerType: "mouse", clientX: 100, clientY: 100 });
    });
    act(() => {
      result.current.onOpenChange(true);
    });
    act(() => {
      result.current.onPointerMove({ pointerType: "mouse", clientX: 160, clientY: 103 });
    });
    act(() => {
      result.current.onPointerUp();
    });

    expect(result.current.open).toBe(false);
  });

  it("拖曳到格子外面才放開(該格子收不到 pointerup)—— 選單不開啟,而且下一次點擊不會被殘留旗標卡住", () => {
    const { result } = renderHook(() => useTapVsDragOpenState());

    act(() => {
      result.current.onPointerDown({ pointerType: "mouse", clientX: 100, clientY: 100 });
    });
    act(() => {
      result.current.onPointerMove({ pointerType: "mouse", clientX: 300, clientY: 100 });
    });
    // 這裡刻意不呼叫 onPointerUp,模擬「放開時滑鼠已經離開這個格子」。
    expect(result.current.open).toBe(false);

    // 下一次完整的點擊仍然要正常開啟。
    act(() => {
      result.current.onPointerDown({ pointerType: "mouse", clientX: 100, clientY: 100 });
    });
    act(() => {
      result.current.onPointerUp();
    });

    expect(result.current.open).toBe(true);
  });
});
