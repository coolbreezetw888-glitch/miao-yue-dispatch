// 超級管理員後台「服務人員名單 / 客服名單」兩張唯讀卡片的畫面顯示 fallback 規則。
// 規格書「超級管理員商家詳情強化」#701。
//
// 這個檔案刻意只放純函式與常數、**不 import React、也不 import supabase client**,
// 方便直接寫單元測試——完全比照 src/modules/merchant/adminDisplay.ts 的既有做法。
//
// ⚠️ 不要在這裡把 null 「coalesce 成某個字串再回傳給資料庫」。資料庫誠實回傳 null、
//    fallback 一律由畫面負責,這是 get_merchant_admin_users 註解裡寫明的既有原則:
//    後端補預設值會讓前端無法分辨「真的沒填」與「填了那串預設文字」。

import type { PlatformAgentRow, PlatformStaffRow } from "./types";

/** Email 沒有值時的畫面 fallback(服務人員還沒開通登入時會遇到)。 */
export const PERSON_LOGIN_EMAIL_PLACEHOLDER = "尚未開通登入";

/** 客服 job_title 沒填時的 fallback。跟 ManagePage.tsx 的 jobTitleFallback 用同一個字串。 */
export const DEFAULT_AGENT_JOB_TITLE = "客服";

/**
 * 名單上的主要稱呼:「姓名(暱稱)」,沒暱稱就只有姓名。
 *
 * 比照 StaffListPage.tsx / AgentListPage.tsx 既有的顯示格式,不自創第二種。
 * ⚠️ 跟 adminDisplay.ts 的 adminDisplayName() 規則**不同**是刻意的:merchant_admins 沒有
 *    name 欄位(只有 display_name + 登入 email),所以那邊的 fallback 是「email 的 @ 前半段」;
 *    merchant_staff / merchant_agents 的 name 是 NOT NULL,一定有真名可以顯示,不需要那層
 *    fallback,反而應該把暱稱當成補充資訊放在括號裡。
 */
export function personDisplayName(p: Pick<PlatformStaffRow, "name" | "nickname">): string {
  const nickname = p.nickname?.trim();
  return nickname ? `${p.name}(${nickname})` : p.name;
}

/** 登入信箱,null/空白時 fallback 成「尚未開通登入」。 */
export function personLoginEmail(p: Pick<PlatformStaffRow, "login_email">): string {
  return p.login_email?.trim() || PERSON_LOGIN_EMAIL_PLACEHOLDER;
}

/** 客服職稱,null/空白時 fallback 成「客服」。 */
export function agentJobTitle(p: Pick<PlatformAgentRow, "job_title">): string {
  return p.job_title?.trim() || DEFAULT_AGENT_JOB_TITLE;
}
