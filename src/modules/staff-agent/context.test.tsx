// 模組 14(服務人員端)規則 2.10:useMerchantRole 判斷順序(admin > agent > staff)的專屬測試。
// 對應規格書第七節測試規劃「規則 2.10 角色優先權:Vitest(涵蓋四種身份組合的判斷順序正確)」。
// pgTAP 那一半(同一 user_id 同時是商家 A 服務人員、商家 B 管理員時,對兩間商家分別查詢角色
// 正確不互相干擾)見 supabase/tests/database/module14_03_role_priority.sql。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MerchantRole } from "./types";

const getVerifiedUserMock = vi.fn();
const amIMerchantAdminMock = vi.fn();
const fetchMyAgentRowMock = vi.fn();
const fetchMyStaffRowMock = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getVerifiedUser: (...args: unknown[]) => getVerifiedUserMock(...args),
}));

vi.mock("./api", () => ({
  amIMerchantAdmin: (...args: unknown[]) => amIMerchantAdminMock(...args),
  fetchMyAgentRow: (...args: unknown[]) => fetchMyAgentRowMock(...args),
  fetchMyStaffRow: (...args: unknown[]) => fetchMyStaffRowMock(...args),
}));

// vi.mock 呼叫會被 vitest 提升到檔案最頂端執行,所以這裡用一般的靜態 import 就能拿到套用
// 上面 mock 之後的 useMerchantRole,不需要動態 import。
import { useMerchantRole } from "./context";

function Probe({
  merchantId,
  onResult,
}: {
  merchantId: string;
  onResult: (role: MerchantRole | undefined) => void;
}) {
  const { data } = useMerchantRole(merchantId);
  onResult(data);
  return null;
}

describe("useMerchantRole — 規則 2.10 角色優先權(admin > agent > staff)", () => {
  beforeEach(() => {
    getVerifiedUserMock.mockReset();
    amIMerchantAdminMock.mockReset();
    fetchMyAgentRowMock.mockReset();
    fetchMyStaffRowMock.mockReset();
    getVerifiedUserMock.mockResolvedValue({ id: "user-1" });
  });

  async function renderRole(merchantId: string): Promise<MerchantRole | undefined> {
    const queryClient = new QueryClient();
    let captured: MerchantRole | undefined;

    render(
      <QueryClientProvider client={queryClient}>
        <Probe merchantId={merchantId} onResult={(r) => (captured = r)} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(captured).not.toBeUndefined());
    return captured;
  }

  it("同時是 admin + agent + staff 時,一律回傳 'admin'(最高優先權)", async () => {
    amIMerchantAdminMock.mockResolvedValue(true);
    fetchMyAgentRowMock.mockResolvedValue({ status: "active" });
    fetchMyStaffRowMock.mockResolvedValue({ status: "active", login_status: "active" });

    const role = await renderRole("merchant-a");
    expect(role).toBe("admin");
  });

  it("不是 admin,但同時是 agent(active) + staff(active) 時,回傳 'agent'", async () => {
    amIMerchantAdminMock.mockResolvedValue(false);
    fetchMyAgentRowMock.mockResolvedValue({ status: "active" });
    fetchMyStaffRowMock.mockResolvedValue({ status: "active", login_status: "active" });

    const role = await renderRole("merchant-b");
    expect(role).toBe("agent");
  });

  it("不是 admin、agent 已被移除(或查無資料),但 staff 是 active+active 時,回傳 'staff'", async () => {
    amIMerchantAdminMock.mockResolvedValue(false);
    fetchMyAgentRowMock.mockResolvedValue(null);
    fetchMyStaffRowMock.mockResolvedValue({ status: "active", login_status: "active" });

    const role = await renderRole("merchant-c");
    expect(role).toBe("staff");
  });

  it("四者都不符合(不是 admin/agent/有效服務人員)時,回傳 null", async () => {
    amIMerchantAdminMock.mockResolvedValue(false);
    fetchMyAgentRowMock.mockResolvedValue(null);
    fetchMyStaffRowMock.mockResolvedValue(null);

    const role = await renderRole("merchant-d");
    expect(role).toBeNull();
  });

  it("staff 紀錄存在但 status=removed 時,不算有效服務人員,回傳 null(規則 2.9 的前提條件)", async () => {
    amIMerchantAdminMock.mockResolvedValue(false);
    fetchMyAgentRowMock.mockResolvedValue(null);
    fetchMyStaffRowMock.mockResolvedValue({ status: "removed", login_status: "active" });

    const role = await renderRole("merchant-e");
    expect(role).toBeNull();
  });

  it("staff 紀錄存在但 login_status 尚未 active(邀請中)時,不算有效服務人員,回傳 null", async () => {
    amIMerchantAdminMock.mockResolvedValue(false);
    fetchMyAgentRowMock.mockResolvedValue(null);
    fetchMyStaffRowMock.mockResolvedValue({ status: "active", login_status: "invited" });

    const role = await renderRole("merchant-f");
    expect(role).toBeNull();
  });
});
