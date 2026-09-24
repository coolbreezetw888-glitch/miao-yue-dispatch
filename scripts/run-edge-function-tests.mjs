// 模組 15 擴充:Supabase Edge Function(Deno)測試的執行器。
//
// =========================================================================
// 為什麼需要這個東西(不是「另外發明一套測試框架」,是「讓既有的 Deno 測試真的跑得起來」)
//
// supabase/functions/ 底下的程式碼是 **Deno** 執行環境,測試檔用的是 Deno 原生的
// `Deno.test()` 與 `jsr:@std/assert`。正規跑法是:
//
//     deno test --allow-env supabase/functions/
//
// 但**這個專案的開發機目前沒有安裝 deno**(`deno --version` → command not found),而且
// package.json 刻意沒有把 deno 加成 devDependency(它是一個獨立的執行檔,不是 npm 套件;
// 為了跑測試而新增一個幾十 MB 的二進位相依,決定權在主腦/使用者,不該由這批順手帶進來)。
//
// 所以這支腳本用 esbuild(專案本來就有,Vite 的相依)把 Deno 測試檔打包成 Node 可以執行的
// ESM,並用最小的 shim 補上三樣 Deno 專有的東西:
//   1. `Deno.test(...)`        → 收集成一個陣列,最後統一執行
//   2. `Deno.env.get/set`      → 一個 Map(測試要靠它控制 SUPABASE_URL / VAPID_* 這些環境變數)
//   3. `jsr:@std/assert` 的 assertEquals / assert → 轉接到 node:assert 的 deepStrictEqual
//
// ⚠️ 這個 shim **不是** Deno 的完整替代品。它能跑的前提是:被測的程式碼只用到標準 Web API
//    (Request / Response / URL / crypto.randomUUID),而且所有外部相依都是可注入的
//    (`handleRequest(req, deps)`)。本模組的三個測試檔都是照這個前提寫的。
//    如果之後有人在 Edge Function 裡用了 Deno 專有 API(Deno.readFile、Deno.serve 之類),
//    這支腳本會直接報錯 —— 那時候就是該裝 deno 的時候了,不要硬改這個 shim。
//
// 用法:
//     npm run test:edge
//     node scripts/run-edge-function-tests.mjs supabase/functions/push-send-test/index.test.ts
//
// 不帶參數時,會自動掃 supabase/functions/ 底下全部的 *.test.ts。
// =========================================================================

import { build } from "esbuild";
import { readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FUNCTIONS_DIR = "supabase/functions";

function findTestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    // node_modules 底下是 Deno 自己抓下來的相依快取,不是我們的測試。
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...findTestFiles(full));
    else if (entry.endsWith(".test.ts")) found.push(full);
  }
  return found;
}

const targets = process.argv.slice(2);
const testFiles = targets.length > 0 ? targets : findTestFiles(FUNCTIONS_DIR);

if (testFiles.length === 0) {
  console.error(`在 ${FUNCTIONS_DIR} 底下找不到任何 *.test.ts`);
  process.exit(1);
}

// Deno 專有的 URL/jsr/npm import,在 Node 這一側各自換成一個最小替身。
// ⚠️ supabase-js 與 web-push 的替身故意「一被呼叫就丟錯」:Edge Function 的測試一律靠
//    handleRequest(req, deps) 注入假的 client/sendPush,**不應該**有任何測試真的去建連線或打 FCM。
//    如果哪天有測試不小心走到真的路徑,這裡會立刻用一句看得懂的話炸掉,而不是靜默對外發請求。
const SHIM_MODULES = {
  "jsr:@std/assert": `
    import { deepStrictEqual } from "node:assert";
    export function assertEquals(actual, expected, msg) { deepStrictEqual(actual, expected, msg); }
    export function assert(cond, msg) { if (!cond) throw new Error(msg || "assert failed"); }
    export function assertExists(v, msg) {
      if (v === null || v === undefined) throw new Error(msg || "expected a value");
    }
  `,
  // 只是型別宣告的 side-effect import,Node 這一側什麼都不用做。
  "jsr:@supabase/functions-js": `export {};`,
  "https://esm.sh/@supabase/supabase-js": `
    export function createClient() {
      throw new Error(
        "[run-edge-function-tests] 測試不應該建立真正的 Supabase client —— " +
        "請用 handleRequest(req, deps) 注入假的 createCallerClient/createAdminClient。",
      );
    }
  `,
  "npm:web-push": `
    export default {
      sendNotification() {
        throw new Error(
          "[run-edge-function-tests] 測試不應該真的送出推播 —— 請注入假的 sendPush。",
        );
      },
      setVapidDetails() {},
    };
  `,
};

const denoImportShim = {
  name: "deno-import-shim",
  setup(b) {
    b.onResolve({ filter: /^(jsr:|npm:|https?:)/ }, (args) => {
      const key = Object.keys(SHIM_MODULES).find((prefix) => args.path.startsWith(prefix));
      if (!key) {
        return {
          errors: [
            {
              text:
                `這支腳本沒有為 "${args.path}" 準備替身。` +
                "請在 scripts/run-edge-function-tests.mjs 的 SHIM_MODULES 補上," +
                "或改用真正的 `deno test`。",
            },
          ],
        };
      }
      return { path: key, namespace: "deno-shim" };
    });
    b.onLoad({ filter: /.*/, namespace: "deno-shim" }, (args) => ({
      contents: SHIM_MODULES[args.path],
      loader: "js",
    }));
  },
};

/** 在 bundle 最前面注入 Deno 全域物件的最小實作。 */
const DENO_PRELUDE = `
globalThis.__denoTests = [];
globalThis.__denoEnv = new Map();
globalThis.Deno = {
  test: (a, b) => {
    if (typeof a === "string") globalThis.__denoTests.push({ name: a, fn: b });
    else globalThis.__denoTests.push({ name: a.name, fn: a.fn });
  },
  env: {
    get: (key) => globalThis.__denoEnv.get(key),
    set: (key, value) => globalThis.__denoEnv.set(key, String(value)),
    delete: (key) => globalThis.__denoEnv.delete(key),
  },
};
`;

const outDir = mkdtempSync(join(tmpdir(), "edge-fn-tests-"));
let passed = 0;
const failures = [];

try {
  for (const file of testFiles) {
    const outfile = join(outDir, `${Buffer.from(file).toString("hex")}.mjs`);
    await build({
      entryPoints: [resolve(file)],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      outfile,
      plugins: [denoImportShim],
      banner: { js: DENO_PRELUDE },
      logLevel: "error",
    });

    globalThis.__denoTests = [];
    await import(pathToFileURL(outfile).href);
    const tests = globalThis.__denoTests;

    console.log(`\n${file}  (${tests.length} tests)`);
    for (const t of tests) {
      try {
        await t.fn();
        passed += 1;
        console.log(`  ✓ ${t.name}`);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        failures.push({ file, name: t.name, message });
        console.log(`  ✗ ${t.name}`);
      }
    }
  }
} finally {
  try {
    rmSync(outDir, { recursive: true, force: true });
  } catch {
    // 暫存目錄清不掉不影響結果。
  }
}

console.log(`\nEdge Function tests: ${passed} passed, ${failures.length} failed`);
for (const f of failures) {
  console.log(`\nFAIL ${f.file} › ${f.name}`);
  console.log(
    f.message
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
}
process.exit(failures.length === 0 ? 0 : 1);
