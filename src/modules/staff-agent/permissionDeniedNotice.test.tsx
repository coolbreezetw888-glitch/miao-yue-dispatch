// SPECS-INDEX #1007(第 14 批,#976 報表回饋):沒有權限被路由守衛導回功能頁時要跳提示。
//   ・純函式:文字(全形標點)、權限名稱對照、什麼身分才提示
//   ・守衛實測:只開「店家報表」的客服進「服務人員報表」⇒ 導回 /app + 提示;管理員 / 有權限的客服不提示
//   ・原始碼守門:每一個「沒權限就 navigate('/app')」的守衛都要接上提示,之後新增守衛忘了接會紅
import { cleanup, render } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastSpy = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastSpy, Toaster: () => null }));

const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", () => ({ useNavigate: () => navigateSpy }));

const state = vi.hoisted(() => ({
  merchant: { id: "m1" } as { id: string } | null,
  role: "agent" as string | null,
  permission: false as boolean | undefined,
}));
vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: state.merchant, isLoading: false }),
}));
vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => ({ data: state.role, isLoading: false }),
  useAgentPermission: () => ({ data: state.permission, isLoading: false }),
}));
vi.mock("@/components/patterns", () => ({ GuardLoading: () => null }));

import { RequireStaffReportAccess } from "@/modules/payroll/RequireStaffReportAccess";

import {
  agentPermissionLabel,
  permissionDeniedMessage,
  shouldNotifyPermissionDenied,
} from "./permissionDeniedNotice";

function Child(): ReactNode {
  return <p>報表內容</p>;
}

beforeEach(() => {
  state.merchant = { id: "m1" };
  state.role = "agent";
  state.permission = false;
  toastSpy.error.mockClear();
  navigateSpy.mockClear();
});
afterEach(cleanup);

describe("permissionDeniedNotice 純函式", () => {
  it("文字照使用者指定的句型,全形標點", () => {
    expect(permissionDeniedMessage("服務人員報表")).toBe(
      "你沒有「服務人員報表」的權限，如需使用請聯絡商家管理員。",
    );
  });
  it("權限名稱取客服權限設定頁上的同一份名稱", () => {
    expect(agentPermissionLabel("staff_report")).toBe("服務人員報表");
    expect(agentPermissionLabel("billing")).toBe("店家報表");
    expect(agentPermissionLabel("orders")).toBe("訂單管理");
  });
  it("只有「選定商家 + 客服」才提示", () => {
    expect(shouldNotifyPermissionDenied({ hasMerchant: true, role: "agent" })).toBe(true);
    expect(shouldNotifyPermissionDenied({ hasMerchant: false, role: "agent" })).toBe(false);
    expect(shouldNotifyPermissionDenied({ hasMerchant: true, role: "staff" })).toBe(false);
    expect(shouldNotifyPermissionDenied({ hasMerchant: true, role: null })).toBe(false);
  });
});

describe("RequireStaffReportAccess(#976 使用者回報的那一頁)", () => {
  it("🔴 只開店家報表的客服 ⇒ 導回 /app,並跳「你沒有「服務人員報表」的權限」", () => {
    render(
      <RequireStaffReportAccess>
        <Child />
      </RequireStaffReportAccess>,
    );
    expect(navigateSpy).toHaveBeenCalledWith("/app", { replace: true });
    expect(toastSpy.error).toHaveBeenCalledWith(
      "你沒有「服務人員報表」的權限，如需使用請聯絡商家管理員。",
      { id: "permission-denied:服務人員報表" },
    );
  });
  it("有權限的客服、管理員 ⇒ 不導回、不提示", () => {
    state.permission = true;
    render(
      <RequireStaffReportAccess>
        <Child />
      </RequireStaffReportAccess>,
    );
    state.role = "admin";
    state.permission = false;
    render(
      <RequireStaffReportAccess>
        <Child />
      </RequireStaffReportAccess>,
    );
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(toastSpy.error).not.toHaveBeenCalled();
  });
  it("還沒選定商家 ⇒ 照舊安靜導回(不說「你沒有權限」)", () => {
    state.merchant = null;
    render(
      <RequireStaffReportAccess>
        <Child />
      </RequireStaffReportAccess>,
    );
    expect(navigateSpy).toHaveBeenCalledWith("/app", { replace: true });
    expect(toastSpy.error).not.toHaveBeenCalled();
  });
});

describe("原始碼守門:每一個「沒權限就導回 /app」的守衛都要接上提示", () => {
  function listRequireGuards(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...listRequireGuards(full));
      else if (/^Require\w+\.tsx$/.test(name)) out.push(full);
    }
    return out;
  }
  it('Require*.tsx 只要有 navigate("/app"),就要呼叫 notifyPermissionDenied', () => {
    const root = join(process.cwd(), "src", "modules");
    const guards = listRequireGuards(root).filter((f) =>
      readFileSync(f, "utf-8").includes('navigate("/app", { replace: true })'),
    );
    // 目前 19 支(17 支看客服權限 + RequireMerchantAdmin + RequireDataImportAccess)。
    expect(guards.length).toBeGreaterThanOrEqual(19);
    const missing = guards.filter(
      (f) => !readFileSync(f, "utf-8").includes("notifyPermissionDenied("),
    );
    expect(missing).toEqual([]);
  });
});
