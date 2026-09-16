// 回歸測試:對應 ARCHITECTURE.md 第八節第 5 條要補的坑第 2 項
// ——「同一瀏覽器換帳號,會短暫看到上一個帳號的商家」。
//
// 完整背景見 src/modules/merchant/context.tsx 檔案開頭的說明,根本原因有兩層:
//   1. localStorage 的「目前操作中商家 id」原本是全域 key,不分帳號(純函式部分見
//      constants.test.ts,這裡不重複測)。
//   2. 更根本的一層:react-query 的快取 key 原本也是全域的,如果帳號 A 尚未結束的請求在畫面
//      已經切換到帳號 B 之後才回應,會把 A 的資料寫進全域共用的快取 key,讓 B 讀到 A 的商家清單。
//
// 這裡直接重現第 2 點的競態情境:模擬「A 的請求特別慢,慢到使用者已經切換成 B」,驗證 A 的資料
// 最終抵達時,不會污染 B 當下看到的商家清單——因為兩者的 queryKey 天生不同(見 context.tsx
// ACCESSIBLE_MERCHANTS_QUERY_KEY_PREFIX 的用法)。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import type { MerchantWithGroup } from "./types";

const getVerifiedUserMock = vi.fn();
let authStateChangeCallback: ((event: string, session: unknown) => void) | null = null;
const unsubscribeMock = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getVerifiedUser: (...args: unknown[]) => getVerifiedUserMock(...args),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        authStateChangeCallback = cb;
        return { data: { subscription: { unsubscribe: unsubscribeMock } } };
      },
    },
  },
}));

const fetchAccessibleMerchantsMock = vi.fn();
const fetchMerchantAdminUsersMock = vi.fn();
const getFeatureFlagMock = vi.fn();

vi.mock("./api", () => ({
  fetchAccessibleMerchants: (...args: unknown[]) => fetchAccessibleMerchantsMock(...args),
  fetchMerchantAdminUsers: (...args: unknown[]) => fetchMerchantAdminUsersMock(...args),
  getFeatureFlag: (...args: unknown[]) => getFeatureFlagMock(...args),
}));

// 動態 import,確保套用上面 mock 之後的模組。
async function importContextModule() {
  return await import("./context");
}

function makeShop(id: string, name: string): MerchantWithGroup {
  return {
    id,
    name,
    group_id: `group-${id}`,
    industry_type: "on_site_dispatch",
    logo_url: null,
    address: null,
    contact_email: null,
    intro: null,
    theme_preset: null,
    theme_custom_color: null,
    announcement_enabled: false,
    announcement_content: null,
    booking_slug: `${name}-slug`,
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    group: { id: `group-${id}`, name: `${name} 集團` },
  } as unknown as MerchantWithGroup;
}

describe("CurrentMerchantProvider — 跨帳號快取隔離回歸測試", () => {
  beforeEach(() => {
    localStorage.clear();
    getVerifiedUserMock.mockReset();
    fetchAccessibleMerchantsMock.mockReset();
    fetchMerchantAdminUsersMock.mockReset();
    getFeatureFlagMock.mockReset();
    authStateChangeCallback = null;
    unsubscribeMock.mockClear();
  });

  it("帳號 A 的請求延遲抵達時,不會污染已經切換成帳號 B 之後看到的商家清單", async () => {
    const { CurrentMerchantProvider, useGroupMerchants } = await importContextModule();

    const shopA = makeShop("merchant-a", "涼風工匠");
    const shopB = makeShop("merchant-b", "美甲");

    let resolveShopAFetch!: (value: MerchantWithGroup[]) => void;
    fetchAccessibleMerchantsMock
      .mockImplementationOnce(
        () =>
          new Promise<MerchantWithGroup[]>((resolve) => {
            resolveShopAFetch = resolve;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve([shopB]));

    // 一開始就是使用者 A 登入(避免測試依賴 onAuthStateChange 的第一次觸發時機)。
    getVerifiedUserMock.mockResolvedValue({ id: "user-a" });

    const queryClient = new QueryClient();
    let capturedMerchants: MerchantWithGroup[] = [];

    function Probe() {
      const { merchants } = useGroupMerchants();
      capturedMerchants = merchants;
      return null;
    }

    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <CurrentMerchantProvider>{children}</CurrentMerchantProvider>
        </QueryClientProvider>
      );
    }

    render(
      <Wrapper>
        <Probe />
      </Wrapper>,
    );

    // 等到「使用者 A」的查詢真的被觸發(第一次呼叫 fetchAccessibleMerchants,對應 A 的 queryKey)。
    await waitFor(() => expect(fetchAccessibleMerchantsMock).toHaveBeenCalledTimes(1));

    // 使用者換成 B(這裡不 await,模擬「A 的請求還吊在半空中」的競態情境)。
    getVerifiedUserMock.mockResolvedValue({ id: "user-b" });
    expect(authStateChangeCallback).not.toBeNull();
    authStateChangeCallback?.("SIGNED_IN", { user: { id: "user-b" } });

    // B 的查詢(第二次呼叫)會立刻 resolve,等畫面反映出 B 的商家清單。
    await waitFor(() => expect(capturedMerchants).toEqual([shopB]));

    // 這時候才讓 A 那個「慢半拍」的請求抵達——這正是造成過原始 bug 的時序。
    resolveShopAFetch([shopA]);
    // 讓微任務/effect 有機會跑完。
    await Promise.resolve();
    await Promise.resolve();

    // 關鍵斷言:A 遲到的資料不能覆蓋掉 B 當下看到的商家清單。
    expect(capturedMerchants).toEqual([shopB]);
    expect(capturedMerchants).not.toEqual([shopA]);

    // A 的資料確實有進快取(不是被丟棄),只是被存在 A 自己專屬的 queryKey 底下,不影響 B。
    const cachedForA = queryClient.getQueryData([
      "merchant-module",
      "accessible-merchants",
      "user-a",
    ]);
    const cachedForB = queryClient.getQueryData([
      "merchant-module",
      "accessible-merchants",
      "user-b",
    ]);
    expect(cachedForA).toEqual([shopA]);
    expect(cachedForB).toEqual([shopB]);
  });

  it("useMerchantSwitcherState 切換商家時,只寫入目前使用者自己的 localStorage key", async () => {
    const { CurrentMerchantProvider, useMerchantSwitcherState } = await importContextModule();

    const shopA1 = makeShop("merchant-a1", "分店一");
    const shopA2 = makeShop("merchant-a2", "分店二");
    fetchAccessibleMerchantsMock.mockResolvedValue([shopA1, shopA2]);
    getVerifiedUserMock.mockResolvedValue({ id: "user-a" });

    const queryClient = new QueryClient();
    let switcher!: ReturnType<typeof useMerchantSwitcherState>;

    function Probe() {
      switcher = useMerchantSwitcherState();
      return null;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <CurrentMerchantProvider>
          <Probe />
        </CurrentMerchantProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(switcher.merchants.length).toBe(2));

    switcher.setCurrentMerchantId("merchant-a2");

    await waitFor(() =>
      expect(localStorage.getItem("miaoyue.currentMerchantId.user-a")).toBe("merchant-a2"),
    );
    // 不會誤寫到其他使用者的 key 底下(這裡沒有其他使用者存在,確認也沒有寫出一個全域、
    // 不分帳號的舊版 key)。
    expect(localStorage.getItem("miaoyue.currentMerchantId")).toBeNull();
  });
});
