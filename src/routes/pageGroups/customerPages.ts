// SPECS-INDEX #1054(網站拆檔):「客人預約端」分組 —— 公開預約頁、會員中心、聯絡人邀請頁、LINE 登入回來的頁面。
// 客人打開預約頁只會下載主程式 + 這一包(加上共用元件的小分檔),不會下載商家後台與超級管理員的程式。
export { default as PublicBookingPage } from "@/modules/public-booking/PublicBookingPage";
export { default as MemberCenterPage } from "@/modules/public-booking/MemberCenterPage";
export { default as ContactInvitePage } from "@/modules/public-booking/ContactInvitePage";
export { default as LineLoginCallbackPage } from "@/modules/public-booking/LineLoginCallbackPage";
