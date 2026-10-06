// SPECS-INDEX #976 第 3 批(2026-10-06):「再行銷通知」頁守衛。改前只給商家管理員,新增 line_marketing 客服權限。
// 驗:管理員進得去;line_marketing=true 的客服進得去;沒開(含只開 line_notification)的客服導回 /app;
// 載入中不先閃出內容(fail-closed)。
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const roleMock = vi.fn();
const permissionMock = vi.fn();

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "m1" }, isLoading: false }),
}));
vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => roleMock(),
  useAgentPermission: (key: string) => permissionMock(key),
}));

import { RequireLineMarketingAccess } from "./RequireLineMarketingAccess";

function renderGuard() {
  render(
    <MemoryRouter initialEntries={["/app/line-marketing"]}>
      <Routes>
        <Route
          path="/app/line-marketing"
          element={
            <RequireLineMarketingAccess>
              <p>再行銷通知內容</p>
            </RequireLineMarketingAccess>
          }
        />
        <Route path="/app" element={<p>首頁</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RequireLineMarketingAccess(#976 第 3 批)", () => {
  it("商家管理員:進得去", () => {
    roleMock.mockReturnValue({ data: "admin", isLoading: false });
    permissionMock.mockReturnValue({ data: null, isLoading: false });
    renderGuard();
    expect(screen.getByText("再行銷通知內容")).toBeTruthy();
  });

  it("客服且 line_marketing 開啟:進得去,而且查的就是 line_marketing 這把鑰匙", () => {
    roleMock.mockReturnValue({ data: "agent", isLoading: false });
    permissionMock.mockImplementation((key: string) => ({
      data: key === "line_marketing",
      isLoading: false,
    }));
    renderGuard();
    expect(screen.getByText("再行銷通知內容")).toBeTruthy();
    expect(permissionMock).toHaveBeenCalledWith("line_marketing");
  });

  it("客服沒開 line_marketing(只開 line_notification 也一樣):導回首頁", () => {
    roleMock.mockReturnValue({ data: "agent", isLoading: false });
    permissionMock.mockImplementation((key: string) => ({
      data: key === "line_notification",
      isLoading: false,
    }));
    renderGuard();
    expect(screen.queryByText("再行銷通知內容")).toBeNull();
    expect(screen.getByText("首頁")).toBeTruthy();
  });

  it("客服權限還在載入:不先閃出內容", () => {
    roleMock.mockReturnValue({ data: "agent", isLoading: false });
    permissionMock.mockReturnValue({ data: undefined, isLoading: true });
    renderGuard();
    expect(screen.queryByText("再行銷通知內容")).toBeNull();
    expect(screen.queryByText("首頁")).toBeNull();
  });

  it("服務人員角色:導回首頁", () => {
    roleMock.mockReturnValue({ data: "staff", isLoading: false });
    permissionMock.mockReturnValue({ data: null, isLoading: false });
    renderGuard();
    expect(screen.queryByText("再行銷通知內容")).toBeNull();
    expect(screen.getByText("首頁")).toBeTruthy();
  });
});
