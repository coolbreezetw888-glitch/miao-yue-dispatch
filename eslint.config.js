import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      ".output",
      ".vinxi",
      // .claude/ 底下放的是 Claude Code 的設定、skills、以及 git worktree 的暫存副本
      // (.claude/worktrees/ 每一份都是一整套原始碼複本)。那些副本不是專案原始碼,
      // 掃進來會讓 lint 結果暴增到幾十萬筆、把真正的訊號整個淹沒。
      ".claude",
      // Supabase CLI 依照資料庫 schema 自動產生的型別檔,每次重新產生都會蓋掉手動調整,
      // 不該納入 lint/format。同步也寫進 .prettierignore。
      "src/integrations/supabase/types.ts",
      // ─────────────────────────────────────────────────────────────────
      // #713(2026-09-25):Supabase Edge Function 是 **Deno** 執行環境,不是這個專案的
      // Vite/Node 環境 —— 它用 `https://esm.sh/...` / `npm:` / `jsr:` 這種 URL import,
      // 而且**有自己的 linter**(`deno lint`,設定在 supabase/functions/deno.json)。
      //
      // 為什麼一定要排除:那些檔案裡的 `// deno-lint-ignore no-explicit-any` 是 Deno 的指令,
      // ESLint 根本不認得,於是同一行同時被兩套 linter 檢查 —— Deno 放行、ESLint 報
      // `@typescript-eslint/no-explicit-any` 錯誤。過去之所以沒人發現,是因為派工時都寫
      // `npx eslint src e2e`(只掃兩個資料夾),`npx eslint .` 一跑就會冒出 6 個 error。
      //
      // 這次的重點不是消掉那 6 個 error,是讓 **`npx eslint .` 變成一個可信的單一指令** ——
      // 不用再靠人記得「這次要掃哪幾個資料夾」。package.json 的 `npm run lint` 就是 `eslint .`。
      //
      // ⚠️ 排除不等於沒人檢查:supabase/functions/** 由 `deno lint` / `deno check` 負責。
      "supabase/functions/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // 測試框架的設定檔跟 Playwright e2e 測試都是在 Node 環境下執行(不是瀏覽器),
    // 需要 process/__dirname 這類 Node 全域變數,見 .claude/skills/automated-testing/SKILL.md。
    files: ["*.config.ts", "e2e/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  eslintPluginPrettier,
);
