// 「只連本機」e2e 模式的守門函式(local-target.ts)單元測試。
// 這幾條是整個本機模式的安全前提:任何一條被改壞,本機模式就可能悄悄連到雲端專案。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertLocalBaseUrl,
  assertLocalSupabaseUrl,
  installLoopbackOnlyFetchGuard,
  isLoopbackHost,
  loadLocalSupabaseTargetIntoEnv,
  localAuthStorageKey,
  nonLoopbackWebSocketUrls,
  parseSupabaseStatusEnv,
} from "./local-target";

describe("assertLocalSupabaseUrl", () => {
  it("本機網址放行", () => {
    expect(assertLocalSupabaseUrl("http://127.0.0.1:55321").port).toBe("55321");
    expect(assertLocalSupabaseUrl("http://localhost:54321").hostname).toBe("localhost");
  });

  it("雲端專案網址一律中止", () => {
    expect(() => assertLocalSupabaseUrl("https://abcdefgh.supabase.co")).toThrow(/supabase\.co/);
    // 就算路徑或查詢字串裡夾帶 supabase.co 也擋(寧可錯殺)。
    expect(() => assertLocalSupabaseUrl("http://127.0.0.1:1/?x=a.supabase.co")).toThrow();
  });

  it("其他非本機主機中止", () => {
    expect(() => assertLocalSupabaseUrl("https://example.com")).toThrow(/不是 127\.0\.0\.1/);
    expect(() => assertLocalSupabaseUrl("http://127.0.0.1.evil.test")).toThrow();
  });

  it("空值 / 格式錯誤中止", () => {
    expect(() => assertLocalSupabaseUrl(undefined)).toThrow(/supabase start/);
    expect(() => assertLocalSupabaseUrl("")).toThrow();
    expect(() => assertLocalSupabaseUrl("not a url")).toThrow(/格式/);
  });
});

describe("isLoopbackHost / localAuthStorageKey / parseSupabaseStatusEnv", () => {
  it("只認 127.0.0.1 / localhost / ::1", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(false);
    expect(isLoopbackHost("wjtbmmnakcriuaqoknsq.supabase.co")).toBe(false);
  });

  it("本機 session key 是 sb-127-auth-token", () => {
    expect(localAuthStorageKey("http://127.0.0.1:55321")).toBe("sb-127-auth-token");
  });

  it("解析 supabase status -o env(含 CRLF 與引號)", () => {
    const parsed = parseSupabaseStatusEnv(
      'API_URL="http://127.0.0.1:55321"\r\nANON_KEY=abc\r\nnoise line\n',
    );
    expect(parsed["API_URL"]).toBe("http://127.0.0.1:55321");
    expect(parsed["ANON_KEY"]).toBe("abc");
  });
});

describe("installLoopbackOnlyFetchGuard", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("miaoyue.e2eLocal.fetchGuard")];
  });

  it("非本機請求被擋、本機請求放行", async () => {
    const spy = vi.fn(async () => new Response("ok"));
    globalThis.fetch = spy as unknown as typeof fetch;
    installLoopbackOnlyFetchGuard();

    await expect(fetch("https://abc.supabase.co/rest/v1/x")).rejects.toThrow(/非本機/);
    await expect(fetch(new URL("https://example.com/"))).rejects.toThrow(/非本機/);
    expect(spy).not.toHaveBeenCalled();

    await fetch("http://127.0.0.1:55321/rest/v1/x");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("nonLoopbackWebSocketUrls(#874:WebSocket 也只准連本機)", () => {
  it("本機的 Realtime 與 Vite HMR WebSocket 放行", () => {
    expect(
      nonLoopbackWebSocketUrls([
        "ws://127.0.0.1:55321/realtime/v1/websocket?apikey=x&vsn=2.0.0",
        "ws://localhost:5194/?token=abc",
        "ws://[::1]:5194/",
      ]),
    ).toEqual([]);
  });

  it("雲端 Realtime、其他主機、非 ws 協定、壞網址一律挑出來", () => {
    const bad = [
      "wss://abcdefgh.supabase.co/realtime/v1/websocket",
      "ws://127.0.0.1:1/?x=a.supabase.co",
      "wss://example.com/socket",
      "ws://127.0.0.1.evil.test/",
      "http://127.0.0.1:55321/",
      "not a url",
    ];
    expect(nonLoopbackWebSocketUrls(bad)).toEqual(bad);
  });
});

// =========================================================================
// 第 6 批(#849):預設 e2e 的本機模式也共用這兩支。
// =========================================================================
describe("assertLocalBaseUrl(前端網址也只准本機)", () => {
  it("本機前端放行", () => {
    expect(assertLocalBaseUrl("http://localhost:5195").port).toBe("5195");
    expect(assertLocalBaseUrl("http://127.0.0.1:5195/").hostname).toBe("127.0.0.1");
  });

  it("正式站、雲端、其他主機、非 http 協定、空值一律中止", () => {
    expect(() => assertLocalBaseUrl("https://miaoyue.example.com")).toThrow(/不是 127\.0\.0\.1/);
    expect(() => assertLocalBaseUrl("https://abc.supabase.co")).toThrow(/supabase\.co/);
    expect(() => assertLocalBaseUrl("ftp://localhost:5195")).toThrow(/協定/);
    expect(() => assertLocalBaseUrl("http://localhost.evil.test:5195")).toThrow();
    expect(() => assertLocalBaseUrl("")).toThrow();
    expect(() => assertLocalBaseUrl(undefined)).toThrow();
    expect(() => assertLocalBaseUrl("not a url")).toThrow(/格式/);
  });
});

describe("loadLocalSupabaseTargetIntoEnv(取本機網址與金鑰,不是本機就中止)", () => {
  const KEYS = [
    "E2E_LOCAL_SUPABASE_URL",
    "E2E_LOCAL_SUPABASE_PUBLISHABLE_KEY",
    "E2E_LOCAL_SUPABASE_SERVICE_ROLE_KEY",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("CLI 回本機網址 ⇒ 放進環境變數並回傳 origin", () => {
    const result = loadLocalSupabaseTargetIntoEnv(
      () => 'API_URL="http://127.0.0.1:55321"\nPUBLISHABLE_KEY="pk"\nSERVICE_ROLE_KEY="sk"\n',
    );
    expect(result).toEqual({ url: "http://127.0.0.1:55321", publishableKey: "pk" });
    expect(process.env["E2E_LOCAL_SUPABASE_URL"]).toBe("http://127.0.0.1:55321");
  });

  it("🔴 故障注入:CLI 回雲端網址 ⇒ throw,環境變數不會被寫入", () => {
    expect(() =>
      loadLocalSupabaseTargetIntoEnv(
        () =>
          'API_URL="https://abcdefgh.supabase.co"\nPUBLISHABLE_KEY="pk"\nSERVICE_ROLE_KEY="sk"\n',
      ),
    ).toThrow(/supabase\.co/);
    expect(process.env["E2E_LOCAL_SUPABASE_URL"]).toBeUndefined();
  });

  it("🔴 故障注入:外面先設好的 E2E_LOCAL_SUPABASE_URL 不是本機 ⇒ 一樣 throw(不會因為「已經有值」就跳過檢查)", () => {
    process.env["E2E_LOCAL_SUPABASE_URL"] = "https://abcdefgh.supabase.co";
    process.env["E2E_LOCAL_SUPABASE_PUBLISHABLE_KEY"] = "pk";
    const cli = vi.fn(() => "");
    expect(() => loadLocalSupabaseTargetIntoEnv(cli)).toThrow(/supabase\.co/);
    expect(cli).not.toHaveBeenCalled();
  });

  it("CLI 失敗(本機 Supabase 沒開)或沒回金鑰 ⇒ throw", () => {
    expect(() =>
      loadLocalSupabaseTargetIntoEnv(() => {
        throw new Error("docker not running");
      }),
    ).toThrow(/supabase start/);
    expect(() =>
      loadLocalSupabaseTargetIntoEnv(() => 'API_URL="http://127.0.0.1:55321"\n'),
    ).toThrow(/金鑰/);
  });
});
