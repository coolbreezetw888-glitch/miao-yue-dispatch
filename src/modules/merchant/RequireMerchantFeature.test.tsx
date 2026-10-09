// SPECS-INDEX #1025 功能開關 FG1-T03:RequireMerchantFeature 三種狀態(T10)。
//
//   1. 開(true)⇒ 顯示內容
//   2. 關(false)⇒ 導回 /app/manage(或指定的 redirectTo),不顯示內容、不跳任何提示
//   3. 讀取中(undefined)⇒ 只顯示骨架,不導、不顯示內容
//   4. 讀取失敗 ⇒ 骨架 + 錯誤提示(可重試),不導、不顯示內容

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  status: undefined as boolean | undefined,
  isError: false,
  refetch: vi.fn(),
}));

vi.mock("./features", () => ({
  useMerchantFeatures: () => ({
    features: undefined,
    hasFeature: () => state.status,
    isLoading: state.status === undefined && !state.isError,
    isError: state.isError,
    refetch: state.refetch,
  }),
}));

const { RequireMerchantFeature } = await import("./RequireMerchantFeature");

function renderAt(path: string, redirectTo?: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/app/data-import"
          element={
            redirectTo ? (
              <RequireMerchantFeature featureKey="data_import" redirectTo={redirectTo}>
                <p>匯入頁內容</p>
              </RequireMerchantFeature>
            ) : (
              <RequireMerchantFeature featureKey="data_import">
                <p>匯入頁內容</p>
              </RequireMerchantFeature>
            )
          }
        />
        <Route path="/app/manage" element={<p>功能頁</p>} />
        <Route path="/app/other" element={<p>別的頁</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  state.status = undefined;
  state.isError = false;
});

describe("RequireMerchantFeature", () => {
  it("開 ⇒ 顯示內容", () => {
    state.status = true;
    renderAt("/app/data-import");
    expect(screen.getByText("匯入頁內容")).toBeInTheDocument();
  });

  it("關 ⇒ 導回功能頁,內容不出現", () => {
    state.status = false;
    renderAt("/app/data-import");
    expect(screen.getByText("功能頁")).toBeInTheDocument();
    expect(screen.queryByText("匯入頁內容")).not.toBeInTheDocument();
  });

  it("關 ⇒ 有指定 redirectTo 時導到那裡", () => {
    state.status = false;
    renderAt("/app/data-import", "/app/other");
    expect(screen.getByText("別的頁")).toBeInTheDocument();
  });

  it("讀取中 ⇒ 只有骨架:不導、不顯示內容", () => {
    state.status = undefined;
    renderAt("/app/data-import");
    expect(screen.getByLabelText("載入中")).toBeInTheDocument();
    expect(screen.queryByText("匯入頁內容")).not.toBeInTheDocument();
    expect(screen.queryByText("功能頁")).not.toBeInTheDocument();
  });

  it("讀取失敗 ⇒ 骨架 + 錯誤提示:不導、不顯示內容", () => {
    state.status = undefined;
    state.isError = true;
    renderAt("/app/data-import");
    expect(screen.getByTestId("merchant-feature-guard-error")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("讀不到這個頁面的設定");
    expect(screen.queryByText("匯入頁內容")).not.toBeInTheDocument();
    expect(screen.queryByText("功能頁")).not.toBeInTheDocument();
  });
});
