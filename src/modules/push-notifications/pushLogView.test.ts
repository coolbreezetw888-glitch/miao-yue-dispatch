// SPECS-INDEX #778:推播發送記錄頁的純邏輯測試。
//
// 故障注入紀錄(2026-09-28,實際做過、看到紅字、再還原):
//   1. 把 skipReasonLabel 改成直接 `return reason`(不查表)→ 「五種原因都查得到白話說明」
//      與「白話說明裡不含英文代碼」兩條立刻紅,錯誤訊息是 expected 'no_subscription' toBe
//      '這個人還沒在任何裝置上開通推播'。
//   2. 把 groupKeyOf 多塞 row.target_type 進 key → 「同一個人兩個身份 → 一組兩列」那條紅
//      (expected 2 groups toHaveLength 1),sameUserNotes 那條也跟著紅。
//   還原後全部轉綠。

import { describe, expect, it } from "vitest";

import {
  PUSH_LOG_ACTION_HINTS,
  UNKNOWN_SKIP_REASON_SUFFIX,
  actionHintForSkipReason,
  describeRecipientOutcome,
  formatSameUserNote,
  groupKeyOf,
  groupPushLogRows,
  recipientKey,
  skipReasonLabel,
  summarizeGroup,
  toRecipientView,
  type RecipientDirectory,
} from "./pushLogView";
import type { PushNotificationLogRow } from "./types";
import { PUSH_LOG_SKIP_REASONS, PUSH_LOG_SKIP_REASON_LABELS } from "./types";

function makeRow(overrides: Partial<PushNotificationLogRow> = {}): PushNotificationLogRow {
  return {
    id: "log-1",
    merchant_id: "m1",
    event_type: "booking_created",
    booking_id: "b1",
    target_type: "staff",
    target_id: "staff-1",
    status: "sent",
    skip_reason: null,
    device_count: 1,
    success_count: 1,
    error_detail: null,
    rendered_title: "新訂單通知",
    rendered_body: "10/01 10:00 王小明 剪髮",
    attempted_at: "2026-09-27T16:27:00.000Z",
    ack_subscription_id: null,
    ack_token: null,
    acked_at: null,
    ...overrides,
  };
}

/** goldtw2021 的實際情形:同一個登入帳號,同時是客服(agent-1)又是服務人員(staff-1)。 */
function dualIdentityDirectory(): RecipientDirectory {
  return new Map([
    [recipientKey("agent", "agent-1"), { name: "阿金", userId: "user-gold" }],
    [recipientKey("staff", "staff-1"), { name: "阿金", userId: "user-gold" }],
    [recipientKey("admin", "admin-1"), { name: "老闆", userId: "user-boss" }],
  ]);
}

describe("跳過原因的白話說明(#734 的 label 表終於有畫面在用)", () => {
  it("五種原因都查得到白話說明,而且就是 label 表裡的那一句(不重新設計文案)", () => {
    for (const reason of PUSH_LOG_SKIP_REASONS) {
      expect(skipReasonLabel(reason)).toBe(PUSH_LOG_SKIP_REASON_LABELS[reason]);
    }
  });

  it("白話說明裡不會出現英文代碼(負向),而且真的有一句中文(正向對照)", () => {
    for (const reason of PUSH_LOG_SKIP_REASONS) {
      const label = skipReasonLabel(reason)!;
      expect(label).not.toContain(reason);
      expect(label).toMatch(/[一-鿿]/);
    }
  });

  it("資料庫多了一個前端沒有文案的原因時,不會一片空白,而是原始代碼 + 明顯的「請回報」後綴", () => {
    expect(skipReasonLabel("brand_new_reason")).toBe(
      `brand_new_reason${UNKNOWN_SKIP_REASON_SUFFIX}`,
    );
  });

  it("skip_reason 為 null(成功送達的列)時沒有說明", () => {
    expect(skipReasonLabel(null)).toBeNull();
    expect(skipReasonLabel(undefined)).toBeNull();
  });

  it("五種原因每一種都有「可以怎麼做」的建議,而且 key 跟 label 表完全一致(不多不少)", () => {
    expect(Object.keys(PUSH_LOG_ACTION_HINTS).sort()).toEqual([...PUSH_LOG_SKIP_REASONS].sort());
    for (const reason of PUSH_LOG_SKIP_REASONS) {
      expect(actionHintForSkipReason(reason)!.length).toBeGreaterThan(0);
    }
    expect(actionHintForSkipReason("brand_new_reason")).toBeNull();
  });

  it("「還沒開通裝置」的建議要告訴老闆去請那個人按「開啟通知」,不是丟代碼", () => {
    expect(actionHintForSkipReason("no_subscription")).toContain("開啟通知");
  });
});

describe("單一收件人那一列的白話結果", () => {
  it("跳過:顯示白話原因 + 建議做法", () => {
    const view = toRecipientView(
      makeRow({
        status: "skipped",
        skip_reason: "no_subscription",
        device_count: 0,
        success_count: 0,
      }),
      new Map(),
    );
    expect(view.detail).toBe("這個人還沒在任何裝置上開通推播");
    expect(view.hint).toBe(PUSH_LOG_ACTION_HINTS["no_subscription"]);
    expect(view.statusLabel).toBe("跳過");
  });

  it("成功:寫出送到幾台裝置,沒有建議做法(正常狀態不需要解釋)", () => {
    const view = toRecipientView(makeRow({ device_count: 2, success_count: 2 }), new Map());
    expect(view.detail).toBe("已送到 2 台裝置");
    expect(view.hint).toBeNull();
    expect(view.statusLabel).toBe("成功");
  });

  it("部分成功 / 失敗:寫出幾台送達 + 錯誤內容", () => {
    expect(
      describeRecipientOutcome(
        makeRow({
          status: "partially_sent",
          device_count: 3,
          success_count: 1,
          error_detail: "410 Gone",
        }),
      ),
    ).toBe("3 台裝置中只有 1 台送達。錯誤內容：410 Gone");
    expect(
      describeRecipientOutcome(
        makeRow({ status: "failed", device_count: 1, success_count: 0, error_detail: "500" }),
      ),
    ).toBe("1 台裝置都沒有送達。錯誤內容：500");
  });

  it("名冊查得到 → 帶姓名與 userId;查不到 → 只剩角色", () => {
    const withName = toRecipientView(makeRow(), dualIdentityDirectory());
    expect(withName.roleLabel).toBe("服務人員");
    expect(withName.name).toBe("阿金");
    expect(withName.userId).toBe("user-gold");

    const withoutName = toRecipientView(makeRow(), new Map());
    expect(withoutName.roleLabel).toBe("服務人員");
    expect(withoutName.name).toBeNull();
    expect(withoutName.userId).toBeNull();
  });

  it("target_type 為 null(商家總開關關閉那種整件事跳過)→ 沒有角色,原因照樣白話", () => {
    const view = toRecipientView(
      makeRow({
        target_type: null,
        target_id: null,
        status: "skipped",
        skip_reason: "event_disabled",
      }),
      new Map(),
    );
    expect(view.roleLabel).toBeNull();
    expect(view.detail).toBe("這個事件的商家總開關是關閉的");
  });
});

describe("群組:一件事一組,同一個人兩個身份不會像是重複發送", () => {
  it("前提:兩列的 group key 相同;把 target_type 放進 key 就會分家(這條守住群組 key 的設計)", () => {
    const a = makeRow({ id: "a", target_type: "agent", target_id: "agent-1" });
    const b = makeRow({
      id: "b",
      target_type: "staff",
      target_id: "staff-1",
      attempted_at: "2026-09-27T16:27:05.000Z",
    });
    expect(groupKeyOf(a)).toBe(groupKeyOf(b));
  });

  it("同一個人兩個身份(同一筆訂單、同一事件、同一分鐘)→ 一組兩列,並標出「同一個人,手機只會收到一次」", () => {
    const rows = [
      makeRow({
        id: "a",
        target_type: "staff",
        target_id: "staff-1",
        attempted_at: "2026-09-27T16:27:05.000Z",
      }),
      makeRow({
        id: "b",
        target_type: "agent",
        target_id: "agent-1",
        attempted_at: "2026-09-27T16:27:04.000Z",
      }),
    ];
    const groups = groupPushLogRows(rows, dualIdentityDirectory());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.recipients).toHaveLength(2);
    // admin → agent → staff 的固定順序
    expect(groups[0]!.recipients.map((r) => r.targetType)).toEqual(["agent", "staff"]);
    expect(groups[0]!.sameUserNotes).toHaveLength(1);
    expect(formatSameUserNote(groups[0]!.sameUserNotes[0]!)).toBe(
      "阿金同時是客服和服務人員，所以這裡有 2 列;他的手機只會收到一次。",
    );
    // 代表時間 = 最新那一列
    expect(groups[0]!.attempted_at).toBe("2026-09-27T16:27:05.000Z");
    expect(groups[0]!.key).toBe("a");
  });

  it("正向對照:兩個不同的人(userId 不同)在同一組 → 合併成一組,但**不會**標成同一個人", () => {
    const rows = [
      makeRow({ id: "a", target_type: "staff", target_id: "staff-1" }),
      makeRow({ id: "b", target_type: "admin", target_id: "admin-1" }),
    ];
    const groups = groupPushLogRows(rows, dualIdentityDirectory());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.recipients).toHaveLength(2);
    expect(groups[0]!.sameUserNotes).toEqual([]);
  });

  it("名冊查不到 userId 時,不會亂猜「同一個人」(寧可少講,不要講錯)", () => {
    const rows = [
      makeRow({ id: "a", target_type: "staff", target_id: "staff-1" }),
      makeRow({ id: "b", target_type: "agent", target_id: "agent-1" }),
    ];
    const groups = groupPushLogRows(rows, new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sameUserNotes).toEqual([]);
  });

  it("不同訂單 / 不同事件 / 差超過一分鐘 → 各自一組,最新的在前", () => {
    const rows = [
      makeRow({ id: "a", booking_id: "b1", attempted_at: "2026-09-27T16:27:00.000Z" }),
      makeRow({ id: "b", booking_id: "b2", attempted_at: "2026-09-27T16:27:10.000Z" }),
      makeRow({
        id: "c",
        booking_id: "b1",
        event_type: "booking_cancelled",
        attempted_at: "2026-09-27T16:27:20.000Z",
      }),
      makeRow({ id: "d", booking_id: "b1", attempted_at: "2026-09-27T16:29:00.000Z" }),
    ];
    const groups = groupPushLogRows(rows, new Map());
    expect(groups.map((g) => g.key)).toEqual(["d", "c", "b", "a"]);
  });

  it("文案只有其中一列有值(event_disabled 那列是 null)時,群組照樣拿得到標題/內容", () => {
    const rows = [
      makeRow({
        id: "a",
        rendered_title: null,
        rendered_body: null,
        target_type: null,
        target_id: null,
        status: "skipped",
        skip_reason: "event_disabled",
      }),
      makeRow({ id: "b", attempted_at: "2026-09-27T16:27:01.000Z" }),
    ];
    const group = groupPushLogRows(rows, new Map())[0]!;
    expect(group.rendered_title).toBe("新訂單通知");
    expect(group.rendered_body).toBe("10/01 10:00 王小明 剪髮");
  });
});

describe("整組的結果徽章", () => {
  const view = (status: string, skip_reason: string | null = null) =>
    toRecipientView(makeRow({ status, skip_reason }), new Map());

  it("全部成功 → 全部送達", () => {
    expect(summarizeGroup([view("sent"), view("sent")])).toEqual({
      kind: "all_sent",
      label: "全部送達",
    });
  });
  it("有人成功有人沒 → 部分送達", () => {
    expect(summarizeGroup([view("sent"), view("skipped", "no_subscription")]).kind).toBe("partial");
    expect(summarizeGroup([view("partially_sent")]).kind).toBe("partial");
  });
  it("全部失敗(有裝置但送不到)→ 發送失敗", () => {
    expect(summarizeGroup([view("failed")])).toEqual({ kind: "failed", label: "發送失敗" });
  });
  it("全部跳過 → 沒有發送", () => {
    expect(summarizeGroup([view("skipped", "event_disabled")])).toEqual({
      kind: "skipped",
      label: "沒有發送",
    });
  });
});
