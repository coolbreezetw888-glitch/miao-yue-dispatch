// SPECS-INDEX #861 第 5 項:全站彈窗開窗時不要自動聚焦第一個可聚焦元素(手機會彈鍵盤)。
//
// 使用者原話:手機一打開彈窗就自動跳出鍵盤,不方便。根因是 **Radix Dialog 的預設行為**
//(DialogContent 內部的 FocusScope 在 mount 時把焦點送進去第一個可聚焦元素),不是我們寫的
// autoFocus —— 全 src/ 只有 ServiceItemsPage.tsx 一處自己寫過,已一併拿掉。
//
// 🔴 這一支要同時釘住「關掉自動聚焦」跟「不要因此把無障礙弄壞」兩件事。
// 只 preventDefault 不接手焦點的話,焦點會留在窗**外面**那顆觸發按鈕上,鍵盤使用者會迷路。
// 所以四條測試:
//   1. 開窗後焦點**不在輸入框**上(= 手機不會彈鍵盤)
//   2. 開窗後焦點在**對話框容器**裡面(不是留在窗外的觸發按鈕上)
//   3. Tab 進得去(從容器往下走,第一個可聚焦的東西拿到焦點)
//   4. Esc 關得掉,而且關掉後焦點回到原本那顆觸發按鈕
//
// ⚠️ jsdom 沒有版面計算,也沒有真正的虛擬鍵盤 —— 這裡能證明的是「焦點落在哪個元素」,
//    「手機到底還會不會彈鍵盤」最終仍要實機確認(彈鍵盤的觸發條件就是「輸入框拿到焦點」,
//    所以第 1 條是它的機器可驗代理指標)。
//
// 【故障注入驗證(2026-09-30 實際跑過,兩個殼各注入一次,都已還原)】
//   (a) CardDialog.tsx 拿掉 `onOpenAutoFocus={autoFocus.onOpenAutoFocus}`(= 回到 Radix 預設)
//       → CardDialog 那 4 條**全部轉紅**,包含「開窗後焦點不在輸入框上」。
//   (b) FullPageLayer.tsx 同樣拿掉
//       → 只有 3 條轉紅,**「開窗後焦點不在輸入框上」仍然綠**。
//
//   🔴 (b) 這個結果本身就是一個重要發現,寫在這裡免得以後有人誤會:
//   全頁層裡 DOM 上第一個可聚焦的元素是**標題列左上角那顆 ✕**(它在 <header> 裡、排在內容之前),
//   所以 Radix 的預設行為在全頁層上是「聚焦 ✕」,**本來就不會彈鍵盤**。
//   真正會彈鍵盤的是**小卡窗**:CardDialogContent 的 DOM 順序是 `{children}` 先、✕ 後,
//   所以第一個可聚焦的東西就是表單的第一個輸入框(見 CardDialog.tsx)。
//   ⇒ 使用者回報的「一開窗就彈鍵盤」發生在小卡窗;全頁層這邊的改動是為了兩個殼行為一致
//     (焦點都落在容器上),不是在修一個它原本就沒有的 bug。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ActionBar } from "./ActionBar";
import {
  CardDialog,
  CardDialogContent,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
  CardDialogTrigger,
} from "./CardDialog";
import { FieldInput } from "./FormField";
import { FullPageLayer, FullPageLayerContent, FullPageLayerTrigger } from "./FullPageLayer";

function CardDialogHarness() {
  return (
    <CardDialog>
      <CardDialogTrigger>打開小卡窗</CardDialogTrigger>
      <CardDialogContent>
        <CardDialogHeader>
          <CardDialogTitle>修改登入信箱</CardDialogTitle>
        </CardDialogHeader>
        <FieldInput aria-label="登入信箱" defaultValue="" />
        <CardDialogFooter>
          <button type="button">儲存</button>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
  );
}

function FullPageLayerHarness() {
  return (
    <FullPageLayer>
      <FullPageLayerTrigger>打開全頁層</FullPageLayerTrigger>
      <FullPageLayerContent
        title="新增預約"
        footer={
          <ActionBar>
            <button type="button">建立預約</button>
          </ActionBar>
        }
      >
        <FieldInput aria-label="客戶姓名" defaultValue="" />
      </FullPageLayerContent>
    </FullPageLayer>
  );
}

/** Radix 把對話框容器渲染成 role="dialog"(FocusScope 以 asChild 給了它 tabIndex={-1})。 */
function dialogEl(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("彈窗開窗時不自動聚焦(#861 第 5 項)", () => {
  afterEach(() => {
    cleanup();
  });

  describe("CardDialog(小卡窗)", () => {
    it("開窗後焦點不在輸入框上(= 手機不會自動彈鍵盤)", async () => {
      const user = userEvent.setup();
      render(<CardDialogHarness />);
      await user.click(screen.getByText("打開小卡窗"));
      await waitFor(() => expect(dialogEl()).toBeInTheDocument());
      expect(screen.getByLabelText("登入信箱")).not.toHaveFocus();
    });

    it("焦點放在對話框容器本身,不是留在窗外面那顆觸發按鈕上", async () => {
      const user = userEvent.setup();
      render(<CardDialogHarness />);
      const trigger = screen.getByText("打開小卡窗");
      await user.click(trigger);
      await waitFor(() => expect(dialogEl()).toHaveFocus());
      expect(trigger).not.toHaveFocus();
    });

    it("鍵盤 Tab 進得去:從容器按一次 Tab,焦點進到窗內的可聚焦元素", async () => {
      const user = userEvent.setup();
      render(<CardDialogHarness />);
      await user.click(screen.getByText("打開小卡窗"));
      await waitFor(() => expect(dialogEl()).toHaveFocus());

      await user.tab();
      const focused = document.activeElement as HTMLElement;
      expect(dialogEl().contains(focused)).toBe(true);
      expect(focused).not.toBe(dialogEl());
    });

    it("Esc 關得掉,而且關掉後焦點回到原本那顆觸發按鈕", async () => {
      const user = userEvent.setup();
      render(<CardDialogHarness />);
      const trigger = screen.getByText("打開小卡窗");
      await user.click(trigger);
      await waitFor(() => expect(dialogEl()).toHaveFocus());

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(trigger).toHaveFocus();
    });
  });

  describe("FullPageLayer(全頁層:長表單,使用者回報的主場)", () => {
    it("開窗後焦點不在輸入框上(= 手機不會自動彈鍵盤)", async () => {
      const user = userEvent.setup();
      render(<FullPageLayerHarness />);
      await user.click(screen.getByText("打開全頁層"));
      await waitFor(() => expect(dialogEl()).toBeInTheDocument());
      expect(screen.getByLabelText("客戶姓名")).not.toHaveFocus();
    });

    it("焦點放在對話框容器本身", async () => {
      const user = userEvent.setup();
      render(<FullPageLayerHarness />);
      const trigger = screen.getByText("打開全頁層");
      await user.click(trigger);
      await waitFor(() => expect(dialogEl()).toHaveFocus());
      expect(trigger).not.toHaveFocus();
    });

    it("鍵盤 Tab 進得去", async () => {
      const user = userEvent.setup();
      render(<FullPageLayerHarness />);
      await user.click(screen.getByText("打開全頁層"));
      await waitFor(() => expect(dialogEl()).toHaveFocus());

      await user.tab();
      const focused = document.activeElement as HTMLElement;
      expect(dialogEl().contains(focused)).toBe(true);
      expect(focused).not.toBe(dialogEl());
    });

    it("Esc 關得掉,而且關掉後焦點回到原本那顆觸發按鈕", async () => {
      const user = userEvent.setup();
      render(<FullPageLayerHarness />);
      const trigger = screen.getByText("打開全頁層");
      await user.click(trigger);
      await waitFor(() => expect(dialogEl()).toHaveFocus());

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(trigger).toHaveFocus();
    });
  });
});
