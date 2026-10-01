// SPECS-INDEX #972:通知類 Edge Function 的「傳入的訂單 / 請假紀錄,真的屬於傳入的商家嗎?」檢查。
//
// 為什麼需要:line-notify-dispatch / push-notify-dispatch 的授權只確認「呼叫者能管理 merchant_id」,
// 但 booking_id / staff_leave_record_id 是呼叫者自己填的。A 商家的管理員/客服如果拿到 B 商家的訂單編號,
// 就能用 A 的身分觸發通知,讓 B 的訂單內容(客戶姓名、服務、金額…)與 B 的服務人員/會員 LINE 使用者
// 編號寫進 A 看得到的發送記錄。
//
// 這裡是 Edge Function 那一層的檢查;資料庫函式(resolve_line_notification_targets、
// render_booking_notification_variables、render_staff_leave_notification_variables)另外也有同樣的檢查
// (migration 20261001150000),兩層都擋 = 縱深防禦。
//
// 設計比照 pushDispatchCore 的窄介面:檢查邏輯本身只依賴 NotifySubjectOwnershipLookup,Deno 測試可以
// 傳入假的 lookup;真正查資料庫的實作 buildNotifySubjectOwnershipLookup 用 service role client。
//
// 回應慣例:不符 → 404「找不到…或它不屬於這個商家」(不區分「不存在」與「別家的」,避免被拿來探測編號);
// 查詢本身出錯 → 500(fail closed,絕不當作通過)。兩種情況都**不寫任何發送記錄**。

// deno-lint-ignore no-explicit-any
type AnyAdminClient = any;

export interface NotifySubjectOwnershipLookup {
  /** 訂單存在且 merchant_id = merchantId → true;不存在或別家的 → false;查詢出錯 → 丟例外。 */
  bookingBelongsToMerchant(bookingId: string, merchantId: string): Promise<boolean>;
  /** 請假紀錄存在且它的服務人員屬於 merchantId → true;否則 false;查詢出錯 → 丟例外。 */
  staffLeaveRecordBelongsToMerchant(staffLeaveRecordId: string, merchantId: string): Promise<boolean>;
}

export type NotifySubjectOwnershipResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "lookup_failed" };

export interface NotifySubjects {
  bookingId?: string | null;
  staffLeaveRecordId?: string | null;
}

/** 有帶的編號逐一檢查;任何一個不符就整個不通過。沒帶任何編號 → 通過(沒有東西可以越界)。 */
export async function checkNotifySubjectsBelongToMerchant(
  lookup: NotifySubjectOwnershipLookup,
  merchantId: string,
  subjects: NotifySubjects,
): Promise<NotifySubjectOwnershipResult> {
  try {
    if (subjects.bookingId) {
      const ok = await lookup.bookingBelongsToMerchant(subjects.bookingId, merchantId);
      if (!ok) return { ok: false, reason: "not_found" };
    }
    if (subjects.staffLeaveRecordId) {
      const ok = await lookup.staffLeaveRecordBelongsToMerchant(
        subjects.staffLeaveRecordId,
        merchantId,
      );
      if (!ok) return { ok: false, reason: "not_found" };
    }
    return { ok: true };
  } catch (err) {
    console.error("[notify-subject-ownership] 檢查訂單/請假紀錄歸屬時發生錯誤", err);
    return { ok: false, reason: "lookup_failed" };
  }
}

/** 真正查資料庫的實作(service role client)。 */
export function buildNotifySubjectOwnershipLookup(
  adminClient: AnyAdminClient,
): NotifySubjectOwnershipLookup {
  return {
    async bookingBelongsToMerchant(bookingId: string, merchantId: string) {
      const { data, error } = await adminClient
        .from("bookings")
        .select("id")
        .eq("id", bookingId)
        .eq("merchant_id", merchantId)
        .maybeSingle();
      if (error) throw error;
      return data !== null && data !== undefined;
    },

    async staffLeaveRecordBelongsToMerchant(staffLeaveRecordId: string, merchantId: string) {
      const { data: record, error: recordError } = await adminClient
        .from("staff_leave_records")
        .select("staff_id")
        .eq("id", staffLeaveRecordId)
        .maybeSingle();
      if (recordError) throw recordError;
      const staffId = (record as { staff_id: string | null } | null)?.staff_id;
      if (!staffId) return false;

      const { data: staff, error: staffError } = await adminClient
        .from("merchant_staff")
        .select("id")
        .eq("id", staffId)
        .eq("merchant_id", merchantId)
        .maybeSingle();
      if (staffError) throw staffError;
      return staff !== null && staff !== undefined;
    },
  };
}

export const NOTIFY_SUBJECT_NOT_FOUND_MESSAGE = "找不到這筆訂單或請假紀錄,或它不屬於這個商家";
export const NOTIFY_SUBJECT_LOOKUP_FAILED_MESSAGE = "確認訂單歸屬時發生錯誤";
