// 手機版容器寬度溢出修正(見 .project/specs/手機版容器寬度溢出修正.md 第三節)——
// 建立/清理 e2e/mobile-overflow.spec.ts 用的真實 fixture 資料。
//
// 為什麼要真的建立資料,不用 mock:這個 bug 的根因是「右側動態長文字撐開 flex 容器」,
// 只有真的用長 email/長電話號碼組合字串/長地址跑過一次真實畫面渲染才測得出來(比照
// 先前 QA 用真實長度 email 複驗才抓到 bug 的教訓,見 SPECS-INDEX 編號 183 的複驗紀錄)。
//
// 資料建立方式比照本專案過去所有 QA 複驗的做法:用 @supabase/supabase-js 以 anon key
// 透過「真實 signUp() 等效流程」建立一個全新測試帳號,再呼叫真正的 RPC/資料表操作
// (跟前端 src/modules/*/api.ts 呼叫的是同一組 RPC/資料表,不是另外模擬一套),
// 打的是正式 Supabase 專案(.env 的 wjtbmmnakcriuaqoknsq)——不會、也不可能碰到本機
// pgTAP 測試用的 Docker 容器,兩者是完全不同的資料庫。
//
// **已知限制(重要,請 code owner 留意)**:這個專案的資料庫刻意不開放「真刪除」商家/服務人員/
// 服務項目/料錢成本品項/預約(規則:分店只能停用不能真刪除,service_items/material_cost_items/
// merchant_staff/bookings 也都只有軟刪除 RLS 政策,沒有 DELETE 政策),這是刻意的業務規則,
// 不是這次測試沒做好。也就是說:一般開發者在自己機器上執行 `npm run test:e2e` 時,
// teardownMobileOverflowFixture() 只能做到「軟停用/軟移除」這些 fixture 資料,沒辦法把它們
// 從資料庫整個刪乾淨——底層資料列會留在正式的 wjtbmmnakcriuaqoknsq 專案裡(用
// `e2e-mobile-overflow-` 開頭的 email 跟商家名稱清楚標記,不會跟真實商家「涼風工匠」「美甲」或
// 真實帳號搞混)。要徹底清除這些殘留資料,需要有資料庫直接存取權限(例如 Supabase SQL Editor 或
// 有權限的維運人員),定期手動清除 `auth.users.email like 'e2e-mobile-overflow-%'` 這批資料——
// 這件事需要主腦或使用者確認可接受的處理方式(例如排定週期性手動清理),不是這次能在純前端
// client 呼叫範圍內自動解決的。這次交付驗收時,已經用 Supabase 的直接 SQL 存取權限把當次
// demo 用的 fixture 完整刪乾淨並查證過(見交付報告),但那是本次交付過程的人工步驟,
// 不是這個檔案本身能自動做到的事。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

import { getSupabaseAuthStorageKey } from "./supabase-storage-key";
import { buildTaipeiIso, getTaipeiNow, toDateKey } from "../../src/modules/booking/dateUtils";
import { disableFixtureMerchant } from "./merchant-teardown-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readEnvValue(key: string): string {
  const envPath = resolve(__dirname, "../../.env");
  const content = readFileSync(envPath, "utf-8");
  const line = content
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`) || l.startsWith(`${key} =`));
  if (!line) {
    throw new Error(
      `找不到 .env 裡的 ${key}——mobile-overflow 這個 e2e 測試需要它來建立 fixture 資料。`,
    );
  }
  const value = line.slice(line.indexOf("=") + 1).trim();
  return value.replace(/^["']|["']$/g, "");
}

// 比照 src/integrations/supabase/client.ts 的做法:新格式 publishable key(sb_publishable_...)
// 不是合法的 JWT,supabase-js 預設可能還是塞一個 `Authorization: Bearer <publishable key>`
// 標頭,要在真正送出的 fetch 裡拿掉,否則伺服器會判斷成一組格式錯誤的 JWT 而回應異常。
function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function buildFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }
    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

function createFixtureSupabaseClient(): SupabaseClient {
  const url = readEnvValue("VITE_SUPABASE_URL");
  const key = readEnvValue("VITE_SUPABASE_PUBLISHABLE_KEY");
  return createClient(url, key, {
    global: { fetch: buildFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// 刻意設計成「會撐開沒有防護的 flex 容器」的長文字測試資料(規格書第三節「測試資料」)。
// 全部不用純中文(中日韓文字預設就能逐字換行,不太會重現這個 bug),改用「長串不含空白的
// 數字/英文」模擬真實會出問題的情境(長電話號碼組合字串、長 email、地址裡的長網址片段、
// 長姓名的英文拼音),比照使用者原始回報的「客戶欄位」「客戶地址欄位」被撐開的實際樣態。
// ---------------------------------------------------------------------------
// #636/#637(SPECS-INDEX):merchant_staff.phone 這次改成 NOT NULL + CHECK(^09\d{8}$)
// (#595/#596,見 supabase/migrations/20260922140000_req595_596_staff_agent_phone_not_null_check.sql),
// 這個 40 碼組合字串不再是合法值,寫入 merchant_staff.phone 會直接被 CHECK 擋下。這裡繼續保留
// 常數本身(仍然可以合法用在 bookings.customer_phone——該欄位沒有格式 CHECK),但主要服務人員
// 的「電話欄位測溢出」情境改用下面的 LONG_STAFF_INTRO(merchant_staff.intro,純文字、無格式
// 限制),測的是同一個編輯對話框裡的另一個自由文字欄位,不影響原本要驗證「畫面會不會溢出」的
// 情境本身。
export const LONG_PHONE_COMBO = "0912345678" + "0987654321" + "0223456789" + "0955667788";
export const LONG_ADDRESS =
  "台北市信義區松仁路100號附近(地圖連結:" +
  "https://maps.example.test/loc/averylongunbrokenpathsegmentfortestingoverflowonly1234567890" +
  ")";
export const LONG_CUSTOMER_NAME_PREFIX = "E2E測試客戶";
export const LONG_CUSTOMER_NAME =
  LONG_CUSTOMER_NAME_PREFIX + "ChristopherWellingtonMontgomeryFitzgeraldThompsoniusOverflow";
export const LONG_STAFF_NAME_PREFIX = "E2E測試主要服務人員";
export const LONG_STAFF_NAME =
  LONG_STAFF_NAME_PREFIX + "AlexanderConstantinopleWashingtonOverflowStressTest";
export const LONG_ASSISTANT_NAME_PREFIX = "E2E測試助手";
export const LONG_ASSISTANT_NAME =
  LONG_ASSISTANT_NAME_PREFIX + "BartholomewFitzgeraldPendragonOverflowStressTest";
export const LONG_SERVICE_NAME_PREFIX = "E2E測試超長服務項目";
export const LONG_SERVICE_NAME =
  LONG_SERVICE_NAME_PREFIX + "WithAnUnbrokenEnglishSuffixForOverflowStressTesting1234567890";
export const SHORT_SERVICE_NAME = "E2E測試加購服務";
export const LONG_CATEGORY_NAME =
  "E2E測試超長分類名稱WithAnUnbrokenEnglishSuffixForOverflowStressTesting";
export const LONG_MATERIAL_NAME =
  "E2E測試超長料錢成本品項名稱WithAnUnbrokenEnglishSuffixForOverflowStressTesting";
export const LONG_NOTES = "備註內容刻意加長方便測試:" + "測試撐開容器".repeat(15);
export const LONG_STAFF_INTRO =
  "E2E測試服務人員簡介刻意加長方便測試撐開容器:" +
  "WithAnUnbrokenEnglishSuffixForOverflowStressTesting1234567890".repeat(3);

export interface MobileOverflowFixture {
  runId: string;
  email: string;
  password: string;
  session: Session;
  merchantId: string;
  groupId: string;
  staffMainId: string;
  staffAssistantId: string;
  serviceItemLongId: string;
  serviceItemShortId: string;
  categoryId: string;
  materialCostItemId: string;
  bookingId: string;
  bookingDateKey: string;
}

/** 建立這次測試需要的全部 fixture 資料,回傳建立好的各項 id,供 spec 檔案在畫面上定位元素、
 * 也供 teardown 使用。任何一步失敗就整個丟出例外,讓測試直接失敗、不要留下半套資料誤導判斷。 */
export async function setupMobileOverflowFixture(): Promise<MobileOverflowFixture> {
  const client = createFixtureSupabaseClient();
  const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  // email 本身就刻意夠長(70+ 字元),同時也是「商家設定頁-管理員名單」那一列要顯示的真實
  // 動態內容,一魚兩吃:既是測試帳號的識別字首,也是長 email 的重現素材。
  const email = `e2e-mobile-overflow-width-check-please-ignore-${runId}@example-overflow-test-domain.test`;
  const password = `E2eOverflow!${runId}Aa`;

  const { data: signUpData, error: signUpError } = await client.auth.signUp({ email, password });
  if (signUpError) {
    throw new Error(`建立 e2e 測試帳號失敗(signUp):${signUpError.message}`);
  }
  let session = signUpData.session;
  if (!session) {
    // 這個專案的正式 Supabase 專案目前設定是 signUp 後直接回傳可用 session(過去多次 QA
    // 複驗都是這樣操作成功的),如果哪天改成要求 email 驗證,這裡會很明確地失敗並說明原因,
    // 不會裝作成功接著誤判整批畫面測試結果。
    const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError || !signInData.session) {
      throw new Error(
        "建立 e2e 測試帳號後拿不到可用的 session——這個 Supabase 專案可能開啟了「需要驗證信箱才能登入」," +
          "跟過去 QA 複驗時的行為不一致,請確認 Authentication 設定,或改成用既有的、已驗證過的測試帳號" +
          `建立 session。原始錯誤:${signInError?.message ?? "signUp 沒有回傳 session"}`,
      );
    }
    session = signInData.session;
  }

  // 3.2:一次原子性建立集團+第一間商家,並自動把呼叫者登記為管理員。
  // 選 on_site_dispatch(到府派工),因為這個產業類型才會顯示「客戶地址」欄位(見
  // INDUSTRY_REQUIRES_CUSTOMER_ADDRESS),對應規格書要用長地址重現 bug 的情境。
  const merchantName = `E2E手機版容器寬度溢出測試商家${runId}`;
  const { data: merchantId, error: merchantError } = await client.rpc("create_group_and_merchant", {
    p_name: merchantName,
    p_industry_type: "on_site_dispatch",
    p_address: LONG_ADDRESS,
    p_contact_email: email,
    p_intro: "e2e-mobile-overflow 自動化測試用商家,測試完會清除/停用,不是真實商家。",
  });
  if (merchantError || !merchantId) {
    throw new Error(`建立測試商家失敗:${merchantError?.message ?? "沒有回傳 merchant id"}`);
  }

  const { data: merchantRow, error: fetchMerchantError } = await client
    .from("merchants")
    .select("group_id")
    .eq("id", merchantId as string)
    .single();
  if (fetchMerchantError || !merchantRow) {
    throw new Error(`查詢測試商家的 group_id 失敗:${fetchMerchantError?.message}`);
  }
  const groupId = (merchantRow as { group_id: string }).group_id;

  // 1.1(隱含):七天都開 08:00-21:00,避免測試依賴「今天剛好是星期幾」這種易碎條件,
  // 週檢視格線才會渲染出來(否則會顯示「尚未設定這天的營業時間」,連格線都不出現)。
  const businessHoursRows = Array.from({ length: 7 }, (_, dayOfWeek) => ({
    merchant_id: merchantId as string,
    day_of_week: dayOfWeek,
    is_closed: false,
    open_time: "08:00",
    close_time: "21:00",
  }));
  const { error: hoursError } = await client
    .from("merchant_business_hours")
    .upsert(businessHoursRows, { onConflict: "merchant_id,day_of_week" });
  if (hoursError) throw new Error(`寫入測試商家營業時間失敗:${hoursError.message}`);

  // 3.4:服務人員。unlimited_backend_edit=true 讓 create_booking 略過營業時間/可預約時段/
  // 跨日檢查(見 supabase/migrations/20260917100200_booking_expansion_functions.sql 的
  // check_staff_booking_slot),測試只在意「畫面會不會溢出」,不需要額外處理時段邊界。
  // #636/#637(SPECS-INDEX):merchant_staff.phone 這次改成 NOT NULL + CHECK(^09\d{8}$)
  // (#595/#596),原本刻意塞在這裡測「電話欄位超長文字溢出」的 LONG_PHONE_COMBO(40 碼組合
  // 字串)已經不符合這個格式,寫入會直接被 CHECK 擋下。改用合法格式的佔位電話,同一個編輯
  // 對話框裡改用 LONG_STAFF_INTRO(merchant_staff.intro,自由文字、無格式限制)延續原本
  // 「這個對話框裡也有一個超長文字欄位」的測試情境。
  const staffMainPhone = `09${runId.slice(-7)}0`;
  const { data: staffMain, error: staffMainError } = await client
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId as string,
      name: LONG_STAFF_NAME,
      phone: staffMainPhone,
      intro: LONG_STAFF_INTRO,
      contact_email: email,
      is_listed: true,
      no_time_slot_limit: true,
      unlimited_backend_edit: true,
    })
    .select("id")
    .single();
  if (staffMainError || !staffMain)
    throw new Error(`建立測試主要服務人員失敗:${staffMainError?.message}`);

  // 助手用另一組合法格式的佔位電話,跟上面 staffMain 的電話區分開來,避免同一次測試 run
  // 建立的兩位服務人員撞號。
  const staffAssistantPhone = `09${runId.slice(-7)}1`;
  const { data: staffAssistant, error: staffAssistantError } = await client
    .from("merchant_staff")
    .insert({
      merchant_id: merchantId as string,
      name: LONG_ASSISTANT_NAME,
      phone: staffAssistantPhone,
      is_listed: true,
      no_time_slot_limit: true,
      unlimited_backend_edit: true,
    })
    .select("id")
    .single();
  if (staffAssistantError || !staffAssistant) {
    throw new Error(`建立測試助手失敗:${staffAssistantError?.message}`);
  }

  // 服務項目管理頁的「分類」區塊,測試一個超長分類名稱是否會撐開容器。
  const { data: category, error: categoryError } = await client
    .from("service_categories")
    .insert({ merchant_id: merchantId as string, name: LONG_CATEGORY_NAME })
    .select("id")
    .single();
  if (categoryError || !category) throw new Error(`建立測試服務分類失敗:${categoryError?.message}`);

  const { data: svcLong, error: svcLongError } = await client
    .from("service_items")
    .insert({
      merchant_id: merchantId as string,
      category_id: (category as { id: string }).id,
      name: LONG_SERVICE_NAME,
      price: 888,
      item_type: "primary",
      duration_minutes: 30,
    })
    .select("id")
    .single();
  if (svcLongError || !svcLong)
    throw new Error(`建立測試服務項目(長名稱)失敗:${svcLongError?.message}`);

  const { data: svcShort, error: svcShortError } = await client
    .from("service_items")
    .insert({
      merchant_id: merchantId as string,
      name: SHORT_SERVICE_NAME,
      price: 100,
      item_type: "addon",
      duration_minutes: 15,
    })
    .select("id")
    .single();
  if (svcShortError || !svcShort)
    throw new Error(`建立測試服務項目(短名稱)失敗:${svcShortError?.message}`);

  // 2.3/決策記錄 4:料錢成本功能預設關閉,測試要看得到管理頁/建單表單的料錢成本區塊,
  // 要先開啟這個功能開關(比照 BusinessHoursPage.tsx 的 MaterialCostEnabledToggle 呼叫方式)。
  const { error: flagError } = await client
    .from("merchant_feature_flags")
    .upsert(
      { merchant_id: merchantId as string, feature_key: "material_cost_enabled", enabled: true },
      { onConflict: "merchant_id,feature_key" },
    );
  if (flagError) throw new Error(`開啟測試商家的料錢成本功能開關失敗:${flagError.message}`);

  const { data: materialItem, error: materialItemError } = await client
    .from("material_cost_items")
    .insert({ merchant_id: merchantId as string, name: LONG_MATERIAL_NAME, amount: 250 })
    .select("id")
    .single();
  if (materialItemError || !materialItem) {
    throw new Error(`建立測試料錢成本品項失敗:${materialItemError?.message}`);
  }

  // 3.3/4.1:建立一筆預約,時段選在「今天」(Asia/Taipei)10:00,搭配全天開放的營業時間跟
  // unlimited_backend_edit 的服務人員,不需要煩惱測試執行當下實際是星期幾。
  const bookingDateKey = toDateKey(getTaipeiNow());
  const startAt = buildTaipeiIso(bookingDateKey, "10:00");

  // #604(SPECS-INDEX,對應 supabase/migrations/20260922160600_req604_payment_method_required.sql):
  // create_booking 付款方式已改為必填(p_payment_method_id 不能是 null),否則 RPC 直接 raise
  // exception「請選擇付款方式」。create_group_and_merchant 建立商家時已經自動呼叫
  // seed_default_payment_methods(),這裡直接查一筆該商家目前的啟用中付款方式來用(比照
  // e2e/support/line-notifications-fixture.ts 既有做法)。
  const { data: paymentMethod, error: paymentMethodError } = await client
    .from("payment_methods")
    .select("id")
    .eq("merchant_id", merchantId as string)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (paymentMethodError || !paymentMethod) {
    throw new Error(
      `查詢測試商家的預設付款方式失敗:${paymentMethodError?.message ?? "查無啟用中的付款方式"}`,
    );
  }

  const { data: booking, error: bookingError } = await client.rpc("create_booking", {
    p_merchant_id: merchantId as string,
    p_staff_id: (staffMain as { id: string }).id,
    // create_booking 簽章在「建單功能擴充」批次(migration 20260918110200 附近)已經從
    // p_service_item_ids(純字串陣列)改成 p_service_items(jsonb 物件陣列,每個元素帶
    // service_item_id/quantity/unit_price),比照 src/modules/booking/api.ts 的
    // buildServiceItemsJsonb 既有寫法,quantity 固定 1、unit_price 對應各自建立時的 price。
    p_service_items: [
      { service_item_id: (svcLong as { id: string }).id, quantity: 1, unit_price: 888 },
      { service_item_id: (svcShort as { id: string }).id, quantity: 1, unit_price: 100 },
    ],
    p_start_at: startAt,
    p_customer_name: LONG_CUSTOMER_NAME,
    p_customer_phone: LONG_PHONE_COMBO,
    p_notes: LONG_NOTES,
    p_assistant_staff_ids: [(staffAssistant as { id: string }).id],
    p_material_cost_item_ids: [(materialItem as { id: string }).id],
    p_customer_address: LONG_ADDRESS,
    p_payment_method_id: (paymentMethod as { id: string }).id,
  });
  if (bookingError || !booking) throw new Error(`建立測試預約失敗:${bookingError?.message}`);

  return {
    runId,
    email,
    password,
    session,
    merchantId: merchantId as string,
    groupId,
    staffMainId: (staffMain as { id: string }).id,
    staffAssistantId: (staffAssistant as { id: string }).id,
    serviceItemLongId: (svcLong as { id: string }).id,
    serviceItemShortId: (svcShort as { id: string }).id,
    categoryId: (category as { id: string }).id,
    materialCostItemId: (materialItem as { id: string }).id,
    bookingId: (booking as { id: string }).id,
    bookingDateKey,
  };
}

/** 把 fixture 的真實 session 灌進瀏覽器 localStorage,讓 Playwright 開的頁面直接是「已登入」
 * 狀態,不用每個測試都重新跑一次真的登入表單流程(比照 e2e/auth-guard-redirect-loop.spec.ts
 * 注入 session 的做法,差別只在於這裡灌的是一組真的、簽章有效的 session)。 */
export async function injectFixtureSession(
  page: Page,
  fixture: MobileOverflowFixture,
): Promise<void> {
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(fixture.session)] as [string, string],
  );
}

/** 給「超級管理員後台」這個選用測試區塊用:用一組已存在的帳密登入(不是這個檔案建立的),
 * 灌進瀏覽器 localStorage。見 e2e/mobile-overflow.spec.ts 開頭關於 platform_admins 這張表
 * 沒有開放自助寫入、沒辦法自動建立測試帳號的說明。 */
export async function injectSessionForCredentials(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  const client = createFixtureSupabaseClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`登入測試帳號 ${email} 失敗:${error?.message ?? "沒有回傳 session"}`);
  }
  const storageKey = getSupabaseAuthStorageKey();
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(data.session)] as [string, string],
  );
}

/** 測試結束後盡量把 fixture 清乾淨。**見檔案開頭註解的已知限制**:這裡只能做到 RLS 允許
 * client 端操作的「軟停用/軟移除」,沒辦法把底層資料列真的從資料庫刪掉(這是這個專案刻意
 * 的業務規則,不是這次沒做完)。回傳值列出實際做了哪些清理動作,方便 CI/終端機日誌留下紀錄。 */
export async function teardownMobileOverflowFixture(
  fixture: MobileOverflowFixture,
): Promise<string[]> {
  const client = createFixtureSupabaseClient();
  const { error: sessionError } = await client.auth.setSession({
    access_token: fixture.session.access_token,
    refresh_token: fixture.session.refresh_token,
  });
  if (sessionError) {
    return [`警告:無法還原測試帳號 session,略過軟清理(${sessionError.message})`];
  }

  const actions: string[] = [];

  const { error: cancelError } = await client.rpc("cancel_booking", {
    p_booking_id: fixture.bookingId,
    p_reason: "e2e-mobile-overflow 測試結束,自動取消 fixture 預約。",
  });
  actions.push(
    cancelError ? `取消 fixture 預約失敗:${cancelError.message}` : "已取消 fixture 預約",
  );

  const { error: staffMainError } = await client
    .from("merchant_staff")
    .update({ status: "removed" })
    .eq("id", fixture.staffMainId);
  const { error: staffAssistantError } = await client
    .from("merchant_staff")
    .update({ status: "removed" })
    .eq("id", fixture.staffAssistantId);
  actions.push(
    staffMainError || staffAssistantError
      ? `移除 fixture 服務人員失敗:${staffMainError?.message ?? staffAssistantError?.message}`
      : "已移除 fixture 服務人員(軟刪除)",
  );

  const { error: svcError } = await client
    .from("service_items")
    .update({ status: "removed" })
    .in("id", [fixture.serviceItemLongId, fixture.serviceItemShortId]);
  actions.push(
    svcError ? `下架 fixture 服務項目失敗:${svcError.message}` : "已下架 fixture 服務項目(軟刪除)",
  );

  const { error: materialError } = await client
    .from("material_cost_items")
    .update({ status: "removed" })
    .eq("id", fixture.materialCostItemId);
  actions.push(
    materialError
      ? `下架 fixture 料錢成本品項失敗:${materialError.message}`
      : "已下架 fixture 料錢成本品項(軟刪除)",
  );

  // service_categories 有 DELETE 政策(真刪除),可以真的清掉。
  const { error: categoryError } = await client
    .from("service_categories")
    .delete()
    .eq("id", fixture.categoryId);
  actions.push(
    categoryError
      ? `刪除 fixture 服務分類失敗:${categoryError.message}`
      : "已刪除 fixture 服務分類",
  );

  // merchant_business_hours 有 DELETE 政策,一併清掉,恢復「查無設定」的初始狀態。
  const { error: hoursError } = await client
    .from("merchant_business_hours")
    .delete()
    .eq("merchant_id", fixture.merchantId);
  actions.push(
    hoursError
      ? `刪除 fixture 營業時間設定失敗:${hoursError.message}`
      : "已刪除 fixture 營業時間設定",
  );

  // merchants 沒有真刪除的管道(規則 8:分店只能停用不能真刪除),這裡做到停用是 client 端
  // 能做到的最大程度,底層資料列的真刪除留給有資料庫直接存取權限的人工清理(見檔案開頭註解)。
  // #638:直接停用會被「集團底下至少要保留一間啟用中商家」擋下(這裡建立時是集團裡唯一一間),
  // disableFixtureMerchant 會先建立同集團的空殼佔位商家繞開這條規則,見
  // e2e/support/merchant-teardown-helper.ts 開頭說明。
  actions.push(await disableFixtureMerchant(client, fixture.merchantId));

  return actions;
}
