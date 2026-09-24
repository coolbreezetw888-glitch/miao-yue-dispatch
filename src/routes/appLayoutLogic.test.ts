// 後台導覽外殼角色判斷的單元測試。
//
// ⚠️ 這個檔案存在的理由要寫清楚,免得之後有人覺得「這幾個一行的函式測它幹嘛」:
// 2026-09-24 發生線上故障 —— 雙重身分(某商家的客服 + 同一間商家的服務人員)的使用者登入後
// 完全進不去服務人員端,底部選單被套成商家端,而他身為客服沒有任何客服權限,所以「功能」頁只剩
// 「目前沒有開放給你的功能,請聯絡商家管理員開通權限。」這句話。這條路徑當時 **零測試覆蓋**,
// 唯一的進入路徑(藏在商家切換器下拉選單最底部的一個選項)也從來沒有在實機上被驗證過。
//
// 所以這裡逐一釘住:純服務人員 / 雙重身分未切換 / 雙重身分已切換 / 雙重身分但在沒有服務人員身分的
// 那間商家 / 角色還在載入中 / 純管理員 / 純客服,七種情況的 isStaffView、tabs、切換入口是否出現。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  APP_HEADER_TITLE_PATTERNS,
  MERCHANT_TABS,
  readStoredStaffViewPreference,
  resolveAppHeaderTitle,
  resolveHomePageOutcome,
  resolveIsDualRoleEligible,
  resolveIsStaffView,
  resolveTabs,
  shouldShowStaffViewSwitch,
  STAFF_TABS,
  staffViewPreferenceKey,
  isStaffViewResolved,
  writeStoredStaffViewPreference,
  type MerchantRoleValue,
  type SimpleStorage,
} from "./appLayoutLogic";

/** 把三個輸入攤平成「這個角色實際會看到什麼」,讓每個情境只需要一行斷言。 */
function viewFor(
  merchantRole: MerchantRoleValue,
  hasActiveStaffRecord: boolean,
  forcedStaffView = false,
) {
  const isStaffView = resolveIsStaffView({ merchantRole, hasActiveStaffRecord, forcedStaffView });
  return {
    isStaffView,
    tabLabels: resolveTabs(isStaffView).map((tab) => tab.label),
    showsSwitch: shouldShowStaffViewSwitch(merchantRole, hasActiveStaffRecord),
  };
}

describe("底部分頁籤的組合本身", () => {
  it("商家端與服務人員端都是 4 個分頁籤(「所有角色分頁籤數量一致」這條既有規則)", () => {
    expect(MERCHANT_TABS).toHaveLength(4);
    expect(STAFF_TABS).toHaveLength(4);
  });

  it("商家端分頁籤這次沒有改動:功能/行事曆/訂單管理/店家報表", () => {
    expect(MERCHANT_TABS.map((t) => t.label)).toEqual(["功能", "行事曆", "訂單管理", "店家報表"]);
    expect(MERCHANT_TABS.map((t) => t.to)).toEqual([
      "/app/manage",
      "/app/calendar",
      "/app/orders",
      "/app/billing-report",
    ]);
  });

  it("服務人員端分頁籤(2026-09-24 使用者指定的新順序):個人資料/行事曆/休假設定/薪資報表", () => {
    expect(STAFF_TABS.map((t) => t.label)).toEqual(["個人資料", "行事曆", "休假設定", "薪資報表"]);
    expect(STAFF_TABS.map((t) => t.to)).toEqual([
      "/app",
      "/app/calendar",
      "/app/my-availability",
      "/app/my-payroll",
    ]);
  });

  it("服務人員端不出現「功能」分頁籤,但 /app/manage 這條路由只是被隱藏、沒有從商家端消失", () => {
    expect(STAFF_TABS.some((t) => t.to === "/app/manage")).toBe(false);
    expect(MERCHANT_TABS.some((t) => t.to === "/app/manage")).toBe(true);
  });

  it("isActive:「個人資料」只在 /app 本身亮起,不會被 /app/calendar 之類的子路由誤判", () => {
    const profileTab = STAFF_TABS[0]!;
    expect(profileTab.isActive("/app")).toBe(true);
    expect(profileTab.isActive("/app/calendar")).toBe(false);
    expect(profileTab.isActive("/app/my-payroll")).toBe(false);
  });

  it("isActive:商家端「功能」分頁籤涵蓋 /app/staff、/app/agents、/app/settings 等子頁", () => {
    const manageTab = MERCHANT_TABS[0]!;
    for (const pathname of [
      "/app/manage",
      "/app/staff",
      "/app/agents",
      "/app/service-items",
      "/app/settings",
    ]) {
      expect(manageTab.isActive(pathname)).toBe(true);
    }
    expect(manageTab.isActive("/app/orders")).toBe(false);
  });
});

describe("resolveIsStaffView / tabs / 切換入口:七種身分情境", () => {
  it("純服務人員(role=staff):看服務人員端、拿 STAFF_TABS、沒有切換入口", () => {
    const v = viewFor("staff", true);
    expect(v.isStaffView).toBe(true);
    expect(v.tabLabels).toEqual(["個人資料", "行事曆", "休假設定", "薪資報表"]);
    // 純服務人員沒有商家端可以切過去,所以不該出現切換入口。
    expect(v.showsSwitch).toBe(false);
  });

  it("雙重身分(role=agent + 有服務人員紀錄)未切換:看商家端、拿 MERCHANT_TABS,但切換入口一定要出現", () => {
    const v = viewFor("agent", true, false);
    expect(v.isStaffView).toBe(false);
    expect(v.tabLabels).toEqual(["功能", "行事曆", "訂單管理", "店家報表"]);
    // ⬇⬇ 這一條就是這次線上故障的核心:切換入口必須存在,否則這個人永遠進不去服務人員端。
    expect(v.showsSwitch).toBe(true);
  });

  it("雙重身分已切換:看服務人員端、拿 STAFF_TABS、切換入口仍然要在(才能切回商家端)", () => {
    const v = viewFor("agent", true, true);
    expect(v.isStaffView).toBe(true);
    expect(v.tabLabels).toEqual(["個人資料", "行事曆", "休假設定", "薪資報表"]);
    expect(v.showsSwitch).toBe(true);
  });

  it("雙重身分(role=admin + 有服務人員紀錄):管理員這一半跟客服完全一樣的行為", () => {
    expect(viewFor("admin", true, false).isStaffView).toBe(false);
    expect(viewFor("admin", true, false).showsSwitch).toBe(true);
    expect(viewFor("admin", true, true).isStaffView).toBe(true);
  });

  it("雙重身分的人切到「沒有服務人員身分的那間商家」:切換入口不出現,也不會誤切成服務人員端", () => {
    // 實際案例:goldtw2021 在「涼風工匠」是客服+服務人員,在「美甲」只是客服。
    const v = viewFor("agent", false, false);
    expect(v.showsSwitch).toBe(false);
    expect(v.isStaffView).toBe(false);
    expect(v.tabLabels).toEqual(["功能", "行事曆", "訂單管理", "店家報表"]);
  });

  it("即使上一間商家的選擇殘留成 forcedStaffView=true,在沒有服務人員紀錄的商家也不會生效", () => {
    // 這是安全側的斷言:沒有服務人員紀錄卻顯示服務人員端,頁面會查不到任何資料、卡在載入中。
    expect(viewFor("agent", false, true).isStaffView).toBe(false);
    expect(viewFor("admin", false, true).isStaffView).toBe(false);
  });

  it("純管理員:商家端、MERCHANT_TABS、沒有切換入口", () => {
    const v = viewFor("admin", false);
    expect(v.isStaffView).toBe(false);
    expect(v.tabLabels).toEqual(["功能", "行事曆", "訂單管理", "店家報表"]);
    expect(v.showsSwitch).toBe(false);
  });

  it("純客服:商家端、MERCHANT_TABS、沒有切換入口", () => {
    const v = viewFor("agent", false);
    expect(v.isStaffView).toBe(false);
    expect(v.tabLabels).toEqual(["功能", "行事曆", "訂單管理", "店家報表"]);
    expect(v.showsSwitch).toBe(false);
  });

  it("角色還在載入中(undefined):一律先當成商家端,而且不長出切換入口(避免閃一下又消失)", () => {
    const v = viewFor(undefined, false);
    expect(v.isStaffView).toBe(false);
    expect(v.tabLabels).toEqual(["功能", "行事曆", "訂單管理", "店家報表"]);
    expect(v.showsSwitch).toBe(false);
    // 載入中 + 服務人員紀錄已經先回來的交錯順序,也不能被誤判成雙重身分。
    expect(viewFor(undefined, true, true).isStaffView).toBe(false);
    expect(viewFor(undefined, true, true).showsSwitch).toBe(false);
  });

  it("角色解出來是 null(跟這間店無關):商家端,不長出切換入口", () => {
    const v = viewFor(null, true, true);
    expect(v.isStaffView).toBe(false);
    expect(v.showsSwitch).toBe(false);
  });

  it("resolveIsDualRoleEligible 與 shouldShowStaffViewSwitch 對所有角色值都同義", () => {
    const roles: MerchantRoleValue[] = ["admin", "agent", "staff", null, undefined];
    for (const role of roles) {
      for (const hasStaff of [true, false]) {
        expect(shouldShowStaffViewSwitch(role, hasStaff)).toBe(
          resolveIsDualRoleEligible(role, hasStaff),
        );
      }
    }
  });
});

describe("isStaffViewResolved:角色載入競態", () => {
  it("商家還沒選定時一律「還沒有答案」——兩個查詢此時都是停用狀態,isLoading 會騙人", () => {
    expect(
      isStaffViewResolved({
        hasCurrentMerchant: false,
        roleLoading: false,
        staffRecordLoading: false,
      }),
    ).toBe(false);
  });

  it("角色或服務人員紀錄任一個還在載入,就還沒有答案", () => {
    expect(
      isStaffViewResolved({
        hasCurrentMerchant: true,
        roleLoading: true,
        staffRecordLoading: false,
      }),
    ).toBe(false);
    expect(
      isStaffViewResolved({
        hasCurrentMerchant: true,
        roleLoading: false,
        staffRecordLoading: true,
      }),
    ).toBe(false);
  });

  it("商家已選定 + 兩個查詢都結束 ⇒ 有答案了", () => {
    expect(
      isStaffViewResolved({
        hasCurrentMerchant: true,
        roleLoading: false,
        staffRecordLoading: false,
      }),
    ).toBe(true);
  });
});

describe("resolveHomePageOutcome:/app 這個路由該做什麼", () => {
  it("還沒有答案時顯示載入中,絕對不能先把人彈去 /app/manage", () => {
    // 這就是改版前的 bug:merchantRole 還是 undefined ⇒ isStaffView false ⇒ 純服務人員被彈走,
    // 使用者會先看到一眼商家端的「功能」頁(對沒權限的人而言就是那句「目前沒有開放給你的功能」)。
    expect(resolveHomePageOutcome({ isViewResolved: false, isStaffView: false })).toBe("loading");
    expect(resolveHomePageOutcome({ isViewResolved: false, isStaffView: true })).toBe("loading");
  });

  it("有答案且是服務人員端 ⇒ 渲染服務人員的個人資料頁", () => {
    expect(resolveHomePageOutcome({ isViewResolved: true, isStaffView: true })).toBe(
      "render-staff-home",
    );
  });

  it("有答案但不是服務人員端 ⇒ 才導去 /app/manage", () => {
    expect(resolveHomePageOutcome({ isViewResolved: true, isStaffView: false })).toBe(
      "redirect-to-manage",
    );
  });

  it("串起來看:純服務人員從「載入中」走到「渲染自己的頁面」,中間不會經過 redirect", () => {
    const sequence = [
      // 第一個 render:商家還沒選定。
      { hasCurrentMerchant: false, roleLoading: false, staffRecordLoading: false },
      // 商家選定了,兩個查詢啟動。
      { hasCurrentMerchant: true, roleLoading: true, staffRecordLoading: true },
      // 服務人員紀錄先回來,角色還在查。
      { hasCurrentMerchant: true, roleLoading: true, staffRecordLoading: false },
      // 都回來了。
      { hasCurrentMerchant: true, roleLoading: false, staffRecordLoading: false },
    ];
    const outcomes = sequence.map((resolution, index) => {
      const merchantRole: MerchantRoleValue = index === 3 ? "staff" : undefined;
      return resolveHomePageOutcome({
        isViewResolved: isStaffViewResolved(resolution),
        isStaffView: resolveIsStaffView({
          merchantRole,
          hasActiveStaffRecord: index >= 2,
          forcedStaffView: false,
        }),
      });
    });
    expect(outcomes).toEqual(["loading", "loading", "loading", "render-staff-home"]);
    expect(outcomes).not.toContain("redirect-to-manage");
  });
});

describe("雙重身分檢視選擇的記憶", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    const storage: SimpleStorage = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
      removeItem: (key) => void map.delete(key),
    };
    return { storage, map };
  }

  it("key 依「使用者 + 商家」分開,缺任一個就回傳 null(還不知道該讀哪一把)", () => {
    expect(staffViewPreferenceKey("u1", "m1")).toBe("miaoyue.staffView.u1.m1");
    expect(staffViewPreferenceKey("u1", "m2")).not.toBe(staffViewPreferenceKey("u1", "m1"));
    expect(staffViewPreferenceKey("u2", "m1")).not.toBe(staffViewPreferenceKey("u1", "m1"));
    expect(staffViewPreferenceKey(null, "m1")).toBeNull();
    expect(staffViewPreferenceKey("u1", null)).toBeNull();
    expect(staffViewPreferenceKey(undefined, undefined)).toBeNull();
  });

  it("寫入 true 之後讀得回來;寫入 false 是把 key 清掉(預設回商家端)", () => {
    const { storage, map } = fakeStorage();
    writeStoredStaffViewPreference(storage, "u1", "m1", true);
    expect(readStoredStaffViewPreference(storage, "u1", "m1")).toBe(true);
    writeStoredStaffViewPreference(storage, "u1", "m1", false);
    expect(readStoredStaffViewPreference(storage, "u1", "m1")).toBe(false);
    expect(map.has("miaoyue.staffView.u1.m1")).toBe(false);
  });

  it("A 店的選擇不會外溢到 B 店,也不會外溢到另一個帳號", () => {
    const { storage } = fakeStorage();
    writeStoredStaffViewPreference(storage, "u1", "m1", true);
    expect(readStoredStaffViewPreference(storage, "u1", "m2")).toBe(false);
    expect(readStoredStaffViewPreference(storage, "u2", "m1")).toBe(false);
  });

  it("沒存過 / 存了奇怪的值 ⇒ 一律 false", () => {
    const { storage } = fakeStorage({ "miaoyue.staffView.u1.m1": "yes" });
    expect(readStoredStaffViewPreference(storage, "u1", "m1")).toBe(false);
    expect(readStoredStaffViewPreference(storage, "u1", "zzz")).toBe(false);
  });

  it("storage 不存在或存取就丟例外(無痕模式/封鎖網站資料)時不會爆掉", () => {
    const throwing: SimpleStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredStaffViewPreference(throwing, "u1", "m1")).toBe(false);
    expect(() => writeStoredStaffViewPreference(throwing, "u1", "m1", true)).not.toThrow();
    expect(readStoredStaffViewPreference(null, "u1", "m1")).toBe(false);
    expect(() => writeStoredStaffViewPreference(undefined, "u1", "m1", true)).not.toThrow();
  });
});

// =========================================================================
// 頁首的「目前在哪個功能頁」標題
// =========================================================================
//
// 2026-09-24 使用者實機回報:「頁首應該要顯示目前在哪個功能頁,現在不知道自己在哪。」
// 這一段測試的重點不是「某條路徑對到某個字」這種瑣事,而是守住兩件會真的讓使用者看到壞畫面的事:
//   ① 每一條路由都有標題 —— 漏掉一條,使用者在那一頁就回到「不知道自己在哪」的原點。
//      所以下面有一條測試**直接去讀 src/App.tsx**,把 <Route element={<AppLayout />}> 底下的
//      路徑全部撈出來逐條比對,不靠人工把 34 條路徑抄第二遍(抄就一定會不同步)。
//   ② 永遠回傳字串,不會是 undefined —— 畫面上出現字面的 "undefined" 是最難看的那種 bug。

/** 把 pattern 裡的 `:param` 換成一個假值,變成一條真的會出現在網址列上的路徑。 */
function concretePath(pattern: string): string {
  return pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "abc-123" : segment))
    .join("/");
}

/** 從 src/App.tsx 撈出 `<Route element={<AppLayout />}>` 底下所有子路由的 path。
 * 刻意讀原始檔字串而不是 import App 元件:這條測試的目的就是「清單有沒有跟 App.tsx 同步」,
 * 真的去 render <App /> 反而要把整棵樹的 supabase/react-query 都 mock 掉,得不償失。 */
function appLayoutChildRoutePaths(): string[] {
  // ⚠️ 不能用 `new URL("../App.tsx", import.meta.url)`:這個專案的 vitest 跑在 jsdom 環境下,
  // import.meta.url 是 http:// 開頭的位址,readFileSync 會直接丟 "The URL must be of scheme file"。
  // vitest 的工作目錄就是專案根目錄(vitest.config.ts 所在的地方),所以從那裡組路徑最穩。
  const source = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
  const start = source.indexOf("element={<AppLayout />}");
  expect(start).toBeGreaterThan(-1);
  // 巢狀在裡面的 <Route ... /> 全部是自閉合標籤,所以第一個 </Route> 就是這個區塊的結尾。
  const end = source.indexOf("</Route>", start);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  return Array.from(block.matchAll(/path="([^"]+)"/g)).map((match) => match[1]!);
}

describe("resolveAppHeaderTitle(頁首顯示目前功能頁名稱)", () => {
  it("使用者已經指定的那幾條,文字完全照指定", () => {
    expect(resolveAppHeaderTitle({ pathname: "/app", isStaffView: true })).toBe("個人資料");
    expect(resolveAppHeaderTitle({ pathname: "/app/calendar", isStaffView: false })).toBe("行事曆");
    expect(resolveAppHeaderTitle({ pathname: "/app/my-availability", isStaffView: true })).toBe(
      "休假設定",
    );
    expect(resolveAppHeaderTitle({ pathname: "/app/my-payroll", isStaffView: true })).toBe(
      "薪資報表",
    );
    expect(resolveAppHeaderTitle({ pathname: "/app/manage", isStaffView: false })).toBe("功能");
    expect(resolveAppHeaderTitle({ pathname: "/app/orders", isStaffView: false })).toBe("訂單管理");
    expect(resolveAppHeaderTitle({ pathname: "/app/billing-report", isStaffView: false })).toBe(
      "店家報表",
    );
  });

  it("/app 會因為 isStaffView 而不同,而且商家端也一定有值(不是 undefined、不是空字串)", () => {
    // ⚠️ 商家端的 /app 實務上不會停留(HomePage 會 <Navigate> 到 /app/manage),但頁首在那一瞬間
    // 還是會渲染一次 —— 回 undefined 會讓畫面印出字面的 "undefined",回空字串會閃一下空白。
    // 這裡釘住「回傳使用者下一秒真的會到的那一頁的名字」,所以那一瞬間看起來是「標題先到」。
    const merchantSide = resolveAppHeaderTitle({ pathname: "/app", isStaffView: false });
    expect(merchantSide).toBe("功能");
    expect(merchantSide).not.toBe("");
    expect(resolveAppHeaderTitle({ pathname: "/app", isStaffView: true })).toBe("個人資料");
  });

  it("服務人員端的標題跟底部分頁籤的 label 一致(同一個東西不能有兩個名字)", () => {
    for (const tab of STAFF_TABS) {
      expect(resolveAppHeaderTitle({ pathname: tab.to, isStaffView: true })).toBe(tab.label);
    }
  });

  it("商家端的標題跟底部分頁籤的 label 一致", () => {
    for (const tab of MERCHANT_TABS) {
      expect(resolveAppHeaderTitle({ pathname: tab.to, isStaffView: false })).toBe(tab.label);
    }
  });

  it("帶參數的路徑吃得到,而且不會被同前綴的固定路徑搶走", () => {
    // 頁面內文是「{姓名} 的權限設定」,頁首拿不到姓名,用該頁自己的 fallback 文字。
    expect(
      resolveAppHeaderTitle({ pathname: "/app/staff/9f2c-uuid/permissions", isStaffView: false }),
    ).toBe("權限設定");
    expect(
      resolveAppHeaderTitle({ pathname: "/app/agents/9f2c-uuid/permissions", isStaffView: false }),
    ).toBe("權限設定");
    expect(resolveAppHeaderTitle({ pathname: "/app/members/9f2c-uuid", isStaffView: false })).toBe(
      "會員資料",
    );
    // 前綴相同但段數不同的,各自對到自己的標題,不會互相吃掉。
    expect(resolveAppHeaderTitle({ pathname: "/app/staff", isStaffView: false })).toBe(
      "服務人員管理",
    );
    expect(resolveAppHeaderTitle({ pathname: "/app/agents", isStaffView: false })).toBe("客服管理");
    expect(resolveAppHeaderTitle({ pathname: "/app/members", isStaffView: false })).toBe(
      "會員管理",
    );
    expect(resolveAppHeaderTitle({ pathname: "/app/member-points", isStaffView: false })).toBe(
      "紅利點數管理",
    );
    // 兩層的資料匯入:/app/data-import/history 不可以被 /app/data-import 吃掉。
    expect(resolveAppHeaderTitle({ pathname: "/app/data-import", isStaffView: false })).toBe(
      "資料匯入",
    );
    expect(
      resolveAppHeaderTitle({ pathname: "/app/data-import/history", isStaffView: false }),
    ).toBe("匯入紀錄");
  });

  it("認不出來的路徑回空字串,而且絕對不是 undefined", () => {
    for (const pathname of [
      "/app/does-not-exist",
      "/app/manage/extra/segments",
      "/platform-admin",
      "/signin",
      "/",
      "",
      "/app/calendar/2026/09/24",
    ]) {
      const title = resolveAppHeaderTitle({ pathname, isStaffView: false });
      expect(typeof title).toBe("string");
      expect(title).toBe("");
      // 「不是 undefined」要單獨釘一次:這是會讓畫面出現字面 "undefined" 的那顆地雷。
      expect(title).not.toBeUndefined();
    }
  });

  it("結尾多一個斜線當成同一頁", () => {
    expect(resolveAppHeaderTitle({ pathname: "/app/orders/", isStaffView: false })).toBe(
      "訂單管理",
    );
    expect(resolveAppHeaderTitle({ pathname: "/app/", isStaffView: true })).toBe("個人資料");
  });

  it("每一條標題都是非空字串(清單本身沒有漏填)", () => {
    for (const pattern of APP_HEADER_TITLE_PATTERNS) {
      const title = resolveAppHeaderTitle({
        pathname: concretePath(pattern),
        isStaffView: false,
      });
      expect(title, `${pattern} 沒有對到標題`).not.toBe("");
    }
  });

  it("App.tsx 底下每一條子路由都有標題(清單跟 App.tsx 同步)", () => {
    const routePaths = appLayoutChildRoutePaths();
    // 防呆:萬一上面那段字串剖析壞了(例如 App.tsx 改寫法),路徑數量會變 0,這條會先炸掉,
    // 而不是變成一份「什麼都沒檢查、永遠會過」的假測試。
    expect(routePaths.length).toBeGreaterThan(20);
    expect(routePaths).toContain("/app");
    expect(routePaths).toContain("/app/staff/:staffId/permissions");

    const missing = routePaths.filter((path) => {
      if (path === "/app") return false; // 特別處理(依 isStaffView 分岔),上面已經單獨測過。
      return resolveAppHeaderTitle({ pathname: concretePath(path), isStaffView: false }) === "";
    });
    expect(missing, `這幾條 App.tsx 的路由還沒有頁首標題:${missing.join(", ")}`).toEqual([]);
  });

  it("清單裡沒有 App.tsx 已經不存在的殘留路徑", () => {
    const routePaths = new Set(appLayoutChildRoutePaths());
    const stale = APP_HEADER_TITLE_PATTERNS.filter((pattern) => !routePaths.has(pattern));
    expect(stale, `這幾條已經不在 App.tsx 裡了,應該刪掉:${stale.join(", ")}`).toEqual([]);
  });
});
