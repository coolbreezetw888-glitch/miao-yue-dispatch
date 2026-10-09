// 第 11 批 E(#992,2026-10-07):客服權限「相依權限」—— 打開時提示、按確定就一併開啟。
//
// 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §11.3~§11.6。
// 這支檔案只放「誰需要誰」的表、遞移閉包的純函式與文案,畫面在 AgentPermissionsPage.tsx。
//
// 🔴 相依只是前端提示:後端 set_agent_permissions 刻意不檢查相依(規則上線前就存在的不一致資料
//    —— 正式庫 4 位「會員管理開、紅利點數關」的客服 —— 會在商家改別的權限時被擋)。
// 🔴 商家永遠可以按「只開這一個 / 只關這一個」做出任何組合;做出來的不完整狀態由 legacyDependencyNotes
//    依當下狀態即時算出黃色 `!`(不另存旗標,舊資料與商家剛剛自己選的一視同仁)。
// 📌 刻意不放 types.ts:避開 C / D 也在改的 AGENT_PERMISSION_SECTIONS 那一段。

import { AGENT_PERMISSION_SECTIONS } from "./types";

export interface AgentPermissionDependency {
  /** 這個權限 */
  key: string;
  /** 需要搭配的權限 */
  requires: string;
  /** 「開了 key、沒開 requires」時,key 下方常駐黃色 `!` 的文字 */
  legacyNote: string;
}

/** §11.3 相依關係表 E-1~E-5;順序即顯示順序(同一個權限有兩句時,依這裡的先後排)。 */
export const AGENT_PERMISSION_DEPENDENCIES: readonly AgentPermissionDependency[] = [
  {
    key: "material_costs",
    requires: "commission_settings",
    legacyNote: "「料錢影響服務人員抽成」開關目前改不了，需要同時開啟「抽成與薪資設定」權限。",
  },
  {
    key: "commission_settings",
    requires: "material_costs",
    legacyNote:
      "「料錢是否影響抽成」的開關在料錢成本管理頁，目前進不去，需要同時開啟「料錢成本管理」權限。",
  },
  {
    key: "commission_settings",
    requires: "team_leave",
    legacyNote:
      "假別扣款規則在「月薪人員假別設定」頁，目前進不去，需要同時開啟「月薪人員假別設定」權限。",
  },
  {
    key: "members",
    requires: "member_points",
    legacyNote:
      "「紅利點數」頁目前只看得到頁面、看不到規則設定，要查看或修改紅利規則，需要同時開啟「紅利點數」權限。",
  },
  {
    key: "member_points",
    requires: "members",
    legacyNote: "目前進不去「紅利點數」頁，這個權限還沒有作用，需要同時開啟「會員管理」權限。",
  },
];

/** §11.5:「一起開啟」時,清單每一項寫的「這位客服會多看到 / 多能做」。 */
export const AGENT_PERMISSION_GRANT_EFFECTS: Readonly<Record<string, string>> = {
  commission_settings: "會看到所有服務人員的月薪金額與抽成比例，而且可以修改。",
  team_leave:
    "會看到所有月薪制、日薪制、時薪制服務人員的請假紀錄，可以登記、取消請假，也可以修改假別清單。",
  material_costs: "可以新增、編輯、下架料錢成本品項，也可以打開或關閉料錢成本功能。",
  member_points:
    "可以修改紅利點數的所有規則，包含核發條件、紅利計算、點數使用、推薦系統與生日獎勵。",
  members: "會看到所有會員的姓名、電話等資料，可以新增、編輯、下架會員，也可以查看點數並登記兌換。",
};

/** §11.5:「一起關閉」時,清單每一項寫的「會失去」。 */
export const AGENT_PERMISSION_REVOKE_EFFECTS: Readonly<Record<string, string>> = {
  commission_settings: "不能再查看、修改服務人員的月薪與抽成比例。",
  team_leave: "不能再查看請假紀錄，也不能登記請假、修改假別清單。",
  material_costs: "不能再管理料錢成本品項與功能開關。",
  member_points: "不能再查看、修改紅利點數規則。",
  members: "不能再查看、編輯會員資料，也進不去紅利點數頁。",
};

/** 依 AGENT_PERMISSION_SECTIONS 的畫面順序排序(不在清單裡的排最後,理論上不會發生)。 */
function sortByScreenOrder(keys: Iterable<string>): string[] {
  const order = new Map(AGENT_PERMISSION_SECTIONS.map((s, i) => [s.key, i]));
  return [...keys].sort(
    (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
}

function requirementsOf(key: string): string[] {
  return AGENT_PERMISSION_DEPENDENCIES.filter((d) => d.key === key).map((d) => d.requires);
}

function dependentsOf(key: string): string[] {
  return AGENT_PERMISSION_DEPENDENCIES.filter((d) => d.requires === key).map((d) => d.key);
}

/**
 * 打開 key:回傳「還沒開、要一併打開」的權限(遞移閉包,依畫面順序排序)。
 * - E-R1:一路找到底;已經開著的不列,但仍會往下找(它自己缺的也要補上);key 自己不列。
 * - E-R3:隱藏中的權限不列、不開、也不從它往下找。
 */
export function keysToEnableWith(
  key: string,
  isOn: (k: string) => boolean,
  isHidden: (k: string) => boolean,
): string[] {
  const visited = new Set<string>([key]);
  const result = new Set<string>();
  const queue = [key];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const req of requirementsOf(current)) {
      if (visited.has(req)) continue;
      visited.add(req);
      if (isHidden(req)) continue;
      if (!isOn(req)) result.add(req);
      queue.push(req);
    }
  }
  return sortByScreenOrder(result);
}

/**
 * 關掉 key:回傳「目前開著、會因此不能完整使用而要一併關閉」的權限(反向遞移閉包,依畫面順序排序)。
 * - E-R4:只沿著「目前開著」的權限往上找(本來就關著的不會因為這次關閉而失去什麼)。
 * - E-R3:隱藏中的權限不列、不關、也不從它往上找。
 */
export function keysToDisableWith(
  key: string,
  isOn: (k: string) => boolean,
  isHidden: (k: string) => boolean,
): string[] {
  const visited = new Set<string>([key]);
  const result = new Set<string>();
  const queue = [key];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dep of dependentsOf(current)) {
      if (visited.has(dep)) continue;
      visited.add(dep);
      if (isHidden(dep) || !isOn(dep)) continue;
      result.add(dep);
      queue.push(dep);
    }
  }
  return sortByScreenOrder(result);
}

/** §11.6:key 開著、但它需要的權限沒開 ⇒ 回傳那幾句提醒(依 AGENT_PERMISSION_DEPENDENCIES 順序)。 */
export function legacyDependencyNotes(
  key: string,
  isOn: (k: string) => boolean,
  isHidden: (k: string) => boolean,
): string[] {
  if (!isOn(key) || isHidden(key)) return [];
  return AGENT_PERMISSION_DEPENDENCIES.filter(
    (d) => d.key === key && !isHidden(d.requires) && !isOn(d.requires),
  ).map((d) => d.legacyNote);
}

/** §11.5 小卡窗文案(標題 / 說明第一句 / 淡字提醒 / 按鈕),集中在這裡方便 vitest 逐字核對。 */
export const DEPENDENCY_CONFIRM_COPY = {
  enable: {
    title: (n: number) => `要一起開啟 ${n} 個相關權限嗎？`,
    lead: (label: string) =>
      `「${label}」要搭配下面的權限才能完整使用。按「一起開啟」後，這位客服會同時多出這些權限：`,
    hint: "按「只開這一個」也可以，之後這個權限下方會一直提醒還缺哪些權限。",
    action: "一起開啟",
    onlyThis: "只開這一個",
  },
  disable: {
    title: (n: number) => `要一起關閉 ${n} 個相關權限嗎？`,
    lead: (label: string) =>
      `關掉「${label}」後，下面的權限就沒辦法完整使用，按「一起關閉」會同時關掉：`,
    hint: "按「只關這一個」也可以，之後受影響的權限下方會一直提醒。",
    action: "一起關閉",
    onlyThis: "只關這一個",
  },
  cancel: "取消",
} as const;
