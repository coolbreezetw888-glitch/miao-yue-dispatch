// 第 11 批 E(#992,2026-10-07):相依權限的純函式與文案。
// 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §11.3~§11.6、§11.10 vitest。
//
// 📌 結果一律依「畫面順序」(AGENT_PERMISSION_SECTIONS)排序:月薪人員假別設定排在抽成與薪資設定前面,
//    料錢成本管理又排在月薪人員假別設定前面。規格書 §11.4 表格「一併處理」欄的文字順序只是描述,
//    驗收以 E-R1 的「依畫面順序排序」為準。

import { describe, expect, it } from "vitest";

import {
  AGENT_PERMISSION_DEPENDENCIES,
  AGENT_PERMISSION_GRANT_EFFECTS,
  AGENT_PERMISSION_REVOKE_EFFECTS,
  DEPENDENCY_CONFIRM_COPY,
  keysToDisableWith,
  keysToEnableWith,
  legacyDependencyNotes,
} from "./agentPermissionDependencies";
import { AGENT_PERMISSION_SECTIONS } from "./types";

const DEP_KEYS = [
  "material_costs",
  "commission_settings",
  "team_leave",
  "members",
  "member_points",
] as const;

const notHidden = () => false;
const onSet = (...keys: string[]) => {
  const s = new Set(keys);
  return (k: string) => s.has(k);
};
const allOn = onSet(...DEP_KEYS);
const allOff = onSet();

const E1 = "「料錢影響服務人員抽成」開關目前改不了，需要同時開啟「抽成與薪資設定」權限。";
const E2 =
  "「料錢是否影響抽成」的開關在料錢成本管理頁，目前進不去，需要同時開啟「料錢成本管理」權限。";
const E3 =
  "假別扣款規則在「月薪人員假別設定」頁，目前進不去，需要同時開啟「月薪人員假別設定」權限。";
const E4 =
  "「紅利點數」頁目前只看得到頁面、看不到規則設定，要查看或修改紅利規則，需要同時開啟「紅利點數」權限。";
const E5 = "目前進不去「紅利點數」頁，這個權限還沒有作用，需要同時開啟「會員管理」權限。";

describe("§11.3 相依關係表", () => {
  it("E-1~E-5 逐字、順序固定", () => {
    expect(AGENT_PERMISSION_DEPENDENCIES.map((d) => [d.key, d.requires, d.legacyNote])).toEqual([
      ["material_costs", "commission_settings", E1],
      ["commission_settings", "material_costs", E2],
      ["commission_settings", "team_leave", E3],
      ["members", "member_points", E4],
      ["member_points", "members", E5],
    ]);
  });

  it("每組 key / requires 都存在於 AGENT_PERMISSION_SECTIONS,而且都不是隱藏項目", () => {
    const keys = new Map(AGENT_PERMISSION_SECTIONS.map((s) => [s.key, s]));
    for (const d of AGENT_PERMISSION_DEPENDENCIES) {
      expect(keys.has(d.key), d.key).toBe(true);
      expect(keys.has(d.requires), d.requires).toBe(true);
      expect(keys.get(d.key)?.hidden ?? false).toBe(false);
      expect(keys.get(d.requires)?.hidden ?? false).toBe(false);
    }
  });
});

describe("§11.4 實際會算出的集合(10 列,初始 = 一併處理的權限跟動作方向相反)", () => {
  it("打開 料錢成本管理(全關)⇒ 月薪人員假別設定、抽成與薪資設定(遞移,一次列兩個)", () => {
    expect(keysToEnableWith("material_costs", allOff, notHidden)).toEqual([
      "team_leave",
      "commission_settings",
    ]);
  });
  it("打開 抽成與薪資設定(全關)⇒ 料錢成本管理、月薪人員假別設定", () => {
    expect(keysToEnableWith("commission_settings", allOff, notHidden)).toEqual([
      "material_costs",
      "team_leave",
    ]);
  });
  it("打開 月薪人員假別設定 ⇒ 無(直接打開)", () => {
    expect(keysToEnableWith("team_leave", allOff, notHidden)).toEqual([]);
  });
  it("打開 會員管理 ⇒ 紅利點數", () => {
    expect(keysToEnableWith("members", allOff, notHidden)).toEqual(["member_points"]);
  });
  it("打開 紅利點數 ⇒ 會員管理", () => {
    expect(keysToEnableWith("member_points", allOff, notHidden)).toEqual(["members"]);
  });
  it("關掉 料錢成本管理(全開)⇒ 抽成與薪資設定", () => {
    expect(keysToDisableWith("material_costs", allOn, notHidden)).toEqual(["commission_settings"]);
  });
  it("關掉 抽成與薪資設定(全開)⇒ 料錢成本管理", () => {
    expect(keysToDisableWith("commission_settings", allOn, notHidden)).toEqual(["material_costs"]);
  });
  it("關掉 月薪人員假別設定(全開)⇒ 料錢成本管理、抽成與薪資設定(反向遞移)", () => {
    expect(keysToDisableWith("team_leave", allOn, notHidden)).toEqual([
      "material_costs",
      "commission_settings",
    ]);
  });
  it("關掉 會員管理 ⇒ 紅利點數", () => {
    expect(keysToDisableWith("members", allOn, notHidden)).toEqual(["member_points"]);
  });
  it("關掉 紅利點數 ⇒ 會員管理", () => {
    expect(keysToDisableWith("member_points", allOn, notHidden)).toEqual(["members"]);
  });
});

describe("§11.4 規則細節", () => {
  it("E-R1:已經開著的不列(抽成與薪資設定已開 ⇒ 打開料錢成本管理只列月薪人員假別設定)", () => {
    expect(keysToEnableWith("material_costs", onSet("commission_settings"), notHidden)).toEqual([
      "team_leave",
    ]);
    expect(
      keysToEnableWith("material_costs", onSet("commission_settings", "team_leave"), notHidden),
    ).toEqual([]);
  });
  it("E-R1:自己不列(雙向相依不會把自己列進去)", () => {
    expect(keysToEnableWith("members", allOff, notHidden)).not.toContain("members");
    expect(keysToDisableWith("members", allOn, notHidden)).not.toContain("members");
  });
  it("E-R3:隱藏目標不列、也不往下找(假裝抽成與薪資設定是隱藏的 ⇒ 打開料錢成本管理回傳空)", () => {
    const hidden = (k: string) => k === "commission_settings";
    expect(keysToEnableWith("material_costs", allOff, hidden)).toEqual([]);
    expect(keysToDisableWith("team_leave", allOn, hidden)).toEqual([]);
  });
  it("E-R4:關閉只沿著目前開著的往上找(抽成與薪資設定本來就關 ⇒ 關假別不列任何人)", () => {
    expect(
      keysToDisableWith("team_leave", onSet("team_leave", "material_costs"), notHidden),
    ).toEqual([]);
  });
  it("不在相依表裡的權限 ⇒ 永遠是空的", () => {
    expect(keysToEnableWith("orders", allOff, notHidden)).toEqual([]);
    expect(keysToDisableWith("orders", allOn, notHidden)).toEqual([]);
  });
});

describe("§11.6 legacyDependencyNotes", () => {
  const cases: Array<[string, string, string]> = [
    ["material_costs", "commission_settings", E1],
    ["members", "member_points", E4],
    ["member_points", "members", E5],
  ];
  for (const [key, req, note] of cases) {
    it(`${key}:自己開 + ${req} 沒開 ⇒ 有;${req} 開 ⇒ 無;自己關 ⇒ 無`, () => {
      expect(legacyDependencyNotes(key, onSet(key), notHidden)).toEqual([note]);
      expect(legacyDependencyNotes(key, onSet(key, req), notHidden)).toEqual([]);
      expect(legacyDependencyNotes(key, onSet(req), notHidden)).toEqual([]);
    });
  }
  it("commission_settings 的 E-2 / E-3 各自成立,兩句同時成立時順序固定 E-2 → E-3", () => {
    expect(
      legacyDependencyNotes("commission_settings", onSet("commission_settings"), notHidden),
    ).toEqual([E2, E3]);
    expect(
      legacyDependencyNotes(
        "commission_settings",
        onSet("commission_settings", "team_leave"),
        notHidden,
      ),
    ).toEqual([E2]);
    expect(
      legacyDependencyNotes(
        "commission_settings",
        onSet("commission_settings", "material_costs"),
        notHidden,
      ),
    ).toEqual([E3]);
    expect(legacyDependencyNotes("commission_settings", allOn, notHidden)).toEqual([]);
    expect(legacyDependencyNotes("commission_settings", allOff, notHidden)).toEqual([]);
  });
});

describe("§11.4 最右欄:按「只開 / 只關這一個」之後的提醒(對動作後的狀態算)", () => {
  function notesFor(state: (k: string) => boolean) {
    const out: Record<string, string[]> = {};
    for (const k of DEP_KEYS) {
      const n = legacyDependencyNotes(k, state, notHidden);
      if (n.length > 0) out[k] = n;
    }
    return out;
  }
  it("只開 料錢成本管理 ⇒ 料錢成本管理下方 E-1", () => {
    expect(notesFor(onSet("material_costs"))).toEqual({ material_costs: [E1] });
  });
  it("只開 抽成與薪資設定 ⇒ 抽成與薪資設定下方 E-2、E-3", () => {
    expect(notesFor(onSet("commission_settings"))).toEqual({ commission_settings: [E2, E3] });
  });
  it("只開 會員管理 ⇒ 會員管理下方 E-4", () => {
    expect(notesFor(onSet("members"))).toEqual({ members: [E4] });
  });
  it("只開 紅利點數 ⇒ 紅利點數下方 E-5", () => {
    expect(notesFor(onSet("member_points"))).toEqual({ member_points: [E5] });
  });
  it("只關 料錢成本管理(另外兩把開)⇒ 抽成與薪資設定下方 E-2", () => {
    expect(notesFor(onSet("commission_settings", "team_leave"))).toEqual({
      commission_settings: [E2],
    });
  });
  it("只關 料錢成本管理(假別也關著)⇒ 抽成與薪資設定下方 E-2、E-3", () => {
    expect(notesFor(onSet("commission_settings"))).toEqual({ commission_settings: [E2, E3] });
  });
  it("只關 抽成與薪資設定 ⇒ 料錢成本管理下方 E-1", () => {
    expect(notesFor(onSet("material_costs", "team_leave"))).toEqual({ material_costs: [E1] });
  });
  it("只關 月薪人員假別設定 ⇒ 只有抽成與薪資設定下方 E-3,料錢成本管理沒有提醒", () => {
    expect(notesFor(onSet("material_costs", "commission_settings"))).toEqual({
      commission_settings: [E3],
    });
  });
  it("只關 會員管理 ⇒ 紅利點數下方 E-5", () => {
    expect(notesFor(onSet("member_points"))).toEqual({ member_points: [E5] });
  });
  it("只關 紅利點數 ⇒ 會員管理下方 E-4", () => {
    expect(notesFor(onSet("members"))).toEqual({ members: [E4] });
  });
});

describe("§11.5 文案", () => {
  it("一起開啟 / 一起關閉的白話逐字", () => {
    expect(AGENT_PERMISSION_GRANT_EFFECTS).toEqual({
      commission_settings: "會看到所有服務人員的月薪金額與抽成比例，而且可以修改。",
      team_leave: "會看到所有月薪制服務人員的請假紀錄，可以登記、取消請假，也可以修改假別清單。",
      material_costs: "可以新增、編輯、下架料錢成本品項，也可以打開或關閉料錢成本功能。",
      member_points:
        "可以修改紅利點數的所有規則，包含核發條件、紅利計算、點數使用、推薦系統與生日獎勵。",
      members:
        "會看到所有會員的姓名、電話等資料，可以新增、編輯、下架會員，也可以查看點數並登記兌換。",
    });
    expect(AGENT_PERMISSION_REVOKE_EFFECTS).toEqual({
      commission_settings: "不能再查看、修改服務人員的月薪與抽成比例。",
      team_leave: "不能再查看請假紀錄，也不能登記請假、修改假別清單。",
      material_costs: "不能再管理料錢成本品項與功能開關。",
      member_points: "不能再查看、修改紅利點數規則。",
      members: "不能再查看、編輯會員資料，也進不去紅利點數頁。",
    });
  });

  it("5 個權限都有開啟 / 關閉兩句白話", () => {
    for (const k of DEP_KEYS) {
      expect(AGENT_PERMISSION_GRANT_EFFECTS[k], k).toBeTruthy();
      expect(AGENT_PERMISSION_REVOKE_EFFECTS[k], k).toBeTruthy();
    }
  });

  it("小卡窗標題 / 說明 / 淡字 / 按鈕逐字", () => {
    expect(DEPENDENCY_CONFIRM_COPY.enable.title(2)).toBe("要一起開啟 2 個相關權限嗎？");
    expect(DEPENDENCY_CONFIRM_COPY.disable.title(1)).toBe("要一起關閉 1 個相關權限嗎？");
    expect(DEPENDENCY_CONFIRM_COPY.enable.lead("料錢成本管理")).toBe(
      "「料錢成本管理」要搭配下面的權限才能完整使用。按「一起開啟」後，這位客服會同時多出這些權限：",
    );
    expect(DEPENDENCY_CONFIRM_COPY.disable.lead("月薪人員假別設定")).toBe(
      "關掉「月薪人員假別設定」後，下面的權限就沒辦法完整使用，按「一起關閉」會同時關掉：",
    );
    expect(DEPENDENCY_CONFIRM_COPY.enable.hint).toBe(
      "按「只開這一個」也可以，之後這個權限下方會一直提醒還缺哪些權限。",
    );
    expect(DEPENDENCY_CONFIRM_COPY.disable.hint).toBe(
      "按「只關這一個」也可以，之後受影響的權限下方會一直提醒。",
    );
    expect([
      DEPENDENCY_CONFIRM_COPY.enable.action,
      DEPENDENCY_CONFIRM_COPY.enable.onlyThis,
      DEPENDENCY_CONFIRM_COPY.disable.action,
      DEPENDENCY_CONFIRM_COPY.disable.onlyThis,
      DEPENDENCY_CONFIRM_COPY.cancel,
    ]).toEqual(["一起開啟", "只開這一個", "一起關閉", "只關這一個", "取消"]);
  });

  it("標點守門:不含半形 , : ; ! ?、不含全形 （ ） ／、不含半形 ( ) /", () => {
    const texts = [
      ...AGENT_PERMISSION_DEPENDENCIES.map((d) => d.legacyNote),
      ...Object.values(AGENT_PERMISSION_GRANT_EFFECTS),
      ...Object.values(AGENT_PERMISSION_REVOKE_EFFECTS),
      DEPENDENCY_CONFIRM_COPY.enable.title(3),
      DEPENDENCY_CONFIRM_COPY.disable.title(3),
      DEPENDENCY_CONFIRM_COPY.enable.lead("料錢成本管理"),
      DEPENDENCY_CONFIRM_COPY.disable.lead("料錢成本管理"),
      DEPENDENCY_CONFIRM_COPY.enable.hint,
      DEPENDENCY_CONFIRM_COPY.disable.hint,
    ];
    const bad = texts.filter((t) => /[,:;!?]|[（）／]|[()/]/.test(t));
    expect(bad).toEqual([]);
  });
});

// §11.10 ⑬ 後半 / §11.9 第 7 點:三顆直排只套在客服權限頁這一個小卡窗;
// 服務人員頁 #977 的 order-switch-confirm 仍只有 2 顆、footer 不帶任何覆寫 class。
describe("§11.9:服務人員頁 #977 小卡窗不受影響", () => {
  it("order-switch-confirm 只有「取消」+ 一顆 Action,footer 沒有覆寫 class", async () => {
    const { readSourceWithoutComments } = await import("@/test/sourceScan");
    const src = readSourceWithoutComments("src/modules/staff-agent/StaffListPage.tsx");
    const start = src.indexOf('data-testid="order-switch-confirm"');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("</CardAlertDialogContent>", start));
    expect(block.match(/<CardAlertDialogCancel\b/g)).toHaveLength(1);
    expect(block.match(/<CardAlertDialogAction\b/g)).toHaveLength(1);
    expect(block).not.toMatch(/<Button\b/);
    expect(block).toContain("<CardAlertDialogFooter>");
  });
});
