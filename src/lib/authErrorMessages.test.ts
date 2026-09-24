// 2026-09-24 深夜巡檢新增:Supabase Auth 英文錯誤訊息 → 中文對照表的單元測試。
// 重點不只是「有翻到」,還包含「查不到的訊息不能被吞掉」——那是這張表刻意的設計選擇。

import { describe, expect, it } from "vitest";

import { translateAuthErrorMessage } from "./authErrorMessages";

describe("translateAuthErrorMessage:登入相關", () => {
  it("Invalid login credentials(師傅打錯密碼最常見的那一句)", () => {
    expect(translateAuthErrorMessage("Invalid login credentials")).toBe("Email 或密碼不正確");
  });

  it("Email not confirmed", () => {
    expect(translateAuthErrorMessage("Email not confirmed")).toBe(
      "這個 Email 還沒完成驗證,請到信箱點擊驗證連結",
    );
  });

  it("User not found", () => {
    expect(translateAuthErrorMessage("User not found")).toBe(
      "找不到這個帳號,請確認 Email 是否正確,或先建立帳號",
    );
  });
});

describe("translateAuthErrorMessage:註冊相關", () => {
  it("User already registered", () => {
    expect(translateAuthErrorMessage("User already registered")).toBe(
      "這個 Email 已經註冊過了,請直接登入或使用忘記密碼",
    );
  });

  it("A user with this email address has already been registered(同一件事的另一種寫法)", () => {
    expect(
      translateAuthErrorMessage("A user with this email address has already been registered"),
    ).toBe("這個 Email 已經註冊過了,請直接登入或使用忘記密碼");
  });

  it("Unable to validate email address: invalid format", () => {
    expect(translateAuthErrorMessage("Unable to validate email address: invalid format")).toBe(
      "Email 格式不正確,請檢查有沒有打錯",
    );
  });

  it("Signups not allowed for this instance", () => {
    expect(translateAuthErrorMessage("Signups not allowed for this instance")).toBe(
      "目前沒有開放自行註冊,請聯絡系統管理員",
    );
  });
});

describe("translateAuthErrorMessage:頻率限制", () => {
  it("Email rate limit exceeded", () => {
    expect(translateAuthErrorMessage("Email rate limit exceeded")).toBe("嘗試太頻繁,請稍後再試");
  });

  it("帶秒數的 For security purposes 訊息,把秒數帶進中文句子", () => {
    expect(
      translateAuthErrorMessage(
        "For security purposes, you can only request this after 46 seconds.",
      ),
    ).toBe("操作太頻繁,請等 46 秒後再試一次");
  });

  it("秒數是 1 秒時(英文是單數 second)也要命中", () => {
    expect(
      translateAuthErrorMessage("For security purposes, you can only request this after 1 second."),
    ).toBe("操作太頻繁,請等 1 秒後再試一次");
  });
});

describe("translateAuthErrorMessage:密碼與連結失效", () => {
  it("Password should be at least 6 characters(精準比對)", () => {
    expect(translateAuthErrorMessage("Password should be at least 6 characters.")).toBe(
      "密碼至少要 6 個字元",
    );
  });

  it("Password should be at least 8 characters(專案改過長度要求,靠規則帶出正確數字)", () => {
    expect(translateAuthErrorMessage("Password should be at least 8 characters.")).toBe(
      "密碼至少要 8 個字元",
    );
  });

  it("Email link is invalid or has expired", () => {
    expect(translateAuthErrorMessage("Email link is invalid or has expired")).toBe(
      "這個連結已經失效或過期,請重新操作一次取得新的連結",
    );
  });
});

describe("translateAuthErrorMessage:正規化(大小寫/空白/結尾句點的差異不該影響比對)", () => {
  it("結尾多一個句點一樣命中", () => {
    expect(translateAuthErrorMessage("Invalid login credentials.")).toBe("Email 或密碼不正確");
  });

  it("全小寫一樣命中", () => {
    expect(translateAuthErrorMessage("invalid login credentials")).toBe("Email 或密碼不正確");
  });

  it("前後有多餘空白一樣命中", () => {
    expect(translateAuthErrorMessage("  User already registered  ")).toBe(
      "這個 Email 已經註冊過了,請直接登入或使用忘記密碼",
    );
  });
});

describe("translateAuthErrorMessage:查不到的訊息不能被吞掉", () => {
  it("對照表沒有的英文訊息,原樣回傳原文(刻意不換成「請稍後再試」,保留追查線索)", () => {
    const unknown = "Some brand new GoTrue error nobody has seen before";
    expect(translateAuthErrorMessage(unknown)).toBe(unknown);
  });

  it("空字串 / null / undefined 才回傳通用文字(這時候原本就沒有任何線索可以保留)", () => {
    expect(translateAuthErrorMessage("")).toBe("發生未知錯誤,請稍後再試");
    expect(translateAuthErrorMessage(null)).toBe("發生未知錯誤,請稍後再試");
    expect(translateAuthErrorMessage(undefined)).toBe("發生未知錯誤,請稍後再試");
  });
});
