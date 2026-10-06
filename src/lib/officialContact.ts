// 秒約官方(平台方)的聯絡管道 —— SPECS-INDEX #974(2026-10-06)。
//
// 使用者 2026-10-02 裁決 H-3:「LINE 串接設定」頁的說明要附「可聯繫我們的官方 LINE@ 協助設定」,
// 但官方 LINE@ 還沒申請 ⇒ 先預留位置。
//
// 🔴 OFFICIAL_LINE_AT_URL 目前刻意是空字串:空的時候畫面上「官方 LINE@」只顯示純文字;
//    之後申請好了,把網址填進這一個常數(例如 https://lin.ee/xxxx),用到 OfficialLineAtLink
//    (src/components/OfficialLineAtLink.tsx)的地方會自動變成可點的連結,不用改其他程式。
//    **不要放假網址或範例網址** —— 商家點下去會連到別人的帳號。

export const OFFICIAL_LINE_AT_URL = "";
