// personDisplay.ts 的單元測試(規格書「超級管理員商家詳情強化」#709)。
//
// 這裡要釘住兩件事:
//   ① 空值處理:資料庫刻意不 coalesce(否則前端分不出「真的沒填」跟「填了預設字」),
//      所以 null / 空字串 / 只有空白 三種「沒填」都必須走到同一個 fallback。
//      ⚠️「只有空白」這一種最容易漏:`p.job_title || "客服"` 對 `"  "` 會回傳 `"  "`
//        (空白字串是 truthy),畫面上看起來就是一片空白。所以實作一定要先 trim()。
//   ② 中文用語:2026-09-24 這批把全系統的「師傅」改成「服務人員」、「按件計酬」改成
//      「抽成制」。這裡直接斷言字串內容,避免之後有人把舊用語回填進來。

import { describe, expect, it } from "vitest";

import {
  AGENT_STATUS_LABELS,
  STAFF_COMPENSATION_TYPE_LABELS,
  STAFF_LOGIN_STATUS_LABELS,
} from "@/modules/staff-agent/types";

import {
  agentJobTitle,
  DEFAULT_AGENT_JOB_TITLE,
  personDisplayName,
  personLoginEmail,
  PERSON_LOGIN_EMAIL_PLACEHOLDER,
} from "./personDisplay";

describe("personDisplayName", () => {
  it("有暱稱時顯示「姓名(暱稱)」", () => {
    expect(personDisplayName({ name: "王小明", nickname: "小明" })).toBe("王小明(小明)");
  });

  it("nickname 是 null 時只顯示姓名", () => {
    expect(personDisplayName({ name: "王小明", nickname: null })).toBe("王小明");
  });

  it("nickname 是空字串時只顯示姓名", () => {
    expect(personDisplayName({ name: "王小明", nickname: "" })).toBe("王小明");
  });

  it("nickname 只有空白時只顯示姓名(不會變成「王小明(  )」)", () => {
    expect(personDisplayName({ name: "王小明", nickname: "  " })).toBe("王小明");
  });
});

describe("personLoginEmail", () => {
  it("有值時原樣回傳", () => {
    expect(personLoginEmail({ login_email: "someone@example.com" })).toBe("someone@example.com");
  });

  it("null 時 fallback 成「尚未開通登入」", () => {
    expect(personLoginEmail({ login_email: null })).toBe(PERSON_LOGIN_EMAIL_PLACEHOLDER);
    expect(PERSON_LOGIN_EMAIL_PLACEHOLDER).toBe("尚未開通登入");
  });

  it("空字串時 fallback", () => {
    expect(personLoginEmail({ login_email: "" })).toBe("尚未開通登入");
  });

  it("只有空白時 fallback(不能回傳一片空白)", () => {
    expect(personLoginEmail({ login_email: "  " })).toBe("尚未開通登入");
  });
});

describe("agentJobTitle", () => {
  it("有值時原樣回傳", () => {
    expect(agentJobTitle({ job_title: "值班客服" })).toBe("值班客服");
  });

  it("null 時 fallback 成「客服」", () => {
    expect(agentJobTitle({ job_title: null })).toBe(DEFAULT_AGENT_JOB_TITLE);
    expect(DEFAULT_AGENT_JOB_TITLE).toBe("客服");
  });

  it("空字串時 fallback", () => {
    expect(agentJobTitle({ job_title: "" })).toBe("客服");
  });

  it("只有空白時 fallback", () => {
    expect(agentJobTitle({ job_title: "  " })).toBe("客服");
  });
});

describe("中文用語釘樁(2026-09-24 用語統一)", () => {
  it("計酬類型:piece_rate 顯示「抽成制」、monthly_salary 顯示「月薪制」", () => {
    // ⚠️ 這是 2026-09-24 用語統一的結果:`piece_rate` 不能再顯示成「按件計酬」。
    //    資料庫存的值仍然是英文 'piece_rate',只有中文顯示改——所以這條測試盯的是
    //    「顯示字串」,不是資料庫值。
    expect(STAFF_COMPENSATION_TYPE_LABELS.piece_rate).toBe("抽成制");
    expect(STAFF_COMPENSATION_TYPE_LABELS.monthly_salary).toBe("月薪制");
  });

  it("計酬類型的中文用語裡不得再出現舊稱「按件計酬」", () => {
    expect(Object.values(STAFF_COMPENSATION_TYPE_LABELS).join("|")).not.toContain("按件計酬");
  });

  it("服務人員登入狀態 / 客服狀態的中文用語裡都不得出現舊稱「師傅」", () => {
    // 2026-09-24 全系統把「師傅」改成「服務人員」。這裡用簡單的字串檢查防止未來回填舊用語。
    const allLabels = [
      ...Object.values(STAFF_LOGIN_STATUS_LABELS),
      ...Object.values(AGENT_STATUS_LABELS),
    ].join("|");
    expect(allLabels).not.toContain("師傅");
  });
});
