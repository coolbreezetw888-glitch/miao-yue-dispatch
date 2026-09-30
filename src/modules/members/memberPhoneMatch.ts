// SPECS-INDEX #915 / #936(2026-10-01 第二波):建單表單「客戶電話」下方那個面板的純邏輯。
// 規格書:.project/specs/建單自動建立會員與會員兩層狀態.md §12.2(以 §十二 為準,前文 §#914/§#915 已作廢)
//
// 抽成純函式的理由:規格書 §12.6 要求 vitest 測到「面板三種狀態的判斷」與「點選後三欄帶入」,
// 元件裡的 inline 判斷測不到。⇒ 對應測試在 memberPhoneMatch.test.ts。
//
// 🔴 這個面板**不決定**訂單掛在哪位會員底下(§12.1):
//    新增訂單時前端一律不帶 p_member_id,由後端 create_booking 用「送出那一刻的電話」完全相等比對。
//    面板上點選候選,只是「把資料帶進表單」的快捷鍵。

import type { MemberPhoneMatchCandidate } from "./types";

/**
 * 客戶電話正規化 —— **逐字對應**後端 `private.normalize_phone`
 * (supabase/migrations/20260927010000_normalize_phone_extension.sql):
 *   `nullif(regexp_replace(split_part(p_phone, '#', 1), '[^0-9]', '', 'g'), '')`
 * 也就是:在第一個 `#` 處截斷(分機不參與比對)→ 去掉所有非數字 → 空字串視為 null。
 *
 * 規格書要求「用既有 normalize 規則比對,不要自己發明」:前端原本沒有這支函式,這裡是把後端那條
 * 既有規則原樣搬過來,不是新規則。改後端那支時務必同步改這裡,否則面板的「完全相等」會跟
 * create_booking 的自動連結判斷不一致(面板說「將連結」,後端卻建了新會員)。
 */
export function normalizeCustomerPhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined) return null;
  const beforeExtension = phone.split("#", 1)[0] ?? "";
  const digits = beforeExtension.replace(/[^0-9]/g, "");
  return digits === "" ? null : digits;
}

/**
 * 面板三種狀態(§12.2 表格):
 *   A. hidden —— 沒有候選(含不足 4 位、查詢中、查詢失敗)⇒ 完全不顯示
 *   B. prefix —— 有候選,但沒有任何一位的電話跟欄位完全相等 ⇒ 列出「開頭相符的客戶」
 *   C. exact  —— 候選中有一位電話完全相等 ⇒ 一行「將連結既有客戶:{姓名}」,其餘候選不再列出
 */
export type PhoneMatchPanelState =
  | { kind: "hidden" }
  | { kind: "prefix"; candidates: MemberPhoneMatchCandidate[] }
  | { kind: "exact"; match: MemberPhoneMatchCandidate };

export function derivePhoneMatchPanelState(
  phone: string,
  candidates: readonly MemberPhoneMatchCandidate[] | null | undefined,
): PhoneMatchPanelState {
  const list = candidates ?? [];
  if (list.length === 0) return { kind: "hidden" };

  const normalizedInput = normalizeCustomerPhone(phone);
  if (normalizedInput !== null) {
    // #931 之後同一商家一支電話只會有一位 active 會員;後端也把完全相等的那位排在第一筆。
    // 這裡仍用 find 找,不假設「一定是第一筆」,避免排序規則日後被改掉時面板悄悄講錯話。
    const match = list.find((c) => normalizeCustomerPhone(c.phone) === normalizedInput);
    if (match) return { kind: "exact", match };
  }
  return { kind: "prefix", candidates: [...list] };
}

/** 建單表單裡,點選候選時會被帶入的三個欄位。 */
export interface CustomerPrefillFields {
  customerPhone: string;
  customerName: string;
  customerAddress: string;
}

/**
 * #936:點選候選會員時,算出三個欄位的新值(§12.2「點選候選會員時,一次做三件事」):
 *   1. 電話 = 該會員的完整電話(面板因此自然切到狀態 C,「點了誰」跟「電話是誰的」永遠一致);
 *   2. 姓名 = 該會員姓名;
 *   3. 地址 = 只在該產業會顯示地址欄位時(requiresCustomerAddress)才帶入,而且會員有地址才帶;
 *      否則原封不動。
 * 帶入會**覆蓋**原本打的字(客服主動點選 = 明確意圖)。會員電話萬一是空的(理論上不會,
 * 前綴比對一定要有電話才找得到)就保留欄位原值,不把電話清空。
 *
 * 這支只在「點選」時被呼叫;狀態 C 自然出現(客服自己把電話打完整)時**不呼叫**,
 * 所以不會把客服已經打好的姓名/地址吃掉。
 */
export function applyCandidatePrefill(
  current: CustomerPrefillFields,
  candidate: MemberPhoneMatchCandidate,
  requiresCustomerAddress: boolean,
): CustomerPrefillFields {
  const candidatePhone = candidate.phone?.trim() ?? "";
  const candidateAddress = candidate.lastBookingAddress?.trim() ?? "";
  return {
    customerPhone: candidatePhone !== "" ? candidatePhone : current.customerPhone,
    customerName: candidate.name,
    customerAddress:
      requiresCustomerAddress && candidateAddress !== ""
        ? candidateAddress
        : current.customerAddress,
  };
}
