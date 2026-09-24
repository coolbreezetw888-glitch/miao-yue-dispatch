// 商家切換器裡「切換到服務人員端/商家端」那個下拉選單項目的渲染測試。
//
// 這個測試直接回答 2026-09-24 線上故障調查時問出來、當時完全沒有自動化答案的問題:
// 「MerchantSwitcher 的那個切換選項,實際上到底有沒有渲染出來?有沒有因為某些條件被藏起來?」
//
// 結論(由下面幾條測試釘住):選項本身**有**正確渲染,包含「只有一間商家」這個原本會提早 return
// 純文字標籤的分支也有特別處理過。所以那次故障不是「選項沒渲染」,而是「選項藏在下拉選單最底部,
// 使用者根本沒想到要去點開商家切換器」—— 純粹是可發現性(discoverability)的問題。
// 主要入口因此改成常駐橫幅(src/routes/DualRoleViewSwitchBar.tsx),這個選項保留當第二條路。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MerchantWithGroup } from "./types";

const useMerchantSwitcherStateMock = vi.fn();

vi.mock("./context", () => ({
  useMerchantSwitcherState: () => useMerchantSwitcherStateMock(),
}));

import { MerchantSwitcher } from "./MerchantSwitcher";

function makeMerchant(id: string, name: string, groupId = `group-${id}`): MerchantWithGroup {
  return {
    id,
    name,
    group_id: groupId,
    industry_type: "on_site_dispatch",
    logo_url: null,
    address: null,
    contact_email: null,
    intro: null,
    theme_preset: null,
    theme_custom_color: null,
    announcement_enabled: false,
    announcement_content: null,
    booking_slug: `${id}-slug`,
    status: "active",
    created_at: new Date().toISOString(),
    group: { id: groupId, name: `${name}集團` },
  } as unknown as MerchantWithGroup;
}

function setState(merchants: MerchantWithGroup[], currentMerchantId: string | null) {
  useMerchantSwitcherStateMock.mockReturnValue({
    merchants,
    currentMerchantId,
    setCurrentMerchantId: vi.fn(),
    isLoading: false,
  });
}

/** Radix 的下拉選單內容只有在打開之後才會進 DOM,所以每個測試都要先點開觸發按鈕。
 * Radix 的觸發按鈕靠 pointerdown 開啟(不是 click),所以這裡用 fireEvent.pointerDown。 */
function openDropdown() {
  const trigger = screen.getByRole("button");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("MerchantSwitcher 的雙重身分切換選項", () => {
  beforeEach(() => {
    useMerchantSwitcherStateMock.mockReset();
  });

  // 這個專案的 vitest 沒有開 globals,@testing-library/react 的自動 cleanup 不會生效。
  afterEach(() => {
    cleanup();
  });

  it("多間商家 + 有雙重身分:下拉選單裡有「切換到服務人員端」", () => {
    const merchants = [makeMerchant("m1", "涼風工匠"), makeMerchant("m2", "美甲")];
    setState(merchants, "m1");

    render(<MerchantSwitcher canSwitchToStaffView isStaffView={false} onToggleView={() => {}} />);
    openDropdown();

    expect(screen.getByText("切換到服務人員端")).toBeTruthy();
  });

  it("目前已經在服務人員端:同一個位置變成「切換到商家端」", () => {
    setState([makeMerchant("m1", "涼風工匠"), makeMerchant("m2", "美甲")], "m1");

    render(<MerchantSwitcher canSwitchToStaffView isStaffView onToggleView={() => {}} />);
    openDropdown();

    expect(screen.getByText("切換到商家端")).toBeTruthy();
    expect(screen.queryByText("切換到服務人員端")).toBeNull();
  });

  it("只有一間商家 + 有雙重身分:仍然會長出下拉選單來裝這個選項(不會退化成純文字標籤)", () => {
    // 這個分支特別容易出錯:元件本來有一段「只有一間商家就直接顯示店名純文字、不做下拉選單」的
    // 提早 return,如果沒有把 canSwitchToStaffView 一起納入判斷,單一商家的雙重身分使用者就會
    // 完全沒有任何切換入口。
    setState([makeMerchant("m1", "涼風工匠")], "m1");

    render(<MerchantSwitcher canSwitchToStaffView isStaffView={false} onToggleView={() => {}} />);
    openDropdown();

    expect(screen.getByText("切換到服務人員端")).toBeTruthy();
  });

  it("沒有雙重身分:不顯示這個選項", () => {
    setState([makeMerchant("m1", "涼風工匠"), makeMerchant("m2", "美甲")], "m1");

    render(<MerchantSwitcher canSwitchToStaffView={false} isStaffView={false} />);
    openDropdown();

    expect(screen.queryByText("切換到服務人員端")).toBeNull();
    expect(screen.queryByText("切換到商家端")).toBeNull();
  });

  it("只有一間商家、也沒有雙重身分:維持既有行為(純文字標籤,沒有下拉選單)", () => {
    setState([makeMerchant("m1", "涼風工匠")], "m1");

    render(<MerchantSwitcher canSwitchToStaffView={false} isStaffView={false} />);

    expect(screen.getByText("涼風工匠")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

// 2026-09-24(頁首吸頂 + 顯示功能頁名稱)新增的 variant="compact"。
//
// 使用者實機回報頁首要吸頂、而且要顯示「目前在哪個功能頁」,於是頁首那一列要同時塞 LOGO、
// 功能頁名稱、登出按鈕三樣東西 —— 商家名稱佔掉的寬度必須讓出來(320px 手機沒有那麼多空間)。
// 這一組測試守的是「縮成只剩 LOGO 之後,原本的功能一個都沒掉」:
//   ・雙重身分的切換選項照樣在(這是 2026-09-24 線上故障的核心,不能因為改外觀又弄壞一次)。
//   ・只剩一個圖示的按鈕一定要有 aria-label,否則對讀螢幕的人就是一顆沒有名字的按鈕。
//   ・沒有 LOGO 的商家要有 fallback(店名首字),不能出現破圖或空白。
describe('MerchantSwitcher variant="compact"(頁首用:只顯示 LOGO)', () => {
  beforeEach(() => {
    useMerchantSwitcherStateMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("觸發按鈕上不再顯示商家名稱文字,但仍然是一顆可以點開的按鈕", () => {
    setState([makeMerchant("m1", "涼風工匠"), makeMerchant("m2", "美甲")], "m1");

    render(<MerchantSwitcher variant="compact" canSwitchToStaffView={false} />);

    const trigger = screen.getByRole("button");
    expect(trigger).toBeTruthy();
    // 名稱不在按鈕上(整個元件在選單還沒打開時,畫面上不該出現店名文字)。
    expect(screen.queryByText("涼風工匠")).toBeNull();
  });

  it("只剩圖示的按鈕有 aria-label,而且 label 裡帶著目前商家名稱", () => {
    setState([makeMerchant("m1", "涼風工匠"), makeMerchant("m2", "美甲")], "m1");

    render(<MerchantSwitcher variant="compact" canSwitchToStaffView={false} />);

    // 為什麼 label 要帶店名:compact 版頁首上看不到店名,如果只寫「切換商家」,讀螢幕的人就完全
    // 不知道自己現在在哪一間店。
    const trigger = screen.getByRole("button", { name: "切換商家(目前:涼風工匠)" });
    expect(trigger).toBeTruthy();
  });

  it("點開之後,切換商家與雙重身分切換選項都還在(縮成 LOGO 沒有弄掉任何功能)", () => {
    setState([makeMerchant("m1", "涼風工匠"), makeMerchant("m2", "美甲")], "m1");

    render(
      <MerchantSwitcher
        variant="compact"
        canSwitchToStaffView
        isStaffView={false}
        onToggleView={() => {}}
      />,
    );
    openDropdown();

    expect(screen.getByText("切換到服務人員端")).toBeTruthy();
    // 商家名稱在選單裡照樣看得到,所以「按鈕上沒有名稱」不等於「使用者查不到現在在哪一間店」。
    expect(screen.getByText("涼風工匠")).toBeTruthy();
    expect(screen.getByText("美甲")).toBeTruthy();
  });

  it("只有一間商家 + 有雙重身分:compact 也一樣長出下拉選單來裝切換選項", () => {
    // 對應上面 full 版那條同名測試 —— 那個提早 return 的分支在 compact 下也不能把入口弄掉。
    setState([makeMerchant("m1", "涼風工匠")], "m1");

    render(
      <MerchantSwitcher
        variant="compact"
        canSwitchToStaffView
        isStaffView={false}
        onToggleView={() => {}}
      />,
    );
    openDropdown();

    expect(screen.getByText("切換到服務人員端")).toBeTruthy();
  });

  it("只有一間商家、也沒有雙重身分:compact 只留 LOGO,不顯示店名文字、也沒有按鈕", () => {
    setState([makeMerchant("m1", "涼風工匠")], "m1");

    render(<MerchantSwitcher variant="compact" canSwitchToStaffView={false} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("涼風工匠")).toBeNull();
    // 沒有 logo_url 的 fallback(既有的 MerchantLogo 寫法):店名首字。
    expect(screen.getByText("涼")).toBeTruthy();
  });

  it("有 logo_url 時顯示圖片,alt 帶店名;沒有時 fallback 成店名首字", () => {
    const withLogo = makeMerchant("m1", "涼風工匠");
    (withLogo as { logo_url: string | null }).logo_url = "https://example.test/logo.png";
    setState([withLogo, makeMerchant("m2", "美甲")], "m1");

    render(<MerchantSwitcher variant="compact" canSwitchToStaffView={false} />);
    expect(screen.getByAltText("涼風工匠 LOGO")).toBeTruthy();

    cleanup();

    setState([makeMerchant("m1", "涼風工匠"), makeMerchant("m2", "美甲")], "m1");
    render(<MerchantSwitcher variant="compact" canSwitchToStaffView={false} />);
    expect(screen.queryByAltText("涼風工匠 LOGO")).toBeNull();
    expect(screen.getByText("涼")).toBeTruthy();
  });
});
