// SPECS-INDEX #852:createBooking / updateBooking 一定要把 p_hide_notes_from_staff 帶出去。
//
// 🔴 為什麼這一支要獨立寫:api.ts 這個檔案的既有慣用寫法是
//      ...(input.notes ? { p_notes: input.notes } : {})
//    —— 用 truthy 判斷來決定「要不要放這個 key」。**布林欄位絕對不能照抄這個寫法**:
//    `false` 是 falsy,會被整個省略掉 ⇒ 後端拿 default false。
//    這次的旗標剛好 default 也是 false,所以「關掉」這個動作照抄寫法**看起來會正常**;
//    真正會出事的是 update_booking 的無條件覆寫(見 bookingFormHideNotes.test.tsx 檔頭)。
//    但「key 到底有沒有送出去」是一個會被下一個人照抄改壞的地方,所以在這一層直接釘死:
//    **不管值是 true 還是 false,p_hide_notes_from_staff 都要出現在 RPC 參數裡。**
//
// 【故障注入驗證(2026-09-30 實際跑過並還原)】
//   api.ts 的 `p_hide_notes_from_staff: input.hideNotesFromStaff ?? false,` 改成
//   `...(input.hideNotesFromStaff ? { p_hide_notes_from_staff: true } : {}),`(= 照抄既有慣用寫法)
//   → 5 條裡 **3 條立刻轉紅**(createBooking 帶 false / createBooking 不帶 / updateBooking 帶 false;
//     toHaveProperty 收到的物件裡根本沒有那個 key),而「帶 true」那兩條**仍然綠**
//     —— 正好示範這個 bug 為什麼難發現:只測 true 的話永遠會過。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: rpcMock,
    // updateBooking 會先 from("bookings").select(...) 偷看一眼舊的主服務人員(#823),
    // 那一步任何錯誤都被吞掉,這裡回一個最小可用的鏈就好。
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

const SHARED = {
  staffId: STAFF_ID,
  serviceItems: [{ serviceItemId: SERVICE_ITEM_ID, quantity: 1, unitPrice: 1000 }],
  startAt: "2036-01-05T02:00:00+00:00",
  customerName: "陳先生",
  customerPhone: "0912345678",
};

/** 這次呼叫送給 PostgREST 的參數物件。 */
function lastRpcParams(): Record<string, unknown> {
  return rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe("createBooking / updateBooking:p_hide_notes_from_staff 一律無條件帶值(#852)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: { id: BOOKING_ID, merchant_id: MERCHANT_ID, staff_id: STAFF_ID },
      error: null,
    });
  });

  it("createBooking 帶 true → p_hide_notes_from_staff = true", async () => {
    await createBooking({ merchantId: MERCHANT_ID, ...SHARED, hideNotesFromStaff: true });
    expect(rpcMock).toHaveBeenCalledWith("create_booking", expect.anything());
    expect(lastRpcParams()).toHaveProperty("p_hide_notes_from_staff", true);
  });

  it("🔴 createBooking 帶 false → 這個 key 還是要在(不可以被 falsy 判斷省略掉)", async () => {
    await createBooking({ merchantId: MERCHANT_ID, ...SHARED, hideNotesFromStaff: false });
    expect(lastRpcParams()).toHaveProperty("p_hide_notes_from_staff", false);
  });

  it("createBooking 完全不帶這個欄位 → 送出 false(= 預設服務人員看得到,#850)", async () => {
    await createBooking({ merchantId: MERCHANT_ID, ...SHARED });
    expect(lastRpcParams()).toHaveProperty("p_hide_notes_from_staff", false);
  });

  it("updateBooking 帶 true → p_hide_notes_from_staff = true", async () => {
    await updateBooking({
      bookingId: BOOKING_ID,
      ...SHARED,
      previousStaffId: null,
      hideNotesFromStaff: true,
    });
    expect(rpcMock).toHaveBeenCalledWith("update_booking", expect.anything());
    expect(lastRpcParams()).toHaveProperty("p_hide_notes_from_staff", true);
  });

  it("🔴 updateBooking 帶 false → 這個 key 還是要在", async () => {
    await updateBooking({
      bookingId: BOOKING_ID,
      ...SHARED,
      previousStaffId: null,
      hideNotesFromStaff: false,
    });
    expect(lastRpcParams()).toHaveProperty("p_hide_notes_from_staff", false);
  });
});
