// SPECS-INDEX #925 整合測試:資料匯入精靈的兩個 CSV 下載點
//   ① 「下載失敗清單 CSV」(使用者自己上傳的原始資料被原樣退回,最容易夾帶 = + - @ 開頭的值)
//   ② 「下載 CSV 模板」(會員 / 歷史訂單)
// 都經過 src/lib/csv.ts 的共用跳脫;而且失敗清單「下載 → 再匯入」不會讓資料多 / 少一個單引號。
//
// 【故障注入】拿掉 neutralizeCsvFormula 的判斷 → ① 的「補單引號」那條轉紅。
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyColumnMapping, parseCsvText } from "@/lib/csv";

import { buildFailedRowsCsv } from "./failedRowsCsv";

const { downloadMock, buildSpy } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  buildSpy: vi.fn(),
}));

vi.mock("@/lib/csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/csv")>();
  return {
    ...actual,
    downloadCsv: downloadMock,
    buildCsvContent: (...args: Parameters<typeof actual.buildCsvContent>) => {
      buildSpy(...args);
      return actual.buildCsvContent(...args);
    },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("./RequireDataImportAccess", () => ({
  RequireDataImportAccess: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "m1", name: "測試商家" }, isLoading: false }),
}));
vi.mock("@/modules/staff-agent/context", () => ({
  useMerchantStaffList: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/modules/staff-agent/api", () => ({ addMerchantStaff: vi.fn() }));
vi.mock("./api", () => ({
  importHistoricalBookingsBatch: vi.fn(),
  importMembersBatch: vi.fn(),
  parseErrorReport: vi.fn(() => []),
}));

import ImportWizardPage from "./ImportWizardPage";

afterEach(() => {
  cleanup();
  downloadMock.mockReset();
  buildSpy.mockReset();
});

describe("匯入失敗清單 CSV(#925)", () => {
  const failed = [
    {
      name: '=HYPERLINK("http://evil")',
      phone: "+886912345678",
      notes: "-備註,有逗號",
      starting_points_balance: -100,
      row_number: 3,
    },
  ];

  it("字串欄位補單引號;number 型別(點數 -100、列號)維持原樣", () => {
    const csv = buildFailedRowsCsv(failed);
    const [header, line] = csv.slice(1).split("\r\n"); // 第一個字元是 UTF-8 BOM
    expect(header).toBe("name,phone,notes,starting_points_balance,row_number");
    expect(line).toBe(`"'=HYPERLINK(""http://evil"")",'+886912345678,"'-備註,有逗號",-100,3`);
  });

  it("下載 → 再匯入:讀回來的每一格跟使用者當初上傳的值完全相同(不多也不少一個單引號)", () => {
    const parsed = parseCsvText(buildFailedRowsCsv(failed));
    const mapped = applyColumnMapping(parsed.headers, parsed.rows, {
      name: "name",
      phone: "phone",
      notes: "notes",
      starting_points_balance: "starting_points_balance",
    });
    expect(mapped).toEqual([
      {
        name: '=HYPERLINK("http://evil")',
        phone: "+886912345678",
        notes: "-備註,有逗號",
        starting_points_balance: "-100",
      },
    ]);
  });

  it("ImportWizardPage 的「下載失敗清單」按鈕確實呼叫這支(原始碼守門)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "ImportWizardPage.tsx"), "utf8");
    expect(src).toMatch(
      /downloadCsv\("匯入失敗清單\.csv",\s*buildFailedRowsCsv\(rawFailedRows\)\)/,
    );
  });
});

describe("下載 CSV 模板(#925:同樣經過共用 builder)", () => {
  it.each(["會員資料", "歷史訂單"])(
    "%s模板:經過 @/lib/csv 的 buildCsvContent 才下載",
    async (kind) => {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <ImportWizardPage />
        </MemoryRouter>,
      );
      await user.click(screen.getByRole("button", { name: kind }));
      await user.click(screen.getByRole("button", { name: "下載 CSV 模板" }));
      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(downloadMock).toHaveBeenCalledTimes(1);
      expect(downloadMock.mock.calls[0]?.[0]).toMatch(/匯入模板\.csv$/);
    },
  );
});
