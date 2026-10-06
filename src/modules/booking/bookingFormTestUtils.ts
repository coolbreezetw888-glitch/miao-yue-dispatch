// 建單表單元件測試共用的操作步驟(只給 *.test.tsx 用,產品程式不會 import)。
//
// SPECS-INDEX #979(2026-10-06)之後,建單表單的兩個操作方式變了,三支表單測試都要照新的方式點:
//   ・服務項目:不再是表單上的一顆顆方塊,要先點「選擇項目 >」進整頁、勾選、按「確認」
//   ・付款方式:不再是一排單選方塊(radio),改成下拉選單(Radix Select)
// 集中在這裡,之後畫面再改只要改一個地方。

import { act, fireEvent, screen, within } from "@testing-library/react";

/** jsdom 沒有實作 Radix Select 需要的幾個 DOM API,打開下拉前先補上(只補不存在的)。 */
export function installRadixSelectPolyfills(): void {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto["hasPointerCapture"]) proto["hasPointerCapture"] = () => false;
  if (!proto["setPointerCapture"]) proto["setPointerCapture"] = () => {};
  if (!proto["releasePointerCapture"]) proto["releasePointerCapture"] = () => {};
  if (!proto["scrollIntoView"]) proto["scrollIntoView"] = () => {};
}

/** 打開「選擇項目」整頁 → 依序勾選 → 按「確認」。 */
export function pickServiceItems(names: (string | RegExp)[]): void {
  fireEvent.click(document.getElementById("booking-service-items") as HTMLElement);
  const picker = screen.getByTestId("service-item-picker");
  for (const name of names) {
    fireEvent.click(within(picker).getByRole("checkbox", { name }));
  }
  fireEvent.click(within(picker).getByRole("button", { name: /^確認/ }));
}

/** 付款方式下拉:用鍵盤打開(jsdom 裡最穩定的方式),再點選項。 */
export async function selectPaymentMethod(name: string): Promise<void> {
  installRadixSelectPolyfills();
  const trigger = document.getElementById("booking-payment-method") as HTMLElement;
  await act(async () => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  const option = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.click(option);
  });
}

/** 一天 48 個半小時起點(mock list_staff_bookable_start_times 用:全部都能約)。 */
export const ALL_DAY_START_TIMES: string[] = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, "0");
  return `${h}:${i % 2 === 0 ? "00" : "30"}`;
});
