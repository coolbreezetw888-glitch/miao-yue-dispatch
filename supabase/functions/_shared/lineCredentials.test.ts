import { assertEquals } from "jsr:@std/assert@1";
import {
  getLineMessagingCredentials,
  LINE_CREDENTIALS_RPC,
  parseLineMessagingCredentials,
} from "./lineCredentials.ts";

const SECRET = "SECRET-SENTINEL-1053";
const TOKEN = "TOKEN-SENTINEL-1053";

function captureConsoleError() {
  const logs: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  return { logs, restore: () => (console.error = orig) };
}

Deno.test("#1053 parseLineMessagingCredentials:兩個欄位都是非空字串才回金鑰,否則 null", () => {
  assertEquals(parseLineMessagingCredentials({ channel_secret: SECRET, channel_access_token: TOKEN }), {
    channelSecret: SECRET,
    channelAccessToken: TOKEN,
  });
  assertEquals(parseLineMessagingCredentials(null), null);
  assertEquals(parseLineMessagingCredentials({ channel_secret: SECRET }), null);
  assertEquals(parseLineMessagingCredentials({ channel_secret: "", channel_access_token: TOKEN }), null);
  assertEquals(parseLineMessagingCredentials({ channel_secret: SECRET, channel_access_token: 123 }), null);
  assertEquals(parseLineMessagingCredentials("x"), null);
});

Deno.test("#1053 getLineMessagingCredentials:呼叫 service_role 專用 RPC,帶 p_merchant_id", async () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data: { channel_secret: SECRET, channel_access_token: TOKEN }, error: null });
    },
  };
  const got = await getLineMessagingCredentials(client, "m-1");
  assertEquals(got, { channelSecret: SECRET, channelAccessToken: TOKEN });
  assertEquals(calls, [{ fn: LINE_CREDENTIALS_RPC, args: { p_merchant_id: "m-1" } }]);
  assertEquals(LINE_CREDENTIALS_RPC, "internal_get_line_messaging_credentials");
});

Deno.test("#1053 getLineMessagingCredentials:RPC 回 null(沒設定 / Vault 讀不到)⇒ null,不寫 log", async () => {
  const cap = captureConsoleError();
  try {
    const got = await getLineMessagingCredentials({ rpc: () => Promise.resolve({ data: null, error: null }) }, "m-1");
    assertEquals(got, null);
    assertEquals(cap.logs.length, 0);
  } finally {
    cap.restore();
  }
});

Deno.test("#1053 getLineMessagingCredentials:RPC 錯誤 / 丟例外 ⇒ null;log 只有固定文字 + 代碼,不帶錯誤原文", async () => {
  const cap = captureConsoleError();
  try {
    const got1 = await getLineMessagingCredentials(
      { rpc: () => Promise.resolve({ data: null, error: { code: "42501", message: `permission denied ${TOKEN}` } }) },
      "m-1",
      "[line-webhook]",
    );
    const got2 = await getLineMessagingCredentials(
      { rpc: () => Promise.reject(new TypeError(`boom ${SECRET}`)) },
      "m-1",
      "[line-webhook]",
    );
    const got3 = await getLineMessagingCredentials(
      { rpc: () => Promise.resolve({ data: { channel_secret: SECRET, channel_access_token: TOKEN }, error: null }) },
      "",
    );
    assertEquals([got1, got2, got3], [null, null, null]);
    assertEquals(cap.logs, [
      ["[line-webhook] 讀取 LINE 金鑰失敗", "42501"],
      ["[line-webhook] 讀取 LINE 金鑰失敗", "TypeError"],
    ]);
  } finally {
    cap.restore();
  }
});
