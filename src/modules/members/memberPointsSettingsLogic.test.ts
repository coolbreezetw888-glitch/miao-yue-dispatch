// 紅利系統重構 批次 6:紅利點數管理頁四個分頁的純函式測試(規格書 §4.1~§4.5、§2.2、§2.10、§七)。
// 取代原本 previewCalculators.test.ts(舊的「每 N 元 1 點」試算,欄位已 drop)。

import { describe, expect, it } from "vitest";

import { buildMerchantMemberSettingsPayload } from "./api";
import {
  ALL_SERVICE_ITEMS_VALUE,
  basicFieldLabels,
  birthdayLineStatusTone,
  birthdaySampleValues,
  computeBasicPoints,
  computeRedeemExample,
  countMessageChars,
  duplicateFormulaMessage,
  findDuplicateFormula,
  formulaItemOptions,
  formulaPreviewSentence,
  nextFormulaName,
  renderBirthdayMessage,
  shouldRenderPointsTabs,
  shouldShowOwnFormulaNote,
  validateBasicDraft,
  validateFormulaDraft,
  validateRedeemDraft,
  type FormulaDraft,
} from "./memberPointsSettingsLogic";
import {
  BIRTHDAY_LINE_STATUS_LABELS,
  DEFAULT_MERCHANT_MEMBER_SETTINGS,
  type BirthdayLineStatus,
  type PointFormulaServiceItem,
} from "./types";

const ITEMS: PointFormulaServiceItem[] = [
  { id: "item-ac", name: "壁掛分離式 (普通機型)", price: 2200, status: "active" },
  { id: "item-wash", name: "清洗", price: 800, status: "active" },
  { id: "item-old", name: "舊項目", price: 500, status: "removed" },
];

function draft(partial: Partial<FormulaDraft>): FormulaDraft {
  return {
    key: partial.key ?? "k",
    id: null,
    name: "公式 1",
    enabled: true,
    serviceItemId: null,
    minUnitPrice: "0",
    pointsPerUnit: "1",
    ...partial,
  };
}

describe("§4.1 分頁顯示條件 shouldRenderPointsTabs", () => {
  it("有規則權限 + 功能開啟 ⇒ 顯示", () => {
    expect(
      shouldRenderPointsTabs({
        canManagePointsRules: true,
        settings: { points_feature_enabled: true },
      }),
    ).toBe(true);
  });
  it("功能關閉 ⇒ 不顯示", () => {
    expect(
      shouldRenderPointsTabs({
        canManagePointsRules: true,
        settings: { points_feature_enabled: false },
      }),
    ).toBe(false);
  });
  it("沒有規則權限(只有會員管理)⇒ 不顯示", () => {
    expect(
      shouldRenderPointsTabs({
        canManagePointsRules: false,
        settings: { points_feature_enabled: true },
      }),
    ).toBe(false);
  });
  it("讀不到設定(undefined)⇒ 不顯示,不拿預設值猜", () => {
    expect(shouldRenderPointsTabs({ canManagePointsRules: true, settings: undefined })).toBe(false);
  });
});

describe("§4.2 基本設定:標籤切換 + §2.2 試算", () => {
  it("每滿額累計關:每筆訂單獲得 / 最低消費金額", () => {
    expect(basicFieldLabels(false)).toEqual({
      pointsPerOrder: "每筆訂單獲得",
      minAmount: "最低消費金額",
    });
  });
  it("每滿額累計開:每滿額獲得 / 每滿額消費金額", () => {
    expect(basicFieldLabels(true)).toEqual({
      pointsPerOrder: "每滿額獲得",
      minAmount: "每滿額消費金額",
    });
  });
  it("門檻剛好等於 ⇒ 給點;差 1 元 ⇒ 0", () => {
    const rule = { pointsPerOrder: 5, minAmount: 500, tieredEnabled: false };
    expect(computeBasicPoints(500, rule)).toBe(5);
    expect(computeBasicPoints(499, rule)).toBe(0);
  });
  it("累計 2.9 倍取 2 倍", () => {
    expect(
      computeBasicPoints(290, { pointsPerOrder: 3, minAmount: 100, tieredEnabled: true }),
    ).toBe(6);
  });
  it("門檻 0 ⇒ 每筆都給(未累計)", () => {
    expect(computeBasicPoints(1, { pointsPerOrder: 2, minAmount: 0, tieredEnabled: false })).toBe(
      2,
    );
  });
  it("每筆訂單獲得 0 ⇒ 一律 0(尚未設定)", () => {
    expect(
      computeBasicPoints(99999, { pointsPerOrder: 0, minAmount: 0, tieredEnabled: false }),
    ).toBe(0);
  });
  it("累計開但門檻 0 ⇒ 驗證擋下(資料庫 CHECK 的白話版)", () => {
    const v = validateBasicDraft({ pointsPerOrder: "1", minAmount: "0", tieredEnabled: true });
    expect(v.tieredNeedsMinAmount).toBe(true);
    expect(v.ok).toBe(false);
  });
  it("點數有小數 / 負數 ⇒ 擋下", () => {
    expect(
      validateBasicDraft({ pointsPerOrder: "1.5", minAmount: "0", tieredEnabled: false }).ok,
    ).toBe(false);
    expect(
      validateBasicDraft({ pointsPerOrder: "-1", minAmount: "0", tieredEnabled: false }).ok,
    ).toBe(false);
  });
});

describe("§4.2 一句話預覽", () => {
  it("個別項目:名稱 + [NT$現價] + 數量 × N點 + 門檻", () => {
    expect(
      formulaPreviewSentence({ item: ITEMS[0]!, pointsPerUnit: "50", minUnitPrice: "2200" }),
    ).toBe("壁掛分離式 (普通機型) [NT$2,200]：數量 × 50點 (單項金額≥2200元)");
  });
  it("全部服務項目", () => {
    expect(formulaPreviewSentence({ item: null, pointsPerUnit: "50", minUnitPrice: "2200" })).toBe(
      "全部服務項目：數量 × 50點 (單項金額≥2200元)",
    );
  });
  it("門檻 0 時省略括號", () => {
    expect(formulaPreviewSentence({ item: null, pointsPerUnit: "1", minUnitPrice: "0" })).toBe(
      "全部服務項目：數量 × 1點",
    );
  });
  it("欄位還沒填好 ⇒ null(不顯示半套句子)", () => {
    expect(formulaPreviewSentence({ item: null, pointsPerUnit: "", minUnitPrice: "0" })).toBeNull();
  });
});

describe("§4.2 第 5 點 (c):下拉選項變灰「已有公式」", () => {
  const drafts = [
    draft({ key: "a", serviceItemId: null }),
    draft({ key: "b", serviceItemId: "item-ac" }),
    draft({ key: "c", serviceItemId: "item-wash" }),
  ];
  it("別的卡已經用了「全部」與冷氣 ⇒ 第三張卡的這兩個選項變灰並註記已有公式", () => {
    const opts = formulaItemOptions(drafts, "c", ITEMS);
    const all = opts.find((o) => o.value === ALL_SERVICE_ITEMS_VALUE)!;
    const ac = opts.find((o) => o.value === "item-ac")!;
    const wash = opts.find((o) => o.value === "item-wash")!;
    expect(all).toMatchObject({ disabled: true, note: "已有公式" });
    expect(ac).toMatchObject({
      disabled: true,
      note: "已有公式",
      label: "壁掛分離式 (普通機型) (NT$2,200)",
    });
    // 自己目前選的那個永遠可選。
    expect(wash).toMatchObject({ disabled: false, note: null });
  });
  it("已下架項目只在「這張卡自己綁著它」時出現,並標(已下架)", () => {
    expect(formulaItemOptions(drafts, "a", ITEMS).some((o) => o.value === "item-old")).toBe(false);
    const withOld = [...drafts, draft({ key: "d", serviceItemId: "item-old" })];
    const old = formulaItemOptions(withOld, "d", ITEMS).find((o) => o.value === "item-old");
    expect(old).toMatchObject({ disabled: false, note: "(已下架)" });
  });
});

describe("§4.2 第 6 點:儲存前重複偵測", () => {
  it("同一個項目兩條 ⇒ 回項目名與先設定的公式名", () => {
    const dup = findDuplicateFormula(
      [
        draft({ name: "公式甲", serviceItemId: "item-ac" }),
        draft({ name: "公式乙", serviceItemId: "item-ac" }),
      ],
      ITEMS,
    );
    expect(dup).toEqual({ itemLabel: "壁掛分離式 (普通機型)", formulaName: "公式甲" });
    expect(duplicateFormulaMessage(dup!)).toBe(
      "「壁掛分離式 (普通機型)」已被公式「公式甲」設定，同一個服務項目只能有一條公式",
    );
  });
  it("兩條「全部服務項目」⇒ 也擋", () => {
    expect(
      findDuplicateFormula([draft({ name: "一" }), draft({ name: "二" })], ITEMS)?.itemLabel,
    ).toBe("全部服務項目");
  });
  it("「全部」+ 個別項目可並存(第 2 題 B)⇒ 不算重複", () => {
    expect(
      findDuplicateFormula(
        [draft({ serviceItemId: null }), draft({ serviceItemId: "item-ac" })],
        ITEMS,
      ),
    ).toBeNull();
  });
});

describe("§4.2 其他", () => {
  it("新公式預設名稱 = 最大的「公式 N」+ 1", () => {
    expect(nextFormulaName([])).toBe("公式 1");
    expect(nextFormulaName([{ name: "公式 1" }, { name: "公式 3" }])).toBe("公式 4");
    expect(nextFormulaName([{ name: "冷氣" }])).toBe("公式 2");
  });
  it("公式名稱空白 / 超過 50 字 ⇒ 錯誤", () => {
    expect(validateFormulaDraft(draft({ name: "  " })).name).toBe("請填公式名稱");
    expect(validateFormulaDraft(draft({ name: "字".repeat(51) })).name).toBe(
      "公式名稱最多 50 個字",
    );
    expect(validateFormulaDraft(draft({ name: "字".repeat(50) })).ok).toBe(true);
  });
  it("(b) 小字:只有個別項目、且同時有「全部」那條時才顯示", () => {
    const all = draft({ serviceItemId: null });
    const ac = draft({ serviceItemId: "item-ac" });
    expect(shouldShowOwnFormulaNote(ac, [all, ac])).toBe(true);
    expect(shouldShowOwnFormulaNote(ac, [ac])).toBe(false);
    expect(shouldShowOwnFormulaNote(all, [all, ac])).toBe(false);
  });
  it("(b) 小字(v2.4 裁決 21 ②):這張公式關著 ⇒ 不顯示;「全部」那條關著 ⇒ 不顯示", () => {
    const all = draft({ serviceItemId: null });
    const allOff = draft({ serviceItemId: null, enabled: false });
    const ac = draft({ serviceItemId: "item-ac" });
    const acOff = draft({ serviceItemId: "item-ac", enabled: false });
    expect(shouldShowOwnFormulaNote(acOff, [all, acOff])).toBe(false);
    expect(shouldShowOwnFormulaNote(ac, [allOff, ac])).toBe(false);
    expect(shouldShowOwnFormulaNote(ac, [all, ac])).toBe(true);
  });
});

describe("§4.3 點數使用:驗證 + 範例試算(對齊 compute_booking_redeem_limits / v2.4 第 9~11 條)", () => {
  it("兩個比例欄位要同時有值或同時 0", () => {
    expect(
      validateRedeemDraft({ pointsUnit: "100", amountUnit: "0", maxRatioPercent: "50" })
        .pairMismatch,
    ).toBe(true);
    expect(validateRedeemDraft({ pointsUnit: "", amountUnit: "", maxRatioPercent: "0" }).ok).toBe(
      true,
    );
    expect(
      validateRedeemDraft({ pointsUnit: "100", amountUnit: "10", maxRatioPercent: "50" }).ok,
    ).toBe(true);
  });
  it("比例超過 100 ⇒ 擋下", () => {
    expect(
      validateRedeemDraft({ pointsUnit: "100", amountUnit: "10", maxRatioPercent: "101" }).ok,
    ).toBe(false);
  });
  it("100 點 = 10 元、50% ⇒ NT$1,000 最多 5000 點折 500 元(不含零頭點數,v2.4 第 9 條)", () => {
    expect(
      computeRedeemExample({ pointsUnit: 100, amountUnit: 10, maxRatioPercent: 50, payable: 1000 }),
    ).toEqual({ maxPoints: 5000, maxAmount: 500, capAmount: 500 });
  });
  it("7 點 = 3 元、上限 329 元 ⇒ 768 點折 329 元(v2.4 第 9 條原例:不是 769 點)", () => {
    const r = computeRedeemExample({
      pointsUnit: 7,
      amountUnit: 3,
      maxRatioPercent: 33,
      payable: 997,
    });
    expect(r).toEqual({ maxPoints: 768, maxAmount: 329, capAmount: 329 });
  });
  it("7 點 = 3 元、上限 330 元 ⇒ 770 點剛好折 330 元", () => {
    const r = computeRedeemExample({
      pointsUnit: 7,
      amountUnit: 3,
      maxRatioPercent: 33,
      payable: 1000,
    });
    expect(r).toEqual({ maxPoints: 770, maxAmount: 330, capAmount: 330 });
  });
  it("尚未設定(任一為 0)⇒ null", () => {
    expect(
      computeRedeemExample({ pointsUnit: 0, amountUnit: 0, maxRatioPercent: 50, payable: 1000 }),
    ).toBeNull();
    expect(
      computeRedeemExample({ pointsUnit: 100, amountUnit: 10, maxRatioPercent: 0, payable: 1000 }),
    ).toBeNull();
  });
  it("連 1 元都折不到 ⇒ null", () => {
    expect(
      computeRedeemExample({ pointsUnit: 100, amountUnit: 1, maxRatioPercent: 1, payable: 50 }),
    ).toBeNull();
  });
});

describe("§4.5 生日獎勵", () => {
  it("v2.4 第 20 條:7 種 LINE 狀態都有中文標籤,兩個新略過狀態用指定文案", () => {
    const all: BirthdayLineStatus[] = [
      "pending",
      "sent",
      "failed",
      "skipped_not_bound",
      "skipped_not_connected",
      "skipped_member_removed",
      "skipped_merchant_disabled",
    ];
    expect(Object.keys(BIRTHDAY_LINE_STATUS_LABELS).sort()).toEqual([...all].sort());
    expect(BIRTHDAY_LINE_STATUS_LABELS).toEqual({
      pending: "待發送",
      sent: "已發送",
      failed: "發送失敗",
      skipped_not_bound: "未綁定略過",
      skipped_not_connected: "商家未連線略過",
      skipped_member_removed: "會員已下架，未發送",
      skipped_merchant_disabled: "商家已停用，未發送",
    });
  });
  it("狀態顏色:已發送綠、待發送黃、失敗紅、各種略過灰", () => {
    expect(birthdayLineStatusTone("sent")).toBe("success");
    expect(birthdayLineStatusTone("pending")).toBe("warning");
    expect(birthdayLineStatusTone("failed")).toBe("danger");
    expect(birthdayLineStatusTone("skipped_member_removed")).toBe("neutral");
    expect(birthdayLineStatusTone("skipped_merchant_disabled")).toBe("neutral");
  });
  it("字數照資料庫 char_length:emoji 算 1 個字", () => {
    expect(countMessageChars("生日快樂🎂")).toBe(5);
    expect("生日快樂🎂".length).toBe(6);
  });
  it("變數預覽:三個變數都代入,不認得的變數原樣保留", () => {
    const values = birthdaySampleValues({ merchantName: "示範店", points: 88 });
    expect(
      renderBirthdayMessage(
        "{{member_name}} 您好,{{merchant_name}} 送您 {{points}} 點 {{x}}",
        values,
      ),
    ).toBe("王小明 您好,示範店 送您 88 點 {{x}}");
  });
  it("點數還沒填好 / 是 0 ⇒ 範例用 100,不顯示「送 0 點」", () => {
    expect(birthdaySampleValues({ merchantName: "店", points: 0 })["points"]).toBe("100");
  });
});

describe("§3.14 局部 patch(取代整列 upsert)", () => {
  it("只把有帶的欄位放進 payload,沒帶的不送(資料庫維持原值)", () => {
    expect(
      buildMerchantMemberSettingsPayload("m1", { policyEnabled: true, policyContent: null }),
    ).toEqual({
      merchant_id: "m1",
      policy_enabled: true,
      policy_content: null,
    });
  });
  it("紅利欄位對應正確的資料庫欄位名", () => {
    expect(
      buildMerchantMemberSettingsPayload("m1", {
        earnMode: "advanced",
        redeemMaxRatioPercent: 30,
        birthdayLineMessage: "hi",
      }),
    ).toEqual({
      merchant_id: "m1",
      earn_mode: "advanced",
      redeem_max_ratio_percent: 30,
      birthday_line_message: "hi",
    });
  });
  it("前端預設值跟 schema DEFAULT 一致(沒有舊的 points_earn_rate)", () => {
    expect(DEFAULT_MERCHANT_MEMBER_SETTINGS).not.toHaveProperty("points_earn_rate");
    expect(DEFAULT_MERCHANT_MEMBER_SETTINGS).toMatchObject({
      earn_mode: "basic",
      referral_inviter_earning_enabled: true,
      referral_invitee_earning_enabled: true,
      birthday_line_message: "生日快樂！本店已贈送您 {{points}} 點紅利，祝您有美好的一天。",
    });
  });
});
