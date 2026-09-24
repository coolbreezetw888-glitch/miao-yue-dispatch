// SPECS-INDEX #714 §4.3 第二層(行為等價):e2e/support/env-file.ts 的單元測試。
//
// **為什麼這支測試放在 e2e/ 底下卻是 Vitest,不是 Playwright**:被測的是一支純函式
// (讀字串、切行、去引號),跟瀏覽器、跟資料庫都無關。用 Vitest 秒跑、不啟動 dev server、
// 不建任何測試資料,是唯一合理的層級。vitest.config.ts 的 `include` 已經加上
// `e2e/support/**/*.test.{ts,tsx}` 這一條(Playwright 的檔案一律是 `*.spec.ts`,不會被誤收)。
//
// 🔴 **一律用 vi.mock("node:fs") 假造 `.env`,絕對不讀真的 `.env`**:
//    ① 測試不能依賴這台機器上 `.env` 的實際內容(別人 clone 下來就會紅);
//    ② `.env` 裡有 E2E_PLATFORM_ADMIN_EMAIL / _PASSWORD 這類機密,**不可以讓任何真實值
//       有機會出現在測試輸出或失敗訊息裡**(CLAUDE.md 第九章)。
//
// ⚠️ 每一條測試都會先把 process.env 裡的同名 key 清掉——readOptionalEnvValue 的第一步是
//    查 process.env,不清掉的話「讀 .env」那條路徑根本不會被執行到,測試會變成假通過。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ⚠️ 兩個實測踩到的坑,改這段之前先讀:
//   ① 這個 mock 工廠**必須同時給 default export**:Vitest 轉譯 `node:fs` 這種內建模組時
//      會走 CJS interop,只給具名 export 會在載入階段就爆
//      「No "default" export is defined on the "node:fs" mock」。
//   ② 工廠裡**不能引用任何頂層變數**:`vi.mock` 會被 hoist 到檔案最上方,引用頂層的
//      `const readFileSyncMock = vi.fn()` 會爆
//      「Cannot access 'readFileSyncMock' before initialization」。
//      所以 vi.fn() 直接寫在工廠裡,外面再用 vi.mocked(readFileSync) 取回同一個 spy。
vi.mock("node:fs", () => {
  const readFileSync = vi.fn();
  return { readFileSync, default: { readFileSync } };
});

import { readFileSync } from "node:fs";

import { readOptionalEnvValue, readRequiredEnvValue } from "./env-file";

const KEY = "E2E_UNIT_TEST_FAKE_KEY";
const mockedReadFileSync = vi.mocked(readFileSync);

/** 讓下一次讀取看到這份假的 `.env` 內容。 */
function givenEnvFile(content: string): void {
  mockedReadFileSync.mockReturnValue(content as unknown as ReturnType<typeof readFileSync>);
}

beforeEach(() => {
  mockedReadFileSync.mockReset();
  delete process.env[KEY];
});

afterEach(() => {
  delete process.env[KEY];
});

describe("readOptionalEnvValue —— .env 解析", () => {
  it("最基本的 KEY=value", () => {
    givenEnvFile(`OTHER=1\n${KEY}=hello-world\nANOTHER=2\n`);
    expect(readOptionalEnvValue(KEY)).toBe("hello-world");
  });

  it("等號兩側有空白(KEY = value)也讀得到,而且值不含前後空白", () => {
    // 這個分支對應 env-file.ts 的 `l.startsWith(`${key} =`)`:少了它,寫成
    // `KEY = value` 的 .env 會整個讀不到。
    givenEnvFile(`${KEY} =   spaced-value   \n`);
    expect(readOptionalEnvValue(KEY)).toBe("spaced-value");
  });

  it("值用雙引號包起來時會去掉引號", () => {
    givenEnvFile(`${KEY}="quoted-value"\n`);
    expect(readOptionalEnvValue(KEY)).toBe("quoted-value");
  });

  it("值用單引號包起來時會去掉引號", () => {
    givenEnvFile(`${KEY}='quoted-value'\n`);
    expect(readOptionalEnvValue(KEY)).toBe("quoted-value");
  });

  it("值本身含有等號時,只切第一個等號(例如 JWT / base64 結尾的 =)", () => {
    // 這條釘住 `line.slice(line.indexOf("=") + 1)` 用的是 indexOf 不是 lastIndexOf/split("=")。
    // Supabase 的 key 尾巴常常就是 `=`,切錯會直接拿到殘缺的憑證。
    givenEnvFile(`${KEY}=abc.def=ghi==\n`);
    expect(readOptionalEnvValue(KEY)).toBe("abc.def=ghi==");
  });

  it("🔴 CRLF(\\r\\n)換行的 .env 讀出來的值不可以夾帶 \\r", () => {
    // ⚠️ 這條不能省:這個 repo 有大量 CRLF 檔案(automated-testing/SKILL.md 第六節),
    //    `.env` 本身也可能是 CRLF。如果解析出來的值尾巴多一個 \r,拿去組 Supabase URL
    //    會在很遠的地方爆出看不懂的錯(參照「逐字轉貼 SQL 要用指紋驗證」那次 CRLF 事故)。
    givenEnvFile(`OTHER=1\r\n${KEY}=crlf-value\r\nANOTHER=2\r\n`);
    const value = readOptionalEnvValue(KEY);
    expect(value).toBe("crlf-value");
    expect(value).not.toMatch(/[\r\n]/);
  });

  it("🔴 CRLF + 引號:去引號要在去掉 \\r 之後做,否則引號會留在值裡", () => {
    // 這條比上一條嚴格:`replace(/^["']|["']$/g, "")` 是對**行尾**比對的,
    // 如果 \r 還沒被 trim 掉,結尾的 `"` 就不在字串尾端,引號會拔不掉,
    // 值會變成 `crlf-quoted"`。這是「順序寫反」才會出現的 bug。
    givenEnvFile(`${KEY}="crlf-quoted"\r\n`);
    expect(readOptionalEnvValue(KEY)).toBe("crlf-quoted");
  });

  it("找不到這個 key ⇒ undefined", () => {
    givenEnvFile(`SOMETHING_ELSE=1\n`);
    expect(readOptionalEnvValue(KEY)).toBeUndefined();
  });

  it("有這一行但值是空的 ⇒ undefined(不是空字串)", () => {
    givenEnvFile(`${KEY}=\n`);
    expect(readOptionalEnvValue(KEY)).toBeUndefined();
  });

  it("只有前綴相同的 key 不會被誤判(KEY_EXTRA 不算 KEY)", () => {
    // `startsWith(`${key}=`)` 的等號不是裝飾:少了它,找 `E2E_UNIT_TEST_FAKE_KEY` 會誤中
    // `E2E_UNIT_TEST_FAKE_KEY_EXTRA`,拿到完全不相干的值。
    givenEnvFile(`${KEY}_EXTRA=wrong-one\n`);
    expect(readOptionalEnvValue(KEY)).toBeUndefined();
  });

  it("根本沒有 .env 檔案(readFileSync 丟錯)⇒ undefined,不往外丟例外", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    expect(readOptionalEnvValue(KEY)).toBeUndefined();
  });
});

describe("readOptionalEnvValue —— process.env 優先", () => {
  it("process.env 有值時直接用它,連 .env 都不讀", () => {
    // CI 是用真正的環境變數注入的,不會有 .env 檔案,所以這個順序不能反過來。
    process.env[KEY] = "from-process-env";
    givenEnvFile(`${KEY}=from-dotenv\n`);

    expect(readOptionalEnvValue(KEY)).toBe("from-process-env");
    expect(mockedReadFileSync).not.toHaveBeenCalled();
  });

  it("process.env 的值是空字串時,視為沒設定,回頭讀 .env", () => {
    process.env[KEY] = "";
    givenEnvFile(`${KEY}=from-dotenv\n`);

    expect(readOptionalEnvValue(KEY)).toBe("from-dotenv");
    expect(mockedReadFileSync).toHaveBeenCalled();
  });
});

describe("readRequiredEnvValue —— 讀不到就丟錯", () => {
  it("讀得到時回傳值,行為跟 readOptionalEnvValue 一致", () => {
    givenEnvFile(`${KEY}=required-value\n`);
    expect(readRequiredEnvValue(KEY)).toBe("required-value");
  });

  it("找不到 key ⇒ throw,而且錯誤訊息帶出 key 名稱與用途描述", () => {
    givenEnvFile(`SOMETHING_ELSE=1\n`);
    expect(() => readRequiredEnvValue(KEY, "某某 e2e 測試")).toThrowError(
      `找不到 .env 裡的 ${KEY}——某某 e2e 測試需要它來建立 fixture 資料。`,
    );
  });

  it("🔴 有這一行但值是空的 ⇒ 也要 throw,不可以回傳空字串", () => {
    // 規格書 §四 4.2 的明確裁決:呼叫端全部拿它去組 Supabase URL / API key,
    // 空字串一路往下傳只會在更遠的地方爆出看不懂的錯,不如當場爆掉。
    givenEnvFile(`${KEY}=\n`);
    expect(() => readRequiredEnvValue(KEY)).toThrowError(/找不到 \.env 裡的/);
  });

  it("沒有傳 purpose 時用預設描述", () => {
    givenEnvFile(``);
    expect(() => readRequiredEnvValue(KEY)).toThrowError(
      `找不到 .env 裡的 ${KEY}——這個 e2e 測試需要它來建立 fixture 資料。`,
    );
  });
});
