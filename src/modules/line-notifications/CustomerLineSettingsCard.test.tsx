// 客戶端第 5 批(C5-K01 / K02;5-B 加 Q01 / Q02、提醒時數):後台「LINE 通知事件」頁的「通知客人」卡
// (沒接上 / 正常 / 客服視角、開關立即儲存與失敗退回、範本編輯與恢復預設、本月額度、每月上限只有管理員),
// 以及店家事件卡不再有「會員」勾選、確認訂單彈窗只列店家這邊。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: null as unknown,
  updateCalls: [] as unknown[],
  updateError: null as unknown,
  role: "admin" as string,
  toasts: [] as string[],
  rpcCalls: [] as { fn: string; args: unknown }[],
  rpcData: null as unknown,
  quota: null as unknown,
  quotaError: null as unknown,
  invokeCalls: [] as { fn: string; body: unknown }[],
  capCalls: [] as unknown[],
  capError: null as unknown,
  usage: null as unknown,
  usageError: null as unknown,
}));

vi.mock("sonner", () => ({
  toast: Object.assign((msg: string) => state.toasts.push(msg), {
    success: (msg: string) => state.toasts.push(msg),
    error: (msg: string) => state.toasts.push(msg),
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(async (fn: string, args: unknown) => {
      state.rpcCalls.push({ fn, args });
      if (fn === "get_customer_line_settings") return { data: state.settings, error: null };
      if (fn === "update_customer_line_settings") {
        state.updateCalls.push(args);
        if (state.updateError) return { data: null, error: state.updateError };
        const patch = (args as { p_patch: Record<string, unknown> }).p_patch;
        const cur = state.settings as Record<string, Record<string, unknown>>;
        const templates = { ...(cur["templates"] ?? {}) };
        for (const [k, v] of Object.entries((patch["templates"] as Record<string, string>) ?? {})) {
          if (v === "" || v === null) delete templates[k];
          else templates[k] = v;
        }
        const { templates: _t, ...switches } = patch;
        state.settings = {
          ...cur,
          settings: { ...cur["settings"], ...switches },
          templates,
        };
        return { data: state.settings, error: null };
      }
      if (fn === "get_customer_line_usage") {
        if (state.usageError) return { data: null, error: state.usageError };
        return { data: state.usage, error: null };
      }
      if (fn === "set_customer_line_monthly_cap") {
        state.capCalls.push(args);
        if (state.capError) return { data: null, error: state.capError };
        const cur = state.settings as Record<string, Record<string, unknown>>;
        state.settings = {
          ...cur,
          settings: {
            ...cur["settings"],
            monthly_cap: (args as { p_monthly_cap: unknown }).p_monthly_cap,
          },
        };
        return { data: state.settings, error: null };
      }
      return { data: state.rpcData, error: null };
    }),
    functions: {
      invoke: vi.fn(async (fn: string, opts: { body: unknown }) => {
        state.invokeCalls.push({ fn, body: opts.body });
        if (state.quotaError) return { data: null, error: state.quotaError };
        return { data: state.quota, error: null };
      }),
    },
  },
}));

vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => ({ data: state.role }),
  useAgentPermission: () => ({ data: true }),
}));

const { CustomerLineSettingsCard } = await import("./CustomerLineSettingsCard");
const { ConfirmBookingLineDialog } = await import("./ConfirmBookingLineDialog");
const { fetchPendingLineNotificationPreview } = await import("./api");

function baseSettings(over: Record<string, unknown> = {}) {
  return {
    connected: true,
    line_login_enabled: true,
    is_on_site: false,
    is_admin: true,
    settings: {
      on_submitted: true,
      on_scheduled_by_store: false,
      on_confirmed: true,
      on_rescheduled: true,
      on_cancelled_by_store: true,
      on_cancelled_by_customer: true,
      on_reminder: false,
      on_completed: false,
      on_contact_events: true,
      reminder_hours_before: 24,
      monthly_cap: null,
      quota_blocked_until: null,
      updated_at: null,
    },
    templates: {},
    default_templates: {
      confirmed:
        "「{{merchant_name}}」已確認你的預約：\n{{booking_date}} {{booking_time}}\n服務人員：{{staff_name}}\n查看或取消：{{member_center_url}}",
    },
    ...over,
  };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CustomerLineSettingsCard
          merchantId="m1"
          merchantName="涼風工匠"
          merchantPhone="0223456789"
          bookingSlug="demo"
          isOnSite={false}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.settings = baseSettings();
  state.updateCalls = [];
  state.updateError = null;
  state.role = "admin";
  state.toasts = [];
  state.rpcCalls = [];
  state.rpcData = null;
  state.quota = {
    plan_limit: 200,
    used: 132,
    by_category: { customer: 80, store: 40, marketing: 12, birthday: 0 },
    cap: null,
    blocked_until: null,
  };
  state.quotaError = null;
  state.invokeCalls = [];
  state.capCalls = [];
  state.capError = null;
  state.usage = null;
  state.usageError = null;
});
afterEach(() => cleanup());

describe("C5-K02「通知客人」卡", () => {
  it("正常:9 種通知各一列(開關、何時發、大約用量、編輯文字);常駐額度說明;本月額度;管理員看得到上限", async () => {
    renderCard();
    const card = await screen.findByTestId("customer-line-card");
    await within(card).findByTestId("customer-line-kind-on_submitted");
    expect(within(card).getAllByRole("switch")).toHaveLength(9);
    expect(card).toHaveTextContent("收到線上預約");
    expect(card).toHaveTextContent("店家幫客人建了預約");
    expect(card).toHaveTextContent("客人取消時通知其他聯絡人");
    expect(within(card).getAllByTestId("customer-line-usage")[0]).toHaveTextContent(
      "大約用量：每筆預約 1 則；公司會員由第二聯絡人下單時 2 則。",
    );
    expect(screen.getByTestId("customer-line-quota-note")).toHaveTextContent("免費方案每月 200 則");
    expect(card).toHaveTextContent("客人可以在會員中心自己關掉預約通知或優惠通知。");
    expect(card).toHaveTextContent("服務前提醒");
    expect(card).toHaveTextContent("服務完成");
    expect(card).toHaveTextContent("聯絡人申請與移除");
    expect(await screen.findByTestId("customer-line-quota-summary")).toHaveTextContent(
      "本月已用 132／200 則（客人通知 80、員工通知 40、行銷 12）",
    );
    expect(state.invokeCalls).toEqual([{ fn: "line-quota-status", body: { merchant_id: "m1" } }]);
    expect(screen.getByTestId("customer-line-monthly-cap")).toHaveTextContent("每月客人通知上限");
    expect(screen.getByTestId("customer-line-monthly-cap-input")).toHaveValue("");
    expect(screen.queryByTestId("customer-line-quota-blocked")).toBeNull();
    // Q1 = A:提醒、完成預設關;聯絡人申請預設開。
    for (const [key, on] of [
      ["on_reminder", "false"],
      ["on_completed", "false"],
      ["on_contact_events", "true"],
    ] as const) {
      expect(
        within(screen.getByTestId(`customer-line-kind-${key}`)).getByRole("switch"),
      ).toHaveAttribute("aria-checked", on);
    }
    expect(screen.queryByTestId("customer-line-not-connected")).toBeNull();
    expect(screen.queryByTestId("customer-line-login-off")).toBeNull();
    // 「店家幫客人建了預約」預設關(Q1 = A)。
    const scheduled = within(
      screen.getByTestId("customer-line-kind-on_scheduled_by_store"),
    ).getByRole("switch");
    expect(scheduled).toHaveAttribute("aria-checked", "false");
  });

  it("沒接上官方帳號 ⇒ 黃色 ! + 管理員看到連結;LINE 登入沒開 ⇒ 灰字", async () => {
    state.settings = baseSettings({ connected: false, line_login_enabled: false });
    renderCard();
    const note = await screen.findByTestId("customer-line-not-connected");
    expect(note).toHaveTextContent("還沒有接上 LINE 官方帳號，接上之後才會通知客人。");
    expect(within(note).getByRole("link", { name: "去 LINE 串接設定" })).toHaveAttribute(
      "href",
      "/app/line-settings",
    );
    expect(screen.getByTestId("customer-line-login-off")).toHaveTextContent(
      "客人要用 LINE 登入加入會員後才收得到。",
    );
    // 沒接上 ⇒ 不查 LINE 用量;管理員仍可先設上限。
    expect(state.invokeCalls).toEqual([]);
    expect(screen.queryByTestId("customer-line-quota-summary")).toBeNull();
    expect(screen.getByTestId("customer-line-monthly-cap")).toBeInTheDocument();
  });

  it("客服視角:沒接上時不給連結(那頁只有管理員進得去),改成文字說明", async () => {
    state.role = "agent";
    state.settings = baseSettings({ connected: false, is_admin: false });
    renderCard();
    const note = await screen.findByTestId("customer-line-not-connected");
    expect(within(note).queryByRole("link")).toBeNull();
    expect(note).toHaveTextContent("請商家管理員到「LINE 串接設定」接上。");
    // 客服 + 沒接上:整個額度區不出現。
    expect(screen.queryByTestId("customer-line-quota")).toBeNull();
  });

  it("客服視角(is_admin = false):看得到本月額度與上限數字(唯讀),沒有輸入框", async () => {
    state.role = "agent";
    state.settings = baseSettings({ is_admin: false });
    renderCard();
    expect(await screen.findByTestId("customer-line-quota-summary")).toHaveTextContent(
      "本月已用 132／200 則",
    );
    expect(screen.queryByTestId("customer-line-monthly-cap")).toBeNull();
    expect(screen.queryByTestId("customer-line-monthly-cap-input")).toBeNull();
    expect(screen.getByTestId("customer-line-monthly-cap-readonly")).toHaveTextContent(
      "每月客人通知上限：不限制（只有商家管理員可以修改）",
    );
    cleanup();
    state.settings = baseSettings({
      is_admin: false,
      settings: { ...baseSettings().settings, monthly_cap: 1500 },
    });
    renderCard();
    expect(await screen.findByTestId("customer-line-monthly-cap-readonly")).toHaveTextContent(
      "每月客人通知上限：1,500 則（只有商家管理員可以修改）",
    );
  });

  it("切開關 ⇒ 立即只送那一個鍵;成功 toast", async () => {
    renderCard();
    const row = await screen.findByTestId("customer-line-kind-on_confirmed");
    const sw = within(row).getByRole("switch");
    await userEvent.click(sw);
    await waitFor(() => expect(state.updateCalls).toHaveLength(1));
    expect(state.updateCalls[0]).toEqual({ p_merchant_id: "m1", p_patch: { on_confirmed: false } });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(state.toasts).toContain("已儲存通知客人設定");
  });

  it("切開關失敗 ⇒ 退回 + 固定中文(不顯示資料庫原文)", async () => {
    state.updateError = { code: "42501", hint: "forbidden", message: "permission denied raw" };
    renderCard();
    const sw = within(await screen.findByTestId("customer-line-kind-on_confirmed")).getByRole(
      "switch",
    );
    await userEvent.click(sw);
    await waitFor(() => expect(state.toasts).toContain("儲存失敗"));
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("編輯文字:預設文字 + 預覽;沒改 ⇒ 儲存停用 + 常駐 !;改了存;改過才有恢復預設", async () => {
    renderCard();
    const row = await screen.findByTestId("customer-line-kind-on_confirmed");
    await userEvent.click(within(row).getByTestId("customer-line-edit-toggle"));
    const editor = within(row).getByTestId("customer-line-template-confirmed");
    const textarea = within(editor).getByRole("textbox");
    expect((textarea as HTMLTextAreaElement).value).toContain("已確認你的預約");
    expect(editor).toHaveTextContent("客人實際會收到");
    expect(editor).toHaveTextContent("「涼風工匠」已確認你的預約：");
    expect(editor).toHaveTextContent("還沒有修改文字。");
    expect(within(editor).getByTestId("customer-line-template-save")).toBeDisabled();
    expect(within(editor).queryByTestId("customer-line-template-restore")).toBeNull();

    await userEvent.clear(textarea);
    await userEvent.type(textarea, "已確認，{{{{member_name}}");
    // userEvent.type 把 {{ 當成跳脫 ⇒ 實際輸入「{{member_name}}」。
    expect((textarea as HTMLTextAreaElement).value).toBe("已確認，{{member_name}}");
    expect(editor).toHaveTextContent("已確認，王小明");
    await userEvent.click(within(editor).getByTestId("customer-line-template-save"));
    await waitFor(() => expect(state.updateCalls).toHaveLength(1));
    expect(state.updateCalls[0]).toEqual({
      p_merchant_id: "m1",
      p_patch: { templates: { confirmed: "已確認，{{member_name}}" } },
    });
    const restore = await within(editor).findByTestId("customer-line-template-restore");
    // 恢復預設要先確認(確認窗、危險樣式、說明會刪掉且無法還原);按取消 ⇒ 不送出。
    await userEvent.click(restore);
    let dialog = await screen.findByTestId("customer-line-template-restore-dialog");
    expect(dialog).toHaveTextContent("恢復成預設文字嗎？");
    expect(dialog).toHaveTextContent(
      "你自訂的通知文字會被刪掉，改回系統預設文字，刪掉後無法還原。",
    );
    expect(within(dialog).getByTestId("customer-line-template-restore-confirm").className).toMatch(
      /text-destructive/,
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByTestId("customer-line-template-restore-dialog")).toBeNull(),
    );
    expect(state.updateCalls).toHaveLength(1);
    await userEvent.click(restore);
    dialog = await screen.findByTestId("customer-line-template-restore-dialog");
    await userEvent.click(within(dialog).getByTestId("customer-line-template-restore-confirm"));
    await waitFor(() => expect(state.updateCalls).toHaveLength(2));
    await waitFor(() =>
      expect(screen.queryByTestId("customer-line-template-restore-dialog")).toBeNull(),
    );
    expect(state.updateCalls[1]).toEqual({
      p_merchant_id: "m1",
      p_patch: { templates: { confirmed: "" } },
    });
    await waitFor(() =>
      expect((textarea as HTMLTextAreaElement).value).toContain("已確認你的預約"),
    );
  });

  it("變數按鈕插入 {{變數}};超過 500 字 ⇒ 錯誤 + 停用", async () => {
    renderCard();
    const row = await screen.findByTestId("customer-line-kind-on_rescheduled");
    await userEvent.click(within(row).getByTestId("customer-line-edit-toggle"));
    const editor = within(row).getByTestId("customer-line-template-rescheduled");
    const textarea = within(editor).getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.clear(textarea);
    await userEvent.click(within(editor).getByRole("button", { name: "插入變數：原本的時間" }));
    expect(textarea.value).toBe("{{old_booking_time}}");
    await userEvent.clear(textarea);
    await userEvent.click(textarea);
    await userEvent.paste("字".repeat(501));
    expect(editor).toHaveTextContent("最多 500 字");
    expect(within(editor).getByTestId("customer-line-template-save")).toBeDisabled();
  });
});

describe("C5-K02 5-B:服務前提醒時數、每月上限、本月額度", () => {
  it("服務前 N 小時:預設 24;改成 6 ⇒ 立即只送 reminder_hours_before", async () => {
    renderCard();
    const row = await screen.findByTestId("customer-line-kind-on_reminder");
    const select = within(row).getByTestId("customer-line-reminder-hours");
    expect(select).toHaveValue("24");
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      "2",
      "3",
      "6",
      "12",
      "24",
      "48",
    ]);
    await userEvent.selectOptions(select, "6");
    await waitFor(() => expect(state.updateCalls).toHaveLength(1));
    expect(state.updateCalls[0]).toEqual({
      p_merchant_id: "m1",
      p_patch: { reminder_hours_before: 6 },
    });
    await waitFor(() => expect(select).toHaveValue("6"));
    expect(state.toasts).toContain("已儲存提醒時間");
  });

  it("提醒時數存檔失敗 ⇒ 退回原值", async () => {
    state.updateError = { code: "22023", hint: "reminder_hours_invalid" };
    renderCard();
    const select = within(await screen.findByTestId("customer-line-kind-on_reminder")).getByTestId(
      "customer-line-reminder-hours",
    );
    await userEvent.selectOptions(select, "48");
    await waitFor(() => expect(state.toasts).toContain("儲存失敗"));
    await waitFor(() => expect(select).toHaveValue("24"));
  });

  it("每月上限:沒改 ⇒ 停用 + 常駐 !;填 0 ⇒ 錯誤;填 150 存檔;清空 = 不限制", async () => {
    renderCard();
    const capBox = await screen.findByTestId("customer-line-monthly-cap");
    const input = within(capBox).getByTestId("customer-line-monthly-cap-input");
    const save = within(capBox).getByTestId("customer-line-monthly-cap-save");
    expect(save).toBeDisabled();
    expect(capBox).toHaveTextContent("還沒有修改上限。");

    await userEvent.type(input, "0");
    expect(capBox).toHaveTextContent("每月上限請填 1 到 100,000 的整數，留空代表不限制。");
    expect(save).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, "150");
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(state.capCalls).toHaveLength(1));
    expect(state.capCalls[0]).toEqual({ p_merchant_id: "m1", p_monthly_cap: 150 });
    expect(state.toasts).toContain("已儲存每月上限");
    await waitFor(() => expect(save).toBeDisabled());

    await userEvent.clear(input);
    await userEvent.click(save);
    await waitFor(() => expect(state.capCalls).toHaveLength(2));
    expect(state.capCalls[1]).toEqual({ p_merchant_id: "m1", p_monthly_cap: null });
    expect(state.toasts).toContain("已改成不限制");
  });

  it("每月上限存檔被擋(客服)⇒ 固定中文", async () => {
    state.capError = { code: "42501", hint: "forbidden", message: "raw" };
    renderCard();
    const capBox = await screen.findByTestId("customer-line-monthly-cap");
    await userEvent.type(within(capBox).getByTestId("customer-line-monthly-cap-input"), "100");
    await userEvent.click(within(capBox).getByTestId("customer-line-monthly-cap-save"));
    await waitFor(() => expect(state.toasts).toContain("儲存失敗"));
  });

  it("已有上限 ⇒ 輸入框帶出現值", async () => {
    state.settings = baseSettings({
      settings: { ...baseSettings().settings, monthly_cap: 150 },
    });
    renderCard();
    expect(await screen.findByTestId("customer-line-monthly-cap-input")).toHaveValue("150");
  });

  it("停發中 ⇒ 紅字「本月額度已用完，下個月 1 日恢復。」", async () => {
    state.settings = baseSettings({
      settings: { ...baseSettings().settings, quota_blocked_until: "2999-01-01T00:00:00Z" },
    });
    renderCard();
    const blocked = await screen.findByTestId("customer-line-quota-blocked");
    expect(blocked).toHaveTextContent("本月額度已用完，下個月 1 日恢復。");
    expect(blocked.className).toMatch(/text-destructive/);
  });

  it("LINE 查不到用量 ⇒ 只顯示秒約的統計 + 說明;Edge 失敗 ⇒ 查不到 + 重新查詢", async () => {
    state.quota = {
      plan_limit: null,
      used: null,
      by_category: { customer: 5, store: 2, marketing: 0, birthday: 0 },
    };
    renderCard();
    expect(await screen.findByTestId("customer-line-quota-summary")).toHaveTextContent(
      "秒約本月已發 7 則（客人通知 5、員工通知 2、行銷 0）",
    );
    expect(screen.getByTestId("customer-line-quota")).toHaveTextContent(
      "暫時查不到 LINE 官方帳號的用量，上面只算秒約發出的訊息。",
    );
    cleanup();
    // Edge 叫不到 ⇒ 退回資料庫統計。
    state.quotaError = new Error("boom");
    state.usage = {
      by_category: { customer: 1, store: 2, marketing: 3, birthday: 0 },
      blocked_until: null,
    };
    renderCard();
    expect(await screen.findByTestId("customer-line-quota-summary")).toHaveTextContent(
      "秒約本月已發 6 則（客人通知 1、員工通知 2、行銷 3）",
    );
    cleanup();
    // 兩個都失敗 ⇒ 查不到 + 重新查詢。
    state.usageError = { code: "42501" };
    renderCard();
    expect(
      await screen.findByTestId("customer-line-quota-error", {}, { timeout: 3000 }),
    ).toHaveTextContent("暫時查不到本月用量。");
    expect(screen.getByRole("button", { name: "重新查詢" })).toBeInTheDocument();
  });
});

describe("C5-K01 確認訂單彈窗只列店家這邊", () => {
  it("預覽回會員 ⇒ 濾掉;只剩會員 ⇒ 視為沒有對象(不跳彈窗)", async () => {
    state.rpcData = {
      has_any_target: true,
      targets: [
        { type: "staff", name: "阿明" },
        { type: "member", name: "王小明" },
      ],
    };
    const r = await fetchPendingLineNotificationPreview("b1", "booking_confirmed");
    expect(r).toEqual({ hasAnyTarget: true, targets: [{ type: "staff", name: "阿明" }] });
    state.rpcData = { has_any_target: true, targets: [{ type: "member", name: "王小明" }] };
    expect(await fetchPendingLineNotificationPreview("b1", "booking_confirmed")).toEqual({
      hasAnyTarget: false,
      targets: [],
    });
  });

  it("彈窗文字不列會員,並說明客人那邊照「通知客人」設定", () => {
    render(
      <ConfirmBookingLineDialog
        open
        targets={[
          { type: "admin", name: "老闆" },
          { type: "member", name: "王小明" },
        ]}
        onOpenChange={() => undefined}
        onChoice={() => undefined}
      />,
    );
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("將會通知：商家管理員 老闆(LINE)");
    expect(dialog).not.toHaveTextContent("王小明");
    expect(screen.getByTestId("confirm-line-customer-note")).toHaveTextContent(
      "客人那邊會依「LINE 通知事件」頁的「通知客人」設定通知，跟這裡選是或否無關。",
    );
  });
});

describe("C5-K02 留空儲存 = 恢復預設", () => {
  it("店家有自訂文字時,留空按儲存也要先確認", async () => {
    state.settings = baseSettings({ templates: { confirmed: "自訂的確認文字" } });
    renderCard();
    const row = await screen.findByTestId("customer-line-kind-on_confirmed");
    await userEvent.click(within(row).getByTestId("customer-line-edit-toggle"));
    const editor = within(row).getByTestId("customer-line-template-confirmed");
    const textarea = within(editor).getByRole("textbox");
    expect(textarea).toHaveValue("自訂的確認文字");
    await userEvent.clear(textarea);
    await userEvent.click(within(editor).getByTestId("customer-line-template-save"));
    const dialog = await screen.findByTestId("customer-line-template-restore-dialog");
    expect(state.updateCalls).toHaveLength(0);
    await userEvent.click(within(dialog).getByTestId("customer-line-template-restore-confirm"));
    await waitFor(() => expect(state.updateCalls).toHaveLength(1));
    expect(state.updateCalls[0]).toEqual({
      p_merchant_id: "m1",
      p_patch: { templates: { confirmed: "" } },
    });
  });
});
