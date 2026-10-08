// 客戶端第 2 批(C2-A03 / C2-F01):LINE 登入設定的回傳解析與欄位檢查。

import { describe, expect, it } from "vitest";

import { channelIdError, channelSecretError, parseMerchantLineLoginStatus } from "./lineLoginApi";
import { formatLastLoginDate, parseMemberCustomerLoginStatus } from "./memberCustomerLoginApi";

describe("parseMerchantLineLoginStatus", () => {
  it("只挑白名單欄位;secret 原文、Vault id 就算資料庫多回也不會被收下;callback = 網站網域 + 路徑", () => {
    const status = parseMerchantLineLoginStatus({
      configured: true,
      channel_id: "1234567890",
      channel_secret_masked: "••••ab12",
      enabled: true,
      last_login_succeeded_at: null,
      linked_oa_status: "not_linked",
      callback_path: "/auth/line/callback",
      channel_secret: "SENTINELSECRET0123456789abcdef01",
      channel_secret_vault_id: "SENTINEL_VAULT",
    });
    expect(status).toEqual({
      configured: true,
      channelId: "1234567890",
      channelSecretMasked: "••••ab12",
      enabled: true,
      lastLoginSucceededAt: null,
      linkedOaStatus: "not_linked",
      callbackUrl: `${window.location.origin}/auth/line/callback`,
    });
    expect(JSON.stringify(status)).not.toMatch(/SENTINEL/);
  });

  it("沒設定 / 奇怪的值 ⇒ 安全的預設", () => {
    expect(parseMerchantLineLoginStatus(null)).toMatchObject({
      configured: false,
      enabled: false,
      channelSecretMasked: null,
      linkedOaStatus: null,
    });
    expect(parseMerchantLineLoginStatus({ linked_oa_status: "hacked" }).linkedOaStatus).toBeNull();
  });
});

describe("欄位檢查", () => {
  it("Channel ID", () => {
    expect(channelIdError("1234567890")).toBeNull();
    expect(channelIdError(" ")).toBe("請填 Channel ID。");
    expect(channelIdError("abc")).toMatch(/一串數字/);
  });
  it("Channel Secret:第一次必填、之後留空 = 沿用", () => {
    expect(channelSecretError("", true)).toBe("請填 Channel Secret。");
    expect(channelSecretError("", false)).toBeNull();
    expect(channelSecretError("a".repeat(32), true)).toBeNull();
    expect(channelSecretError("a".repeat(31), false)).toMatch(/32 碼/);
  });
});

describe("C2-H03 會員客戶端登入狀態", () => {
  it("解析 + 日期", () => {
    expect(
      parseMemberCustomerLoginStatus({ linked: true, last_login_at: "2026-10-08T02:00:00Z" }),
    ).toEqual({
      linked: true,
      lastLoginAt: "2026-10-08T02:00:00Z",
      relinkBlocked: false,
    });
    expect(parseMemberCustomerLoginStatus({ linked: false, relink_blocked: true })).toEqual({
      linked: false,
      lastLoginAt: null,
      relinkBlocked: true,
    });
    expect(parseMemberCustomerLoginStatus("x")).toEqual({
      linked: false,
      lastLoginAt: null,
      relinkBlocked: false,
    });
    expect(formatLastLoginDate("2026-10-07T17:00:00Z")).toBe("10月8日");
  });
});
