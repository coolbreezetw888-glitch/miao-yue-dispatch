// 規格書 .project/specs/建單自動建立會員與會員兩層狀態.md §三 #923.3 第 5、6 條指定要補的 vitest:
//   第 5 條:會員類型篩選的過濾函式(#918 名單頁的 visibleMembers 判斷)
//   第 6 條:CSV 會員類型欄位的中文對應(#919 會員報表)
// 順便把 #920 詳情頁的日期格式化一起測(同一支純函式檔,測了才不會有人改壞)。
//
// 🔴 這裡刻意只測純函式,不去 render 元件、也不去測 toast —— 規格書明寫這個原則。

import { describe, expect, it } from "vitest";

import {
  formatIdentityVerifiedDate,
  isMemberIdentityFilter,
  matchesMemberIdentityFilter,
  memberIdentityStatus,
  memberIdentityStatusLabel,
  MEMBER_IDENTITY_FILTER_OPTIONS,
  MEMBER_IDENTITY_STATUS_LABELS,
} from "./memberIdentityStatus";

const VERIFIED_AT = "2026-09-20T08:30:00+00:00";

describe("memberIdentityStatus(#908 的兩層狀態怎麼判)", () => {
  it("有時間戳 = 已完成驗證", () => {
    expect(memberIdentityStatus(VERIFIED_AT)).toBe("verified");
  });

  it("null = 尚未驗證", () => {
    expect(memberIdentityStatus(null)).toBe("unverified");
  });

  it("🔴 undefined(#908 的 migration 還沒上線、或呼叫端沒 select 到這個欄位)一律當成未驗證", () => {
    // 保守方向很重要:猜錯成「未驗證」只會少發通知;猜錯成「已驗證」會把不是本人的紀錄
    // 當成正式會員,通知就寄出去了。
    expect(memberIdentityStatus(undefined)).toBe("unverified");
  });

  it("空字串也算未驗證(不會因為髒資料誤判成正式會員)", () => {
    expect(memberIdentityStatus("")).toBe("unverified");
  });
});

describe("#919 CSV 的會員類型欄位:中文白話對應", () => {
  it("已驗證 → 「已完成驗證」", () => {
    expect(memberIdentityStatusLabel(VERIFIED_AT)).toBe("已完成驗證");
  });

  it("未驗證 → 「尚未驗證」", () => {
    expect(memberIdentityStatusLabel(null)).toBe("尚未驗證");
  });

  it("🔴 不可以輸出時間戳或 true/false —— 這份 CSV 是給商家在 Excel 裡看的", () => {
    const label = memberIdentityStatusLabel(VERIFIED_AT);
    expect(label).not.toContain("2026");
    expect(label).not.toMatch(/true|false/i);
  });

  it("文案常數就是這兩句(#918/#919/#920 三個畫面共用,改動會同時影響三處)", () => {
    expect(MEMBER_IDENTITY_STATUS_LABELS).toEqual({
      verified: "已完成驗證",
      unverified: "尚未驗證",
    });
  });

  it("🔴 守門:狀態名稱裡不可以出現「綁定」兩個字(2026-09-30 使用者裁決)", () => {
    // 理由見 memberIdentityStatus.ts 的註解:①「LINE 綁定」是通知管道,不是身分;
    // ② #866 裁決全面改手機簡訊驗證碼登入 ⇒ 未來會有兩條驗證路徑,「綁定」只描述其中一條,
    // 拿它當整體狀態的名稱會越來越不準。這條測試是為了擋掉「不小心改回去」。
    for (const label of Object.values(MEMBER_IDENTITY_STATUS_LABELS)) {
      expect(label).not.toContain("綁定");
    }
    // 篩選下拉的選項文字同樣不可以帶「綁定」。
    for (const option of MEMBER_IDENTITY_FILTER_OPTIONS) {
      expect(option.label).not.toContain("綁定");
    }
  });
});

describe("#918 會員名單的「會員類型」篩選", () => {
  it("all 全部放行", () => {
    expect(matchesMemberIdentityFilter(VERIFIED_AT, "all")).toBe(true);
    expect(matchesMemberIdentityFilter(null, "all")).toBe(true);
    expect(matchesMemberIdentityFilter(undefined, "all")).toBe(true);
  });

  it("verified 只留已完成驗證", () => {
    expect(matchesMemberIdentityFilter(VERIFIED_AT, "verified")).toBe(true);
    expect(matchesMemberIdentityFilter(null, "verified")).toBe(false);
  });

  it("unverified 只留尚未驗證", () => {
    expect(matchesMemberIdentityFilter(null, "unverified")).toBe(true);
    expect(matchesMemberIdentityFilter(undefined, "unverified")).toBe(true);
    expect(matchesMemberIdentityFilter(VERIFIED_AT, "unverified")).toBe(false);
  });

  it("兩種篩選的結果加起來 = 全部(不會有人兩邊都不見)", () => {
    const rows: Array<string | null> = [VERIFIED_AT, null, null, "2026-01-01T00:00:00Z"];
    const verified = rows.filter((r) => matchesMemberIdentityFilter(r, "verified"));
    const unverified = rows.filter((r) => matchesMemberIdentityFilter(r, "unverified"));
    expect(verified.length + unverified.length).toBe(rows.length);
  });

  it("下拉選單就是三個選項,而且第一個是「全部」", () => {
    expect(MEMBER_IDENTITY_FILTER_OPTIONS.map((o) => o.value)).toEqual([
      "all",
      "verified",
      "unverified",
    ]);
  });

  it("isMemberIdentityFilter 只放行這三個值(給 guardPhantomEmptyChange 當白名單)", () => {
    expect(isMemberIdentityFilter("all")).toBe(true);
    expect(isMemberIdentityFilter("verified")).toBe(true);
    expect(isMemberIdentityFilter("unverified")).toBe(true);
    // Radix Select 的幽靈空值事件就是這一種,一定要擋掉。
    expect(isMemberIdentityFilter("")).toBe(false);
    expect(isMemberIdentityFilter("line_bound")).toBe(false);
  });
});

describe("#920 詳情頁的「(YYYY-MM-DD 完成驗證)」", () => {
  it("timestamptz 換算成 Asia/Taipei 的日曆日", () => {
    // 2026-09-20 23:30 UTC = 台北時間隔天 07:30 ⇒ 日期要是 09-21,不是 09-20。
    expect(formatIdentityVerifiedDate("2026-09-20T23:30:00+00:00")).toBe("2026-09-21");
  });

  it("沒有值就回 null,讓畫面自己決定不顯示", () => {
    expect(formatIdentityVerifiedDate(null)).toBeNull();
    expect(formatIdentityVerifiedDate(undefined)).toBeNull();
  });

  it("🔴 解析不出來的字串回 null,不要在畫面上印出「Invalid Date」", () => {
    expect(formatIdentityVerifiedDate("不是日期")).toBeNull();
  });
});
