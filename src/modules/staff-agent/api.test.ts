// 模組 3(人員與權限管理)— inviteMerchantAgent 送給 Edge Function 的 body 契約測試。
//
// 【為什麼需要這份測試】(對應 SPECS-INDEX #645:phone 型別安全缺口)
// merchant_agents.phone 是 NOT NULL 欄位(CHECK phone ~ '^09\d{8}$')。inviteMerchantAgent()
// 以前對 phone 用 toNullIfEmpty(),空字串會被靜默轉成 null 送到 Edge Function
// invite-merchant-agent,insert 時直接違反約束——而且錯誤訊息是資料庫的英文約束名稱,
// 使用者完全看不懂。2026-09-25 把 InviteMerchantAgentInput.phone 收緊成必填 `string`、
// 送出前只 trim()。型別能擋「沒帶 phone」,但擋不到「哪天有人又把 toNullIfEmpty 套回 phone」,
// 所以這裡用「斷言實際送出去的 body」把契約釘住,寫法比照 staff-portal/api.test.ts。

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
    rpc: vi.fn(),
    from: vi.fn(),
    storage: { from: vi.fn() },
  },
}));

async function importInviteMerchantAgent() {
  const mod = await import("./api");
  return mod.inviteMerchantAgent;
}

describe("inviteMerchantAgent 送給 Edge Function 的 body 契約(#645 phone NOT NULL)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      data: { agent_id: "agent-1", status: "invited", already_had_account: false },
      error: null,
    });
  });

  it("phone 只會被 trim(),不會被轉成 null(merchant_agents.phone 是 NOT NULL)", async () => {
    const inviteMerchantAgent = await importInviteMerchantAgent();

    await inviteMerchantAgent({
      merchantId: "merchant-1",
      email: " agent@example.test ",
      name: " 王小美 ",
      nickname: "",
      phone: " 0912345678 ",
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [fnName, options] = invokeMock.mock.calls[0] as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(fnName).toBe("invite-merchant-agent");
    expect(options.body).toEqual({
      merchant_id: "merchant-1",
      email: "agent@example.test",
      name: "王小美",
      // nickname 是 nullable 欄位,空字串正規化成 null 是正確的(跟 phone 的規則不同)。
      nickname: null,
      phone: "0912345678",
    });
  });

  it("核心必測:就算呼叫端繞過型別硬塞空字串,phone 也只會是空字串、絕不會變成 null", async () => {
    // 這條就是守 #645 的斷言:以前 toNullIfEmpty("") 會回 null;現在只 trim(),"" 保持 "",
    // 讓 Edge Function / 資料庫的 CHECK 約束用「格式不對」擋下,而不是用 NOT NULL 違反擋下。
    // (正常路徑不會走到這裡——AgentListPage.tsx 的邀請表單已經先用 isValidTaiwanMobilePhone
    // 擋掉空值與錯格式;這條是防「型別被 as 繞過」的最後一道。)
    const inviteMerchantAgent = await importInviteMerchantAgent();

    await inviteMerchantAgent({
      merchantId: "merchant-1",
      email: "agent@example.test",
      name: "王小美",
      phone: "   " as string,
    });

    const [, options] = invokeMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(options.body["phone"]).toBe("");
    expect(options.body["phone"]).not.toBeNull();
  });
});
