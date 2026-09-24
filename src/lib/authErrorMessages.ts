// 登入/註冊等 Supabase Auth 錯誤訊息的中文對照表(跨模組共用,非編號模組)。
//
// 為什麼需要這個檔案(2026-09-24 深夜巡檢抓到的問題):
// src/routes/signin.tsx 跟 src/routes/signup.tsx 原本直接把 `error.message` 丟進 toast,
// 那是 Supabase Auth(GoTrue)回傳的英文字串。結果整個產品都是中文,偏偏「最常出錯的那一頁」
// 是英文——師傅在手機上打錯密碼看到的是「登入失敗 / Invalid login credentials」,
// Email 已經註冊過看到的是「User already registered」。
//
// 設計原則(刻意這樣定,之後維護請照這個原則加):
//   1. 只翻譯「對照表裡查得到」的訊息。查不到的一律原樣顯示英文原文,不要換成「請稍後再試」
//      這種通用句子——那樣會把未知錯誤整個吞掉,之後使用者回報問題時什麼線索都沒有,更難查。
//   2. 比對時把大小寫、前後空白、結尾句點的差異都正規化掉。GoTrue 不同版本同一個錯誤
//      有時多一個句點、有時首字母大小寫不同,寫死一字不差的字串比對很容易失效。
//   3. 有些訊息帶變數(例如「you can only request this after 46 seconds」的秒數),
//      這種用 regex 規則處理,放在精準比對之後。

/** 精準比對用的對照表。key 一律是「小寫 + 去掉前後空白 + 去掉結尾句點」之後的樣子。 */
const EXACT_MESSAGE_MAP: Record<string, string> = {
  // --- 登入 ---
  "invalid login credentials": "Email 或密碼不正確",
  "email not confirmed": "這個 Email 還沒完成驗證,請到信箱點擊驗證連結",
  "user not found": "找不到這個帳號,請確認 Email 是否正確,或先建立帳號",
  "invalid email or password": "Email 或密碼不正確",

  // --- 註冊 ---
  "user already registered": "這個 Email 已經註冊過了,請直接登入或使用忘記密碼",
  "a user with this email address has already been registered":
    "這個 Email 已經註冊過了,請直接登入或使用忘記密碼",
  "signup requires a valid password": "請輸入密碼",
  "signups not allowed for this instance": "目前沒有開放自行註冊,請聯絡系統管理員",
  "email address is invalid": "Email 格式不正確,請檢查有沒有打錯",
  "unable to validate email address: invalid format": "Email 格式不正確,請檢查有沒有打錯",

  // --- 頻率限制 ---
  "email rate limit exceeded": "嘗試太頻繁,請稍後再試",
  "over email send rate limit": "驗證信寄送太頻繁,請稍後再試",
  "over request rate limit": "嘗試太頻繁,請稍後再試",
  "too many requests": "嘗試太頻繁,請稍後再試",

  // --- 密碼 / 重設密碼 ---
  "new password should be different from the old password":
    "新密碼不能跟舊密碼一樣,請換一組新的密碼",
  "password should be at least 6 characters": "密碼至少要 6 個字元",
  "password is too short": "密碼太短了,請至少輸入 6 個字元",

  // --- 連結 / 憑證失效 ---
  "email link is invalid or has expired": "這個連結已經失效或過期,請重新操作一次取得新的連結",
  "token has expired or is invalid": "這個連結已經失效或過期,請重新操作一次取得新的連結",
  "auth session missing": "登入狀態已經失效,請重新登入一次",
  "invalid refresh token: refresh token not found": "登入狀態已經失效,請重新登入一次",

  // --- 伺服器端 ---
  "database error saving new user":
    "建立帳號時伺服器發生錯誤,請稍後再試一次,持續發生請聯絡系統管理員",
};

/** 帶變數、無法精準比對的訊息,用規則處理。順序有意義:由上往下第一個命中的就採用。 */
const PATTERN_RULES: { pattern: RegExp; toMessage: (match: RegExpMatchArray) => string }[] = [
  {
    // 例:"For security purposes, you can only request this after 46 seconds."
    pattern: /you can only request this after (\d+) seconds?/i,
    toMessage: (match) => `操作太頻繁,請等 ${match[1]} 秒後再試一次`,
  },
  {
    // 例:"Password should be at least 8 characters."(長度要求由 Supabase 專案設定決定)
    pattern: /password should be at least (\d+) characters?/i,
    toMessage: (match) => `密碼至少要 ${match[1]} 個字元`,
  },
  {
    // 例:"Email address \"foo@bar\" is invalid"
    pattern: /email address .* is invalid/i,
    toMessage: () => "Email 格式不正確,請檢查有沒有打錯",
  },
];

/** 比對用的正規化:去前後空白、轉小寫、去掉結尾的句點/驚嘆號。 */
function normalize(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
}

/**
 * 把 Supabase Auth 回傳的英文錯誤訊息換成中文。
 *
 * 對照表查不到的訊息「刻意」原樣回傳英文原文(不是換成通用的「請稍後再試」)——保留原文才有線索
 * 可以追查沒預期到的錯誤,而且之後看到使用者回報某句沒被翻譯的英文,就知道該往這張表補一條。
 */
export function translateAuthErrorMessage(message: string | null | undefined): string {
  if (!message) return "發生未知錯誤,請稍後再試";

  const normalized = normalize(message);
  const exact = EXACT_MESSAGE_MAP[normalized];
  if (exact) return exact;

  for (const rule of PATTERN_RULES) {
    const match = message.match(rule.pattern);
    if (match) return rule.toMessage(match);
  }

  return message;
}
