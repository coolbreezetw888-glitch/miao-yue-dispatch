// 紅利系統重構 批次 3(規格書 §3.3 第 6 步、§3.4 第 0-1 步、v2.4 裁決 5 ②):
// createBooking / updateBooking 送給 RPC 的紅利參數。
//
// 🔴 為什麼要釘死「key 有沒有在」:
//   ・update_booking 的 p_points_redeemed 預設是 null = 「維持原折抵」;前端一律帶這個 key(沒有值就送 null),
//     不讓「有沒有帶」變成隱性語意(#852/#857 同一種坑)。
//   ・update_booking 的 p_member_id 沒帶 = 後端把會員清空(v2.4 裁決 5 R7),所以前端一律帶。
//   ・折抵 0 點、派點 0 點都是合法值 —— 不可以被 `...(x ? {…} : {})` 的 truthy 寫法吃掉。
//
// 【故障注入驗證(2026-10-01 實際跑過並還原)】
//   ① api.ts updateBooking 的 `p_points_redeemed: (input.pointsRedeemed ?? null) as number,`
//      改成 `...(input.pointsRedeemed ? { p_points_redeemed: input.pointsRedeemed } : {}),`
//      → 「updateBooking 不帶 pointsRedeemed」「帶 0」兩條轉紅。
//   ② api.ts createBooking 的 p_points_override 判斷改成 `input.pointsOverride ? … : {}`
//      → 「createBooking 派點 0」一條轉紅。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: rpcMock,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
    functions: { invoke: vi.fn() },
  },
}));
vi.mock("@/modules/push-notifications/api", () => ({ dispatchPushNotification: vi.fn() }));
vi.mock("@/modules/line-notifications/api", () => ({ dispatchLineNotification: vi.fn() }));

import { createBooking, updateBooking } from "./api";

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const BOOKING_ID = "44444444-4444-4444-8444-444444444444";
const MEMBER_ID = "55555555-5555-4555-8555-555555555555";

const SHARED = {
  staffId: STAFF_ID,
  serviceItems: [{ serviceItemId: SERVICE_ITEM_ID, quantity: 1, unitPrice: 1000 }],
  startAt: "2036-01-05T02:00:00+00:00",
  customerName: "陳先生",
  customerPhone: "0912345678",
};

function lastRpcParams(): Record<string, unknown> {
  return rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
}

function has(params: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, key);
}

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({
    data: { id: BOOKING_ID, merchant_id: MERCHANT_ID, staff_id: STAFF_ID },
    error: null,
  });
});

describe("createBooking:紅利參數(§3.3 第 6 步)", () => {
  it("不帶任何紅利欄位 → p_points_redeemed 明確送 0、不送 p_points_override(= 用系統建議值)", async () => {
    await createBooking({ merchantId: MERCHANT_ID, ...SHARED });
    const params = lastRpcParams();
    expect(params).toHaveProperty("p_points_redeemed", 0);
    expect(has(params, "p_points_override")).toBe(false);
  });

  it("折抵點數照實送出", async () => {
    await createBooking({ merchantId: MERCHANT_ID, ...SHARED, pointsRedeemed: 150 });
    expect(lastRpcParams()).toHaveProperty("p_points_redeemed", 150);
  });

  it("🔴 人工派點 0(「這筆不派點」)是合法值 → key 要在、值是 0(不能被 truthy 判斷吃掉)", async () => {
    await createBooking({ merchantId: MERCHANT_ID, ...SHARED, pointsOverride: 0 });
    expect(lastRpcParams()).toHaveProperty("p_points_override", 0);
  });

  it("pointsOverride = null → 不送(= 用系統建議值)", async () => {
    await createBooking({ merchantId: MERCHANT_ID, ...SHARED, pointsOverride: null });
    expect(has(lastRpcParams(), "p_points_override")).toBe(false);
  });

  it("新增訂單沒給 memberId → 不送 p_member_id(後端依電話自動連結/建立會員,§12.1)", async () => {
    await createBooking({ merchantId: MERCHANT_ID, ...SHARED });
    expect(has(lastRpcParams(), "p_member_id")).toBe(false);
  });
});

describe("updateBooking:紅利參數(§3.4 第 0-1 步、v2.4 裁決 5 ②)", () => {
  it("🔴 不帶 pointsRedeemed → p_points_redeemed 這個 key 仍然在,值是 null(= 維持原折抵)", async () => {
    await updateBooking({
      bookingId: BOOKING_ID,
      ...SHARED,
      previousStaffId: null,
      memberId: MEMBER_ID,
    });
    const params = lastRpcParams();
    expect(has(params, "p_points_redeemed")).toBe(true);
    expect(params["p_points_redeemed"]).toBeNull();
  });

  it("🔴 pointsRedeemed = 0(取消折抵、退回點數)→ 送 0,不是 null", async () => {
    await updateBooking({
      bookingId: BOOKING_ID,
      ...SHARED,
      previousStaffId: null,
      memberId: MEMBER_ID,
      pointsRedeemed: 0,
    });
    expect(lastRpcParams()).toHaveProperty("p_points_redeemed", 0);
  });

  it("p_points_override_reset 一律帶值:不帶 → false;按了「改用建議值」→ true", async () => {
    await updateBooking({
      bookingId: BOOKING_ID,
      ...SHARED,
      previousStaffId: null,
      memberId: MEMBER_ID,
    });
    expect(lastRpcParams()).toHaveProperty("p_points_override_reset", false);

    rpcMock.mockClear();
    await updateBooking({
      bookingId: BOOKING_ID,
      ...SHARED,
      previousStaffId: null,
      memberId: MEMBER_ID,
      pointsOverrideReset: true,
    });
    expect(lastRpcParams()).toHaveProperty("p_points_override_reset", true);
  });

  it("人工派點照實送出;null / 不帶 → 不送(= 維持原本的人工設定)", async () => {
    await updateBooking({
      bookingId: BOOKING_ID,
      ...SHARED,
      previousStaffId: null,
      memberId: MEMBER_ID,
      pointsOverride: 0,
    });
    expect(lastRpcParams()).toHaveProperty("p_points_override", 0);

    rpcMock.mockClear();
    await updateBooking({
      bookingId: BOOKING_ID,
      ...SHARED,
      previousStaffId: null,
      memberId: MEMBER_ID,
      pointsOverride: null,
    });
    expect(has(lastRpcParams(), "p_points_override")).toBe(false);
  });

  it("🔴 v2.4 裁決 5 ②:memberId 沒給 → p_member_id 這個 key 仍然在(明確送 null,不是漏帶)", async () => {
    await updateBooking({ bookingId: BOOKING_ID, ...SHARED, previousStaffId: null });
    const params = lastRpcParams();
    expect(has(params, "p_member_id")).toBe(true);
    expect(params["p_member_id"]).toBeNull();
  });
});
