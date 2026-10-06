// 紅利系統重構 批次 7(§4.6):建單 / 編輯表單呼叫 preview_booking_points 的 hook。
//
// ・電話、服務項目、數量、單價、金額任一改變都要重查,但客服打字時不要每按一個鍵就打一次 RPC
//   ⇒ 參數停 300ms 沒變才送(debounce)。
// ・重查期間沿用上一次的結果(placeholderData),區塊不會一直閃成骨架;但**只沿用同一次開啟表單**
//   的結果(sessionKey),避免上一張單的預覽(含會員、可用點數)被拿來當這一張的初始值 ——
//   那會讓「會員變了 ⇒ 折抵歸零」(判斷 24)誤判。

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { previewBookingPoints, type PreviewBookingPointsInput } from "./api";
import { parseBookingPointsPreview, type BookingPointsPreview } from "./bookingPointsLogic";

export const BOOKING_POINTS_PREVIEW_DEBOUNCE_MS = 300;

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * @param input  null = 現在不要查(表單沒開、金額欄位填錯、編輯模式的訂單還沒載入)。
 * @param sessionKey 每次開啟表單換一個值。
 * @param staffFetch SPECS-INDEX #977 第 7 批:服務人員模式改打 staff_preview_booking_points(會員由後端決定)。
 *   不傳 = 商家模式,跟改版前一模一樣(query key 也一樣);有傳時 query key 尾端多一段 "staff",不跟商家模式共用快取。
 */
export function useBookingPointsPreview(
  input: PreviewBookingPointsInput | null,
  sessionKey: string,
  staffFetch?: (input: PreviewBookingPointsInput) => Promise<unknown>,
) {
  const serialized = input ? JSON.stringify(input) : null;
  const debounced = useDebouncedValue(serialized, BOOKING_POINTS_PREVIEW_DEBOUNCE_MS);
  const query = useQuery<BookingPointsPreview>({
    queryKey: staffFetch
      ? ["booking-module", "points-preview", sessionKey, debounced, "staff"]
      : ["booking-module", "points-preview", sessionKey, debounced],
    queryFn: async () =>
      parseBookingPointsPreview(
        await (staffFetch ?? previewBookingPoints)(
          JSON.parse(debounced as string) as PreviewBookingPointsInput,
        ),
      ),
    enabled: debounced !== null,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[2] === sessionKey ? previousData : undefined,
    // 預覽是「這一刻」的試算,不要拿快取的舊結果(餘額可能剛被別張單用掉)。
    staleTime: 0,
    retry: false,
  });
  // v2.4 裁決 22 ① (b):畫面上的預覽是不是「目前這份輸入」算出來的。三種情況都算「不是最新」:
  //   ① 輸入剛改、debounce 還沒送出(serialized ≠ debounced)
  //   ② 已送出、還在等伺服器(isFetching)
  //   ③ 正在顯示上一份輸入的結果(isPlaceholderData)
  // 送出時只要會用到預覽的數字(折抵 / 手動派點 / 人工確認),不是最新就要擋(CalendarPage handleSubmit)。
  const isStale = serialized !== debounced || query.isFetching || query.isPlaceholderData;
  return { query, isStale };
}
