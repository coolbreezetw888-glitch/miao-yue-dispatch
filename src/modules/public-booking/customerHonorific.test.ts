// #1048 客戶端稱呼統一用「您」的守門測試。
//
// 為什麼要有這一支:使用者 2026-10-09 測 #1043 時發現「下一步會請你填寫電話。」用了「你」,
// 要求客人看得到的字一律用「您」(比較尊敬)。後台、客服、服務人員端對內用「你」沒關係,
// 所以這支只掃「客人看得到」的範圍:
//   1. src/modules/public-booking 底下所有非測試檔(公開預約頁、完成頁、LINE 登入、會員中心、聯絡人邀請)
//   2. 客人帳號誤闖後台時看到的 src/components/CustomerAccountBlocked.tsx
//   3. LINE 通知客人的預設文案(CUSTOMER_LINE_DEFAULT_TEMPLATES)與完成頁預設文字
//
// 程式註解不算(註解裡會引用舊字句當歷史沿革),所以先把註解換成空白再掃。
// 例外清單:目前沒有。之後真的需要例外,要寫在 ALLOWED 裡並寫明理由。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { CUSTOMER_LINE_DEFAULT_TEMPLATES } from "@/modules/line-notifications/customerLineSettingsLogic";
import {
  DEFAULT_GUEST_COMPLETION_MESSAGE as SETTINGS_DEFAULT_GUEST,
  DEFAULT_MEMBER_COMPLETION_MESSAGE as SETTINGS_DEFAULT_MEMBER,
} from "@/modules/merchant/onlineBookingSettingsLogic";

import {
  DEFAULT_GUEST_COMPLETION_MESSAGE,
  DEFAULT_MEMBER_ACCEPTED_COMPLETION_MESSAGE,
  DEFAULT_MEMBER_COMPLETION_MESSAGE,
  DEFAULT_MEMBER_COMPLETION_MESSAGE_LINE,
} from "./bookingSubmitLogic";

const FORBIDDEN = /[你妳]/;

/** 例外清單:`檔案:行內容片段` → 理由。目前沒有任何例外。 */
const ALLOWED: ReadonlyArray<{ file: string; snippet: string; reason: string }> = [];

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`找不到專案根目錄(從 ${process.cwd()} 往上找 package.json + src/ 都沒有)`);
}

const ROOT = findProjectRoot();

/** 把註解換成空白(保留換行與字串內容;跟 src/lib/terminologyGuard.test.ts 同一套逐字元掃法)。 */
function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  type Mode = "code" | "line" | "block" | "'" | '"' | "`";
  let mode: Mode = "code";
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line";
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        mode = "block";
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") mode = c;
      out.push(c);
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      out.push(c === "\n" ? "\n" : " ");
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code";
        out.push("  ");
        i += 2;
        continue;
      }
      out.push(c === "\n" ? "\n" : " ");
      i += 1;
      continue;
    }
    if (c === "\\") {
      out.push(c, next ?? "");
      i += 2;
      continue;
    }
    if (c === mode) mode = "code";
    out.push(c);
    i += 1;
  }
  return out.join("");
}

function customerFacingFiles(): string[] {
  const dir = join(ROOT, "src", "modules", "public-booking");
  const files = readdirSync(dir)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(dir, f));
  files.push(join(ROOT, "src", "components", "CustomerAccountBlocked.tsx"));
  return files;
}

describe("#1048 客戶端稱呼統一用「您」", () => {
  it("掃描範圍有抓到檔案(防止掃描機制壞掉造成假性通過)", () => {
    const files = customerFacingFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("PublicBookingPage.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("MemberCenterPage.tsx"))).toBe(true);
  });

  it("註解會被排除、字串會被保留", () => {
    const stripped = stripComments('// 你好\nconst a = "https://x"; const b = "你";').split("\n");
    expect(stripped[0]!.trim()).toBe("");
    expect(stripped[1]).toContain("你");
  });

  it("客人看得到的字(排除註解)沒有「你」「妳」", () => {
    const violations: string[] = [];
    for (const file of customerFacingFiles()) {
      const rel = relative(ROOT, file).split("\\").join("/");
      stripComments(readFileSync(file, "utf8"))
        .split("\n")
        .forEach((line, index) => {
          if (!FORBIDDEN.test(line)) return;
          if (ALLOWED.some((a) => a.file === rel && line.includes(a.snippet))) return;
          violations.push(`  ${rel}:${index + 1} → ${line.trim().slice(0, 120)}`);
        });
    }
    expect(violations, `客戶端一律稱呼「您」(#1048):\n${violations.join("\n")}`).toEqual([]);
  });

  it("公開預約頁/會員中心的出錯畫面(ErrorState)一律帶 honorific,顯示「您的資料沒有遺失」", () => {
    const missing: string[] = [];
    for (const file of customerFacingFiles()) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!/<ErrorState(\s|$)/.test(line)) return;
        const tag = lines.slice(index, index + 8).join("\n");
        if (!/\bhonorific\b/.test(tag)) missing.push(`${relative(ROOT, file)}:${index + 1}`);
      });
    }
    expect(missing).toEqual([]);
  });

  it("LINE 通知客人的預設文案、完成頁預設文字都用「您」", () => {
    const texts: Array<[string, string]> = [
      ...Object.entries(CUSTOMER_LINE_DEFAULT_TEMPLATES),
      ["DEFAULT_MEMBER_COMPLETION_MESSAGE", DEFAULT_MEMBER_COMPLETION_MESSAGE],
      ["DEFAULT_MEMBER_COMPLETION_MESSAGE_LINE", DEFAULT_MEMBER_COMPLETION_MESSAGE_LINE],
      ["DEFAULT_MEMBER_ACCEPTED_COMPLETION_MESSAGE", DEFAULT_MEMBER_ACCEPTED_COMPLETION_MESSAGE],
      ["DEFAULT_GUEST_COMPLETION_MESSAGE", DEFAULT_GUEST_COMPLETION_MESSAGE],
      ["settings DEFAULT_MEMBER_COMPLETION_MESSAGE", SETTINGS_DEFAULT_MEMBER],
      ["settings DEFAULT_GUEST_COMPLETION_MESSAGE", SETTINGS_DEFAULT_GUEST],
    ];
    expect(texts.filter(([, t]) => FORBIDDEN.test(t)).map(([k]) => k)).toEqual([]);
  });

  it("含 {{merchant_phone}} 的句子仍然自己一行(5-B 規則沒被改字破壞)", () => {
    for (const template of Object.values(CUSTOMER_LINE_DEFAULT_TEMPLATES)) {
      for (const line of template.split("\n")) {
        if (!line.includes("{{merchant_phone}}")) continue;
        // 同一行只能是「…請聯絡店家：{{merchant_phone}}」這一句,不能跟別的句子擠在一起
        expect(line.endsWith("{{merchant_phone}}")).toBe(true);
        expect(line.split("。").length).toBe(1);
      }
    }
  });
});
