// 模組 15 擴充 §6.5:「證明真的生效」的誠實界線 —— 這個檔案是那條紅線的唯一實作位置。
//
// 🔴 使用者 2026-09-25 特別指定的硬性要求(裁決 Q5):
//    **文案絕對不可以寫成無法兌現的「已生效」。**
//
//    技術上我們確認得到的是「通知抵達了那台裝置的 service worker」;
//    我們確認不到的是「通知真的畫在使用者的通知列上」。
//    這兩件事之間隔著手機的靜音、專注模式、系統層級的網站通知開關 —— 這三樣東西全部關掉,
//    §6.3 的 ack **照樣會回報成功**,而使用者**什麼都看不到**。
//
//    判斷法則(給 engineer 跟 qa 用):把畫面上那句話當成承諾唸出來,問
//    「如果使用者的手機在靜音,這句話還是真的嗎?」—— 不是,就是違規文案。
//
//    禁止字眼:「已生效」「已確認生效」「通知功能正常」「設定完成,你會收到通知」「已成功開啟並生效」
//    允許字眼:「已確認你的**裝置**收到通知」「通知已送出」「還沒收到你裝置的回報」「你剛剛點了測試通知」
//
// ⚠️ 這個檔案有一條 Vitest 測試會對每一句文案掃「禁止字眼清單」。加新文案時請一起跑過。

/** §7.5 / §6.3 的狀態機。 */
export type PushTestState =
  | "idle"
  /** 已呼叫 push-send-test,但還沒收到裝置回報(最多等 15 秒)。 */
  | "waiting"
  /** §6.3:service worker 回報「我收到了」。這是自動能拿到的最強證據。 */
  | "device_acked"
  /** §6.3 備援路徑:使用者真的點了那則通知。最強證據,但需要使用者主動動作。 */
  | "clicked"
  /** 15 秒內沒有任何回報。**不代表失敗**,只代表我們沒有收到回報。 */
  | "no_ack"
  /** 這個人還沒在任何裝置上開通。 */
  | "no_device"
  /** §6.6 擋下。 */
  | "rate_limited"
  /** 呼叫測試推播本身就失敗了(網路/伺服器)。 */
  | "error";

export interface PushTestMessage {
  /** 一句話的主要結果。 */
  text: string;
  /** 需要進一步解釋/排查時才有的第二行。 */
  hint: string | null;
  tone: "success" | "warning" | "muted";
}

/** §6.3 第 4 點:15 秒內沒收到回報就切到 no_ack。 */
export const PUSH_TEST_ACK_TIMEOUT_MS = 15_000;

/** §6.5 的排查清單(ack 沒回來時列出來的常見原因)。 */
export const PUSH_TEST_TROUBLESHOOTING: readonly string[] = [
  "手機開了靜音或專注模式",
  "iPhone 沒有先把秒約加到主畫面(Apple 的限制)",
  "系統或瀏覽器設定裡關掉了這個網站的通知",
  "手機當下沒有網路",
];

export function describePushTestState(state: PushTestState): PushTestMessage | null {
  switch (state) {
    case "idle":
      return null;
    case "waiting":
      return {
        text: "已送出測試通知,正在確認你的裝置是否收到⋯",
        hint: null,
        tone: "muted",
      };
    case "device_acked":
      return {
        // ✅ 只陳述系統真的知道的事:通知抵達了「裝置」。沒有承諾使用者看得到。
        text: "已確認你的裝置收到通知",
        hint: "如果手機上沒看到橫幅,請檢查手機是否在靜音或專注模式。",
        tone: "success",
      };
    case "clicked":
      return {
        text: "你剛剛點了測試通知——從送出到你看到,整條路都通了",
        hint: null,
        tone: "success",
      };
    case "no_ack":
      return {
        text: "通知已送出,但系統沒有收到你裝置的回報",
        hint: "如果你的手機剛剛有跳出通知就沒問題;如果沒有,請看下方的排查建議。",
        tone: "warning",
      };
    case "no_device":
      return {
        text: "你還沒有在任何裝置上開啟通知,所以沒有東西可以測試",
        hint: null,
        tone: "muted",
      };
    case "rate_limited":
      return {
        text: "測試通知發太多次了,請等一分鐘再試",
        hint: null,
        tone: "warning",
      };
    case "error":
      return {
        text: "測試通知沒有送出去",
        hint: "可能是網路不穩或伺服器暫時有狀況,稍後再試一次。",
        tone: "warning",
      };
  }
}

/** §6.3 備援路徑:頁面網址帶了 ?push_test_ack=<token> 代表使用者剛剛點了測試通知。 */
export function readPushTestAckTokenFromSearch(search: string): string | null {
  try {
    const value = new URLSearchParams(search).get("push_test_ack");
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}
