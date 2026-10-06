// SPECS-INDEX #976 第 3 批(2026-10-06,表 C-4):「排班一覽」功能隱藏期間,/app/scheduling 對所有人(含商家管理員、
// 開過 scheduling 權限的客服)一律導回功能頁 /app/manage。
// 這支在 SCHEDULING_FEATURE_HIDDEN = true 時才有意義;還原功能(改成 false)時,這支會紅 —— 提醒同時改測試。
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

import { SCHEDULING_FEATURE_HIDDEN, SCHEDULING_HIDDEN_REDIRECT_TO } from "./featureVisibility";
import { RequireSchedulingAccess } from "./RequireSchedulingAccess";

function renderGuard() {
  render(
    <MemoryRouter initialEntries={["/app/scheduling"]}>
      <Routes>
        <Route
          path="/app/scheduling"
          element={
            <RequireSchedulingAccess>
              <p>排班一覽內容</p>
            </RequireSchedulingAccess>
          }
        />
        <Route path="/app/manage" element={<p>功能頁</p>} />
        <Route path="/app" element={<p>首頁</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RequireSchedulingAccess:排班一覽隱藏期間(#976 C-4)", () => {
  it("前提:功能目前是隱藏狀態,導回位置是功能頁", () => {
    expect(SCHEDULING_FEATURE_HIDDEN).toBe(true);
    expect(SCHEDULING_HIDDEN_REDIRECT_TO).toBe("/app/manage");
  });

  it("商家管理員打網址:導回功能頁,看不到內容", () => {
    roleMock.mockReturnValue({ data: "admin", isLoading: false });
    permissionMock.mockReturnValue({ data: null, isLoading: false });
    renderGuard();
    expect(screen.queryByText("排班一覽內容")).toBeNull();
    expect(screen.getByText("功能頁")).toBeTruthy();
  });

  it("開過 scheduling 權限的客服打網址:導回功能頁,看不到內容", () => {
    roleMock.mockReturnValue({ data: "agent", isLoading: false });
    permissionMock.mockReturnValue({ data: true, isLoading: false });
    renderGuard();
    expect(screen.queryByText("排班一覽內容")).toBeNull();
    expect(screen.getByText("功能頁")).toBeTruthy();
  });
});
