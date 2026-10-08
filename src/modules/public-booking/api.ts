// 客戶端第 1 批(C1):公開預約頁的資料存取層。這個資料夾裡唯一呼叫 supabase 的地方。
//
// 只呼叫兩支「給沒登入的人用」的資料庫函式(規格書 C1-C01 / C1-C02),不直接讀任何資料表
// (未登入的人本來就讀不到 —— 正式庫沒有任何給 anon 的 RLS 規則,C1-F01)。
//
// 📌 回傳一律經過 parse 函式逐欄檢查:資料庫多給、少給、型別不對,都在這裡變成「讀取失敗」,
//    不會讓畫面拿到半殘的資料亂顯示;也因為只挑白名單欄位出來,就算資料庫哪天不小心多回傳了什麼,
//    也不會被畫面用到。
// 📌 畫面上**不顯示原始錯誤訊息**(C1-A10:避免露出資料庫細節)—— 這裡把所有錯誤包成 PublicBookingError,
//    畫面只看 kind 決定顯示哪一句中文。

import { supabase } from "@/integrations/supabase/client";

import type {
  PublicAvailableSlots,
  PublicBookingPage,
  PublicBookingPageOk,
  PublicCategory,
  PublicDayState,
  PublicMemberPolicy,
  PublicSelectedItem,
  PublicServiceItem,
  PublicSlotDay,
  PublicStaff,
} from "./types";

/** 畫面只需要分這幾種,不需要知道資料庫實際說了什麼。 */
export type PublicBookingErrorKind = "network" | "invalid_response" | "rejected";

export class PublicBookingError extends Error {
  readonly kind: PublicBookingErrorKind;
  /** 資料庫的錯誤代碼(例:22023 參數錯、P0002 找不到)。只給程式判斷,不顯示在畫面上。 */
  readonly code: string | null;
  /**
   * 資料庫函式丟錯時附的 hint(例:staff_unavailable、no_primary_item;見 .project/notes/c1-rpc-contract.md)。
   * 畫面用它決定顯示哪一句中文 —— 不比對資料庫的中文訊息字串,也不直接把那段訊息貼到畫面上。
   */
  readonly hint: string | null;
  constructor(
    kind: PublicBookingErrorKind,
    code: string | null = null,
    hint: string | null = null,
  ) {
    super(`public-booking:${kind}`);
    this.name = "PublicBookingError";
    this.kind = kind;
    this.code = code;
    this.hint = hint;
  }
}

// 📌 呼叫方式刻意不依賴 src/integrations/supabase/types.ts 產生的型別(那份只會把回傳寫成 Json,
//    而且是 engineer A 的檔案):回傳值本來就要自己 parse,所以這裡統一用一個「不帶型別」的呼叫方式。
type UntypedRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{
  data: unknown;
  error: { code?: string | null; hint?: string | null } | null;
}>;

const rpc = supabase.rpc.bind(supabase) as unknown as UntypedRpc;

async function callRpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: Awaited<ReturnType<UntypedRpc>>;
  try {
    result = await rpc(fn, args);
  } catch {
    throw new PublicBookingError("network");
  }
  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : null;
    const hint = typeof result.error.hint === "string" ? result.error.hint : null;
    // 資料庫函式主動擋下的(22023 參數錯、P0002 找不到 / 服務人員不可預約)= rejected,重試也沒用;
    // 其他(斷線、逾時、權限)= network,可以按「重新整理」再試。
    const kind: PublicBookingErrorKind =
      code === "22023" || code === "P0002" ? "rejected" : "network";
    throw new PublicBookingError(kind, code, hint);
  }
  return result.data;
}

/**
 * 時段函式擋下來時要顯示的話(依 hint;對照 c1-rpc-contract.md 的錯誤表)。
 * 都是我們自己寫的固定句子,不含任何資料。
 */
export function rejectedSlotsMessage(hint: string | null): string {
  switch (hint) {
    case "staff_unavailable":
      return "這位服務人員目前無法預約，請回上一步改選其他服務人員或「不指定」。";
    case "no_staff_available":
      return "目前沒有可以預約這些服務的服務人員，請聯絡店家或改選其他服務。";
    case "no_primary_item":
      return "請至少選一項主要服務，請回上一步重新選擇。";
    case "duration_too_long":
      return "選的服務太多，請聯絡店家。";
    case "invalid_duration":
      return "這些服務沒有設定工時，請直接聯絡店家。";
    case "page_not_found":
    case "page_unavailable":
      return "這間店目前無法線上預約，請直接聯絡店家。";
    default:
      return "選擇的服務項目可能已經變動，請回上一步重新選擇。";
  }
}

// ---------------------------------------------------------------------------
// parse:逐欄檢查,只挑白名單欄位
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new PublicBookingError("invalid_response");
  return value;
}

function optStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return str(value);
}

function num(value: unknown): number {
  // numeric 欄位經過 PostgREST 可能是字串(例:"2500.00")。
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new PublicBookingError("invalid_response");
  }
  return n;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function arr(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new PublicBookingError("invalid_response");
  return value;
}

function parseCategory(raw: unknown): PublicCategory {
  if (!isRecord(raw)) throw new PublicBookingError("invalid_response");
  return { id: str(raw["id"]), name: str(raw["name"]) };
}

function parseServiceItem(raw: unknown): PublicServiceItem {
  if (!isRecord(raw)) throw new PublicBookingError("invalid_response");
  const itemType = raw["item_type"] === "addon" ? "addon" : "primary";
  return {
    id: str(raw["id"]),
    category_id: optStr(raw["category_id"]),
    name: str(raw["name"]),
    description: optStr(raw["description"]),
    price: num(raw["price"]),
    duration_minutes: num(raw["duration_minutes"]),
    item_type: itemType,
  };
}

function parseStaff(raw: unknown): PublicStaff {
  if (!isRecord(raw)) throw new PublicBookingError("invalid_response");
  const ids = raw["primary_service_item_ids"];
  return {
    id: str(raw["id"]),
    display_name: str(raw["display_name"]),
    avatar_url: optStr(raw["avatar_url"]),
    intro: optStr(raw["intro"]),
    primary_service_item_ids: ids === null || ids === undefined ? null : arr(ids).map(str),
  };
}

/**
 * C2-C06:booking_settings.member_policy = 商家會員政策內容(純文字);沒開或空白 = null。
 * 有內容 ⇒ 勾選框「會員政策 與 隱私權政策」;null ⇒ 只有「隱私權政策」。
 */
function parseMemberPolicy(raw: unknown): PublicMemberPolicy {
  if (typeof raw === "string" && raw.trim() !== "") return { enabled: true, content: raw };
  return { enabled: false, content: null };
}

export function parsePublicBookingPage(data: unknown): PublicBookingPage {
  if (!isRecord(data)) throw new PublicBookingError("invalid_response");
  const status = data["status"];
  if (status === "not_found") return { status: "not_found" };
  if (status === "unavailable") return { status: "unavailable" };
  if (status !== "ok") throw new PublicBookingError("invalid_response");

  const m = data["merchant"];
  if (!isRecord(m)) throw new PublicBookingError("invalid_response");
  const settings = isRecord(data["booking_settings"]) ? data["booking_settings"] : {};
  const industry =
    m["industry_type"] === "in_store_beauty" ? "in_store_beauty" : "on_site_dispatch";

  const page: PublicBookingPageOk = {
    status: "ok",
    merchant: {
      name: str(m["name"]),
      industry_type: industry,
      logo_url: optStr(m["logo_url"]),
      address: optStr(m["address"]),
      phone: optStr(m["phone"]),
      intro: optStr(m["intro"]),
      theme_preset: optStr(m["theme_preset"]),
      theme_custom_color: optStr(m["theme_custom_color"]),
      announcement: optStr(m["announcement"]),
      line_friend_url: optStr(m["line_friend_url"]),
    },
    booking_settings: {
      allow_guest_booking: bool(settings["allow_guest_booking"], true),
      is_on_site: bool(settings["is_on_site"], industry === "on_site_dispatch"),
      line_login_enabled: bool(settings["line_login_enabled"], false),
    },
    member_policy: parseMemberPolicy(settings["member_policy"]),
    categories: arr(data["categories"]).map(parseCategory),
    service_items: arr(data["service_items"]).map(parseServiceItem),
    staff: arr(data["staff"]).map(parseStaff),
  };
  return page;
}

const DAY_STATES: PublicDayState[] = ["open", "closed", "full", "out_of_range"];

function parseSlotDay(raw: unknown): PublicSlotDay {
  if (!isRecord(raw)) throw new PublicBookingError("invalid_response");
  const state = raw["state"];
  if (typeof state !== "string" || !DAY_STATES.includes(state as PublicDayState)) {
    throw new PublicBookingError("invalid_response");
  }
  return {
    date: str(raw["date"]),
    state: state as PublicDayState,
    // "09:00" 或 "09:00:00" 都收,統一成 HH:MM。
    times: arr(raw["times"]).map((t) => str(t).slice(0, 5)),
  };
}

export function parsePublicAvailableSlots(data: unknown): PublicAvailableSlots {
  if (!isRecord(data)) throw new PublicBookingError("invalid_response");
  return {
    duration_minutes: num(data["duration_minutes"]),
    days: arr(data["days"]).map(parseSlotDay),
  };
}

// ---------------------------------------------------------------------------
// 對外
// ---------------------------------------------------------------------------

/** C1-C01。代碼一律轉小寫(C1-A01 邊界)。 */
export async function fetchPublicBookingPage(slug: string): Promise<PublicBookingPage> {
  const data = await callRpc("get_public_booking_page", { p_slug: slug.trim().toLowerCase() });
  return parsePublicBookingPage(data);
}

/** C1-C02。工時由伺服器從資料庫重算,這裡不傳工時。 */
export async function fetchPublicAvailableSlots(params: {
  slug: string;
  items: PublicSelectedItem[];
  staffId: string | null;
  from: string; // YYYY-MM-DD
  days: number;
}): Promise<PublicAvailableSlots> {
  const data = await callRpc("get_public_available_slots", {
    p_slug: params.slug.trim().toLowerCase(),
    p_items: params.items.map((i) => ({
      service_item_id: i.service_item_id,
      quantity: i.quantity,
    })),
    p_staff_id: params.staffId,
    p_from: params.from,
    p_days: params.days,
  });
  return parsePublicAvailableSlots(data);
}
