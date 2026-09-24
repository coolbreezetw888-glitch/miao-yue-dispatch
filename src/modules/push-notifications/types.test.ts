// 模組 15 擴充:types.ts 的常數/純函式測試。
// 對應規格書 §4.4 第 3 點(小字要誠實寫出量有多大)、§4.5(前一天提醒只給服務人員)、
// §5.3(跳過原因的白話說明「CHECK 清單與 label 清單一致」)。

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PUSH_LOG_SKIP_REASONS,
  PUSH_LOG_SKIP_REASON_LABELS,
  PUSH_NOTIFICATION_EVENT_TYPES,
  PUSH_TARGET_TYPE_LABELS,
  eventDescriptionForTarget,
  visibleEventTypesForTarget,
} from "./types";

describe("§4.5 / 裁決 Q2:前一天提醒只開放給服務人員", () => {
  it("服務人員看得到四個事件", () => {
    expect(visibleEventTypesForTarget("staff")).toEqual(PUSH_NOTIFICATION_EVENT_TYPES);
    expect(visibleEventTypesForTarget("staff")).toHaveLength(4);
  });

  it("管理員/客服只有三個事件(不含逐筆發送的「前一天提醒隔天預約」)", () => {
    for (const role of ["admin", "agent"] as const) {
      const visible = visibleEventTypesForTarget(role);
      expect(visible).toHaveLength(3);
      expect(visible).not.toContain("booking_reminder_next_day");
    }
  });
});

describe("§4.4 第 3 點:管理員/客服的小字要誠實寫出「量有多大」", () => {
  it("管理員/客服的新訂單說明明寫「每一筆」", () => {
    expect(eventDescriptionForTarget("booking_created", "admin")).toBe(
      "這間店每一筆新訂單都會通知你",
    );
    expect(eventDescriptionForTarget("booking_created", "agent")).toBe(
      "這間店每一筆新訂單都會通知你",
    );
  });

  it("服務人員的說明是「指派給你的」,不是全店", () => {
    expect(eventDescriptionForTarget("booking_created", "staff")).toBe(
      "指派給你的訂單有新單時通知你",
    );
  });

  it("每一種角色 × 每一個看得到的事件都有一句說明(不會出現空字串)", () => {
    for (const role of ["admin", "agent", "staff"] as const) {
      for (const eventType of visibleEventTypesForTarget(role)) {
        expect(eventDescriptionForTarget(eventType, role).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("§5.3:跳過原因的 CHECK 清單與 label 清單必須一致", () => {
  // 直接讀 migration 檔案取出資料庫真正允許的 skip_reason 值,不是抄一份常數在測試裡 ——
  // 抄一份的話,之後有人只改資料庫、沒改文案,這條測試照樣綠燈,等於沒守住。
  function readSkipReasonsFromMigration(): string[] {
    const file = path.resolve(
      __dirname,
      "../../../supabase/migrations/20260925010000_push_multi_role_schema.sql",
    );
    const sql = readFileSync(file, "utf8");
    const match = sql.match(
      /add constraint push_notification_log_skip_reason_check[\s\S]*?in \(([\s\S]*?)\)/,
    );
    const inner = match?.[1];
    if (!inner) throw new Error("找不到 push_notification_log_skip_reason_check 的 CHECK 定義");
    return [...inner.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
  }

  it("migration 裡允許的每一個 skip_reason 都有白話文案", () => {
    const allowed = readSkipReasonsFromMigration();
    expect(allowed.length).toBeGreaterThan(0);
    for (const reason of allowed) {
      expect(PUSH_LOG_SKIP_REASON_LABELS[reason], `${reason} 沒有白話說明`).toBeTruthy();
    }
  });

  it("types.ts 的 PUSH_LOG_SKIP_REASONS 跟 migration 完全一致(順序不論)", () => {
    expect([...PUSH_LOG_SKIP_REASONS].sort()).toEqual(readSkipReasonsFromMigration().sort());
  });

  it("label 表裡沒有多出資料庫根本寫不進去的原因", () => {
    const allowed = new Set(readSkipReasonsFromMigration());
    for (const key of Object.keys(PUSH_LOG_SKIP_REASON_LABELS)) {
      expect(allowed.has(key), `${key} 不在資料庫的 CHECK 允許值裡`).toBe(true);
    }
  });

  it("新增的兩個原因有對應的文案(personal_disabled / no_recipient)", () => {
    expect(PUSH_LOG_SKIP_REASON_LABELS["personal_disabled"]).toBe("這位服務人員自己關掉了這種通知");
    expect(PUSH_LOG_SKIP_REASON_LABELS["no_recipient"]).toBe("沒有任何人訂閱這個事件的通知");
  });
});

describe("§7.1:角色白話名稱", () => {
  it("三種角色都有名稱", () => {
    expect(PUSH_TARGET_TYPE_LABELS).toEqual({
      admin: "商家管理員",
      agent: "客服",
      staff: "服務人員",
    });
  });
});
