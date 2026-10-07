// 第 11 批 J(#995 J-14 + §17.7「逐頁 dirty 接線」原始碼守門)。
//
// 規則:檔案裡有 <FullPageLayerContent / <CardDialogContent,而且那個檔案有輸入元件(按儲存才寫入的表單),
// 每一個這樣的視窗都必須傳 dirty=(用 useFormDirty 算)。例外寫在 EXEMPT,一定要附理由。
// 另外守:① 頁面不准自己寫 onPointerDownOutside / onInteractOutside(殼已統一攔下,skill 三之六 ④);
//        ② 頁面不准 import OverlayDismissStrip / overlayDirtyDismiss(只給三個殼用);
//        ③ 全站沒有直接用 shadcn ui/dialog 的視窗(J-3;ui/command.tsx 的 CommandDialog 全站沒人用,除外)。

import { describe, expect, it } from "vitest";

import { scanSourceLines } from "@/test/sourceScan";

const INPUT_COMPONENT =
  /<(FieldInput|FieldTextarea|FieldSelect|FieldAmountInput|FieldDate|FieldTime|FieldMonth|FieldColor|FieldNativeSelect|ChoiceChip|ChoiceChipGroup|Input|Textarea|Checkbox|RadioGroup)\b/;

/** 不傳 dirty 的視窗(檢視型 / 即存 / 無欄位)。key = 檔案;value = 視窗開頭標籤裡的辨識字 + 理由。 */
const EXEMPT: { file: string; marker: string; reason: string }[] = [
  {
    file: "src/modules/staff-portal/MyBookingDetailDialog.tsx",
    marker: 'title="預約詳情"',
    reason: "L3 服務人員端預約詳情:檢視型,直接關",
  },
  {
    file: "src/modules/members/MemberSettingsPage.tsx",
    marker: 'title="會員政策(客戶端預覽)"',
    reason: "L6 會員政策預覽:檢視型,直接關",
  },
  {
    file: "src/modules/payroll/PayrollSettingsPage.tsx",
    marker: "的抽成設定`}",
    reason: "L7 抽成設定:每一格改完立刻存檔(即存),沒有整張儲存",
  },
  {
    file: "src/modules/booking/MaterialCostsPage.tsx",
    marker: "<CardDialogContent>",
    reason: "料錢影響抽成確認:沒有欄位(只確認一個開關)",
  },
];

interface Opening {
  file: string;
  line: number;
  tag: string;
}

/** 把同一個檔的行接回去,找出每一個 <FullPageLayerContent / <CardDialogContent 的開頭標籤全文(到對應的 `>`)。 */
function findOpenings(): { openings: Opening[]; fileText: Map<string, string> } {
  const byFile = new Map<string, string[]>();
  for (const l of scanSourceLines()) {
    if (!byFile.has(l.file)) byFile.set(l.file, []);
    byFile.get(l.file)!.push(l.text);
  }
  const openings: Opening[] = [];
  const fileText = new Map<string, string>();
  for (const [file, lines] of byFile) {
    if (!file.endsWith(".tsx")) continue;
    if (file.startsWith("src/components/patterns/")) continue; // 殼本身與它的範例
    const text = lines.join("\n");
    fileText.set(file, text);
    const re = /<(FullPageLayerContent|CardDialogContent)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // 走到對應的 `>`(跳過 {…} 裡的 `=>`)。
      let depth = 0;
      let i = m.index + 1;
      for (; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        else if (ch === ">" && depth === 0) break;
      }
      openings.push({
        file,
        line: text.slice(0, m.index).split("\n").length,
        tag: text.slice(m.index, i + 1),
      });
    }
  }
  return { openings, fileText };
}

describe("第 11 批 J:有欄位的視窗一定要接 dirty", () => {
  const { openings, fileText } = findOpenings();

  it("掃得到全站的視窗(防止守門員自己壞掉變成什麼都不檢查)", () => {
    // 11 處全頁層 + 13 處小卡窗 + ChangeLoginEmailDialog = 25(§17.2 盤點,含這批改殼的 1 處)。
    expect(openings.length).toBeGreaterThanOrEqual(25);
  });

  it("有輸入元件的檔案裡,每一個全頁層 / 小卡窗都有 dirty=(例外見 EXEMPT,附理由)", () => {
    const missing: string[] = [];
    for (const o of openings) {
      if (!INPUT_COMPONENT.test(fileText.get(o.file) ?? "")) continue;
      if (/\bdirty=/.test(o.tag)) continue;
      const exempt = EXEMPT.find((e) => e.file === o.file && o.tag.includes(e.marker));
      if (exempt) continue;
      missing.push(`${o.file}:${o.line}`);
    }
    expect(missing).toEqual([]);
  });

  it("EXEMPT 清單裡的每一項都真的存在、而且真的沒傳 dirty(清單不能過期)", () => {
    for (const e of EXEMPT) {
      const hits = openings.filter((o) => o.file === e.file && o.tag.includes(e.marker));
      expect(hits.length, `${e.file} ${e.marker}`).toBe(1);
      expect(/\bdirty=/.test(hits[0]!.tag), e.reason).toBe(false);
    }
  });

  it("J-14 清單上的頁面全部有接(逐檔點名)", () => {
    const required: [string, number][] = [
      ["src/modules/booking/CalendarPage.tsx", 1], // L1 預約
      ["src/modules/booking/BookingDetailDialog.tsx", 1], // L2 還原 / 取消子畫面原因欄
      ["src/modules/members/MemberDetailPage.tsx", 2], // L4 + 列入黑名單
      ["src/modules/members/MembersListPage.tsx", 1], // L5
      ["src/modules/payroll/PayrollSettingsPage.tsx", 1], // L8
      ["src/modules/scheduling/LeaveRecordsPage.tsx", 1], // L9
      ["src/modules/service-items/ServiceItemsPage.tsx", 1], // L10
      ["src/modules/staff-agent/StaffListPage.tsx", 2], // L11 + 邀請開通登入
      ["src/modules/booking/MaterialCostsPage.tsx", 1], // 料錢品項
      ["src/modules/booking/PaymentMethodsPage.tsx", 1], // 付款方式
      ["src/modules/members/MemberPointsPanel.tsx", 2], // 兌換點數 / 調整點數
      ["src/modules/members/MemberSettingsPage.tsx", 1], // 會員等級
      ["src/modules/payroll/LeaveDeductionRuleDialog.tsx", 1], // 假別扣款規則
      ["src/modules/scheduling/LeaveTypesPage.tsx", 1], // 假別
      ["src/modules/staff-agent/AdminLoginEmailManager.tsx", 1], // 建議新登入信箱
      ["src/modules/staff-agent/AgentListPage.tsx", 1], // 編輯客服資料
      ["src/modules/staff-portal/EditMyStaffProfileDialog.tsx", 1], // 編輯個人資料(服務人員)
      ["src/routes/ManagePage.tsx", 1], // 編輯個人資料(管理員 / 客服)
      ["src/components/ChangeLoginEmailDialog.tsx", 1], // 更改登入信箱(J-3 改殼)
    ];
    for (const [file, count] of required) {
      const wired = openings.filter((o) => o.file === file && /\bdirty=/.test(o.tag));
      expect(wired.length, file).toBe(count);
    }
  });
});

describe("第 11 批 J:頁面不自己處理「點外面」", () => {
  const lines = scanSourceLines().filter((l) => !l.file.startsWith("src/components/patterns/"));

  it("頁面不准寫 onPointerDownOutside / onInteractOutside(殼已統一攔下)", () => {
    // 浮出面板(Popover / Select / 選單)本來就該點外面收起,它們用的是 ui/ 底下的元件,不受這條限制。
    const hits = lines
      .filter((l) => !l.file.startsWith("src/components/ui/"))
      .filter((l) => /onPointerDownOutside|onInteractOutside/.test(l.text))
      .map((l) => `${l.file}:${l.line}`);
    expect(hits).toEqual([]);
  });

  it("頁面不准 import 空白條 / 放棄確認的內部檔(只給三個殼用)", () => {
    const hits = lines
      .filter((l) => /OverlayDismissStrip|overlayDirtyDismiss|overlayDismissLogic/.test(l.text))
      .map((l) => `${l.file}:${l.line}`);
    expect(hits).toEqual([]);
  });

  it("J-3:沒有頁面直接用 shadcn ui/dialog(CommandDialog 的 ui/command.tsx 除外)", () => {
    const hits = lines
      .filter((l) => l.file !== "src/components/ui/command.tsx")
      .filter((l) => /from "@\/components\/ui\/dialog"/.test(l.text))
      .map((l) => `${l.file}:${l.line}`);
    expect(hits).toEqual([]);
  });
});

describe("第 11 批 J(J-8):必須選一個的確認窗不畫上方空白條", () => {
  it("協助人員已移除(assistantRemoval.tsx)傳 dismissStrip={false},而且 Esc 仍被擋", () => {
    const text = scanSourceLines()
      .filter((l) => l.file === "src/modules/booking/assistantRemoval.tsx")
      .map((l) => l.text)
      .join("\n");
    const start = text.indexOf("<CardAlertDialogContent");
    expect(start).toBeGreaterThan(-1);
    const tag = text.slice(
      start,
      text.indexOf('data-testid="assistant-removed-prompt"', start) + 400,
    );
    expect(tag).toContain("dismissStrip={false}");
    expect(tag).toContain("onEscapeKeyDown={(e) => e.preventDefault()}");
  });
});
