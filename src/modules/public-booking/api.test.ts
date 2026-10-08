// 客戶端第 1 批(C1):公開預約頁 api 的回傳檢查。
//   - 只挑白名單欄位出來(資料庫萬一多回傳了什麼,畫面也拿不到)
//   - 結構不對 ⇒ invalid_response(畫面顯示「讀取失敗」,不會拿半殘資料亂顯示)
//   - not_found / unavailable 只留 status

import { describe, expect, it } from "vitest";

import { parsePublicAvailableSlots, parsePublicBookingPage, PublicBookingError } from "./api";

describe("parsePublicBookingPage", () => {
  it("只挑白名單欄位;多出來的欄位(例:商家 id、服務人員本名)一律丟掉", () => {
    const page = parsePublicBookingPage({
      status: "ok",
      merchant: {
        id: "SENTINEL_MERCHANT_ID",
        group_id: "SENTINEL_GROUP",
        contact_email: "sentinel-merchant@example.com",
        name: "涼風工匠",
        industry_type: "on_site_dispatch",
        logo_url: null,
        address: null,
        phone: null,
        intro: null,
        theme_preset: "steady_blue",
        theme_custom_color: null,
        announcement: null,
        line_friend_url: null,
      },
      booking_settings: { allow_guest_booking: false, is_on_site: true, min_lead_hours: 2 },
      categories: [{ id: "c1", name: "分類", created_at: "x" }],
      service_items: [
        {
          id: "i1",
          category_id: null,
          name: "項目",
          description: null,
          price: "2500.00",
          duration_minutes: 90,
          item_type: "primary",
          status: "active",
        },
      ],
      staff: [
        {
          id: "s1",
          display_name: "阿明",
          name: "SENTINEL_STAFF_REALNAME",
          phone: "0900111222",
          avatar_url: null,
          intro: null,
          primary_service_item_ids: null,
        },
      ],
    });
    const text = JSON.stringify(page);
    for (const sentinel of [
      "SENTINEL_MERCHANT_ID",
      "SENTINEL_GROUP",
      "sentinel-merchant@example.com",
      "min_lead_hours",
      "created_at",
      "SENTINEL_STAFF_REALNAME",
      "0900111222",
    ]) {
      expect(text).not.toContain(sentinel);
    }
    expect(page.status === "ok" && page.service_items[0]!.price).toBe(2500);
    expect(page.status === "ok" && page.booking_settings.allow_guest_booking).toBe(false);
  });

  it("not_found / unavailable 只留 status", () => {
    expect(parsePublicBookingPage({ status: "not_found" })).toEqual({ status: "not_found" });
    expect(parsePublicBookingPage({ status: "unavailable", merchant: { name: "x" } })).toEqual({
      status: "unavailable",
    });
  });

  it("結構不對 ⇒ invalid_response", () => {
    expect(() => parsePublicBookingPage(null)).toThrow(PublicBookingError);
    expect(() => parsePublicBookingPage({ status: "ok", merchant: { name: 1 } })).toThrow(
      PublicBookingError,
    );
  });
});

describe("parsePublicAvailableSlots", () => {
  it("時間統一成 HH:MM;未知的日期狀態 ⇒ invalid_response", () => {
    expect(
      parsePublicAvailableSlots({
        duration_minutes: 240,
        days: [{ date: "2026-10-13", state: "open", times: ["09:00:00", "10:30"] }],
      }),
    ).toEqual({
      duration_minutes: 240,
      days: [{ date: "2026-10-13", state: "open", times: ["09:00", "10:30"] }],
    });
    expect(() =>
      parsePublicAvailableSlots({
        duration_minutes: 60,
        days: [{ date: "2026-10-13", state: "weird", times: [] }],
      }),
    ).toThrow(PublicBookingError);
  });
});

describe("C2-C01 / C2-C06 新欄位", () => {
  const base = {
    status: "ok",
    merchant: {
      name: "店",
      industry_type: "in_store_beauty",
      logo_url: null,
      address: null,
      phone: null,
      intro: null,
      theme_preset: null,
      theme_custom_color: null,
      announcement: null,
      line_friend_url: null,
    },
    categories: [],
    service_items: [],
    staff: [],
  };

  it("line_login_enabled、member_policy(有內容 ⇒ 開;null / 空白 ⇒ 沒開);Channel ID 不會被收下", () => {
    const page = parsePublicBookingPage({
      ...base,
      booking_settings: {
        allow_guest_booking: true,
        is_on_site: false,
        line_login_enabled: true,
        member_policy: "點數一年內有效。",
        channel_id: "SENTINEL_CHANNEL",
      },
    });
    if (page.status !== "ok") throw new Error("expected ok");
    expect(page.booking_settings.line_login_enabled).toBe(true);
    expect(page.member_policy).toEqual({ enabled: true, content: "點數一年內有效。" });
    expect(JSON.stringify(page)).not.toContain("SENTINEL_CHANNEL");

    for (const policy of [null, "  ", undefined]) {
      const p2 = parsePublicBookingPage({
        ...base,
        booking_settings: { member_policy: policy },
      });
      if (p2.status !== "ok") throw new Error("expected ok");
      expect(p2.booking_settings.line_login_enabled).toBe(false);
      expect(p2.member_policy).toEqual({ enabled: false, content: null });
    }
  });
});
