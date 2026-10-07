// 第 12 批(#1000、#1001):視窗上方空白條去字 + 電腦版小卡窗加寬。
//
// jsdom 沒有版面引擎、也不套 Tailwind,所以這裡只驗「結構與 class 規格」;
// 真實瀏覽器的寬度 / 高度 / 置中 / 捲動在 e2e-local/b12-card-dialog-wide.spec.ts 驗。

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CardAlertDialog,
  CardAlertDialogContent,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
} from "./CardAlertDialog";
import {
  CardDialog,
  CardDialogContent,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
} from "./CardDialog";
import { FullPageLayer, FullPageLayerContent } from "./FullPageLayer";
import {
  CARD_CONTENT_CLASS,
  CARD_DIALOG_BODY_CLASS,
  CARD_DIALOG_CONTENT_CLASS,
  CARD_DIALOG_FOOTER_CLASS,
  CARD_DIALOG_HEADER_CLASS,
  CARD_FOOTER_CLASS,
} from "./overlayClasses";

beforeEach(() => {
  // 假裝視窗上方還有 200px,空白條才會畫出來(jsdom 預設全部是 0)。
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        top: 200,
        left: 100,
        width: 400,
        height: 300,
        right: 500,
        bottom: 500,
        x: 100,
        y: 200,
        toJSON: () => ({}),
      }) as DOMRect,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

function strips(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-overlay-dismiss-strip]")];
}

const smTokens = (cls: string) => cls.split(" ").filter((c) => c.startsWith("sm:"));
const baseTokens = (cls: string) => cls.split(" ").filter((c) => !c.includes(":"));

describe("#1000 三種視窗的上方空白條都沒有字、沒有 ✕ 圖示", () => {
  it("全頁層 / 小卡窗 / 確認窗", () => {
    render(
      <>
        <FullPageLayer open onOpenChange={() => {}}>
          <FullPageLayerContent title="a">x</FullPageLayerContent>
        </FullPageLayer>
        <CardDialog open onOpenChange={() => {}}>
          <CardDialogContent>
            <CardDialogHeader>
              <CardDialogTitle>b</CardDialogTitle>
            </CardDialogHeader>
          </CardDialogContent>
        </CardDialog>
        <CardAlertDialog open onOpenChange={() => {}}>
          <CardAlertDialogContent>
            <CardAlertDialogHeader>
              <CardAlertDialogTitle>c</CardAlertDialogTitle>
            </CardAlertDialogHeader>
          </CardAlertDialogContent>
        </CardAlertDialog>
      </>,
    );
    expect(strips()).toHaveLength(3);
    for (const strip of strips()) {
      expect(strip.textContent).toBe("");
      expect(strip.children).toHaveLength(0);
      // 手指游標 + 極淡 hover 底色保留。
      expect(strip.className).toContain("cursor-pointer");
      expect(strip.className).toContain("hover:bg-background/10");
    }
  });
});

describe("#1001 小卡窗電腦版:拉寬、標題列 / 按鈕列固定、中間捲動、按鈕平均分寬", () => {
  it("手機(非 sm:)規格跟確認窗 / 改版前完全一樣;電腦寬度同全頁層、高度上 56 下 18、置中", () => {
    expect(baseTokens(CARD_DIALOG_CONTENT_CLASS)).toEqual(baseTokens(CARD_CONTENT_CLASS));
    expect(CARD_DIALOG_CONTENT_CLASS.startsWith(CARD_CONTENT_CLASS)).toBe(true);
    // 確認窗那條沒被改(電腦仍 400px)。
    expect(CARD_CONTENT_CLASS).toContain("max-w-[400px]");
    expect(smTokens(CARD_CONTENT_CLASS)).toEqual([]);
    expect(smTokens(CARD_DIALOG_CONTENT_CLASS)).toEqual(
      expect.arrayContaining([
        "sm:max-w-6xl",
        "sm:max-h-[calc(100dvh-74px)]",
        "sm:top-[calc(50%+19px)]",
        "sm:overflow-hidden",
      ]),
    );
    // 寬度:w-[calc(100%-32px)] 手機電腦共用(= 全頁層 sm:w-[calc(100%-32px)])。
    expect(CARD_DIALOG_CONTENT_CLASS).toContain("w-[calc(100%-32px)]");
    // 不重排成兩欄。
    expect(CARD_DIALOG_CONTENT_CLASS + CARD_DIALOG_BODY_CLASS).not.toMatch(/grid-cols/);
  });

  it("中間內容區:手機 display:contents、電腦自己捲動", () => {
    expect(baseTokens(CARD_DIALOG_BODY_CLASS)).toEqual(["contents"]);
    expect(CARD_DIALOG_BODY_CLASS).toContain("sm:overflow-y-auto");
    expect(CARD_DIALOG_BODY_CLASS).toContain("sm:min-h-0");
  });

  it("按鈕列:手機各半照舊;電腦不再靠右,按鈕平均分寬;確認窗仍靠右", () => {
    expect(baseTokens(CARD_DIALOG_FOOTER_CLASS)).toEqual(baseTokens(CARD_FOOTER_CLASS));
    expect(CARD_DIALOG_FOOTER_CLASS).not.toContain("sm:justify-end");
    expect(CARD_DIALOG_FOOTER_CLASS).not.toContain("sm:[&>*]:flex-none");
    expect(CARD_DIALOG_FOOTER_CLASS).toContain("[&>*]:flex-1");
    expect(CARD_DIALOG_FOOTER_CLASS).toContain("sm:border-t");
    expect(CARD_FOOTER_CLASS).toContain("sm:justify-end");
    expect(CARD_DIALOG_HEADER_CLASS).toContain("sm:border-b");
  });

  it("DOM:標題列 → 中間內容(包起來)→ 按鈕列,順序照原本", () => {
    render(
      <CardDialog open onOpenChange={() => {}}>
        <CardDialogContent>
          <CardDialogHeader>
            <CardDialogTitle>編輯客服資料</CardDialogTitle>
          </CardDialogHeader>
          <form data-testid="f1">
            <input aria-label="姓名" />
          </form>
          <p data-testid="p1">提示</p>
          <CardDialogFooter>
            <button type="button">取消</button>
            <button type="button">儲存</button>
          </CardDialogFooter>
        </CardDialogContent>
      </CardDialog>,
    );
    const dialog = screen.getByRole("dialog");
    const kids = [...dialog.children];
    expect(kids[0]!.hasAttribute("data-card-dialog-header")).toBe(true);
    expect(kids[1]!.hasAttribute("data-card-dialog-body")).toBe(true);
    expect(kids[2]!.hasAttribute("data-card-dialog-footer")).toBe(true);
    const body = kids[1]!;
    expect([...body.children].map((c) => c.getAttribute("data-testid"))).toEqual(["f1", "p1"]);
    expect(dialog.className).toBe(CARD_DIALOG_CONTENT_CLASS);
  });

  it("只有標題 + 按鈕(沒有中間內容)⇒ 不畫空的內容區;按鈕列緊接標題列(上分隔線由 CSS 拿掉)", () => {
    render(
      <CardDialog open onOpenChange={() => {}}>
        <CardDialogContent>
          <CardDialogHeader>
            <CardDialogTitle>確定?</CardDialogTitle>
          </CardDialogHeader>
          <CardDialogFooter>
            <button type="button">確定</button>
          </CardDialogFooter>
        </CardDialogContent>
      </CardDialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("[data-card-dialog-body]")).toBeNull();
    const header = dialog.querySelector("[data-card-dialog-header]")!;
    expect(header.nextElementSibling?.hasAttribute("data-card-dialog-footer")).toBe(true);
    expect(CARD_DIALOG_FOOTER_CLASS).toContain("sm:[[data-card-dialog-header]+&]:border-t-0");
  });

  it("小卡窗空白條仍是最多 48px(維持置中,不改成全頁層的 56px)", () => {
    render(
      <CardDialog open onOpenChange={() => {}}>
        <CardDialogContent>
          <CardDialogHeader>
            <CardDialogTitle>x</CardDialogTitle>
          </CardDialogHeader>
        </CardDialogContent>
      </CardDialog>,
    );
    expect(strips()[0]!.style.height).toBe("48px");
  });
});
