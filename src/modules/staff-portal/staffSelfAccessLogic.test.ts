// 服務人員自助頁面守衛條件的單元測試。
// 背景與根因見 staffSelfAccessLogic.ts 開頭的完整說明(2026-09-24 線上故障的第二個缺口)。

import { describe, expect, it } from "vitest";

import {
  canAccessStaffSelfPages,
  shouldRedirectAwayFromStaffSelfPage,
} from "./staffSelfAccessLogic";

describe("canAccessStaffSelfPages", () => {
  it("純服務人員(有在職服務人員紀錄):可以進", () => {
    expect(canAccessStaffSelfPages({ hasCurrentMerchant: true, hasActiveStaffRecord: true })).toBe(
      true,
    );
  });

  it("雙重身分(客服/管理員 + 同一間商家的服務人員):可以進", () => {
    // ⬇⬇ 這一條就是這次修掉的缺口。改版前守衛用的是 useCurrentMerchantRole() === 'staff',
    // 而這種人的角色永遠解析成 'agent'/'admin',所以會被導去 /app/manage(對他而言一片空白)。
    // 這裡刻意不把「解析出來的角色」當成輸入 —— 判斷條件本來就跟角色優先序無關。
    expect(canAccessStaffSelfPages({ hasCurrentMerchant: true, hasActiveStaffRecord: true })).toBe(
      true,
    );
  });

  it("純管理員/純客服(在這間商家沒有服務人員紀錄):不能進", () => {
    expect(canAccessStaffSelfPages({ hasCurrentMerchant: true, hasActiveStaffRecord: false })).toBe(
      false,
    );
  });

  it("商家還沒選定:不能進(也還不該下結論,交給 loading 判斷)", () => {
    expect(canAccessStaffSelfPages({ hasCurrentMerchant: false, hasActiveStaffRecord: true })).toBe(
      false,
    );
    expect(
      canAccessStaffSelfPages({ hasCurrentMerchant: false, hasActiveStaffRecord: false }),
    ).toBe(false);
  });
});

describe("shouldRedirectAwayFromStaffSelfPage", () => {
  it("載入中一律不導離——避免「查詢還沒有答案就先把人彈走」這種競態", () => {
    expect(
      shouldRedirectAwayFromStaffSelfPage({
        loading: true,
        hasCurrentMerchant: false,
        hasActiveStaffRecord: false,
      }),
    ).toBe(false);
  });

  it("載入完成 + 真的不是這間商家的服務人員 ⇒ 導離", () => {
    expect(
      shouldRedirectAwayFromStaffSelfPage({
        loading: false,
        hasCurrentMerchant: true,
        hasActiveStaffRecord: false,
      }),
    ).toBe(true);
  });

  it("載入完成 + 是服務人員(含雙重身分)⇒ 不導離", () => {
    expect(
      shouldRedirectAwayFromStaffSelfPage({
        loading: false,
        hasCurrentMerchant: true,
        hasActiveStaffRecord: true,
      }),
    ).toBe(false);
  });
});
