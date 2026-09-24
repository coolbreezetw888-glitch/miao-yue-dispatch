// 2026-09-24 深夜巡檢新增:底部固定元件疊放順序的回歸測試。
//
// 守的是這次實際發生的事故:商家設定頁的「尚未儲存變更 / 儲存變更」提示列跟 PWA 安裝提示條
// 兩邊各自寫死 `fixed inset-x-0 bottom-16 z-40`,字面完全一樣,安裝提示條在 DOM 裡排在後面,
// 結果把那顆儲存按鈕整個蓋掉,商家管理員看不到也按不到。
//
// 所以這裡除了測小型訂閱器的行為,更重要的是用「解析 class 字串」的方式,直接斷言三層的
// bottom 距離 / z-index 關係正確,而且實際渲染出來的 InstallPwaHint 在「畫面上有動作列」時
// 真的會往上讓開——不是只看常數檔寫了什麼。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";

import InstallPwaHint from "@/components/InstallPwaHint";

import {
  acquireBottomActionBarSlot,
  BOTTOM_LAYER_ACTION_BAR,
  BOTTOM_LAYER_HINT,
  BOTTOM_LAYER_HINT_ABOVE_ACTION_BAR,
  BOTTOM_LAYER_TAB_BAR,
  resetBottomActionBarsForTest,
} from "./bottomFixedLayers";

/** 從 class 字串裡讀出 `bottom-N` 的 N(Tailwind 間距單位,1 = 4px)。 */
function bottomOf(className: string): number {
  const match = className.match(/\bbottom-(\d+)\b/);
  if (!match) throw new Error(`class 字串裡找不到 bottom-*:${className}`);
  return Number(match[1]);
}

/** 從 class 字串裡讀出 `z-N` 的 N。 */
function zIndexOf(className: string): number {
  const match = className.match(/\bz-(\d+)\b/);
  if (!match) throw new Error(`class 字串裡找不到 z-*:${className}`);
  return Number(match[1]);
}

const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

describe("底部固定元件的疊放順序常數", () => {
  it("動作列(未儲存變更)跟提示條(PWA 安裝)的 class 絕對不能完全一樣——這正是事故成因", () => {
    expect(BOTTOM_LAYER_HINT).not.toBe(BOTTOM_LAYER_ACTION_BAR);
    expect(BOTTOM_LAYER_HINT_ABOVE_ACTION_BAR).not.toBe(BOTTOM_LAYER_ACTION_BAR);
  });

  it("z-index 由高到低是:分頁籤 > 動作列 > 提示條(提示條永遠不可能蓋住儲存按鈕)", () => {
    expect(zIndexOf(BOTTOM_LAYER_TAB_BAR)).toBeGreaterThan(zIndexOf(BOTTOM_LAYER_ACTION_BAR));
    expect(zIndexOf(BOTTOM_LAYER_ACTION_BAR)).toBeGreaterThan(zIndexOf(BOTTOM_LAYER_HINT));
    expect(zIndexOf(BOTTOM_LAYER_ACTION_BAR)).toBeGreaterThan(
      zIndexOf(BOTTOM_LAYER_HINT_ABOVE_ACTION_BAR),
    );
  });

  it("動作列要讓開分頁籤的高度;提示條的「讓位版本」要完整讓開分頁籤 + 一條動作列", () => {
    expect(bottomOf(BOTTOM_LAYER_TAB_BAR)).toBe(0);
    expect(bottomOf(BOTTOM_LAYER_ACTION_BAR)).toBeGreaterThan(bottomOf(BOTTOM_LAYER_TAB_BAR));
    // 一條動作列實際高度約 64px(py-3 上下各 12px + 按鈕 40px),也就是 16 個 Tailwind 間距單位。
    expect(bottomOf(BOTTOM_LAYER_HINT_ABOVE_ACTION_BAR)).toBeGreaterThanOrEqual(
      bottomOf(BOTTOM_LAYER_ACTION_BAR) + 16,
    );
  });
});

describe("useHasBottomActionBar / acquireBottomActionBarSlot", () => {
  afterEach(() => {
    // 這個專案的 vitest 沒有開 globals,@testing-library/react 的自動 cleanup 不會生效,
    // 必須自己卸載上一個測試渲染的元件,否則下一個測試會在畫面上找到兩份 InstallPwaHint。
    cleanup();
    resetBottomActionBarsForTest();
    window.localStorage.clear();
  });

  it("沒有人登記動作列時,提示條用原本貼著分頁籤的位置", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: IOS_SAFARI_UA });
    render(<InstallPwaHint />);

    const hint = await screen.findByText(/加入主畫面/);
    const container = hint.closest("div.fixed");
    expect(container).not.toBeNull();
    expect(container?.className).toContain(`bottom-${bottomOf(BOTTOM_LAYER_HINT)}`);
  });

  it("有動作列登記時,提示條往上讓開,渲染出來的 class 跟動作列不會重疊", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: IOS_SAFARI_UA });

    function FakeUnsavedChangesBar() {
      // 模擬 MerchantSettingsPage 有未儲存變更時做的事。
      useEffect(() => acquireBottomActionBarSlot(), []);
      return <div className={BOTTOM_LAYER_ACTION_BAR}>尚未儲存變更</div>;
    }

    render(
      <>
        <FakeUnsavedChangesBar />
        <InstallPwaHint />
      </>,
    );

    const hint = await screen.findByText(/加入主畫面/);
    const container = hint.closest("div.fixed");
    await waitFor(() =>
      expect(container?.className).toContain(
        `bottom-${bottomOf(BOTTOM_LAYER_HINT_ABOVE_ACTION_BAR)}`,
      ),
    );
    // 最關鍵的一條:兩者不會落在同一個 bottom 距離,提示條不可能蓋在儲存按鈕上。
    expect(container?.className).not.toContain(`bottom-${bottomOf(BOTTOM_LAYER_ACTION_BAR)} `);
    expect(bottomOf(container?.className ?? "")).toBeGreaterThan(bottomOf(BOTTOM_LAYER_ACTION_BAR));
  });

  it("兩條動作列同時存在時,先消失的那條不會把另一條的登記一起關掉", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: IOS_SAFARI_UA });

    const releaseA = acquireBottomActionBarSlot();
    const releaseB = acquireBottomActionBarSlot();
    releaseA();
    // 重複呼叫同一個 release 不該重複扣數(否則會把 B 的登記也扣掉)。
    releaseA();

    render(<InstallPwaHint />);
    const hint = await screen.findByText(/加入主畫面/);
    const container = hint.closest("div.fixed");
    expect(bottomOf(container?.className ?? "")).toBe(bottomOf(BOTTOM_LAYER_HINT_ABOVE_ACTION_BAR));

    releaseB();
  });
});
