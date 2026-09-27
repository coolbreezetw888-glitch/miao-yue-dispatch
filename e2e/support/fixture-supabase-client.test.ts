// SPECS-INDEX #766:e2e/support/fixture-supabase-client.ts 的單元測試。
//
// **為什麼放在 e2e/ 底下卻是 Vitest(`*.test.ts`),不是 Playwright(`*.spec.ts`)**:被測的是
// 「怎麼組 Supabase client」這段純邏輯(挑 key、包 fetch、傳什麼選項),跟瀏覽器無關,也**絕對
// 不能真的連正式資料庫**——這組 helper 的 15 個呼叫端每一支都會對正式庫建資料,所以 #766 明寫
// 「把全部 e2e 跑一遍證明沒改壞」不可接受;能秒跑、不建任何資料的 Vitest 才是驗它的正確層級。
// vitest.config.ts 的 include 已經收 `e2e/support/**/*.test.{ts,tsx}`;playwright.config.ts 的
// testMatch 明寫 `**/*.spec.ts`,所以這支不會被 Playwright 誤收(#714 那次「整套靜默歸零」的坑)。
//
// 🔴 三個外部依賴全部假造,一個都不放行:
//    ① `node:fs` —— 讓 env-file.ts 讀到假的 `.env`(比照 env-file.test.ts,理由與那邊相同:
//       不依賴這台機器的 `.env`、不讓任何真實值有機會出現在測試輸出裡)。
//    ② `@supabase/supabase-js` 的 createClient —— 只記錄被用什麼參數呼叫,回傳一個哨兵物件。
//    ③ 全域 `fetch` —— 用 vi.stubGlobal 換成 spy,檢查包過的 fetch 真正送出去的標頭長什麼樣。
//
// ⚠️ 每條測試都先清掉 process.env 裡的 VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY:
//    readRequiredEnvValue 第一步查 process.env,不清掉的話「讀 .env」那條路徑不會被執行到。
//    afterEach 會把原值放回去,不影響同一個 Vitest 行程裡的其他測試。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ⚠️ 兩個坑同 env-file.test.ts:mock 工廠要同時給 default export;工廠裡不能引用頂層變數。
vi.mock("node:fs", () => {
  const readFileSync = vi.fn();
  return { readFileSync, default: { readFileSync } };
});

vi.mock("@supabase/supabase-js", () => {
  const createClient = vi.fn();
  return { createClient };
});

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import {
  buildFetch,
  createFixtureSupabaseClient,
  isNewSupabaseApiKey,
} from "./fixture-supabase-client";

const URL_KEY = "VITE_SUPABASE_URL";
const KEY_KEY = "VITE_SUPABASE_PUBLISHABLE_KEY";
// 假值——只要「長得像」就好,測試裡沒有任何真實憑證。
const FAKE_URL = "https://unit-test-fake-ref.supabase.co";
const FAKE_NEW_KEY = "sb_publishable_unit_test_fake_key";
const FAKE_LEGACY_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.unit-test-fake-anon-key";
const FAKE_USER_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.unit-test-fake-user-session";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedCreateClient = vi.mocked(createClient);

/** 讓 env-file.ts 下一次讀到這份假的 `.env`。 */
function givenEnvFile(content: string): void {
  mockedReadFileSync.mockReturnValue(content as unknown as ReturnType<typeof readFileSync>);
}

/** 換掉全域 fetch,回傳 spy 供斷言「包過的 fetch 真正送了什麼出去」。 */
function stubGlobalFetch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn().mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** 從 fetch spy 的第 n 次呼叫取出真正送出的 Headers。 */
function sentHeaders(spy: ReturnType<typeof vi.fn>, call = 0): Headers {
  const init = spy.mock.calls[call]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

const savedProcessEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  mockedReadFileSync.mockReset();
  mockedCreateClient.mockReset();
  for (const k of [URL_KEY, KEY_KEY]) {
    savedProcessEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of [URL_KEY, KEY_KEY]) {
    const v = savedProcessEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("isNewSupabaseApiKey", () => {
  it("sb_publishable_ 開頭 ⇒ 新格式", () => {
    expect(isNewSupabaseApiKey(FAKE_NEW_KEY)).toBe(true);
  });

  it("sb_secret_ 開頭 ⇒ 新格式", () => {
    expect(isNewSupabaseApiKey("sb_secret_unit_test_fake")).toBe(true);
  });

  it("舊的 JWT 格式 anon key ⇒ 不是新格式", () => {
    expect(isNewSupabaseApiKey(FAKE_LEGACY_KEY)).toBe(false);
  });

  it("只有前綴相似不算(sb_publishable 少了結尾底線、或出現在中間)", () => {
    // 這兩條釘住的是 startsWith 加上完整前綴含底線;寫成 includes("sb_publishable") 會誤判。
    expect(isNewSupabaseApiKey("sb_publishablex")).toBe(false);
    expect(isNewSupabaseApiKey("prefix_sb_publishable_x")).toBe(false);
    expect(isNewSupabaseApiKey("")).toBe(false);
  });
});

describe("buildFetch —— 一律補 apikey 標頭", () => {
  it("呼叫端完全沒給 headers 時,送出去的請求也要有 apikey", async () => {
    const spy = stubGlobalFetch();
    await buildFetch(FAKE_NEW_KEY)("https://example.test/rest/v1/x");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(sentHeaders(spy).get("apikey")).toBe(FAKE_NEW_KEY);
  });

  it("apikey 是用傳進 buildFetch 的那把 key,不是別的(換一把 key 就換一個值)", async () => {
    // 正向對照:證明上一條的 apikey 斷言真的在讀我們設的值,不是碰巧有個常數叫 apikey。
    const spy = stubGlobalFetch();
    await buildFetch(FAKE_LEGACY_KEY)("https://example.test/");
    expect(sentHeaders(spy).get("apikey")).toBe(FAKE_LEGACY_KEY);
  });

  it("input 原封不動、init 的其他欄位(method / body)原封不動地往下傳", async () => {
    const spy = stubGlobalFetch();
    const input = "https://example.test/rest/v1/merchants";
    await buildFetch(FAKE_NEW_KEY)(input, { method: "POST", body: '{"a":1}' });

    const [sentInput, sentInit] = spy.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(sentInput).toBe(input);
    expect(sentInit.method).toBe("POST");
    expect(sentInit.body).toBe('{"a":1}');
  });

  it("呼叫端原本帶的其他標頭會保留(用 Headers 物件給也一樣)", async () => {
    const spy = stubGlobalFetch();
    const given = new Headers({ "Content-Type": "application/json", Prefer: "return=minimal" });
    await buildFetch(FAKE_NEW_KEY)("https://example.test/", { headers: given });

    const sent = sentHeaders(spy);
    expect(sent.get("Content-Type")).toBe("application/json");
    expect(sent.get("Prefer")).toBe("return=minimal");
    expect(sent.get("apikey")).toBe(FAKE_NEW_KEY);
  });
});

describe("buildFetch —— Authorization 只在「新格式 key 且值就是這把 key」時拿掉", () => {
  it("🔴 新格式 key + Authorization 恰好是 `Bearer <這把 key>` ⇒ 拿掉 Authorization", async () => {
    // 這是整組包裝存在的理由:sb_publishable_ 不是合法 JWT,伺服器看到它當 Bearer 會判格式錯誤。
    const spy = stubGlobalFetch();
    await buildFetch(FAKE_NEW_KEY)("https://example.test/", {
      headers: { Authorization: `Bearer ${FAKE_NEW_KEY}` },
    });

    const sent = sentHeaders(spy);
    expect(sent.has("Authorization")).toBe(false);
    expect(sent.get("apikey")).toBe(FAKE_NEW_KEY);
  });

  it("正向對照 ①:新格式 key + Authorization 是使用者的 session JWT ⇒ **保留**", async () => {
    // 沒有這條,上一條的「Authorization 不見了」可能只是因為包裝把所有 Authorization 都砍了——
    // 那樣登入後的每一個請求都會變成匿名,fixture 的 setup/teardown 會整個失敗。
    const spy = stubGlobalFetch();
    await buildFetch(FAKE_NEW_KEY)("https://example.test/", {
      headers: { Authorization: `Bearer ${FAKE_USER_JWT}` },
    });

    expect(sentHeaders(spy).get("Authorization")).toBe(`Bearer ${FAKE_USER_JWT}`);
  });

  it("正向對照 ②:舊格式 JWT key + Authorization 是 `Bearer <這把 key>` ⇒ **保留**", async () => {
    // 舊格式 anon key 本身就是合法 JWT,supabase-js 拿它當 Bearer 是正常行為,不該被拿掉。
    // 這條證明 isNewSupabaseApiKey 那個條件真的有參與判斷。
    const spy = stubGlobalFetch();
    await buildFetch(FAKE_LEGACY_KEY)("https://example.test/", {
      headers: { Authorization: `Bearer ${FAKE_LEGACY_KEY}` },
    });

    expect(sentHeaders(spy).get("Authorization")).toBe(`Bearer ${FAKE_LEGACY_KEY}`);
  });

  it("標頭名稱大小寫不同(authorization 小寫)也一樣會被比對到", async () => {
    // Headers 是 case-insensitive;呼叫端用小寫給,`headers.get("Authorization")` 也要抓得到。
    const spy = stubGlobalFetch();
    await buildFetch(FAKE_NEW_KEY)("https://example.test/", {
      headers: { authorization: `Bearer ${FAKE_NEW_KEY}` },
    });
    expect(sentHeaders(spy).has("authorization")).toBe(false);
  });

  it("每次呼叫都查當下的全域 fetch,不是在 buildFetch 時就綁死", async () => {
    // 舊的 15 份都是 `return fetch(...)` 讀全域;有人若改成 `const f = fetch` 提早綁定,
    // Playwright 這種會在測試中換 fetch 的環境行為就變了。這條把它釘住。
    const wrapped = buildFetch(FAKE_NEW_KEY);
    const late = stubGlobalFetch();
    await wrapped("https://example.test/");
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe("createFixtureSupabaseClient", () => {
  const SENTINEL = { __unitTestSentinel: true };

  beforeEach(() => {
    mockedCreateClient.mockReturnValue(SENTINEL as unknown as ReturnType<typeof createClient>);
  });

  it("用 .env 的 VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY 呼叫 createClient,並回傳它的結果", () => {
    givenEnvFile(`${URL_KEY}=${FAKE_URL}\n${KEY_KEY}=${FAKE_NEW_KEY}\n`);

    const client = createFixtureSupabaseClient();

    expect(client).toBe(SENTINEL);
    expect(mockedCreateClient).toHaveBeenCalledTimes(1);
    const [url, key] = mockedCreateClient.mock.calls[0] as [string, string, unknown];
    expect(url).toBe(FAKE_URL);
    expect(key).toBe(FAKE_NEW_KEY);
  });

  it("🔴 選項跟舊的 15 份一字不差:persistSession=false、autoRefreshToken=false、global.fetch 有包", () => {
    // fixture 在 Node 端跑,沒有 localStorage;persistSession/autoRefreshToken 開著會在 Node 裡噴警告、
    // 甚至讓 teardown 之後還有 timer 掛著。這條釘住的是「選項沒有被改動」。
    givenEnvFile(`${URL_KEY}=${FAKE_URL}\n${KEY_KEY}=${FAKE_NEW_KEY}\n`);
    createFixtureSupabaseClient();

    const options = mockedCreateClient.mock.calls[0]?.[2] as {
      global?: { fetch?: unknown };
      auth?: { persistSession?: boolean; autoRefreshToken?: boolean };
    };
    expect(options.auth).toEqual({ persistSession: false, autoRefreshToken: false });
    expect(typeof options.global?.fetch).toBe("function");
  });

  it("傳給 createClient 的 fetch 就是用**同一把 key** 包出來的(送出去的 apikey 等於 .env 的 key)", async () => {
    // 正向對照:上一條只證明「有個函式」,這條證明它真的是 buildFetch(key),而不是裸的 fetch。
    givenEnvFile(`${URL_KEY}=${FAKE_URL}\n${KEY_KEY}=${FAKE_NEW_KEY}\n`);
    createFixtureSupabaseClient();
    const options = mockedCreateClient.mock.calls[0]?.[2] as { global: { fetch: typeof fetch } };

    const spy = stubGlobalFetch();
    await options.global.fetch("https://example.test/", {
      headers: { Authorization: `Bearer ${FAKE_NEW_KEY}` },
    });

    const sent = sentHeaders(spy);
    expect(sent.get("apikey")).toBe(FAKE_NEW_KEY);
    expect(sent.has("Authorization")).toBe(false);
  });

  it("讀的是 PUBLISHABLE_KEY,不會誤拿別的 key(.env 同時有 ANON_KEY 時)", () => {
    // 正向對照:證明「key 等於 FAKE_NEW_KEY」那條斷言不是因為 .env 裡只有一把 key 而碰巧成立。
    givenEnvFile(
      `${URL_KEY}=${FAKE_URL}\nVITE_SUPABASE_ANON_KEY=${FAKE_LEGACY_KEY}\n${KEY_KEY}=${FAKE_NEW_KEY}\n`,
    );
    createFixtureSupabaseClient();
    expect(mockedCreateClient.mock.calls[0]?.[1]).toBe(FAKE_NEW_KEY);
  });

  it("找不到 VITE_SUPABASE_URL ⇒ throw,錯誤訊息帶出 key 名與呼叫端給的 purpose;不會呼叫 createClient", () => {
    givenEnvFile(`${KEY_KEY}=${FAKE_NEW_KEY}\n`);
    expect(() => createFixtureSupabaseClient("payroll 這個 e2e 測試")).toThrowError(
      `找不到 .env 裡的 ${URL_KEY}——payroll 這個 e2e 測試需要它來建立 fixture 資料。`,
    );
    expect(mockedCreateClient).not.toHaveBeenCalled();
  });

  it("找不到 VITE_SUPABASE_PUBLISHABLE_KEY ⇒ throw,訊息點名的是 KEY 不是 URL", () => {
    // 正向對照:證明上一條的錯誤訊息真的是依「哪個 key 缺」組出來的,不是固定字串。
    givenEnvFile(`${URL_KEY}=${FAKE_URL}\n`);
    expect(() => createFixtureSupabaseClient("members 這個 e2e 測試")).toThrowError(
      `找不到 .env 裡的 ${KEY_KEY}——members 這個 e2e 測試需要它來建立 fixture 資料。`,
    );
  });

  it("不傳 purpose ⇒ 用預設描述「這個 e2e 測試」(跟舊的 5 份通用訊息一字不差)", () => {
    givenEnvFile(``);
    expect(() => createFixtureSupabaseClient()).toThrowError(
      `找不到 .env 裡的 ${URL_KEY}——這個 e2e 測試需要它來建立 fixture 資料。`,
    );
  });

  it("process.env 有值時優先用它(CI 的注入方式),連 .env 都不讀", () => {
    process.env[URL_KEY] = FAKE_URL;
    process.env[KEY_KEY] = FAKE_NEW_KEY;
    givenEnvFile(`${URL_KEY}=https://should-not-be-used.test\n${KEY_KEY}=should-not-be-used\n`);

    createFixtureSupabaseClient();

    expect(mockedReadFileSync).not.toHaveBeenCalled();
    expect(mockedCreateClient.mock.calls[0]?.[0]).toBe(FAKE_URL);
    expect(mockedCreateClient.mock.calls[0]?.[1]).toBe(FAKE_NEW_KEY);
  });
});
