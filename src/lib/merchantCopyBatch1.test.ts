// SPECS-INDEX #973 / #974 / #976 / #977(2026-10-06,商家端文案與說明調整第 1 批)的文案守門測試。
// 規格書:.project/specs/商家端文案與說明調整-第1批.md(第六節第 1 點)。
//
// 這支測的是「文字有沒有照使用者定案的版本」與「改名後舊名稱有沒有殘留」,都是純資料 / 原始碼斷言,
// 不渲染畫面(畫面行為 ——「?」開關 —— 在 components/patterns/PageHeaderHelp.test.tsx)。
// 🔴 刻意用中文字串逐字比對:「畫面中文字改了、測試就跟著紅」本身就是一層保護。

import { describe, expect, it } from "vitest";

import { OFFICIAL_LINE_AT_URL } from "@/lib/officialContact";
import { LINE_LOG_EVENT_TYPE_LABELS } from "@/modules/line-notifications/types";
import {
  AGENT_PERMISSION_SECTIONS,
  STAFF_BOOLEAN_PERMISSION_FIELDS,
  STAFF_NUMBER_PERMISSION_FIELDS,
  visibleAgentPermissionSections,
} from "@/modules/staff-agent/types";
import { resolveAppHeaderTitle } from "@/routes/appLayoutLogic";
import { readSourceWithoutComments, scanSourceLines } from "@/test/sourceScan";

// ---------------------------------------------------------------------------
// #973:「功能」頁卡片點進去的頁,PageHeader 一律開 helpMode
// ---------------------------------------------------------------------------

/** 功能頁(ManagePage.tsx cards 陣列)每張卡片點進去的頁面檔。排班一覽目前卡片隱藏,但頁面仍是同一類,一併開。 */
const FUNCTION_CARD_PAGES = [
  "src/modules/staff-agent/StaffListPage.tsx",
  "src/modules/staff-agent/AgentListPage.tsx",
  "src/modules/service-items/ServiceItemsPage.tsx",
  "src/modules/booking/BusinessHoursPage.tsx",
  "src/modules/booking/MaterialCostsPage.tsx",
  "src/modules/booking/PaymentMethodsPage.tsx",
  "src/modules/scheduling/LeaveTypesPage.tsx",
  "src/modules/scheduling/LeaveRecordsPage.tsx",
  "src/modules/scheduling/SchedulingOverviewPage.tsx",
  "src/modules/payroll/PayrollSettingsPage.tsx",
  "src/modules/payroll/StaffReportPage.tsx",
  "src/modules/members/MembersListPage.tsx",
  "src/modules/members/MemberPointsPage.tsx",
  "src/modules/members/MemberSettingsPage.tsx",
  "src/modules/line-notifications/LineSettingsPage.tsx",
  "src/modules/line-notifications/LineEventSettingsPage.tsx",
  "src/modules/line-notifications/LineLogsPage.tsx",
  "src/modules/line-notifications/LineMarketingPage.tsx",
  "src/modules/push-notifications/PushEventSettingsPage.tsx",
  "src/modules/push-notifications/PushLogsPage.tsx",
  "src/modules/data-tools/ImportWizardPage.tsx",
  "src/modules/data-tools/ReportExportCenterPage.tsx",
  "src/modules/merchant/MerchantSettingsPage.tsx",
];

/** 底部選單直達頁:**不**開 helpMode(使用者裁決 H-2 只限功能頁卡片)。 */
const BOTTOM_TAB_PAGES = [
  "src/modules/booking/OrdersPage.tsx",
  "src/modules/booking/CalendarPage.tsx",
  "src/modules/payroll/BillingReportPage.tsx",
];

describe("#973 功能頁說明收成「?」", () => {
  it.each(FUNCTION_CARD_PAGES)("%s 的 PageHeader 開了 helpMode", (file) => {
    const src = readSourceWithoutComments(file);
    expect(src).toMatch(/<PageHeader\s[^>]*?\bhelpMode\b/);
  });

  it.each(BOTTOM_TAB_PAGES)("%s(底部選單直達頁)不開 helpMode", (file) => {
    const src = readSourceWithoutComments(file);
    expect(src).not.toMatch(/\bhelpMode\b/);
  });
});

// ---------------------------------------------------------------------------
// #974:各頁說明改寫 + 三個改名
// ---------------------------------------------------------------------------

describe("#974 各頁說明(抽查)", () => {
  const cases: Array<[string, string]> = [
    [
      "src/modules/line-notifications/LineMarketingPage.tsx",
      "挑選已綁定 LINE 的會員名單，發送一次性的自訂文字訊息（不是自動化排程）。",
    ],
    [
      "src/modules/push-notifications/PushEventSettingsPage.tsx",
      "設定每一類事件要不要發推播，以及文案內容。商家管理員、客服、服務人員都要在自己的手機或瀏覽器開啟通知才收得到。",
    ],
    [
      "src/modules/data-tools/ImportWizardPage.tsx",
      "上傳 CSV，把舊系統的資料匯入——這是通用的欄位對應工具，不是一鍵搬家，商家需要先自己把舊系統資料匯出成 CSV。匯入後可以查看匯入紀錄，也可以一鍵復原。",
    ],
    [
      "src/modules/data-tools/ReportExportCenterPage.tsx",
      "這裡是彙整入口，店家報表、服務人員報表頁面上原有的匯出按鈕依然可以使用，兩者資料來源相同。",
    ],
    ["src/modules/booking/BusinessHoursPage.tsx", "」的每週營業時間與嚴格工時衝突檢查設定。"],
    ["src/modules/members/MemberPointsPage.tsx", "」的紅利點數是否開啟以及規則設定。"],
  ];
  it.each(cases)("%s", (file, expected) => {
    expect(readSourceWithoutComments(file)).toContain(expected);
  });

  it("LINE 串接設定:官方 LINE@ 連結先預留(常數是空字串,不放假網址),說明含設定費", () => {
    expect(OFFICIAL_LINE_AT_URL).toBe("");
    const src = readSourceWithoutComments("src/modules/line-notifications/LineSettingsPage.tsx");
    expect(src).toContain(
      "串接 LINE 官方帳號，之後訂單、請假等通知才能真正送出。※若不會設定，可聯繫我們的",
    );
    expect(src).toContain("<OfficialLineAtLink />");
    expect(src).toContain("協助設定，將酌收設定費 $3000。");
  });

  it("三個改名:頁首標題(appLayoutLogic)", () => {
    expect(resolveAppHeaderTitle({ pathname: "/app/service-items", isStaffView: false })).toBe(
      "服務項目",
    );
    expect(resolveAppHeaderTitle({ pathname: "/app/member-points", isStaffView: false })).toBe(
      "紅利點數",
    );
    expect(resolveAppHeaderTitle({ pathname: "/app/line-marketing", isStaffView: false })).toBe(
      "再行銷通知",
    );
  });

  it("三個改名:功能卡片、頁面 H1、LINE 發送記錄的事件名稱", () => {
    const manage = readSourceWithoutComments("src/routes/ManagePage.tsx");
    expect(manage).toContain('label: "服務項目",');
    expect(manage).toContain('label: "紅利點數",');
    expect(manage).toContain('label: "再行銷通知",');
    expect(readSourceWithoutComments("src/modules/service-items/ServiceItemsPage.tsx")).toContain(
      'title="服務項目"',
    );
    expect(readSourceWithoutComments("src/modules/members/MemberPointsPage.tsx")).toContain(
      'title="紅利點數"',
    );
    expect(
      readSourceWithoutComments("src/modules/line-notifications/LineMarketingPage.tsx"),
    ).toContain('title="再行銷通知"');
    expect(LINE_LOG_EVENT_TYPE_LABELS["marketing_manual"]).toBe("再行銷通知");
  });
});

// ---------------------------------------------------------------------------
// 改名後,舊名稱不可再出現在 src/ 的畫面文字(註解、測試檔除外;資料庫 key / 路由本來就是英文)
// ---------------------------------------------------------------------------

/**
 * 舊名稱 → 怎麼比對。
 * - 一般:只要出現就算(這些詞沒有其他正當用法)。
 * - 「行銷通知」:「再行銷通知」也包含這四個字,所以排除前面是「再」的。
 * - 「抽成設定」「下載報表」:這兩組字本身是一般用語(「王小明的抽成設定」「按下載報表」),
 *   只有當成**名稱**引用時才算舊名殘留 ⇒ 只比對「」括起來或單獨一整個字串常值的寫法。
 */
const OLD_NAME_MATCHERS: Array<{ name: string; test: (line: string) => boolean }> = [
  { name: "服務項目管理", test: (l) => l.includes("服務項目管理") },
  { name: "紅利點數管理", test: (l) => l.includes("紅利點數管理") },
  { name: "行銷通知", test: (l) => /(?<!再)行銷通知/.test(l) },
  { name: "帳務管理", test: (l) => l.includes("帳務管理") },
  { name: "團隊休假", test: (l) => l.includes("團隊休假") },
  { name: "抽成設定", test: (l) => /「抽成設定」|["'`]抽成設定["'`]/.test(l) },
  { name: "下載報表", test: (l) => /「下載報表」|["'`]下載報表["'`]/.test(l) },
];

describe("改名後舊名稱不再出現在畫面文字", () => {
  const lines = scanSourceLines();
  it.each(OLD_NAME_MATCHERS.map((m) => [m.name, m] as const))("「%s」", (_name, matcher) => {
    const hits = lines
      .filter((l) => matcher.test(l.text))
      .map((l) => `${l.file}:${l.line}  ${l.text.trim().slice(0, 100)}`);
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #976:客服權限設定 —— 排序與說明
// ---------------------------------------------------------------------------

describe("#976 客服權限設定", () => {
  it("顯示順序:底部選單(訂單管理 → 店家報表)在前,其餘照功能頁卡片順序", () => {
    expect(visibleAgentPermissionSections().map((s) => s.label)).toEqual([
      "訂單管理",
      "店家報表",
      "服務人員",
      "服務項目",
      "營業時間設定",
      "料錢成本管理",
      "付款方式管理",
      "月薪人員假別設定",
      "抽成與薪資設定",
      "服務人員報表",
      "會員管理",
      "紅利點數",
      "會員系統設定",
      "LINE 通知設定",
      // #976 第 3 批:新增「再行銷通知」,排在 LINE 通知設定之後、推播通知設定之前。
      "再行銷通知",
      "推播通知設定",
      "報表匯出中心",
    ]);
  });

  it("key 一個都沒改(只改名稱與順序)", () => {
    const keyOf = (label: string) =>
      visibleAgentPermissionSections().find((s) => s.label === label)?.key;
    expect(keyOf("店家報表")).toBe("billing");
    expect(keyOf("服務人員")).toBe("staff_management");
    expect(keyOf("服務項目")).toBe("service_items");
    expect(keyOf("紅利點數")).toBe("member_points");
    expect(keyOf("抽成與薪資設定")).toBe("commission_settings");
    expect(keyOf("報表匯出中心")).toBe("report_export");
    expect(keyOf("月薪人員假別設定")).toBe("team_leave");
    expect(keyOf("再行銷通知")).toBe("line_marketing");
  });

  it("#976 第 3 批:「再行銷通知」名稱與說明逐字", () => {
    const section = AGENT_PERMISSION_SECTIONS.find((s) => s.key === "line_marketing");
    expect(section?.label).toBe("再行銷通知");
    expect(section?.description).toBe(
      "開放後客服可以挑選已綁定 LINE 的會員名單，發送一次性的自訂文字訊息。",
    );
    expect(section?.hidden).toBeFalsy();
  });

  it("說明(抽查)", () => {
    const desc = (key: string) =>
      visibleAgentPermissionSections().find((s) => s.key === key)?.description;
    expect(desc("billing")).toBe("開放後客服可以查看店家報表。");
    expect(desc("push_notification")).toBe(
      "開放後會連同推播發送記錄一起打開，客服可以設定每一類事件要不要發推播、文案內容。",
    );
    // #986 第 9 批(使用者裁決 1):加註個資。
    expect(desc("report_export")).toBe(
      "開放後客服可以打開報表匯出中心並下載報表。下載的報表含客戶電話等個人資料，請只開放給需要的客服。",
    );
    expect(desc("team_leave")).toBe(
      "開放後會連同請假紀錄功能一起打開，客服可以新增、編輯、下架商家自訂的假別清單，以及登記/取消月薪制服務人員的請假紀錄。",
    );
  });

  it("抽成與薪資設定:補回仍存在的「抽成基準」,已刪除的「預設比例」「月折算天數」不可出現", () => {
    const d = visibleAgentPermissionSections().find(
      (s) => s.key === "commission_settings",
    )!.description;
    // #985 第 8 批 8-4:「調整商家的抽成基準」依規格書改寫成「調整料錢是否影響抽成(在料錢成本管理頁)」
    // ——設定本身仍在(只是修改入口搬到料錢成本管理頁),所以斷言跟著改成新說法。
    expect(d).toContain("料錢是否影響抽成");
    expect(d).toContain("料錢成本管理頁");
    // #986 第 9 批(主腦裁決):只有這把鑰匙的客服改不到料錢頁的開關 ⇒ 說明要寫出「需同時開啟料錢成本管理權限」。
    expect(d).toContain(
      "料錢是否影響抽成的開關在料錢成本管理頁，需要同時開啟「料錢成本管理」權限才能修改。",
    );
    expect(d).not.toContain("預設比例");
    expect(d).not.toContain("月折算天數");
    // #996 第 11 批 K-11:這把鑰匙多了「重新計算抽成」的能力 ⇒ 說明最後補一句。
    expect(d.endsWith("也可以在已完成訂單的詳情按「重新計算抽成」。")).toBe(true);
  });

  // #976 補修(2026-10-06,使用者實機發現):說明裡殘留「對應模組 8」這類內部用語與半形標點。
  // 用完整定義 AGENT_PERMISSION_SECTIONS(含隱藏中的「排班一覽」),還原隱藏項目時也不會帶著舊文字回來。
  // #990 第 11 批(#986 裁決 6 全站規則):括號、斜線改用半形 ⇒ 不再擋半形 ( ),改成擋全形 （ ） ／;
  // 半形逗號、冒號照樣擋。
  it("所有名稱與說明:不含內部用語(模組/規格書),不含半形 , :,也不含全形 （ ） ／", () => {
    const bad = AGENT_PERMISSION_SECTIONS.flatMap((s) =>
      [s.label, s.description]
        .filter((t) => /模組|規格書|[,:]|[（）／]/.test(t))
        .map((t) => `${s.key}: ${t}`),
    );
    expect(bad).toEqual([]);
  });

  it("說明(#976 補修三條逐字)", () => {
    const desc = (key: string) => AGENT_PERMISSION_SECTIONS.find((s) => s.key === key)?.description;
    // #996 第 11 批 K-10:重算抽成改看「抽成與薪資設定」,不再寫「永遠只有商家管理員能做」。
    expect(desc("staff_report")).toBe(
      "開放後客服可以查看個別服務人員的抽成/薪資報表。重新計算已完成訂單的抽成不看這個開關，需要「抽成與薪資設定」權限。",
    );
    expect(desc("orders")).toBe(
      "開放後客服可以在行事曆建立新預約、取消預約、把預約標記為完成。建單時可以看到系統建議派點、手動修改這筆訂單的派點，以及使用會員點數折抵(紅利點數功能開啟時)。",
    );
    expect(desc("scheduling")).toBe(
      "開放後客服可以檢視跨服務人員的每週時段、單日例外、請假彙整總覽頁，是純唯讀檢視權限，跟「月薪人員假別設定」(有寫入行為)是兩把獨立的鑰匙。",
    );
  });

  // 第 11 批 D(#991,2026-10-07):人工電話驗證標記退場 ⇒「會員管理」說明刪掉「標記電話已驗證，」。
  it("第 11 批 D:會員管理說明逐字,全部說明都不再提「電話已驗證」", () => {
    const desc = (key: string) => AGENT_PERMISSION_SECTIONS.find((s) => s.key === key)?.description;
    expect(desc("members")).toBe(
      "開放後客服可以新增、編輯、下架會員資料，並可在會員詳情頁查看點數餘額與異動歷史、登記兌換點數，也能進入「紅利點數」頁，但看不到裡面的規則設定。要查看或修改紅利規則需另外開啟「紅利點數」權限；手動調整點數只有商家管理員能做。",
    );
    expect(
      AGENT_PERMISSION_SECTIONS.filter((s) => /電話已驗證|電話驗證/.test(s.description)),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #977:服務人員 8 個開關 —— 改名、排序、「即將推出」
// ---------------------------------------------------------------------------

describe("#977 服務人員權限功能開關", () => {
  it("8 個開關的順序、名稱、「即將推出」標記", () => {
    expect(
      STAFF_BOOLEAN_PERMISSION_FIELDS.map((f) => [f.key, f.label, Boolean(f.comingSoon)]),
    ).toEqual([
      // 客戶端第 3 批(C3-E02,2026-10-09):客戶線上預約送出上線,拿掉「即將推出」。
      ["no_time_slot_limit", "客戶預約無時段限制", false],
      ["auto_accept_booking", "客戶預約自動接受", false],
      ["unlimited_backend_edit", "商家後台編輯無時段限制", false],
      // #977 第 4 批(2026-10-06):這個開關已生效,拿掉「即將推出」。
      ["direct_accept_after_merchant_confirm", "商家後台確認後直接接單", false],
      ["show_member_info", "服務人員是否顯示會員資料", false],
      ["google_calendar_sync_enabled", "服務人員Google日曆同步", true],
      // #977 第 7 批(2026-10-07):這個開關已生效,拿掉「即將推出」。
      ["can_create_edit_orders", "服務人員新增編輯訂單", false],
      ["can_upload_construction_photos", "服務人員施工圖片上傳", true],
    ]);
  });

  it("說明(抽查)", () => {
    const desc = (key: string) =>
      STAFF_BOOLEAN_PERMISSION_FIELDS.find((f) => f.key === key)?.description;
    expect(desc("auto_accept_booking")).toBe(
      "開啟後，客戶線上預約這位服務人員(或「不指定」時系統排到他)的訂單會直接成立，不用他再確認。訪客預約、黑名單會員的預約仍然要確認。",
    );
    expect(desc("google_calendar_sync_enabled")).toBe(
      "開啟後，這位服務人員的行程會同步到他的 Google 日曆。",
    );
    expect(desc("can_upload_construction_photos")).toBe(
      "開啟後，這位服務人員可以在訂單上傳施工照片，商家端可以查看。",
    );
    expect(desc("unlimited_backend_edit")).toContain("請假時段仍然不能排");
  });

  // #990 第 11 批:說明裡的括號、斜線一律半形(#986 裁決 6 全站規則)。
  it("8 個開關的說明都不含全形 （ ） ／", () => {
    const bad = STAFF_BOOLEAN_PERMISSION_FIELDS.filter((f) => /[（）／]/.test(f.description)).map(
      (f) => `${f.key}: ${f.description}`,
    );
    expect(bad).toEqual([]);
    expect(
      STAFF_BOOLEAN_PERMISSION_FIELDS.find((f) => f.key === "unlimited_backend_edit")?.description,
    ).toContain("可預約時段以外(例如他只開 9 點到 18 點，開啟後 18 點以後也能排)。");
  });

  it("不再有內部用語(「實際串接留給之後的模組」這類)", () => {
    for (const f of [...STAFF_BOOLEAN_PERMISSION_FIELDS, ...STAFF_NUMBER_PERMISSION_FIELDS]) {
      expect(f.description).not.toMatch(/留給之後的模組|實際串接/);
    }
  });

  it("兩個預約天數欄位:只限制客戶線上預約;客戶端第 3 批(C3-E02)起不再標「即將推出」", () => {
    for (const f of STAFF_NUMBER_PERMISSION_FIELDS) {
      expect(
        f.description.startsWith("只限制客戶線上預約，商家管理員與客服在後台建單不受限。"),
      ).toBe(true);
      expect(f.comingSoon).toBeFalsy();
    }
    // 零之零 Q1:最遠天數留空 = 180 天(資料庫同步)。
    expect(
      STAFF_NUMBER_PERMISSION_FIELDS.find((f) => f.key === "booking_window_max_days")?.description,
    ).toContain("留空時系統會用 180 天");
  });

  it("編輯服務人員畫面不再有「這些開關目前先存值」那條常駐提醒,改用「即將推出」標籤", () => {
    const src = readSourceWithoutComments("src/modules/staff-agent/StaffListPage.tsx");
    expect(src).not.toContain("先存值");
    expect(src).toContain("<ComingSoonTag />");
  });
});
