// SPECS-INDEX #641:手機版行事曆服務人員時間軸——橫向滑動誤觸建單/開關時段修復。
//
// 這裡直接測試從 CalendarPage.tsx 抽出來的 useTapVsDragOpenState(見該檔案 DaySlotCell
// 元件上方的完整背景說明),不整個渲染 CalendarPage(牽動大量 context/react-query mocking)。
// 驗證重點:
//   1. 觸控「點擊」(pointerdown 後幾乎沒有移動就 pointerup)→ 開啟選單。
//   2. 觸控「拖曳滑動」(pointerdown 後移動距離超過閾值)→ 不開啟選單,讓原生橫向捲動接手。
//   3. 瀏覽器把這次觸控判定成原生捲動而發 pointercancel(不會再有 pointerup)→ 不開啟選單。
//   4. 滑鼠(pointerType "mouse")完全不受這套攔截邏輯影響,維持原本「按下就開啟」的桌面行為
//      (這裡的 hook 對滑鼠事件是no-op,不覆寫,實際开啟邏輯留給 Radix 內建行為,所以這裡驗證的
//      是「hook 不會把滑鼠事件誤判成需要攔截」)。

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
      result.current.onPointerUp({ pointerType: "touch", clientX: 102, clientY: 101 });
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
      result.current.onPointerUp({ pointerType: "touch", clientX: 140, clientY: 101 });
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
      result.current.onPointerUp({ pointerType: "touch", clientX: 101, clientY: 140 });
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
      result.current.onPointerUp({ pointerType: "touch", clientX: 200, clientY: 200 });
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
      result.current.onPointerUp({ pointerType: "touch", clientX: 20, clientY: 0 });
    });

    expect(result.current.open).toBe(true);
  });

  it("滑鼠事件(pointerType !== touch)完全不觸發攔截邏輯——onOpenChange 直接放行,維持 Radix 原本桌面行為", () => {
    const { result } = renderHook(() => useTapVsDragOpenState());

    // 滑鼠按下:hook 對非 touch 事件是 no-op,不會設定攔截旗標。
    act(() => {
      result.current.onPointerDown({ pointerType: "mouse", clientX: 100, clientY: 100 });
    });
    // Radix 桌面版行為是 pointerdown 當下呼叫 onOpenChange(true)——因為上面沒有設定攔截旗標,
    // 這裡應該直接放行開啟,不會被誤攔下來。
    act(() => {
      result.current.onOpenChange(true);
    });

    expect(result.current.open).toBe(true);
  });
});
