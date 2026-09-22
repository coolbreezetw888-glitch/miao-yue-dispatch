// 模組 11(LINE 通知)— 資料存取層 + 第五節「對外介面」的實作。
// 這裡是唯一直接呼叫 supabase.from('merchant_line_event_settings' / 'line_notification_log')、
// supabase.rpc('set_merchant_line_credentials' / 'generate_xxx_line_binding_code' / ...)、
// supabase.functions.invoke('line-test-connection' / 'line-notify-dispatch' / 'line-send-marketing')
// 的地方。其他模組不應該直接操作這些表/函式,一律 import 這個檔案匯出的 hooks/functions
// (比照模組 7/8/10 api.ts 的既有簡化慣例,查詢 hook 跟底層 supabase 呼叫放同一個檔案)。
//
// 錯誤訊息顯示注意事項(沿用模組 1/3/4/5/6/7/8/9/10 已經確立的踩坑):`error` 不是真正的 Error
// 實例,一律用 `if (error) throw error` 丟出,畫面上用 getErrorMessage() 取訊息。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  LineBindingCodeResult,
  LineBindingTargetType,
  LineNotificationLogRow,
  MerchantLineConfigStatus,
  MerchantLineEventSetting,
  PendingLineNotificationPreview,
} from "./types";

// =========================================================================
// 3.1~3.3:LINE 官方帳號串接憑證管理(規則 2.1,僅商家管理員)。
// =========================================================================
export interface SetMerchantLineCredentialsInput {
  merchantId: string;
  channelId: string;
  channelSecret: string;
  channelAccessToken: string;
}

export async function setMerchantLineCredentials(
  input: SetMerchantLineCredentialsInput,
): Promise<void> {
  const { error } = await supabase.rpc("set_merchant_line_credentials", {
    p_merchant_id: input.merchantId,
    p_channel_id: input.channelId,
    p_channel_secret: input.channelSecret,
    p_channel_access_token: input.channelAccessToken,
  });
  if (error) throw error;
}

interface RawMerchantLineConfigStatus {
  is_connected: boolean;
  channel_id: string | null;
  channel_access_token_masked: string | null;
  display_name: string | null;
  line_bot_basic_id: string | null;
  last_tested_at: string | null;
  last_test_result: string | null;
}

export async function fetchMerchantLineConfigStatus(
  merchantId: string,
): Promise<MerchantLineConfigStatus> {
  const { data, error } = await supabase.rpc("get_merchant_line_config_status", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  const row = data as unknown as RawMerchantLineConfigStatus;
  return {
    isConnected: row.is_connected,
    channelId: row.channel_id,
    channelAccessTokenMasked: row.channel_access_token_masked,
    displayName: row.display_name,
    lineBotBasicId: row.line_bot_basic_id,
    lastTestedAt: row.last_tested_at,
    lastTestResult: row.last_test_result,
  };
}

/** 4.1 對外查詢:目前 LINE 串接狀態(遮蔽過的內容)。 */
export function useMerchantLineConfigStatus(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantLineConfigStatus> {
  return useQuery({
    queryKey: ["line-notifications-module", "config-status", merchantId],
    queryFn: () => fetchMerchantLineConfigStatus(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

export async function disconnectMerchantLine(merchantId: string): Promise<void> {
  const { error } = await supabase.rpc("disconnect_merchant_line", { p_merchant_id: merchantId });
  if (error) throw error;
}

/** Edge Function 呼叫共同的錯誤訊息擷取邏輯(比照 src/modules/staff-agent/api.ts
 * inviteMerchantAgent 既有寫法):supabase.functions.invoke 對非 2xx 回應丟出的
 * FunctionsHttpError 不含 Edge Function 回傳的 JSON 錯誤訊息本文,要另外從 error.context
 * (Response 物件)讀出來。 */
async function extractEdgeFunctionError(error: unknown): Promise<Error> {
  const context = (error as { context?: Response }).context;
  if (context) {
    try {
      const body = (await context.clone().json()) as { error?: string };
      if (body?.error) {
        return new Error(body.error);
      }
    } catch {
      // 讀不到 JSON 本文就退回原本的 error。
    }
  }
  return error instanceof Error ? error : new Error("呼叫失敗,請稍後再試");
}

/** 3.13:呼叫 line-test-connection Edge Function,測試 LINE 憑證是否有效。 */
export async function testLineConnection(
  merchantId: string,
): Promise<{ success: boolean; message: string }> {
  const { data, error } = await supabase.functions.invoke("line-test-connection", {
    body: { merchant_id: merchantId },
  });
  if (error) throw await extractEdgeFunctionError(error);
  return data as { success: boolean; message: string };
}

// =========================================================================
// 3.4~3.7/3.19:LINE 個人帳號綁定碼(判斷 5)+ 解除綁定(規則 2.8 反向操作)。
// =========================================================================
function firstBindingCodeRow(rows: { code: string; expires_at: string }[]): LineBindingCodeResult {
  const row = rows[0];
  if (!row) throw new Error("產生綁定碼失敗,沒有取得任何資料");
  return { code: row.code, expiresAt: row.expires_at };
}

async function issueBindingCode(
  rpcName: "generate_own_admin_line_binding_code" | "generate_own_agent_line_binding_code",
  merchantId: string,
): Promise<LineBindingCodeResult> {
  const { data, error } = await supabase.rpc(rpcName, { p_merchant_id: merchantId });
  if (error) throw error;
  return firstBindingCodeRow(data as { code: string; expires_at: string }[]);
}

/** 3.4:商家管理員幫自己產生綁定碼。 */
export function generateOwnAdminLineBindingCode(
  merchantId: string,
): Promise<LineBindingCodeResult> {
  return issueBindingCode("generate_own_admin_line_binding_code", merchantId);
}

/** 3.5:在職客服幫自己產生綁定碼。 */
export function generateOwnAgentLineBindingCode(
  merchantId: string,
): Promise<LineBindingCodeResult> {
  return issueBindingCode("generate_own_agent_line_binding_code", merchantId);
}

/** 3.6:商家管理員幫服務人員產生綁定碼(沿用模組 3 既有權限邊界,一之二節第 1 點)。 */
export async function generateStaffLineBindingCode(
  staffId: string,
): Promise<LineBindingCodeResult> {
  const { data, error } = await supabase.rpc("generate_staff_line_binding_code", {
    p_staff_id: staffId,
  });
  if (error) throw error;
  return firstBindingCodeRow(data as { code: string; expires_at: string }[]);
}

/** 3.7:歸在既有 members 權限底下,幫會員產生綁定碼。 */
export async function generateMemberLineBindingCode(
  memberId: string,
): Promise<LineBindingCodeResult> {
  const { data, error } = await supabase.rpc("generate_member_line_binding_code", {
    p_member_id: memberId,
  });
  if (error) throw error;
  return firstBindingCodeRow(data as { code: string; expires_at: string }[]);
}

/** 3.19:解除 LINE 綁定(admin/agent 允許本人或管理員;staff 只允許管理員;member 檢查
 * can_manage_members,詳見資料庫端函式的權限邊界)。 */
export async function unbindLineAccount(
  targetType: LineBindingTargetType,
  targetId: string,
): Promise<void> {
  const { error } = await supabase.rpc("unbind_line_account", {
    p_target_type: targetType,
    p_target_id: targetId,
  });
  if (error) throw error;
}

// =========================================================================
// 三個目標的目前綁定狀態查詢(供 4.5/4.6/4.7 的綁定卡片顯示用)。這幾張表的 line_bound/
// line_user_id 欄位是本模組新增/賦予真正意義的欄位,由本模組直接查詢符合模組獨立性
// (規格書一之二節說明:這兩個欄位本來就是本模組的責任範圍)。
// =========================================================================
export interface LineBindingStatus {
  lineBound: boolean;
  lineUserId: string | null;
}

export async function fetchStaffLineBindingStatus(staffId: string): Promise<LineBindingStatus> {
  const { data, error } = await supabase
    .from("merchant_staff")
    .select("line_bound, line_user_id")
    .eq("id", staffId)
    .maybeSingle();
  if (error) throw error;
  return { lineBound: data?.line_bound ?? false, lineUserId: data?.line_user_id ?? null };
}

export function useStaffLineBindingStatus(
  staffId: string | null | undefined,
): UseQueryResult<LineBindingStatus> {
  return useQuery({
    queryKey: ["line-notifications-module", "staff-binding-status", staffId],
    queryFn: () => fetchStaffLineBindingStatus(staffId as string),
    enabled: Boolean(staffId),
  });
}

export async function fetchMemberLineBindingStatus(memberId: string): Promise<LineBindingStatus> {
  const { data, error } = await supabase
    .from("members")
    .select("line_bound, line_user_id")
    .eq("id", memberId)
    .maybeSingle();
  if (error) throw error;
  return { lineBound: data?.line_bound ?? false, lineUserId: data?.line_user_id ?? null };
}

export function useMemberLineBindingStatus(
  memberId: string | null | undefined,
): UseQueryResult<LineBindingStatus> {
  return useQuery({
    queryKey: ["line-notifications-module", "member-binding-status", memberId],
    queryFn: () => fetchMemberLineBindingStatus(memberId as string),
    enabled: Boolean(memberId),
  });
}

export interface SelfLineBindingStatus extends LineBindingStatus {
  /** 本人在這張表的 id(admin=merchant_admins.id / agent=merchant_agents.id),
   * 解除綁定(3.19)要用這個 id,不是 user_id。 */
  selfId: string;
}

/** 4.5「我的 LINE 綁定」card 用:依目前角色查自己那一列。role 由呼叫端傳入(useCurrentMerchantRole
 * 已經判斷過),這裡不重新判斷角色,只負責查對應那張表。 */
export async function fetchMyLineBindingStatus(
  merchantId: string,
  role: "admin" | "agent",
  userId: string,
): Promise<SelfLineBindingStatus> {
  if (role === "admin") {
    const { data, error } = await supabase
      .from("merchant_admins")
      .select("id, line_bound, line_user_id")
      .eq("merchant_id", merchantId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("找不到你在這間商家的管理員紀錄");
    return { selfId: data.id, lineBound: data.line_bound, lineUserId: data.line_user_id };
  }
  const { data, error } = await supabase
    .from("merchant_agents")
    .select("id, line_bound, line_user_id")
    .eq("merchant_id", merchantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("找不到你在這間商家的客服紀錄");
  return { selfId: data.id, lineBound: data.line_bound, lineUserId: data.line_user_id };
}

export function useMyLineBindingStatus(
  merchantId: string | null | undefined,
  role: "admin" | "agent" | null | undefined,
  userId: string | null | undefined,
): UseQueryResult<SelfLineBindingStatus> {
  return useQuery({
    queryKey: ["line-notifications-module", "my-binding-status", merchantId, role, userId],
    queryFn: () => fetchMyLineBindingStatus(merchantId as string, role as "admin" | "agent", userId as string),
    enabled: Boolean(merchantId) && Boolean(role) && Boolean(userId),
  });
}

// =========================================================================
// 3.16:通知事件設定讀寫(直接開放 RLS,比照 merchant_leave_types 既有模式)。
// =========================================================================
export async function fetchMerchantLineEventSettings(
  merchantId: string,
): Promise<MerchantLineEventSetting[]> {
  const { data, error } = await supabase
    .from("merchant_line_event_settings")
    .select("*")
    .eq("merchant_id", merchantId);
  if (error) throw error;
  return data ?? [];
}

export function useMerchantLineEventSettings(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantLineEventSetting[]> {
  return useQuery({
    queryKey: ["line-notifications-module", "event-settings", merchantId],
    queryFn: () => fetchMerchantLineEventSettings(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

export interface UpdateLineEventSettingInput {
  merchantId: string;
  eventType: string;
  enabled: boolean;
  notifyAdmin: boolean;
  notifyAgent: boolean;
  notifyStaff: boolean;
  notifyMember: boolean;
  messageTemplate: string;
}

export async function updateLineEventSetting(
  input: UpdateLineEventSettingInput,
): Promise<MerchantLineEventSetting> {
  const { data, error } = await supabase.rpc("update_line_event_setting", {
    p_merchant_id: input.merchantId,
    p_event_type: input.eventType,
    p_enabled: input.enabled,
    p_notify_admin: input.notifyAdmin,
    p_notify_agent: input.notifyAgent,
    p_notify_staff: input.notifyStaff,
    p_notify_member: input.notifyMember,
    p_message_template: input.messageTemplate,
  });
  if (error) throw error;
  return data as MerchantLineEventSetting;
}

// =========================================================================
// 3.18:發送記錄查詢(4.3 發送記錄頁)。
// =========================================================================
export async function fetchLineNotificationLog(
  merchantId: string,
  eventType: string | null,
  limit: number,
  offset: number,
): Promise<LineNotificationLogRow[]> {
  const { data, error } = await supabase.rpc("get_line_notification_log", {
    p_merchant_id: merchantId,
    ...(eventType ? { p_event_type: eventType } : {}),
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  return (data ?? []) as LineNotificationLogRow[];
}

export function useLineNotificationLog(
  merchantId: string | null | undefined,
  eventType: string | null,
  page: number,
  pageSize = 20,
): UseQueryResult<LineNotificationLogRow[]> {
  return useQuery({
    queryKey: ["line-notifications-module", "notification-log", merchantId, eventType, page, pageSize],
    queryFn: () =>
      fetchLineNotificationLog(merchantId as string, eventType, pageSize, page * pageSize),
    enabled: Boolean(merchantId),
  });
}

// =========================================================================
// 3.15:行銷通知(規則 2.6,僅商家管理員)。
// =========================================================================
export interface MarketableMember {
  id: string;
  name: string;
  phone: string | null;
}

/** 規則 2.6:只有 line_bound=true 的會員才會出現在可選名單裡,避免管理員誤以為選了就會送到。 */
export async function fetchMarketableMembers(merchantId: string): Promise<MarketableMember[]> {
  const { data, error } = await supabase
    .from("members")
    .select("id, name, phone")
    .eq("merchant_id", merchantId)
    .eq("line_bound", true)
    .eq("status", "active")
    .order("name", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export function useMarketableMembers(
  merchantId: string | null | undefined,
): UseQueryResult<MarketableMember[]> {
  return useQuery({
    queryKey: ["line-notifications-module", "marketable-members", merchantId],
    queryFn: () => fetchMarketableMembers(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

export interface SendMarketingMessageInput {
  merchantId: string;
  memberIds: string[];
  message: string;
}

export interface SendMarketingMessageResult {
  sentCount: number;
  failedCount: number;
  skippedCount: number;
}

export async function sendMarketingMessage(
  input: SendMarketingMessageInput,
): Promise<SendMarketingMessageResult> {
  const { data, error } = await supabase.functions.invoke("line-send-marketing", {
    body: {
      merchant_id: input.merchantId,
      member_ids: input.memberIds,
      message: input.message,
    },
  });
  if (error) throw await extractEdgeFunctionError(error);
  const result = data as { sentCount: number; failedCount: number; skippedCount: number };
  return result;
}

// =========================================================================
// 第五節「對外介面」:5.1 dispatchLineNotification、5.2 usePendingLineNotificationPreview。
// 供模組 6(訂單管理)/模組 7(排班與休假管理)的既有 mutation 呼叫成功之後直接 import 使用,
// 不需要各自重新寫 Edge Function 呼叫細節/預覽判斷邏輯。
// =========================================================================
export type DispatchableLineEventType =
  | "booking_created"
  | "booking_confirmed"
  | "booking_cancelled"
  | "booking_completed"
  | "staff_leave_created";

export interface DispatchLineNotificationInput {
  merchantId: string;
  bookingId?: string;
  staffLeaveRecordId?: string;
  eventType: DispatchableLineEventType;
}

/**
 * 5.1/3.11(本模組最重要的邊界原則,規則 2.4 第 4 點):不等待、吞掉錯誤地呼叫
 * line-notify-dispatch Edge Function。這支函式本身回傳 void(不是 Promise),呼叫端不會、也不能
 * await 到任何東西,即使這支 Edge Function 整個掛掉或逾時,也絕對不會讓錯誤往外拋、影響原本呼叫端
 * 的訂單/請假操作。
 */
export function dispatchLineNotification(input: DispatchLineNotificationInput): void {
  void supabase.functions
    .invoke("line-notify-dispatch", {
      body: {
        merchant_id: input.merchantId,
        ...(input.bookingId ? { booking_id: input.bookingId } : {}),
        ...(input.staffLeaveRecordId ? { staff_leave_record_id: input.staffLeaveRecordId } : {}),
        event_type: input.eventType,
      },
    })
    .catch((err: unknown) => {
      // 規則 2.4 第 4 點:只留一行 console.error,不彈出任何錯誤訊息給使用者,不影響原本操作。
      console.error("[line-notify-dispatch] 呼叫失敗(不影響訂單/請假操作)", err);
    });
}

interface RawPendingLineNotificationPreview {
  has_any_target: boolean;
  targets: { type: string; name: string }[];
}

/** 5.2/規則 2.5:確認訂單前預覽會通知誰,純讀取,不影響任何資料。 */
export async function fetchPendingLineNotificationPreview(
  bookingId: string,
  eventType: string,
): Promise<PendingLineNotificationPreview> {
  const { data, error } = await supabase.rpc("preview_line_notification_targets", {
    p_booking_id: bookingId,
    p_event_type: eventType,
  });
  if (error) throw error;
  const raw = data as unknown as RawPendingLineNotificationPreview;
  return {
    hasAnyTarget: raw.has_any_target,
    targets: (raw.targets ?? []).map((t) => ({
      type: t.type as PendingLineNotificationPreview["targets"][number]["type"],
      name: t.name,
    })),
  };
}

/** 5.2 對外介面:包一層 useQuery,`enabled: false`——呼叫端(模組 6「確認訂單」按鈕的處理邏輯)
 * 在使用者按下按鈕的當下呼叫回傳的 refetch(),取得這次要不要顯示 4.8 彈窗的判斷依據,而不是
 * 讓這支查詢隨頁面掛載就自動打出去。 */
export function usePendingLineNotificationPreview(
  bookingId: string | null | undefined,
  eventType: string,
) {
  return useQuery({
    queryKey: ["line-notifications-module", "pending-preview", bookingId, eventType],
    queryFn: () => fetchPendingLineNotificationPreview(bookingId as string, eventType),
    enabled: false,
  });
}
