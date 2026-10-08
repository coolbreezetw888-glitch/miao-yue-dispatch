// 模組 11:LINE 通知 — line-notify-dispatch 的 Deno 測試(對應第七節,規則 2.4 核心必測、
// 3.10/3.14 判斷邏輯一致性)。只測跟 I/O 分離的純函式(renderMessageTemplate/pushLineMessage/
// shouldWriteAnyLogRow/resolveNotificationVariables),用假的 fetch/假的 rpc client 模擬 LINE
// push API 跟資料庫回應。不呼叫真正的 Deno.serve handler(需要真實 Supabase 環境變數/資料庫
// 連線,這次沒有可用的測試環境,見規格書第〇節)——完整的端對端跳過情境已在 pgTAP(module11_02)
// 驗證 resolve_line_notification_targets 這支「唯一一份判斷邏輯」的正確性,這裡只需要驗證
// Edge Function 自己這一層的處理邏輯。

// #972:handleRequest 改成可注入 deps 之後,下面也直接測 handler 的「跨商家訂單/請假紀錄」分支。
// 環境變數改在執行當下讀取,這裡先設假值,避免落入「缺少必要的環境變數」的 500 分支。
Deno.env.set("SUPABASE_URL", "http://localhost:55321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

import { assertEquals } from "jsr:@std/assert@1";
import {
  buildNotifySubjectOwnershipLookup,
  type NotifySubjectOwnershipLookup,
} from "../_shared/notifySubjectOwnership.ts";
import {
  handleRequest,
  type HandleRequestDeps,
  pushLineMessage,
  renderMessageTemplate,
  resolveNotificationVariables,
  shouldWriteAnyLogRow,
  type ResolveTargetsResult,
  type RpcClient,
} from "./index.ts";

Deno.test("renderMessageTemplate: 涵蓋所有已定義變數,正確替換", () => {
  const template =
    "【{{merchant_name}}】{{customer_name}} 於 {{booking_date}} 預約 {{service_names}}。";
  const result = renderMessageTemplate(template, {
    merchant_name: "測試商家",
    customer_name: "王小明",
    booking_date: "2026-12-01 10:00",
    service_names: "洗髮、剪髮",
  });
  assertEquals(result, "【測試商家】王小明 於 2026-12-01 10:00 預約 洗髮、剪髮。");
});

Deno.test("renderMessageTemplate: 缺值情境(變數不在提供的物件裡)保留原樣不報錯", () => {
  const result = renderMessageTemplate("金額:{{final_amount}} 元", {});
  assertEquals(result, "金額:{{final_amount}} 元");
});

Deno.test("renderMessageTemplate: 空字串值正確替換成空字串(不是保留原樣)", () => {
  const result = renderMessageTemplate("取消原因:{{cancel_reason}}", { cancel_reason: "" });
  assertEquals(result, "取消原因:");
});

Deno.test("renderMessageTemplate: 沒有任何變數的純文字範本原樣輸出", () => {
  const result = renderMessageTemplate("這是一則沒有變數的訊息", { unused: "x" });
  assertEquals(result, "這是一則沒有變數的訊息");
});

Deno.test("pushLineMessage: 成功回傳 ok=true", async () => {
  const fakeFetch = (() =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))) as unknown as typeof fetch;
  const result = await pushLineMessage(fakeFetch, "token", "Uabc", "hello");
  assertEquals(result.ok, true);
  assertEquals(result.status, 200);
  assertEquals(result.errorDetail, null);
});

Deno.test("pushLineMessage: LINE 回傳錯誤時記錄錯誤內容", async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ message: "The user hasn't added the bot as a friend" }), {
        status: 400,
      }),
    )) as unknown as typeof fetch;
  const result = await pushLineMessage(fakeFetch, "token", "Uabc", "hello");
  assertEquals(result.ok, false);
  assertEquals(result.status, 400);
  assertEquals(result.errorDetail?.includes("hasn't added"), true);
});

Deno.test("pushLineMessage: 網路錯誤時 status=0 並記錄錯誤訊息", async () => {
  const fakeFetch = (() =>
    Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;
  const result = await pushLineMessage(fakeFetch, "token", "Uabc", "hello");
  assertEquals(result.ok, false);
  assertEquals(result.status, 0);
  assertEquals(result.errorDetail, "connection refused");
});

// =========================================================================
// resolveNotificationVariables(bug fix SPECS-INDEX 385):依 booking_id/staff_leave_record_id
// 呼叫對應的變數組裝函式。核心必測情境是「staff_leave_created 事件(只有 staff_leave_record_id,
// 沒有 booking_id)正確呼叫 render_staff_leave_notification_variables,並把結果套進範本渲染後
// 不再殘留未替換的 {{}} 語法」——這正是這次要修的 bug 本身。
// =========================================================================
function makeRpcClient(responses: Record<string, { data: unknown; error: unknown }>): {
  client: RpcClient;
  calls: { fn: string; args: Record<string, unknown> }[];
} {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(responses[fn] ?? { data: null, error: null });
    },
  };
  return { client, calls };
}

Deno.test(
  "resolveNotificationVariables: booking_id 有值時呼叫 render_booking_notification_variables,不呼叫請假那支",
  async () => {
    const { client, calls } = makeRpcClient({
      render_booking_notification_variables: {
        data: { merchant_name: "測試商家", customer_name: "王小明" },
        error: null,
      },
    });
    const variables = await resolveNotificationVariables(client, "merchant-1", "booking-1", null);
    assertEquals(variables, { merchant_name: "測試商家", customer_name: "王小明" });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].fn, "render_booking_notification_variables");
    // #972:一定要帶 p_merchant_id(資料庫會再確認訂單屬於這間商家;參數名錯了就是 PGRST202)。
    assertEquals(calls[0].args, { p_booking_id: "booking-1", p_merchant_id: "merchant-1" });
  },
);

Deno.test(
  "resolveNotificationVariables(核心必測,bug 385):staff_leave_record_id 有值時正確呼叫 render_staff_leave_notification_variables,渲染後不再殘留 {{}}",
  async () => {
    const { client, calls } = makeRpcClient({
      render_staff_leave_notification_variables: {
        data: {
          merchant_name: "測試商家",
          staff_name: "陳美美",
          booking_date: "2026-10-01",
          leave_type_name: "特休",
        },
        error: null,
      },
    });

    const variables = await resolveNotificationVariables(
      client,
      "merchant-1",
      undefined,
      "leave-1",
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0].fn, "render_staff_leave_notification_variables");
    assertEquals(calls[0].args, {
      p_staff_leave_record_id: "leave-1",
      p_merchant_id: "merchant-1",
    });

    // 這是 bug 385 的實際情境:staff_leave_created 事件的預設文案。修好之前 variables 永遠是
    // {},渲染結果會殘留 {{staff_name}}/{{booking_date}} 沒被替換,直接送給收訊人看到。
    const template = "【{{merchant_name}}】{{staff_name}} 登記了一筆請假:{{booking_date}}。";
    const renderedMessage = renderMessageTemplate(template, variables);
    assertEquals(renderedMessage, "【測試商家】陳美美 登記了一筆請假:2026-10-01。");
    assertEquals(/\{\{\w+\}\}/.test(renderedMessage), false);
  },
);

Deno.test(
  "resolveNotificationVariables: booking_id 跟 staff_leave_record_id 都沒有時(理論上不該發生)回傳空物件,不呼叫任何 RPC",
  async () => {
    const { client, calls } = makeRpcClient({});
    const variables = await resolveNotificationVariables(client, "merchant-1", null, null);
    assertEquals(variables, {});
    assertEquals(calls.length, 0);
  },
);

Deno.test(
  "resolveNotificationVariables: render_booking_notification_variables 呼叫失敗時回傳空物件,不往外拋",
  async () => {
    const { client } = makeRpcClient({
      render_booking_notification_variables: { data: null, error: { message: "boom" } },
    });
    const variables = await resolveNotificationVariables(client, "merchant-1", "booking-1", null);
    assertEquals(variables, {});
  },
);

Deno.test(
  "resolveNotificationVariables: render_staff_leave_notification_variables 呼叫失敗時回傳空物件,不往外拋",
  async () => {
    const { client } = makeRpcClient({
      render_staff_leave_notification_variables: { data: null, error: { message: "boom" } },
    });
    const variables = await resolveNotificationVariables(client, "merchant-1", null, "leave-1");
    assertEquals(variables, {});
  },
);

Deno.test("resolveNotificationVariables: 查無資料時資料庫回傳空物件 {},這裡原樣帶出", async () => {
  const { client } = makeRpcClient({
    render_staff_leave_notification_variables: { data: {}, error: null },
  });
  const variables = await resolveNotificationVariables(client, "merchant-1", null, "leave-missing");
  assertEquals(variables, {});
});

function makeResult(overrides: Partial<ResolveTargetsResult>): ResolveTargetsResult {
  return { connected: true, event_enabled: true, targets: [], skipped: [], ...overrides };
}

Deno.test("shouldWriteAnyLogRow: 2.4 第 1 點——商家沒串接 LINE 時不寫入任何記錄", () => {
  const result = makeResult({ connected: false, event_enabled: false });
  assertEquals(shouldWriteAnyLogRow(result), false);
});

Deno.test("shouldWriteAnyLogRow: 2.4 第 2 點——事件關閉時不寫入任何記錄", () => {
  const result = makeResult({ connected: true, event_enabled: false });
  assertEquals(shouldWriteAnyLogRow(result), false);
});

Deno.test(
  "shouldWriteAnyLogRow: 已連線且事件開啟,但沒有任何目標(理論上不會出現,防禦性驗證)不寫入",
  () => {
    const result = makeResult({ targets: [], skipped: [] });
    assertEquals(shouldWriteAnyLogRow(result), false);
  },
);

Deno.test(
  "shouldWriteAnyLogRow: 已連線且事件開啟,有 skipped 對象時要寫入記錄(核心必測,規則 2.4 第 3 點)",
  () => {
    const result = makeResult({
      targets: [],
      skipped: [{ type: "staff", id: "s1", reason: "target_not_bound" }],
    });
    assertEquals(shouldWriteAnyLogRow(result), true);
  },
);

Deno.test("shouldWriteAnyLogRow: 已連線且事件開啟,有實際目標時要寫入記錄", () => {
  // 客戶端第 5 批 C5-K01:resolve_line_notification_targets 不再回會員對象(pgTAP K01 守門),範例對象改成管理員。
  const result = makeResult({
    targets: [{ type: "admin", id: "a1", name: "管理員甲", line_user_id: "Uabc" }],
  });
  assertEquals(shouldWriteAnyLogRow(result), true);
});

Deno.test(
  "shouldWriteAnyLogRow: #962 服務人員已離職/停用、未開放行事曆檢視被跳過時,仍要寫跳過記錄讓商家查得到",
  () => {
    for (const reason of ["staff_inactive", "staff_calendar_view_off"] as const) {
      const result: ResolveTargetsResult = {
        connected: true,
        event_enabled: true,
        targets: [],
        skipped: [{ type: "staff", id: "s1", reason }],
      };
      assertEquals(shouldWriteAnyLogRow(result), true);
    }
  },
);

// =========================================================================
// SPECS-INDEX #972:跨商家訂單 / 請假紀錄(IDOR)。
//
// 情境:呼叫者是 A 商家(merchant-A)的管理員/客服,授權檢查 can_dispatch_line_notification 對 A 回 true;
// 但他帶的是 B 商家的 booking_id / staff_leave_record_id。
// 必須:回 404、完全不呼叫 resolve_line_notification_targets / render_*、一筆 line_notification_log 都不寫。
//
// 用「會把所有 .from() / .rpc() / .insert() 記下來」的假 adminClient,並且**不**替換歸屬檢查
// (createOwnershipLookup 不帶 → 走真正的 buildNotifySubjectOwnershipLookup),讓 index.ts →
// notifySubjectOwnership.ts → adminClient.from("bookings").eq("id").eq("merchant_id") 這整條真實路徑都走到。
// 假資料庫只認得:booking-A / leave-A(屬於 merchant-A 的服務人員 staff-A),以及
// booking-B / leave-B(屬於 merchant-B 的服務人員 staff-B)。
// =========================================================================
const FAKE_BOOKINGS: Record<string, string> = {
  "booking-A": "merchant-A",
  "booking-B": "merchant-B",
};
const FAKE_LEAVES: Record<string, string> = { "leave-A": "staff-A", "leave-B": "staff-B" };
const FAKE_STAFF: Record<string, string> = { "staff-A": "merchant-A", "staff-B": "merchant-B" };

function makeFakeLineAdminClient(options: { failLookup?: boolean; resolveResult?: unknown } = {}) {
  const rpcCalls: string[] = [];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const selects: { table: string; filters: Record<string, unknown> }[] = [];

  const adminClient = {
    from(table: string) {
      return {
        select() {
          const filters: Record<string, unknown> = {};
          const builder = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return builder;
            },
            maybeSingle() {
              selects.push({ table, filters: { ...filters } });
              if (options.failLookup && (table === "bookings" || table === "staff_leave_records")) {
                return Promise.resolve({ data: null, error: { message: "db down" } });
              }
              if (table === "bookings") {
                const owner = FAKE_BOOKINGS[String(filters.id)];
                const ok =
                  owner !== undefined &&
                  (filters.merchant_id === undefined || filters.merchant_id === owner);
                return Promise.resolve({ data: ok ? { id: filters.id } : null, error: null });
              }
              if (table === "staff_leave_records") {
                const staffId = FAKE_LEAVES[String(filters.id)];
                return Promise.resolve({
                  data: staffId ? { staff_id: staffId } : null,
                  error: null,
                });
              }
              if (table === "merchant_staff") {
                const owner = FAKE_STAFF[String(filters.id)];
                const ok =
                  owner !== undefined &&
                  (filters.merchant_id === undefined || filters.merchant_id === owner);
                return Promise.resolve({ data: ok ? { id: filters.id } : null, error: null });
              }
              if (table === "merchant_line_configs") {
                return Promise.resolve({ data: { channel_access_token: "token" }, error: null });
              }
              if (table === "merchant_line_event_settings") {
                return Promise.resolve({
                  data: { message_template: "{{customer_name}}" },
                  error: null,
                });
              }
              return Promise.resolve({ data: null, error: null });
            },
          };
          return builder;
        },
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
    rpc(fn: string, _args: Record<string, unknown>) {
      rpcCalls.push(fn);
      if (fn === "resolve_line_notification_targets" && options.resolveResult !== undefined) {
        return Promise.resolve({ data: options.resolveResult, error: null });
      }
      if (fn === "resolve_line_notification_targets") {
        // 同商家時:已連線、事件開啟,只有一個未綁定的服務人員 → 只寫一列 skipped,不打 LINE API。
        return Promise.resolve({
          data: {
            connected: true,
            event_enabled: true,
            targets: [],
            skipped: [{ type: "staff", id: "staff-A", reason: "target_not_bound" }],
          },
          error: null,
        });
      }
      return Promise.resolve({ data: {}, error: null });
    },
  };
  return { adminClient, rpcCalls, inserts, selects };
}

function makeLineDeps(
  adminClient: unknown,
  overrides: Partial<HandleRequestDeps> = {},
): HandleRequestDeps {
  return {
    // 呼叫者確實能管理 merchant-A(授權檢查通過)—— 這正是 IDOR 的前提。
    createCallerClient: () => ({ rpc: () => Promise.resolve({ data: true, error: null }) }),
    createAdminClient: () => adminClient,
    ...overrides,
  };
}

function makeLineRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/line-notify-dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer fake-jwt" },
    body: JSON.stringify(body),
  });
}

Deno.test(
  "#972(核心必測):A 商家帶 B 商家的 booking_id → 404,不解析收件人、不寫任何發送記錄",
  async () => {
    const { adminClient, rpcCalls, inserts } = makeFakeLineAdminClient();
    const res = await handleRequest(
      makeLineRequest({
        merchant_id: "merchant-A",
        booking_id: "booking-B",
        event_type: "booking_confirmed",
      }),
      makeLineDeps(adminClient),
    );
    assertEquals(res.status, 404);
    assertEquals(rpcCalls, []);
    assertEquals(inserts, []);
  },
);

Deno.test(
  "#972(核心必測):A 商家帶 B 商家的 staff_leave_record_id → 404,不解析收件人、不寫任何發送記錄",
  async () => {
    const { adminClient, rpcCalls, inserts } = makeFakeLineAdminClient();
    const res = await handleRequest(
      makeLineRequest({
        merchant_id: "merchant-A",
        staff_leave_record_id: "leave-B",
        event_type: "staff_leave_created",
      }),
      makeLineDeps(adminClient),
    );
    assertEquals(res.status, 404);
    assertEquals(rpcCalls, []);
    assertEquals(inserts, []);
  },
);

Deno.test("#972:不存在的 booking_id 也回 404(不區分「不存在」與「別家的」),不寫記錄", async () => {
  const { adminClient, rpcCalls, inserts } = makeFakeLineAdminClient();
  const res = await handleRequest(
    makeLineRequest({
      merchant_id: "merchant-A",
      booking_id: "booking-nope",
      event_type: "booking_created",
    }),
    makeLineDeps(adminClient),
  );
  assertEquals(res.status, 404);
  assertEquals(rpcCalls, []);
  assertEquals(inserts, []);
});

Deno.test("#972:歸屬查詢本身出錯 → 500(fail closed,不當作通過),不寫記錄", async () => {
  const { adminClient, rpcCalls, inserts } = makeFakeLineAdminClient({ failLookup: true });
  const res = await handleRequest(
    makeLineRequest({
      merchant_id: "merchant-A",
      booking_id: "booking-A",
      event_type: "booking_created",
    }),
    makeLineDeps(adminClient),
  );
  assertEquals(res.status, 500);
  assertEquals(rpcCalls, []);
  assertEquals(inserts, []);
});

Deno.test(
  "#972 正向對照:同商家的 booking_id → 正常解析收件人並寫入跳過記錄(行為不變)",
  async () => {
    const { adminClient, rpcCalls, inserts, selects } = makeFakeLineAdminClient();
    const res = await handleRequest(
      makeLineRequest({
        merchant_id: "merchant-A",
        booking_id: "booking-A",
        event_type: "booking_confirmed",
      }),
      makeLineDeps(adminClient),
    );
    assertEquals(res.status, 200);
    assertEquals(rpcCalls, ["resolve_line_notification_targets"]);
    assertEquals(inserts.length, 1);
    assertEquals(inserts[0].table, "line_notification_log");
    assertEquals(inserts[0].row.booking_id, "booking-A");
    // 釘住歸屬查詢真的用了 merchant_id 條件(拿掉 .eq("merchant_id") 這條會轉紅)。
    assertEquals(selects[0], {
      table: "bookings",
      filters: { id: "booking-A", merchant_id: "merchant-A" },
    });
  },
);

Deno.test(
  "#972 正向對照:同商家的 staff_leave_record_id → 正常解析收件人並寫入跳過記錄",
  async () => {
    const { adminClient, rpcCalls, inserts, selects } = makeFakeLineAdminClient();
    const res = await handleRequest(
      makeLineRequest({
        merchant_id: "merchant-A",
        staff_leave_record_id: "leave-A",
        event_type: "staff_leave_created",
      }),
      makeLineDeps(adminClient),
    );
    assertEquals(res.status, 200);
    assertEquals(rpcCalls, ["resolve_line_notification_targets"]);
    assertEquals(inserts.length, 1);
    assertEquals(inserts[0].row.staff_leave_record_id, "leave-A");
    assertEquals(selects[1], {
      table: "merchant_staff",
      filters: { id: "staff-A", merchant_id: "merchant-A" },
    });
  },
);

Deno.test("#972:授權檢查沒過時仍然是 403(歸屬檢查不會蓋掉原本的授權檢查),也不查歸屬", async () => {
  const { adminClient, rpcCalls, inserts, selects } = makeFakeLineAdminClient();
  const res = await handleRequest(
    makeLineRequest({
      merchant_id: "merchant-A",
      booking_id: "booking-A",
      event_type: "booking_confirmed",
    }),
    makeLineDeps(adminClient, {
      createCallerClient: () => ({ rpc: () => Promise.resolve({ data: false, error: null }) }),
    }),
  );
  assertEquals(res.status, 403);
  assertEquals(rpcCalls, []);
  assertEquals(inserts, []);
  assertEquals(selects, []);
});

Deno.test("#972:注入的歸屬檢查回 false 時,handler 一定擋下(handler 確實依賴這道檢查)", async () => {
  const { adminClient, rpcCalls, inserts } = makeFakeLineAdminClient();
  const denyAll: NotifySubjectOwnershipLookup = {
    bookingBelongsToMerchant: () => Promise.resolve(false),
    staffLeaveRecordBelongsToMerchant: () => Promise.resolve(false),
  };
  const res = await handleRequest(
    makeLineRequest({
      merchant_id: "merchant-A",
      booking_id: "booking-A",
      event_type: "booking_confirmed",
    }),
    makeLineDeps(adminClient, { createOwnershipLookup: () => denyAll }),
  );
  assertEquals(res.status, 404);
  assertEquals(rpcCalls, []);
  assertEquals(inserts, []);
});

Deno.test(
  "#972:buildNotifySubjectOwnershipLookup 請假紀錄查不到時回 false,不再查服務人員",
  async () => {
    const { adminClient, selects } = makeFakeLineAdminClient();
    const lookup = buildNotifySubjectOwnershipLookup(adminClient);
    assertEquals(await lookup.staffLeaveRecordBelongsToMerchant("leave-nope", "merchant-A"), false);
    assertEquals(
      selects.map((x) => x.table),
      ["staff_leave_records"],
    );
  },
);

// =========================================================================
// SPECS-INDEX #977 第 7 批(2026-10-07):服務人員本人自己建單 / 改單 / 取消 / 完成後發通知。
// 原本那道 can_dispatch_line_notification(管理員 / 客服)不過時,有帶 booking_id 才**再**問
// can_staff_dispatch_booking_notification。「別人的單 / 協助人員 / 事件不符」的判斷在資料庫那支(pgTAP req977_09 鎖住),
// 這裡鎖住的是 handler 的接線:誰會被問、問了什麼、回答怎麼對應到 200 / 403 / 500。
// =========================================================================
function makeStaffCaller(answers: Record<string, { data: unknown; error: unknown }>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return Promise.resolve(answers[fn] ?? { data: false, error: null });
      },
    },
  };
}

Deno.test(
  "#977-7:管理員檢查不過、服務人員本人自己的單 → 放行(200),而且問的是 can_staff_dispatch_booking_notification(帶商家 / 訂單 / 事件)",
  async () => {
    const { adminClient, rpcCalls } = makeFakeLineAdminClient();
    const caller = makeStaffCaller({
      can_dispatch_line_notification: { data: false, error: null },
      can_staff_dispatch_booking_notification: { data: true, error: null },
    });
    const res = await handleRequest(
      makeLineRequest({
        merchant_id: "merchant-A",
        booking_id: "booking-A",
        event_type: "booking_created",
      }),
      makeLineDeps(adminClient, { createCallerClient: () => caller.client }),
    );
    assertEquals(res.status, 200);
    assertEquals(caller.calls, [
      {
        fn: "can_dispatch_line_notification",
        args: { p_merchant_id: "merchant-A", p_event_type: "booking_created" },
      },
      {
        fn: "can_staff_dispatch_booking_notification",
        args: {
          p_merchant_id: "merchant-A",
          p_booking_id: "booking-A",
          p_event_type: "booking_created",
        },
      },
    ]);
    assertEquals(rpcCalls, ["resolve_line_notification_targets"]);
  },
);

Deno.test(
  "#977-7:別人的單 / 協助人員 / 事件不符(資料庫回 false)→ 403,不查歸屬、不寫記錄",
  async () => {
    const { adminClient, rpcCalls, inserts, selects } = makeFakeLineAdminClient();
    const caller = makeStaffCaller({
      can_dispatch_line_notification: { data: false, error: null },
      can_staff_dispatch_booking_notification: { data: false, error: null },
    });
    const res = await handleRequest(
      makeLineRequest({
        merchant_id: "merchant-A",
        booking_id: "booking-A",
        event_type: "booking_cancelled",
      }),
      makeLineDeps(adminClient, { createCallerClient: () => caller.client }),
    );
    assertEquals(res.status, 403);
    assertEquals(rpcCalls, []);
    assertEquals(inserts, []);
    assertEquals(selects, []);
  },
);

Deno.test("#977-7:沒帶 booking_id(例如請假通知)→ 不問服務人員那支,直接 403", async () => {
  const { adminClient, inserts } = makeFakeLineAdminClient();
  const caller = makeStaffCaller({
    can_dispatch_line_notification: { data: false, error: null },
    can_staff_dispatch_booking_notification: { data: true, error: null },
  });
  const res = await handleRequest(
    makeLineRequest({
      merchant_id: "merchant-A",
      staff_leave_record_id: "leave-A",
      event_type: "staff_leave_created",
    }),
    makeLineDeps(adminClient, { createCallerClient: () => caller.client }),
  );
  assertEquals(res.status, 403);
  assertEquals(
    caller.calls.map((c) => c.fn),
    ["can_dispatch_line_notification"],
  );
  assertEquals(inserts, []);
});

Deno.test("#977-7:服務人員那支 RPC 本身出錯 → 500(fail closed),不寫記錄", async () => {
  const { adminClient, inserts } = makeFakeLineAdminClient();
  const caller = makeStaffCaller({
    can_dispatch_line_notification: { data: false, error: null },
    can_staff_dispatch_booking_notification: { data: null, error: { message: "boom" } },
  });
  const res = await handleRequest(
    makeLineRequest({
      merchant_id: "merchant-A",
      booking_id: "booking-A",
      event_type: "booking_created",
    }),
    makeLineDeps(adminClient, { createCallerClient: () => caller.client }),
  );
  assertEquals(res.status, 500);
  assertEquals(inserts, []);
});

Deno.test("#977-7 正向對照:管理員 / 客服原本就放行 → 不會多問服務人員那支(行為不變)", async () => {
  const { adminClient } = makeFakeLineAdminClient();
  const caller = makeStaffCaller({
    can_dispatch_line_notification: { data: true, error: null },
    can_staff_dispatch_booking_notification: { data: false, error: null },
  });
  const res = await handleRequest(
    makeLineRequest({
      merchant_id: "merchant-A",
      booking_id: "booking-A",
      event_type: "booking_created",
    }),
    makeLineDeps(adminClient, { createCallerClient: () => caller.client }),
  );
  assertEquals(res.status, 200);
  assertEquals(
    caller.calls.map((c) => c.fn),
    ["can_dispatch_line_notification"],
  );
});

// =========================================================================
// #986 第 9 批(使用者裁決):服務人員改單 / 拖拉不通知客戶。服務人員路徑只放行建單、取消、完成三種 LINE 事件,
// 其他事件(例如 booking_updated)在伺服器端直接 403:不問 can_staff_dispatch_booking_notification、不寫任何記錄。
// =========================================================================
Deno.test(
  "#986-9:服務人員路徑 + booking_updated → 403(服務人員修改預約不會發送 LINE 通知),不問服務人員那支、不寫記錄",
  async () => {
    const { adminClient, rpcCalls, inserts, selects } = makeFakeLineAdminClient();
    const caller = makeStaffCaller({
      can_dispatch_line_notification: { data: false, error: null },
      can_staff_dispatch_booking_notification: { data: true, error: null },
    });
    const res = await handleRequest(
      makeLineRequest({
        merchant_id: "merchant-A",
        booking_id: "booking-A",
        event_type: "booking_updated",
      }),
      makeLineDeps(adminClient, { createCallerClient: () => caller.client }),
    );
    assertEquals(res.status, 403);
    assertEquals(await res.json(), { error: "服務人員修改預約不會發送 LINE 通知" });
    assertEquals(
      caller.calls.map((c) => c.fn),
      ["can_dispatch_line_notification"],
    );
    assertEquals(rpcCalls, []);
    assertEquals(inserts, []);
    assertEquals(selects, []);
  },
);

for (const ev of ["booking_created", "booking_cancelled", "booking_completed"] as const) {
  Deno.test(
    `#986-9:服務人員路徑白名單事件 ${ev} → 照第 7 批放行條件(資料庫回 true ⇒ 200)`,
    async () => {
      const { adminClient } = makeFakeLineAdminClient();
      const caller = makeStaffCaller({
        can_dispatch_line_notification: { data: false, error: null },
        can_staff_dispatch_booking_notification: { data: true, error: null },
      });
      const res = await handleRequest(
        makeLineRequest({ merchant_id: "merchant-A", booking_id: "booking-A", event_type: ev }),
        makeLineDeps(adminClient, { createCallerClient: () => caller.client }),
      );
      assertEquals(res.status, 200);
      assertEquals(
        caller.calls.map((c) => c.fn),
        ["can_dispatch_line_notification", "can_staff_dispatch_booking_notification"],
      );
    },
  );
}

Deno.test(
  "#986-9 對照:管理員 / 客服路徑對 booking_updated 行為不變(交給 can_dispatch_line_notification 決定,不套白名單)",
  async () => {
    const { adminClient } = makeFakeLineAdminClient();
    const caller = makeStaffCaller({
      can_dispatch_line_notification: { data: true, error: null },
    });
    const res = await handleRequest(
      makeLineRequest({
        merchant_id: "merchant-A",
        booking_id: "booking-A",
        event_type: "booking_updated",
      }),
      makeLineDeps(adminClient, { createCallerClient: () => caller.client }),
    );
    assertEquals(res.status !== 403, true);
    assertEquals(
      caller.calls.map((c) => c.fn),
      ["can_dispatch_line_notification"],
    );
  },
);

// =========================================================================
// 客戶端第 5 批 C5-K01(QA L1):resolve 結果混入 type:'member' ⇒ 不發送、不寫記錄(Edge 再擋一層)。
// =========================================================================
Deno.test("C5-K01:resolve 混入會員對象(targets / skipped)⇒ 會員不發送也不寫記錄,店家這邊照舊", async () => {
  const { adminClient, rpcCalls, inserts } = makeFakeLineAdminClient({
    resolveResult: {
      connected: true,
      event_enabled: true,
      targets: [{ type: "member", id: "member-A", name: "會員甲", line_user_id: "Umember" }],
      skipped: [
        { type: "member", id: null, reason: "no_target" },
        { type: "staff", id: "staff-A", reason: "target_not_bound" },
      ],
    },
  });
  const res = await handleRequest(
    makeLineRequest({ merchant_id: "merchant-A", booking_id: "booking-A", event_type: "booking_confirmed" }),
    makeLineDeps(adminClient),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { dispatched: false, skippedCount: 1 });
  assertEquals(inserts.map((i) => `${i.table}:${i.row.target_type}`), ["line_notification_log:staff"]);
  assertEquals(rpcCalls.includes("render_booking_notification_variables"), false);
});

Deno.test("C5-K01:resolve 只有會員對象 ⇒ 完全不寫記錄、不發送", async () => {
  const { adminClient, inserts } = makeFakeLineAdminClient({
    resolveResult: {
      connected: true,
      event_enabled: true,
      targets: [{ type: "member", id: "member-A", name: "會員甲", line_user_id: "Umember" }],
      skipped: [{ type: "member", id: "member-B", reason: "target_not_bound" }],
    },
  });
  const res = await handleRequest(
    makeLineRequest({ merchant_id: "merchant-A", booking_id: "booking-A", event_type: "booking_confirmed" }),
    makeLineDeps(adminClient),
  );
  assertEquals(res.status, 200);
  assertEquals(inserts, []);
});
