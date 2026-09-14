# Miao Yue Dispatch

Build a SaaS landing page + authenticated app shell for "秒約 (Miao Yue)" — a dispatch & booking management system for service businesses (both in-store services like beauty/hair/massage/chiropractic, and on-site dispatch services like AC repair/waterproofing/plumbing). It connects three user roles: merchant back-office staff, field service staff, and end customers who self-book appointments.

Reference structure: model the page after a professional B2B SaaS site with a light theme, tech-blue primary color, green CTA accent color, "before/after" comparison sections, and generous whitespace — modern sans-serif typography (Inter or similar).

The site must include a public landing page (/) with these sections IN THIS ORDER:

1. NAVIGATION HEADER: Logo "秒約" on the left. Four nav links: 「功能特色」「方案定價」「適用產業」「常見問題」. Top-right: a primary button labeled "登入 / Sign in".

2. HERO SECTION: Large headline 「秒約,派工排程一次搞定」. Subtext 「客戶預約、師傅排程、帳務結算,一套系統全部串起來——到店服務、到府派工都適用」. Primary CTA button 「立即登入」.

3. REAL-TIME SYNC SHOWCASE: A mocked dashboard preview panel showing a list of today's orders with status badges (「待確認」/「已確認」/「已完成」) and a LINE notification timestamp example. Purely visual/illustrative, no real data.

4. PAIN POINT COMPARISON (two-column "導入前 / 導入後" layout):
   導入前 (5 items): 訊息散落難追蹤、跨店排程常撞期、抽成薪資靠人工對帳、排休記錄零散、會員資料沒系統化留存
   導入後 (5 items, each answering the item above): 智慧建單自動解析、行事曆跨店共用自動避開衝突、按件計酬/月薪雙軌自動算薪、排休時段化+月休天數自動核算、會員紅利/推薦系統整合

5. PRODUCT POSITIONING STATEMENT: A centered value-prop paragraph: 「秒約是為到店服務與到府派工業者打造的派工預約系統,提供商家後台、師傅端排程介面、客戶自助預約頁,一套系統涵蓋接單到結算全流程。」

6. CORE FEATURES (id="功能特色"), 9 feature cards, each with an icon, title, and 1-2 sentence description:
   Card 1「智慧建單」— 輸入文字訊息自動解析並填好預約內容,人工確認送出即可
   Card 2「跨店共用行事曆」— 同一服務人員在多商家的行程共用,自動避開時段衝突
   Card 3「LINE通知整合」— 預約狀態變化自動發送LINE通知給客戶與師傅
   Card 4「彈性計薪」— 按件計酬與月薪制並存,系統自動算薪、自動算請假扣款
   Card 5「排班排休管理」— 整天休/時段休皆可設定,月休天數自動核算出勤門檻
   Card 6「會員與紅利系統」— 會員分級、紅利點數、推薦獎勵、生日贈點一次管理
   Card 7「產業模組化」— 新增商家時選擇到店服務或到府派工模組,自動套用一組建議功能開關
   Card 8「多元支付整合」— 現場支付、銀行匯款、LINE Pay、街口、信用卡,依商家需求開啟
   Card 9「師傅端行動排程介面」— 手機瀏覽器即可查看訂單、回報完工、確認排休,不需另外下載App

7. WORKFLOW SECTION, 4 numbered steps with connecting arrows:
   1「客戶或客服建單」 2「系統智慧解析並指派師傅」 3「師傅接單、到場、完工回報」 4「系統自動核算抽成與薪資」

8. STAFF MOBILE INTERFACE SECTION: Explicitly a **responsive web interface accessed via mobile browser** (NOT a native app — do not add App Store / Google Play badges or download buttons). Show a mocked phone-frame screenshot of the staff view with: 我的訂單列表、當日排程、完工回報按鈕、我的帳務摘要. Caption: 「師傅端不用下載App,手機瀏覽器打開就能用」.

9. PRICING SECTION (id="方案定價"), two pricing cards side by side:
   Card 1「基礎版」— 「$99/月起」,說明文字「含1間商家、最多3位服務人員」
   Card 2「進階版」— 「每間商家 $399/月 + 每位服務人員 $199/月」,說明文字「適合多分店、多師傅團隊」
   Add a small note under the pricing cards: 「（以上為暫定方案,正式定價待確認）」

10. INDUSTRY USE CASES (id="適用產業"), 2 cards:
    Card 1「到店服務」— 美業/美髮/按摩/整骨等,客戶到店預約
    Card 2「到府派工」— 冷氣維修/防水工程/水電等,師傅到府服務

11. ADVANTAGES SUMMARY, 4 short highlight items: 「少漏單」「跨店不撞期」「薪資自動算」「會員留得住」

12. ONBOARDING FLOW, 3 steps: 「1. 選擇產業模組」「2. 設定服務項目與人員」「3. 開始接單」

13. FAQ SECTION (id="常見問題"), 8 Q&A pairs:
    Q1 收費怎麼算? Q2 需要綁約嗎? Q3 師傅端要下載App嗎? Q4 LINE通知怎麼設定? Q5 適合多小的團隊使用? Q6 資料安全嗎? Q7 大概多久能上線? Q8 哪些產業適用?
    (Write plausible short placeholder answers for each, tone should be reassuring and concise.)

14. CONTACT METHODS: Show placeholder contact channels — LINE官方帳號 icon + Email icon (use placeholder values like line@example / hello@miaoyue.app).

15. CONTACT FORM: Fields — 產業類型 (dropdown: 到店服務/到府派工), 公司名稱, 分店數量, 師傅人數, 聯絡電話, LINE ID, 需求說明 (textarea). Submit button 「送出需求」. This form does not need to actually persist anywhere — visual only for v1.

16. FOOTER: Logo「秒約」+ three nav columns (產品/支援/聯絡) each with 2-3 placeholder links, legal links (服務條款/隱私政策, placeholder pages fine), copyright 「© 2026 秒約」.

AUTHENTICATION (use whatever auth backend Lovable provides by default — Lovable Cloud is fine for this v1; we'll swap to a user-owned Supabase project in a later step):
- Sign Up page with email + password
- Sign In page with email + password
- Sign Out functionality
- Email confirmation can be disabled for simplicity in this v1

AUTHENTICATED APP SHELL at /app (the page users land on after signing in):
- Greets the signed-in user: 「Hi {user.email}」
- Placeholder message: 「你的派工管理後台即將上線 — 下一個里程碑會加上商家、師傅與訂單管理功能。」
- A Sign Out button in the header

Design requirements:
- Light theme, tech-blue primary color, green as CTA/accent color
- Use Inter or a similar sans-serif font
- Mobile responsive
- Tasteful subtle animations (fade-in on scroll is fine; don't overdo it)
- Generous whitespace, centered alignment for section headers (matching a professional B2B SaaS tone)

Out of scope for this v1: real booking form, real payment integration, real database tables for merchants/staff/customers/orders (do NOT create custom tables — only use Supabase's default auth.users), the contact form does not need a real backend. Those come in later milestones. Stick to landing page + auth + placeholder dashboard.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/d101fcb9-62d7-48cb-a4e8-91e2b4472c50).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
