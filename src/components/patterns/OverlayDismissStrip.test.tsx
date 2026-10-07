// 第 11 批 J(#995 J-1、J-4 ~ J-8、J-16 ~ J-18):三個殼的「點外面不關」「上方空白條」與全頁層寬度。
//
// jsdom 沒有版面引擎(getBoundingClientRect 永遠是 0 ⇒ 上方 0px ⇒ 空白條不畫),
// 所以這裡把視窗本體的位置假裝成「上方還有 200px」(= 電腦版全頁層 / 置中小卡窗的情境)。
// 真實瀏覽器的位置與寬度在 e2e-local/b11-j-overlay-dismiss-and-width.spec.ts 驗。

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readSourceWithoutComments } from "@/test/sourceScan";

import {
  CardAlertDialog,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
} from "./CardAlertDialog";
import { CardDialog, CardDialogContent, CardDialogHeader, CardDialogTitle } from "./CardDialog";
import { FullPageLayer, FullPageLayerContent } from "./FullPageLayer";
import { FULL_PAGE_PANEL_CLASS, OVERLAY_CLASS } from "./overlayClasses";
import { computeStripRect } from "./overlayDismissLogic";

let rectTop = 200;

beforeEach(() => {
  rectTop = 200;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        top: rectTop,
        left: 100,
        width: 400,
        height: 300,
        right: 500,
        bottom: rectTop + 300,
        x: 100,
        y: rectTop,
        toJSON: () => ({}),
      }) as DOMRect,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

function overlay(): HTMLElement {
  const first = OVERLAY_CLASS.split(" ").find((c) => c.startsWith("bg-"))!;
  const nodes = [...document.querySelectorAll<HTMLElement>("div")].filter((d) =>
    d.className.split(" ").includes(first),
  );
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[nodes.length - 1]!;
}

function strips(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-overlay-dismiss-strip]")];
}

const user = () => userEvent.setup();

/** Radix 的「點外面」偵測是在開窗後下一個 tick 才掛上 document 監聽;不等的話點遮罩根本不會被偵測到,
 *  「點遮罩不關」就會變成假綠燈(故障注入時實際踩到過)。 */
async function radixReady() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("① 全頁層(電腦):點遮罩不關、點上方空白條 = 關", () => {
  it("點遮罩 ⇒ 仍開;點空白條 ⇒ onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(
      <FullPageLayer open onOpenChange={onOpenChange}>
        <FullPageLayerContent title="新增預約">內容</FullPageLayerContent>
      </FullPageLayer>,
    );
    await radixReady();
    await user().click(overlay());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    expect(strips()).toHaveLength(1);
    const strip = strips()[0]!;
    // 全頁層上限 56px,寬 = 面板寬、左右對齊面板。
    expect(strip.style.height).toBe("56px");
    expect(strip.style.top).toBe(`${200 - 56}px`);
    expect(strip.style.left).toBe("100px");
    expect(strip.style.width).toBe("400px");
    await user().click(strip);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("頁面傳的 onPointerDownOutside 仍會被呼叫,但視窗一樣不關", async () => {
    const onOpenChange = vi.fn();
    const onPointerDownOutside = vi.fn();
    render(
      <FullPageLayer open onOpenChange={onOpenChange}>
        <FullPageLayerContent title="新增預約" onPointerDownOutside={onPointerDownOutside}>
          內容
        </FullPageLayerContent>
      </FullPageLayer>,
    );
    await radixReady();
    await user().click(overlay());
    expect(onPointerDownOutside).toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("手機滿版(上方 0px)⇒ 沒有空白條元素", () => {
    rectTop = 0;
    render(
      <FullPageLayer open onOpenChange={() => {}}>
        <FullPageLayerContent title="新增預約">內容</FullPageLayerContent>
      </FullPageLayer>,
    );
    expect(strips()).toHaveLength(0);
  });
});

describe("② 小卡窗:點遮罩不關、點卡片正上方 48px = 關", () => {
  it("點遮罩 ⇒ 仍開;點空白條 ⇒ onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(
      <CardDialog open onOpenChange={onOpenChange}>
        <CardDialogContent>
          <CardDialogHeader>
            <CardDialogTitle>付款方式</CardDialogTitle>
          </CardDialogHeader>
        </CardDialogContent>
      </CardDialog>,
    );
    await radixReady();
    await user().click(overlay());
    expect(onOpenChange).not.toHaveBeenCalled();
    const strip = strips()[0]!;
    expect(strip.style.height).toBe("48px");
    await user().click(strip);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("卡片上方不到 48px ⇒ 用剩下的高度;不到 16px ⇒ 不畫", () => {
    expect(computeStripRect({ top: 30, left: 0, width: 300 }, 48)?.height).toBe(30);
    expect(computeStripRect({ top: 15, left: 0, width: 300 }, 48)).toBeNull();
    expect(computeStripRect({ top: 300, left: 0, width: 300 }, 48)?.height).toBe(48);
  });
});

describe("③ 確認窗:點空白條 = 取消(走 onOpenChange(false)),不跑「取消」鈕自己的 onClick", () => {
  it("onOpenChange(false) 被呼叫、取消鈕 onClick 沒被呼叫", async () => {
    const onOpenChange = vi.fn();
    const onCancelClick = vi.fn();
    render(
      <CardAlertDialog open onOpenChange={onOpenChange}>
        <CardAlertDialogContent>
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>確定要取消預約嗎？</CardAlertDialogTitle>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            <CardAlertDialogCancel onClick={onCancelClick}>返回</CardAlertDialogCancel>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>,
    );
    await radixReady();
    await user().click(overlay());
    expect(onOpenChange).not.toHaveBeenCalled();
    const strip = strips()[0]!;
    // 第 12 批 #1000:條上不顯示任何字或圖示。
    expect(strip.textContent).toBe("");
    expect(strip.querySelector("svg")).toBeNull();
    await user().click(strip);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCancelClick).not.toHaveBeenCalled();
  });

  it("開窗焦點仍落在「取消」鈕(隱藏的關閉鈕沒有搶走 Radix 的 cancelRef)", async () => {
    render(
      <CardAlertDialog open onOpenChange={() => {}}>
        <CardAlertDialogContent>
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>確定?</CardAlertDialogTitle>
          </CardAlertDialogHeader>
          <CardAlertDialogFooter>
            <CardAlertDialogCancel>返回</CardAlertDialogCancel>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "返回" }));
  });

  it("頁面 onEscapeKeyDown preventDefault(例:送出中)⇒ 點空白條也不關", async () => {
    const onOpenChange = vi.fn();
    render(
      <CardAlertDialog open onOpenChange={onOpenChange}>
        <CardAlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>送出中</CardAlertDialogTitle>
          </CardAlertDialogHeader>
        </CardAlertDialogContent>
      </CardAlertDialog>,
    );
    await user().click(strips()[0]!);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("④ dismissStrip={false} ⇒ 沒有空白條元素", () => {
  it("確認窗", () => {
    render(
      <CardAlertDialog open onOpenChange={() => {}}>
        <CardAlertDialogContent dismissStrip={false}>
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>必須選一個</CardAlertDialogTitle>
          </CardAlertDialogHeader>
        </CardAlertDialogContent>
      </CardAlertDialog>,
    );
    expect(strips()).toHaveLength(0);
  });

  it("小卡窗", () => {
    render(
      <CardDialog open onOpenChange={() => {}}>
        <CardDialogContent dismissStrip={false}>
          <CardDialogHeader>
            <CardDialogTitle>x</CardDialogTitle>
          </CardDialogHeader>
        </CardDialogContent>
      </CardDialog>,
    );
    expect(strips()).toHaveLength(0);
  });
});

describe("⑤ 空白條 aria-hidden、不在 Tab 順序", () => {
  it("aria-hidden=true、沒有 tabindex、不是按鈕", () => {
    render(
      <CardDialog open onOpenChange={() => {}}>
        <CardDialogContent>
          <CardDialogHeader>
            <CardDialogTitle>x</CardDialogTitle>
          </CardDialogHeader>
        </CardDialogContent>
      </CardDialog>,
    );
    const strip = strips()[0]!;
    expect(strip.getAttribute("aria-hidden")).toBe("true");
    expect(strip.hasAttribute("tabindex")).toBe(false);
    expect(strip.tagName).toBe("DIV");
    // 隱藏的關閉鈕也不可聚焦。
    for (const hidden of document.querySelectorAll<HTMLElement>("[data-overlay-hidden-close]")) {
      expect(hidden.getAttribute("tabindex")).toBe("-1");
      expect(hidden.style.display).toBe("none");
    }
  });

  it("視窗大小改變會重量位置(resize)", async () => {
    render(
      <CardDialog open onOpenChange={() => {}}>
        <CardDialogContent>
          <CardDialogHeader>
            <CardDialogTitle>x</CardDialogTitle>
          </CardDialogHeader>
        </CardDialogContent>
      </CardDialog>,
    );
    expect(strips()).toHaveLength(1);
    rectTop = 4;
    act(() => {
      fireEvent(window, new Event("resize"));
    });
    await waitFor(() => expect(strips()).toHaveLength(0));
  });
});

describe("全頁層電腦版寬度(J-16 / J-17)", () => {
  it("class 含 sm:max-w-6xl、不含 560 / 760;size=wide 與 default 一樣", () => {
    const { unmount } = render(
      <FullPageLayer open onOpenChange={() => {}}>
        <FullPageLayerContent title="a">x</FullPageLayerContent>
      </FullPageLayer>,
    );
    const defaultClass = screen.getByRole("dialog").className;
    unmount();
    render(
      <FullPageLayer open onOpenChange={() => {}}>
        <FullPageLayerContent title="a" size="wide">
          x
        </FullPageLayerContent>
      </FullPageLayer>,
    );
    const wideClass = screen.getByRole("dialog").className;
    expect(defaultClass).toContain("sm:max-w-6xl");
    expect(defaultClass).toContain("sm:w-[calc(100%-32px)]");
    expect(defaultClass).toContain("sm:top-14");
    expect(defaultClass).not.toMatch(/560|760/);
    expect(wideClass).toBe(defaultClass);
    expect(FULL_PAGE_PANEL_CLASS).toBe("sm:w-[calc(100%-32px)] sm:max-w-6xl");
  });

  it("只拉寬不重排:殼裡沒有 grid-cols / 多欄", () => {
    const src = readSourceWithoutComments("src/components/patterns/FullPageLayer.tsx");
    expect(src).not.toMatch(/grid-cols/);
    // 手機滿版那一段沒有被改到。
    expect(src).toContain("fixed inset-0 z-50 flex h-dvh w-full flex-col");
  });
});
