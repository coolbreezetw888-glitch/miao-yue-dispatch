// 模組 15(服務人員推播通知)— push-notify-dispatch 的 Deno 測試。對應規則 4.7(核心必測:
// 未授權呼叫被擋下)。用可注入的 deps(createCallerClient/createAdminClient)驗證 401/403 分支,
// 不需要真正的 Supabase 環境變數/資料庫連線。
//
// 這幾個環境變數必須在 import "./index.ts" 之前就存在(index.ts 頂層直接讀取),測試檔案開頭
// 先設好假值,確保「缺少環境變數」的 500 分支不會誤擋下面的測試案例。

Deno.env.set("SUPABASE_URL", "http://localhost:55321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("VAPID_SUBJECT", "mailto:test@example.com");
Deno.env.set("VAPID_PUBLIC_KEY", "test-public-key");
Deno.env.set("VAPID_PRIVATE_KEY", "test-private-key");

import { assertEquals } from "jsr:@std/assert@1";
import { handleRequest, type CallerRpcClient, type HandleRequestDeps } from "./index.ts";

function makeDeps(allowed: boolean | null, rpcError: unknown = null): HandleRequestDeps {
  const callerClient: CallerRpcClient = {
    rpc: async () => ({ data: allowed, error: rpcError }),
  };
  return {
    createCallerClient: () => callerClient,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createAdminClient: () => ({}) as any,
  };
}

function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/push-notify-dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

Deno.test("handleRequest(核心必測,規則 4.7):缺少 Authorization 標頭回 401", async () => {
  const req = makeRequest({ merchant_id: "m1", booking_id: "b1", event_type: "booking_created" });
  const res = await handleRequest(req, makeDeps(true));
  assertEquals(res.status, 401);
});

Deno.test(
  "handleRequest(核心必測,規則 4.7):can_manage_bookings 回傳 false 時回 403,未授權呼叫被擋下",
  async () => {
    const req = makeRequest(
      { merchant_id: "m1", booking_id: "b1", event_type: "booking_created" },
      { Authorization: "Bearer fake-jwt" },
    );
    const res = await handleRequest(req, makeDeps(false));
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(typeof body.error, "string");
  },
);

Deno.test("handleRequest:can_manage_bookings RPC 本身出錯時回 500,不當作授權通過", async () => {
  const req = makeRequest(
    { merchant_id: "m1", booking_id: "b1", event_type: "booking_created" },
    { Authorization: "Bearer fake-jwt" },
  );
  const res = await handleRequest(req, makeDeps(null, { message: "boom" }));
  assertEquals(res.status, 500);
});

Deno.test("handleRequest:缺少必要欄位回 400", async () => {
  const req = makeRequest({ merchant_id: "m1" }, { Authorization: "Bearer fake-jwt" });
  const res = await handleRequest(req, makeDeps(true));
  assertEquals(res.status, 400);
});

Deno.test("handleRequest:不支援的 event_type 回 400", async () => {
  const req = makeRequest(
    { merchant_id: "m1", booking_id: "b1", event_type: "booking_completed" },
    { Authorization: "Bearer fake-jwt" },
  );
  const res = await handleRequest(req, makeDeps(true));
  assertEquals(res.status, 400);
});

Deno.test("handleRequest:非 POST 方法回 405", async () => {
  const req = new Request("http://localhost/push-notify-dispatch", { method: "GET" });
  const res = await handleRequest(req, makeDeps(true));
  assertEquals(res.status, 405);
});

Deno.test("handleRequest:OPTIONS 預檢請求回 200 且不驗證授權", async () => {
  const req = new Request("http://localhost/push-notify-dispatch", { method: "OPTIONS" });
  const res = await handleRequest(req, makeDeps(false));
  assertEquals(res.status, 200);
});

Deno.test("handleRequest:請求本文不是合法 JSON 時回 400", async () => {
  const req = new Request("http://localhost/push-notify-dispatch", {
    method: "POST",
    headers: { Authorization: "Bearer fake-jwt", "Content-Type": "application/json" },
    body: "not-json",
  });
  const res = await handleRequest(req, makeDeps(true));
  assertEquals(res.status, 400);
});

Deno.test(
  "handleRequest:授权通过后正常呼叫 dispatchPushForBooking(用假 adminClient 讓下游 DB 呼叫全部靜默失敗,仍應回 200)",
  async () => {
    // 這裡刻意讓 adminClient 是空物件(呼叫 .from()/.rpc() 會丟例外),驗證即使下游 DB 操作失敗,
    // dispatchPushForBooking 內部的 buildPushDispatchDeps 各個方法都有 try 過的 error 處理
    // (見 pushDbAdapter.ts 每個方法遇到 error 都印 log 後回傳安全預設值,不會讓整個請求掛掉)。
    // 這個測試主要驗證 handleRequest 授權通過分支本身不會在呼叫 dispatchPushForBooking 前就中斷。
    const req = makeRequest(
      { merchant_id: "m1", booking_id: "b1", event_type: "booking_created" },
      { Authorization: "Bearer fake-jwt" },
    );
    const deps = makeDeps(true);
    // adminClient.from(...).select(...).eq(...).eq(...).maybeSingle() 需要至少能被呼叫,這裡改用
    // 一個會讓 getEventSetting 收到 rejected promise 的假 client,驗證整個流程仍然「安靜」處理掉。
    deps.createAdminClient = () =>
      ({
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: { message: "db down" } }),
              }),
              maybeSingle: () => Promise.resolve({ data: null, error: { message: "db down" } }),
            }),
          }),
          delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
          insert: () => Promise.resolve({ error: null }),
        }),
        rpc: () => Promise.resolve({ data: {}, error: null }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
    // #972:這個測試的假 adminClient 讓所有 maybeSingle 都回 error,歸屬檢查(查 bookings)也會跟著失敗而
    // 回 500(fail closed,這是對的)。這個測試要驗的是「歸屬檢查之後」的下游安靜處理,所以這裡注入一個
    // 一律通過的歸屬檢查;歸屬檢查本身的行為由檔案最後的 #972 測試負責。
    deps.createOwnershipLookup = () => ({
      bookingBelongsToMerchant: () => Promise.resolve(true),
      staffLeaveRecordBelongsToMerchant: () => Promise.resolve(true),
    });
    const res = await handleRequest(req, deps);
    assertEquals(res.status, 200);
  },
);

// =========================================================================
// SPECS-INDEX #823:request body 的 previous_staff_id 要一路傳到 dispatchPushForBooking。
//
// 這裡刻意**不** mock 掉 pushDbAdapter:用一個「會把每一次 rpc 呼叫記下來」的假 adminClient,
// 讓 index.ts → buildPushDispatchDeps → resolveRecipients → adminClient.rpc('resolve_push_recipients', {...})
// 這整條真實路徑都走到,然後斷言 rpc 被叫了幾次、第三個參數 p_booking_staff_id 各是誰。
// 這樣驗到的是 adapter 真的送出的 RPC 名稱與參數名,不是某個被替身蓋掉的中間層(#805 的教訓)。
// =========================================================================
function makeRecordingAdminClient() {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const insertedTables: string[] = [];
  const adminClient = {
    from: (table: string) => ({
      select: () => {
        const single = () => {
          if (table === "merchant_push_event_settings") {
            return Promise.resolve({
              data: { enabled: true, message_title: "訂單內容異動", message_body: "{{change_summary}}" },
              error: null,
            });
          }
          if (table === "bookings") {
            return Promise.resolve({ data: { staff_id: "staff-new" }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        };
        return {
          eq: () => ({ eq: () => ({ maybeSingle: single }), maybeSingle: single }),
          in: () => Promise.resolve({ data: [], error: null }),
        };
      },
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      insert: () => {
        insertedTables.push(table);
        return Promise.resolve({ error: null });
      },
    }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "resolve_push_recipients") return Promise.resolve({ data: [], error: null });
      if (fn === "is_staff_push_event_disabled") return Promise.resolve({ data: false, error: null });
      if (fn === "render_booking_notification_variables") return Promise.resolve({ data: {}, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { adminClient, rpcCalls, insertedTables };
}

function resolveStaffIdsFrom(rpcCalls: { fn: string; args: Record<string, unknown> }[]): unknown[] {
  return rpcCalls
    .filter((c) => c.fn === "resolve_push_recipients")
    .map((c) => c.args["p_booking_staff_id"]);
}

Deno.test("#823:body 有 previous_staff_id 時,resolve_push_recipients 會被多叫一次,第二次的 p_booking_staff_id 就是舊的那位", async () => {
  const { adminClient, rpcCalls } = makeRecordingAdminClient();
  const deps = makeDeps(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps.createAdminClient = () => adminClient as any;

  const req = makeRequest(
    {
      merchant_id: "m1",
      booking_id: "b1",
      event_type: "booking_updated",
      change_summary: "服務人員改為 王小明",
      previous_staff_id: "staff-old",
    },
    { Authorization: "Bearer fake-jwt" },
  );
  const res = await handleRequest(req, deps);

  assertEquals(res.status, 200);
  assertEquals(resolveStaffIdsFrom(rpcCalls), ["staff-new", "staff-old"]);
  // 順便釘住 adapter 送出的參數名(PostgREST 靠參數名解析函式,名字錯了就是 PGRST202)。
  const first = rpcCalls.find((c) => c.fn === "resolve_push_recipients")!;
  assertEquals(Object.keys(first.args).sort(), ["p_booking_staff_id", "p_event_type", "p_merchant_id"]);
});

Deno.test("#823 正向對照:同樣的請求但**沒有** previous_staff_id → resolve_push_recipients 只叫一次", async () => {
  const { adminClient, rpcCalls } = makeRecordingAdminClient();
  const deps = makeDeps(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps.createAdminClient = () => adminClient as any;

  const req = makeRequest(
    { merchant_id: "m1", booking_id: "b1", event_type: "booking_updated", change_summary: "服務人員改為 王小明" },
    { Authorization: "Bearer fake-jwt" },
  );
  const res = await handleRequest(req, deps);

  assertEquals(res.status, 200);
  assertEquals(resolveStaffIdsFrom(rpcCalls), ["staff-new"]);
});

Deno.test("#823:previous_staff_id 是空字串或只有空白 → 視同沒帶,不會拿空字串去查", async () => {
  for (const previous of ["", "   "]) {
    const { adminClient, rpcCalls } = makeRecordingAdminClient();
    const deps = makeDeps(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps.createAdminClient = () => adminClient as any;

    const req = makeRequest(
      { merchant_id: "m1", booking_id: "b1", event_type: "booking_updated", previous_staff_id: previous },
      { Authorization: "Bearer fake-jwt" },
    );
    const res = await handleRequest(req, deps);

    assertEquals(res.status, 200);
    assertEquals(resolveStaffIdsFrom(rpcCalls), ["staff-new"]);
  }
});

// =========================================================================
// SPECS-INDEX #972:跨商家訂單(IDOR)。呼叫者能管理 merchant-A(can_manage_bookings 回 true),
// 但帶的是 merchant-B 的 booking_id。必須:回 404、不進 dispatchPushForBooking ——
// push_notification_log、user_notifications 一筆都不寫,也不呼叫任何 RPC。
// 不替換歸屬檢查(走真正的 buildNotifySubjectOwnershipLookup),假資料庫會依 .eq() 條件回應。
// =========================================================================
function makeOwnershipAwareAdminClient() {
  const bookingsOwner: Record<string, string> = { "booking-A": "merchant-A", "booking-B": "merchant-B" };
  const rpcCalls: string[] = [];
  const inserts: string[] = [];
  const bookingSelects: Record<string, unknown>[] = [];
  const adminClient = {
    from: (table: string) => ({
      select: () => {
        const filters: Record<string, unknown> = {};
        const single = () => {
          if (table === "bookings") {
            bookingSelects.push({ ...filters });
            const owner = bookingsOwner[String(filters.id)];
            const ok = owner !== undefined &&
              (filters.merchant_id === undefined || filters.merchant_id === owner);
            return Promise.resolve({ data: ok ? { id: filters.id, staff_id: null } : null, error: null });
          }
          if (table === "merchant_push_event_settings") {
            return Promise.resolve({
              data: { enabled: true, message_title: "新訂單", message_body: "{{customer_name}}" },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        };
        const builder = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return builder;
          },
          maybeSingle: single,
          in: () => Promise.resolve({ data: [], error: null }),
        };
        return builder;
      },
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      insert: () => {
        inserts.push(table);
        return Promise.resolve({ error: null });
      },
    }),
    rpc: (fn: string) => {
      rpcCalls.push(fn);
      if (fn === "resolve_push_recipients") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: {}, error: null });
    },
  };
  return { adminClient, rpcCalls, inserts, bookingSelects };
}

Deno.test("#972(核心必測):A 商家帶 B 商家的 booking_id → 404,推播紀錄/站內通知一筆都不寫、不呼叫任何 RPC", async () => {
  const { adminClient, rpcCalls, inserts } = makeOwnershipAwareAdminClient();
  const deps = makeDeps(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps.createAdminClient = () => adminClient as any;
  const res = await handleRequest(
    makeRequest(
      { merchant_id: "merchant-A", booking_id: "booking-B", event_type: "booking_created" },
      { Authorization: "Bearer fake-jwt" },
    ),
    deps,
  );
  assertEquals(res.status, 404);
  assertEquals(rpcCalls, []);
  assertEquals(inserts, []);
});

Deno.test("#972 正向對照:同商家的 booking_id → 照常進入派送(行為不變),歸屬查詢帶了 merchant_id 條件", async () => {
  const { adminClient, rpcCalls, inserts, bookingSelects } = makeOwnershipAwareAdminClient();
  const deps = makeDeps(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps.createAdminClient = () => adminClient as any;
  const res = await handleRequest(
    makeRequest(
      { merchant_id: "merchant-A", booking_id: "booking-A", event_type: "booking_created" },
      { Authorization: "Bearer fake-jwt" },
    ),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(rpcCalls.includes("resolve_push_recipients"), true);
  assertEquals(inserts.includes("push_notification_log"), true);
  // 第一筆是歸屬檢查,第二筆是 pushDbAdapter.getBookingStaffId —— 兩者都要帶 merchant_id。
  assertEquals(bookingSelects, [
    { id: "booking-A", merchant_id: "merchant-A" },
    { id: "booking-A", merchant_id: "merchant-A" },
  ]);
});

Deno.test("#972:歸屬查詢本身出錯 → 500(fail closed),不進派送", async () => {
  const { adminClient, rpcCalls, inserts } = makeOwnershipAwareAdminClient();
  const deps = makeDeps(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps.createAdminClient = () => adminClient as any;
  deps.createOwnershipLookup = () => ({
    bookingBelongsToMerchant: () => Promise.reject(new Error("db down")),
    staffLeaveRecordBelongsToMerchant: () => Promise.reject(new Error("db down")),
  });
  const res = await handleRequest(
    makeRequest(
      { merchant_id: "merchant-A", booking_id: "booking-A", event_type: "booking_created" },
      { Authorization: "Bearer fake-jwt" },
    ),
    deps,
  );
  assertEquals(res.status, 500);
  assertEquals(rpcCalls, []);
  assertEquals(inserts, []);
});

Deno.test("#972:render_booking_notification_variables 一律帶 p_merchant_id(資料庫第二層檢查需要)", async () => {
  const rpcArgs: { fn: string; args: Record<string, unknown> }[] = [];
  const { adminClient } = makeOwnershipAwareAdminClient();
  const deps = makeDeps(true);
  deps.createAdminClient = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({
      ...adminClient,
      rpc: (fn: string, args: Record<string, unknown>) => {
        rpcArgs.push({ fn, args });
        if (fn === "resolve_push_recipients") {
          return Promise.resolve({
            data: [{ target_type: "admin", target_id: "a1", target_user_id: "u1", target_name: "管理員" }],
            error: null,
          });
        }
        return Promise.resolve({ data: {}, error: null });
      },
    }) as any;
  const res = await handleRequest(
    makeRequest(
      { merchant_id: "merchant-A", booking_id: "booking-A", event_type: "booking_created" },
      { Authorization: "Bearer fake-jwt" },
    ),
    deps,
  );
  assertEquals(res.status, 200);
  const render = rpcArgs.find((c) => c.fn === "render_booking_notification_variables");
  assertEquals(render?.args, { p_booking_id: "booking-A", p_merchant_id: "merchant-A" });
});
