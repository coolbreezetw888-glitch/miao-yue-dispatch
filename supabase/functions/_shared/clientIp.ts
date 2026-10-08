// 客戶端 Edge Function 共用:頻率限制用的來源 IP。
// 第 2 批 customer-line-login 原本寫在自己的 index.ts,第 3 批 customer-booking-submit 也要用同一段(規格 C3-G03),
// 搬到這裡兩邊共用(customer-line-login 仍以同名 export 轉出,既有測試不用改)。
//
// QA 第 2 批:不能用客人自己可以偽造的那一段。
//   1. cf-connecting-ip:正式環境前面是 Cloudflare,這個標頭由 Cloudflare 依「實際連線的 IP」覆寫,客人改不了。
//   2. 沒有 cf-connecting-ip(本機 Kong)時,用 X-Forwarded-For 的「最後一段」:客人自己帶的值永遠在前面,
//      代理會把它看到的連線 IP 接在最後面(例:客人送「1.2.3.4」⇒ 收到「1.2.3.4, <真的 IP>」)。
//   3. 都沒有 ⇒ "unknown"(所有這種請求共用同一個額度,寧可嚴不可鬆)。
//   x-real-ip 一律不讀。
// 出處:Supabase 社群實測(github.com/orgs/supabase/discussions/34647):偽造 XFF 時真正的 IP 被接在最後、
// cf-connecting-ip 是真的 IP;Supabase 官方文件沒有正式寫明,部署後主腦請用 curl 偽造一次確認。

export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "unknown";
}
