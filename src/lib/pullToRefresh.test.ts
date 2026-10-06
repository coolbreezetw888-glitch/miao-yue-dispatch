// SPECS-INDEX #982:手機下拉刷新的判斷邏輯(觸發門檻與停用條件)。
import { afterEach, describe, expect, it } from "vitest";

import {
  PULL_LONG_PRESS_CANCEL_MS,
  PULL_TEXT_PULLING,
  PULL_TEXT_READY,
  PULL_TO_REFRESH_THRESHOLD_PX,
  resolvePullBlockReason,
  resolvePullDirection,
  resolvePullIndicator,
  shouldTriggerRefresh,
} from "./pullToRefresh";

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

function reason(
  target: Element | null,
  extra: Partial<Parameters<typeof resolvePullBlockReason>[0]> = {},
) {
  return resolvePullBlockReason({
    target,
    doc: document,
    viewportWidth: 375,
    touchCount: 1,
    pageScrollTop: 0,
    ...extra,
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("data-scroll-locked");
});

describe("觸發門檻", () => {
  it("拉超過約 70px 放開才觸發", () => {
    expect(PULL_TO_REFRESH_THRESHOLD_PX).toBe(70);
    expect(shouldTriggerRefresh(69)).toBe(false);
    expect(shouldTriggerRefresh(70)).toBe(true);
  });
  it("超過門檻時文字變「放開以重新整理」", () => {
    expect(resolvePullIndicator(30).text).toBe(PULL_TEXT_PULLING);
    expect(resolvePullIndicator(30).ready).toBe(false);
    expect(resolvePullIndicator(80).text).toBe(PULL_TEXT_READY);
    expect(resolvePullIndicator(80).ready).toBe(true);
  });
  it("指示器位移有上限(拉很長也不會一路滑到畫面中間)", () => {
    expect(resolvePullIndicator(1000).offset).toBeLessThanOrEqual(64);
    expect(resolvePullIndicator(-10).offset).toBe(0);
  });
});

describe("開始時的停用條件(resolvePullBlockReason)", () => {
  it("一般頁面、在最頂端、單指 ⇒ 可以", () => {
    mount(`<main><p id="t">內容</p></main>`);
    expect(reason(document.getElementById("t"))).toBeNull();
  });
  it("電腦版(寬 ≥ 1024)⇒ 不做", () => {
    mount(`<p id="t"></p>`);
    expect(reason(document.getElementById("t"), { viewportWidth: 1024 })).toBe("desktop");
    expect(reason(document.getElementById("t"), { viewportWidth: 1023 })).toBeNull();
  });
  it("兩根手指(縮放)⇒ 不觸發", () => {
    mount(`<p id="t"></p>`);
    expect(reason(document.getElementById("t"), { touchCount: 2 })).toBe("multi-touch");
  });
  it("🔴 彈窗 / 全頁層開著 ⇒ 停用(就算手指放在彈窗外面)", () => {
    mount(`<p id="t"></p><div role="dialog" data-state="open">表單</div>`);
    expect(reason(document.getElementById("t"))).toBe("overlay-open");
  });
  it("🔴 Radix 鎖住捲動(body data-scroll-locked)⇒ 停用", () => {
    mount(`<p id="t"></p>`);
    document.body.setAttribute("data-scroll-locked", "1");
    expect(reason(document.getElementById("t"))).toBe("overlay-open");
  });
  it("下拉選單 / 小選單開著 ⇒ 停用", () => {
    mount(`<p id="t"></p><div role="menu" data-state="open"></div>`);
    expect(reason(document.getElementById("t"))).toBe("overlay-open");
  });
  it("整頁選擇畫面(data-pull-to-refresh=off)在畫面上 ⇒ 停用", () => {
    mount(`<p id="t"></p><div data-pull-to-refresh="off"><span id="in"></span></div>`);
    expect(reason(document.getElementById("t"))).toBe("overlay-open");
  });
  it("已經關掉的對話框(data-state=closed)不算", () => {
    mount(`<p id="t"></p><div role="dialog" data-state="closed"></div>`);
    expect(reason(document.getElementById("t"))).toBeNull();
  });
  it("🔴 手指從行事曆可拖拉的預約色塊開始 ⇒ 不觸發(長按是拖拉改時間)", () => {
    mount(`<div><button data-booking-draggable="true"><span id="t">王小明</span></button></div>`);
    expect(reason(document.getElementById("t"))).toBe("opted-out");
  });
  it("頁面不在最頂端 ⇒ 不觸發", () => {
    mount(`<p id="t"></p>`);
    expect(reason(document.getElementById("t"), { pageScrollTop: 5 })).toBe("page-not-at-top");
  });
  it("🔴 內層有自己的捲動區、而且不在頂端(行事曆格線往下捲過)⇒ 不觸發;在頂端 ⇒ 可以", () => {
    mount(`<div id="scroller" style="overflow-y:auto"><div id="t">格子</div></div>`);
    const scroller = document.getElementById("scroller")!;
    scroller.scrollTop = 120;
    expect(reason(document.getElementById("t"))).toBe("inner-scrolled");
    scroller.scrollTop = 0;
    expect(reason(document.getElementById("t"))).toBeNull();
  });
});

describe("移動中的方向判斷(resolvePullDirection)", () => {
  it("還沒移動多少 ⇒ 先不決定", () => {
    expect(resolvePullDirection({ dx: 2, dy: 3, elapsedMs: 50 })).toBe("undecided");
  });
  it("往下為主 ⇒ pull", () => {
    expect(resolvePullDirection({ dx: 4, dy: 30, elapsedMs: 100 })).toBe("pull");
  });
  it("🔴 水平為主(左右滑換日 / 換週、橫向捲行事曆)⇒ 放棄", () => {
    expect(resolvePullDirection({ dx: 40, dy: 20, elapsedMs: 100 })).toBe("cancel");
    expect(resolvePullDirection({ dx: -30, dy: 30, elapsedMs: 100 })).toBe("cancel");
  });
  it("往上 ⇒ 放棄(那是要捲頁面)", () => {
    expect(resolvePullDirection({ dx: 0, dy: -20, elapsedMs: 100 })).toBe("cancel");
  });
  it("🔴 長按之後才開始拖(行事曆長按 0.5 秒浮起來)⇒ 放棄", () => {
    expect(resolvePullDirection({ dx: 0, dy: 2, elapsedMs: PULL_LONG_PRESS_CANCEL_MS + 1 })).toBe(
      "cancel",
    );
    expect(resolvePullDirection({ dx: 0, dy: 40, elapsedMs: PULL_LONG_PRESS_CANCEL_MS + 1 })).toBe(
      "cancel",
    );
    expect(PULL_LONG_PRESS_CANCEL_MS).toBeLessThan(500);
  });
});
