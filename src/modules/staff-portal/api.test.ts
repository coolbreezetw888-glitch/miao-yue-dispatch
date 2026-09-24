// 模組 14(服務人員端)— updateMyStaffProfile 的 RPC 參數契約測試。
//
// 【為什麼需要這份測試】
// 2026-09-24 這批改動裡風險最高的一項:migration 20260924040800_drop_person_contact_email.sql
// 把 update_my_staff_profile 從 7 參數 drop 掉、改建成 6 參數(拿掉 p_contact_email),而前端
// 呼叫端在另一個人的檔案範圍裡,是**分開改的**。這兩邊只要有一邊沒跟上:
//   ・前端還送 7 個參數 → migration 套用後 PostgREST 找不到對應重載,服務人員一按「儲存個人資料」
//     就整個失敗(而且錯誤訊息是 PostgREST 的英文「函式不存在」,完全看不出真正原因)。
//   ・前端少送某個該送的參數 → 那個欄位被靜默清空(update_my_staff_profile 是整列覆蓋,
//     不是部分更新)。
//
// 當時這件事**完全沒有型別保護**:呼叫端用的是 callPendingRpc 過渡寫法(因為 types.ts 還沒重新
// 產生,裡面的 Args 仍然把 p_contact_email 列為必填),那個 helper 的參數型別是
// Record<string, unknown> —— 多送、少送、打錯參數名,tsc 一律不會報錯。
//
// 所以這裡用「斷言實際送出去的參數物件」把契約釘住。
//
// ✅ 現況(2026-09-24 收尾):migration 已套用到正式資料庫、types.ts 已重新產生,呼叫端的
// callPendingRpc 已經收掉、改回一般的 supabase.rpc("update_my_staff_profile", …),所以參數名稱與
// 數量現在「也」有 tsc 的保護了。但這份測試仍然完整有效、不可刪除,因為它守的是型別擋不到的那一半:
//   ・空字串正規化(nickname/phone/avatarUrl/intro 送 "" 而不是 null —— 見 api.ts 的說明,
//     gen types 把 text 參數一律推導成非 nullable,所以這個「傳空字串」的決定是型別看不出對錯的)。
//   ・name 有被 trim()。
//   ・沒有多送任何參數(例如哪天有人又把 p_contact_email 加回來)。
// 它斷言的是「送出的內容」,不是「怎麼送的」,所以收掉 callPendingRpc 完全沒有影響。

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: vi.fn(),
    storage: { from: vi.fn() },
    functions: { invoke: vi.fn() },
  },
}));

async function importUpdateMyStaffProfile() {
  const mod = await import("./api");
  return mod.updateMyStaffProfile;
}

describe("updateMyStaffProfile 的 RPC 參數契約(對應 migration 20260924040800 的 6 參數簽章)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: null, error: null });
  });

  it("核心必測:送出的參數恰好是 migration 定義的那 6 個,**不含** p_contact_email", async () => {
    const updateMyStaffProfile = await importUpdateMyStaffProfile();

    await updateMyStaffProfile({
      staffId: "staff-1",
      name: "王小明",
      nickname: "小明",
      phone: "0912345678",
      avatarUrl: "https://example.test/a.png",
      intro: "十年經驗",
    });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [fnName, args] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(fnName).toBe("update_my_staff_profile");

    // 參數名稱集合必須「剛好」是這 6 個 —— 多一個或少一個都會讓 PostgREST 解析不到函式。
    expect(Object.keys(args).sort()).toEqual([
      "p_avatar_url",
      "p_intro",
      "p_name",
      "p_nickname",
      "p_phone",
      "p_staff_id",
    ]);
    // 明確斷言那個被移除的參數真的不見了(不要只靠上面的集合比對,寫出來才看得懂意圖)。
    expect(args).not.toHaveProperty("p_contact_email");

    expect(args).toEqual({
      p_staff_id: "staff-1",
      p_name: "王小明",
      p_nickname: "小明",
      p_phone: "0912345678",
      p_avatar_url: "https://example.test/a.png",
      p_intro: "十年經驗",
    });
  });

  it("姓名會去掉前後空白(資料庫端還會再擋一次空白姓名,兩層都在)", async () => {
    const updateMyStaffProfile = await importUpdateMyStaffProfile();

    await updateMyStaffProfile({ staffId: "staff-1", name: "  王小明  " });

    const [, args] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(args["p_name"]).toBe("王小明");
  });

  it("選填欄位沒給或是 null 時送空字串,不送 null(既有慣例:gen types 把 text 推導成 string,而資料庫端用 nullif(trim(coalesce(x,'')),'') 正規化,空字串跟 null 等效)", async () => {
    const updateMyStaffProfile = await importUpdateMyStaffProfile();

    // nickname/avatarUrl 明確傳 null,phone/intro 整個不給 —— 兩種「沒有值」的寫法都要送出空字串。
    // (tsconfig 開了 exactOptionalPropertyTypes,所以「不給」只能用省略 key 的方式表達,
    //  不能寫 phone: undefined —— 那在呼叫端本來就是型別錯誤,測一個不可能的輸入沒有意義。)
    await updateMyStaffProfile({
      staffId: "staff-1",
      name: "王小明",
      nickname: null,
      avatarUrl: null,
    });

    const [, args] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(args).toEqual({
      p_staff_id: "staff-1",
      p_name: "王小明",
      p_nickname: "",
      p_phone: "",
      p_avatar_url: "",
      p_intro: "",
    });
  });

  it("資料庫回傳 error 時原樣往外丟(讓畫面用 getErrorMessage 顯示資料庫的中文訊息)", async () => {
    const dbError = { message: "沒有權限修改這位服務人員的資料", code: "42501" };
    rpcMock.mockResolvedValue({ data: null, error: dbError });
    const updateMyStaffProfile = await importUpdateMyStaffProfile();

    await expect(updateMyStaffProfile({ staffId: "staff-1", name: "王小明" })).rejects.toBe(
      dbError,
    );
  });
});
