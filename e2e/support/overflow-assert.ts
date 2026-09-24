// 手機版「橫向溢出」斷言助手。
//
// 原本這兩支函式寫在 e2e/mobile-overflow.spec.ts 裡(不 export)。2026-09-25 規格書
// 「超級管理員商家詳情強化」#710 要求新的 platform-admin-merchant-detail.spec.ts
// **複用既有的 assertNoHorizontalOverflow()**,而不是再抄一份——所以整段原封不動搬到
// 這裡對外 export,mobile-overflow.spec.ts 改成 import。
// ⚠️ 搬動時邏輯一個字都沒有改,只有「從檔案內的區域函式」變成「support 模組的 export」。
//    下面的註解(包含每一條排除規則的理由、以及「為什麼只檢查 document.scrollWidth 會
//    變成一份永遠會過的假測試」那段實測紀錄)是這個專案踩過的坑,原樣保留。

import { expect, type Page } from "@playwright/test";

/** 檢查目前頁面有沒有「需要左右滑動才能看完整」的橫向溢出。用完整的頁面/元件描述當作
 * 斷言訊息的一部分,測試失敗時終端機輸出能直接看出是哪個頁面/彈窗出包,不用另外猜。
 *
 * **重點技術細節,寫這份測試時實測踩到的坑,務必保留這段說明**:規格書原本只要求檢查
 * `document.documentElement.scrollWidth <= window.innerWidth`。但實測發現,這個檢查方式
 * 對「彈窗/對話框」(`Dialog`,底層是 `position: fixed`)完全測不出來——用還沒修的
 * `CalendarPage.tsx` 版本實際重現過:客戶欄位的 `<span>` 明明已經撐到
 * `getBoundingClientRect().right` 超過 700px(在 375px 寬的畫面上,肉眼看是明顯被裁切/需要
 * 撐開才看得到全部文字),但 `document.documentElement.scrollWidth` 卻仍然精確等於 375,
 * 完全沒有反映這個溢出。原因是 CSS 的固定定位(`position: fixed`)元素是相對於
 * viewport(而不是 `<html>`)定位的,它的子孫溢出不會被算進 `<html>` 自己的可捲動範圍——
 * 但那個彈窗元素「自己」的 `scrollWidth`(相對於它自己的 `clientWidth`)完全正確反映了
 * 溢出(實測 `scrollWidth: 721` vs `clientWidth: 373`)。所以這裡除了規格書原本要求的
 * document 層級檢查,**額外加上「目前畫面上如果有開啟中的對話框,也檢查那個對話框元素自己
 * 的 scrollWidth」**,兩者都要通過,測試才會對彈窗類型的溢出真的有效——不然會變成一份
 * 「看起來有測試、實際上永遠會過」的假測試,對彈窗类型的 bug 完全沒有防護力。 */
export async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      dialogs: dialogs.map((el) => ({ scrollWidth: el.scrollWidth })),
    };
  });
  expect(
    result.scrollWidth,
    `[${label}] document.documentElement.scrollWidth(${result.scrollWidth}) 超出 window.innerWidth(${result.innerWidth})` +
      `(容許 1px 誤差)——代表這個頁面在 375px 寬的手機螢幕上需要左右滑動才能看完整。`,
  ).toBeLessThanOrEqual(result.innerWidth + 1);

  result.dialogs.forEach((dialog, index) => {
    expect(
      dialog.scrollWidth,
      `[${label}] 第 ${index + 1} 個對話框(role="dialog")的 scrollWidth(${dialog.scrollWidth}) 超出` +
        ` window.innerWidth(${result.innerWidth})(容許 1px 誤差)——彈窗內有內容撐開超出 375px 寬的手機螢幕。`,
    ).toBeLessThanOrEqual(result.innerWidth + 1);
  });

  await assertNoElementOverflow(page, label);
}

/** 編號 190 新增:不透過任何預先猜測的選取器,直接掃描目前畫面上「每一個」元素,比較它
 * 自己的 `scrollWidth` 跟 `clientWidth`——這是唯一能抓到「溢出被相鄰元素視覺蓋住、但沒有撐大
 * 頁面或彈窗整體寬度」這種變體的方式(見檔案開頭「編號 190 追加的第四種偵測方式」說明)。
 *
 * 排除規則,逐項都有實際理由,不是隨便加的:
 * - `INPUT`/`TEXTAREA`/`SELECT`/`OPTION`:表單欄位本身對「內容比欄框寬」有瀏覽器原生的
 *   內部捲動行為(例如打長字的 `<input>`),這是正常的輸入框行為,不是這次要抓的排版 bug。
 * - `SCRIPT`/`STYLE`/`SVG`/`PATH`/`IFRAME`:非可視文字內容元素,量測沒有意義。
 * - `clientWidth <= 4`:排除 shadcn/Radix 大量使用的「螢幕閱讀器專用/視覺隱藏」元素
 *   (例如 `sr-only`,故意把元素縮到 1px 見方再用 `overflow:hidden` 塞進完整文字內容,
 *   這是刻意的無障礙設計,scrollWidth 遠大於 clientWidth 是正常且必要的,不是 bug)。
 * - `overflow-x: auto`/`scroll`:刻意設計成「可以左右滑」的容器(例如比較寬的表格/格線),
 *   這是有意的設計,不是規格書要抓的「應該要換行卻沒換行」問題。
 * - `text-overflow: ellipsis`(對應 Tailwind 的 `truncate`):刻意單行省略號,是規格書
 *   明確認可的其中一種修法,不應該被判定為 bug。
 */
export async function assertNoElementOverflow(page: Page, label: string): Promise<void> {
  const overflowing = await page.evaluate(() => {
    const found: Array<{
      tag: string;
      classes: string;
      text: string;
      scrollWidth: number;
      clientWidth: number;
    }> = [];
    document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
      const tag = el.tagName;
      if (
        [
          "SCRIPT",
          "STYLE",
          "SVG",
          "PATH",
          "IFRAME",
          "INPUT",
          "TEXTAREA",
          "SELECT",
          "OPTION",
        ].includes(tag)
      ) {
        return;
      }
      if (el.clientWidth <= 4) return;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      if (style.overflowX === "auto" || style.overflowX === "scroll") return;
      if (style.textOverflow === "ellipsis") return;
      // 這個元素本身故意比某個「可橫向捲動」的祖先還寬(例如行事曆週檢視格線:外層
      // `overflow-x-auto` 容器裡放一個 `min-w-[640px]` 的內容 div,讓使用者橫向滑動看完整
      // 格線)——這是刻意的設計,不是「文字沒換行撐開容器」的排版 bug,往上找到任何一層
      // 祖先有 `overflow-x: auto`/`scroll` 就跳過,不誤判。
      let ancestor = el.parentElement;
      let hasScrollableAncestor = false;
      while (ancestor) {
        const ancestorOverflowX = window.getComputedStyle(ancestor).overflowX;
        if (ancestorOverflowX === "auto" || ancestorOverflowX === "scroll") {
          hasScrollableAncestor = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (hasScrollableAncestor) return;
      if (el.scrollWidth > el.clientWidth + 1) {
        found.push({
          tag,
          classes: el.className ? String(el.className).slice(0, 100) : "",
          text: (el.textContent ?? "").trim().slice(0, 60),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        });
      }
    });
    return found;
  });

  expect(
    overflowing,
    `[${label}] 發現 ${overflowing.length} 個元素自己的 scrollWidth 超出 clientWidth(容許 1px 誤差)` +
      `——即使沒有撐大整個頁面或彈窗的寬度,這些元素的內容也比自己的版位還寬,實際畫面上很可能被` +
      `相鄰元素蓋住、看不到完整內容:\n${JSON.stringify(overflowing, null, 2)}`,
  ).toEqual([]);
}
