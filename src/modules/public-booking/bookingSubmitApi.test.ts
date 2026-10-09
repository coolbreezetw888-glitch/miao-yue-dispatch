// 客戶端第 3 批(C3-B01 / c3-contract 1-1、1-4):送出請求的格式與 HTTP 結果對照。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./customerClient", () => ({
  readSupabaseEnv: () => ({ url: "https://example.supabase.co", key: "sb_publishable_abc" }),
  getCustomerClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "USER.JWT" } } }) },
  }),
}));

const { submitCustomerBooking, BookingSubmitError } = await import("./bookingSubmitApi");

const draft = {
  items: [{ service_item_id: "i1", quantity: 2 }],
  staff_id: null,
  date: "2026-10-13",
  time: "10:00",
  name: "王小明",
  address: "",
  note: "門口有狗",
};

let calls: { url: string; init: RequestInit }[] = [];
function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }),
  );
}

beforeEach(() => {
  calls = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("submitCustomerBooking", () => {
  it("會員:帶客人 token、不帶 guest;草稿只有 7 個鍵(地址空 ⇒ null)", async () => {
    mockFetch(200, { state: "too_many_open" });
    await expect(
      submitCustomerBooking({ slug: "shop", submissionId: "sid", draft, guest: null }),
    ).resolves.toEqual({ kind: "rejected", state: "too_many_open" });
    const { url, init } = calls[0]!;
    expect(url).toBe("https://example.supabase.co/functions/v1/customer-booking-submit");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer USER.JWT");
    expect(JSON.parse(String(init.body))).toEqual({
      slug: "shop",
      submission_id: "sid",
      draft: {
        items: [{ service_item_id: "i1", quantity: 2 }],
        staff_id: null,
        date: "2026-10-13",
        time: "10:00",
        name: "王小明",
        address: null,
        notes: "門口有狗",
      },
    });
  });

  it("訪客:帶 guest、publishable key 不當 Bearer", async () => {
    mockFetch(200, { state: "bot_check_failed" });
    await submitCustomerBooking({
      slug: "shop",
      submissionId: "sid",
      draft,
      guest: { phone: "0912345678", agreePolicy: true, turnstileToken: "T" },
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(JSON.parse(String(calls[0]!.init.body)).guest).toEqual({
      phone: "0912345678",
      agree_policy: true,
      turnstile_token: "T",
    });
  });

  it("400 依 hint 丟對應代碼;沒 hint ⇒ invalid_request;403 / 500 ⇒ server_error", async () => {
    mockFetch(400, { state: "invalid_request", hint: "invalid_phone" });
    await expect(
      submitCustomerBooking({ slug: "shop", submissionId: "sid", draft, guest: null }),
    ).rejects.toMatchObject({ code: "invalid_phone" });
    mockFetch(400, { state: "invalid_request" });
    await expect(
      submitCustomerBooking({ slug: "shop", submissionId: "sid", draft, guest: null }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    for (const status of [403, 500]) {
      mockFetch(status, { state: "server_error" });
      const err = await submitCustomerBooking({
        slug: "shop",
        submissionId: "sid",
        draft,
        guest: null,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BookingSubmitError);
      expect((err as InstanceType<typeof BookingSubmitError>).code).toBe("server_error");
    }
  });

  it("created:completion_message 從最外層讀", async () => {
    mockFetch(200, {
      state: "created",
      booking: {
        status: "accepted",
        start_at: "2026-10-13T02:00:00+00:00",
        end_at: "2026-10-13T03:00:00+00:00",
        staff_display: "阿明",
        items: [{ name: "室內機清洗", quantity: 2 }],
        address: null,
        phone: null,
        estimated_amount: 5000,
        is_guest: false,
      },
      completion_message: "服務前店家可能會再跟您聯絡確認。",
    });
    const r = await submitCustomerBooking({
      slug: "shop",
      submissionId: "sid",
      draft,
      guest: null,
    });
    expect(r.kind === "created" && r.booking.completionMessage).toBe(
      "服務前店家可能會再跟您聯絡確認。",
    );
  });
});
