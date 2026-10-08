// SPECS-INDEX #1024(第 22 批):可預約時段清單直接調開始 / 結束時間。
//   ・沒改 ⇒ 右邊只有「刪除」;改了 ⇒「還原」+「儲存」
//   ・儲存 ⇒ updateStaffAvailabilityWindow(同一列 id,新時間)+ 重抓
//   ・重疊 / 倒置 ⇒ 欄位框變紅 + `!` 說明、儲存不能按、不送出
//   ・onDirtyChange:改了 true、還原 / 儲存成功後 false
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ updateStaffAvailabilityWindow: vi.fn() }));
vi.mock("./api", () => ({ updateStaffAvailabilityWindow: api.updateStaffAvailabilityWindow }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AvailabilityWindowEditList } from "./AvailabilityWindowEditList";
import type { StaffAvailabilityWindow } from "./types";

const WINDOWS = [
  { id: "w-1", staff_id: "s", day_of_week: 1, start_time: "09:00:00", end_time: "12:00:00" },
  { id: "w-2", staff_id: "s", day_of_week: 1, start_time: "14:00:00", end_time: "16:00:00" },
] as unknown as StaffAvailabilityWindow[];

beforeEach(() => {
  api.updateStaffAvailabilityWindow.mockReset();
  api.updateStaffAvailabilityWindow.mockResolvedValue(WINDOWS[0]);
});
afterEach(() => cleanup());

function setup() {
  const onChanged = vi.fn(async () => undefined);
  const onRemove = vi.fn();
  const onDirtyChange = vi.fn();
  render(
    <AvailabilityWindowEditList
      windows={WINDOWS}
      onChanged={onChanged}
      onRemove={onRemove}
      onDirtyChange={onDirtyChange}
    />,
  );
  return { onChanged, onRemove, onDirtyChange };
}

describe("AvailabilityWindowEditList(#1024)", () => {
  it("沒改 ⇒ 只有「刪除」,欄位帶目前存著的時間", () => {
    const { onRemove } = setup();
    expect(screen.getByText("星期一 09:00 - 12:00")).toBeTruthy();
    expect(
      (screen.getByLabelText("星期一 09:00 - 12:00的開始時間") as HTMLInputElement).value,
    ).toBe("09:00");
    expect(screen.queryByRole("button", { name: /^儲存/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "刪除星期一 09:00 - 12:00" }));
    expect(onRemove).toHaveBeenCalledWith("w-1");
  });

  it("改時間 ⇒ 儲存送同一列 id 的新時間、重抓、dirty 回 false", async () => {
    const { onChanged, onDirtyChange } = setup();
    fireEvent.change(screen.getByLabelText("星期一 09:00 - 12:00的結束時間"), {
      target: { value: "13:00" },
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole("button", { name: "刪除星期一 09:00 - 12:00" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "儲存星期一 09:00 - 12:00" }));
    });
    expect(api.updateStaffAvailabilityWindow).toHaveBeenCalledWith("w-1", {
      startTime: "09:00",
      endTime: "13:00",
    });
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("跟同一天另一組重疊 ⇒ `!` 說明、儲存不能按、不送出", () => {
    setup();
    fireEvent.change(screen.getByLabelText("星期一 09:00 - 12:00的結束時間"), {
      target: { value: "15:00" },
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "這個時段跟同一天已設定的「14:00–16:00」重疊，請調整時間。",
    );
    const save = screen.getByRole("button", { name: "儲存星期一 09:00 - 12:00" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(api.updateStaffAvailabilityWindow).not.toHaveBeenCalled();
  });

  it("開始晚於結束 ⇒ 擋;按「還原」回到原值、dirty false", () => {
    const { onDirtyChange } = setup();
    fireEvent.change(screen.getByLabelText("星期一 14:00 - 16:00的開始時間"), {
      target: { value: "17:00" },
    });
    expect(screen.getByRole("alert").textContent).toContain("開始時間必須早於結束時間");
    fireEvent.click(screen.getByRole("button", { name: "還原星期一 14:00 - 16:00" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (screen.getByLabelText("星期一 14:00 - 16:00的開始時間") as HTMLInputElement).value,
    ).toBe("14:00");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("改回原值 = 沒改(不出現儲存)", () => {
    setup();
    const input = screen.getByLabelText("星期一 09:00 - 12:00的開始時間");
    fireEvent.change(input, { target: { value: "10:00" } });
    fireEvent.change(input, { target: { value: "09:00" } });
    expect(screen.queryByRole("button", { name: /^儲存/ })).toBeNull();
  });

  it("儲存失敗(例:資料庫擋下)⇒ 草稿留著、dirty 仍 true", async () => {
    api.updateStaffAvailabilityWindow.mockRejectedValue(new Error("x"));
    const { onDirtyChange } = setup();
    fireEvent.change(screen.getByLabelText("星期一 09:00 - 12:00的結束時間"), {
      target: { value: "13:00" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "儲存星期一 09:00 - 12:00" }));
    });
    expect(
      (screen.getByLabelText("星期一 09:00 - 12:00的結束時間") as HTMLInputElement).value,
    ).toBe("13:00");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });
});
