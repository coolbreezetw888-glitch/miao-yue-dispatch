// 對應規格書 4.5:分店切換器元件。
// 只有在使用者能存取的商家超過一間時才顯示切換器，否則只顯示目前商家名稱即可(不需要切換 UI)。
// 邊界情況:使用者可能同時是不同集團底下商家的管理員(規格書 4.5 邊界情況)，
// 這裡用「有沒有集團名稱」分組，同一個集團底下的商家歸在一起、用集團名稱當群組標題；
// 集團沒有填 name 的話，用底下第一間商家的店名代替群組標題，方便使用者辨識是哪個集團。
//
// 2026-09-16 對應規格書「首頁外殼與主題色優化」1.1:這個元件搬進 AppLayout.tsx 常駐頂端列左側,
// 取代原本的秒約 LOGO,使用者要求「顯示店家自己的 LOGO」——觸發按鈕上補上目前操作中商家的
// logo_url(沒有 LOGO 時 fallback 成店名首字圓形標誌),不重新設計下拉選單內容本身。
//
// 2026-09-24(頁首吸頂 + 顯示功能頁名稱)新增 `variant` prop:
//   ・"full"(預設,維持原本外觀):LOGO + 商家名稱 + 下拉箭頭。
//   ・"compact":**只有 LOGO**。用在 AppLayout.tsx 的頁首 —— 那一列現在要同時塞 LOGO、目前功能頁
//     名稱、登出按鈕三樣東西,商家名稱佔掉的寬度必須讓給功能頁名稱(320px 手機上沒有那麼多空間,
//     見 e2e/mobile-overflow.spec.ts 守的那顆地雷)。點下去展開的下拉選單內容完全一樣(切換商家、
//     雙重身分切換入口),商家名稱在選單打開後照樣看得到。
// 為什麼加 prop 而不是直接把名稱拔掉:預設值維持 "full",既有的 5 條測試(MerchantSwitcher.test.tsx,
// 2026-09-24 為線上故障補的)不需要改任何斷言就能繼續守住原本的行為;之後若有別的地方要用完整版
// (例如桌面版側邊欄),也不用再把名稱加回來。目前唯一的使用端是 AppLayout.tsx 的頁首。

import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { useMerchantSwitcherState } from "./context";
import { INDUSTRY_TYPE_LABELS } from "./types";
import type { MerchantWithGroup } from "./types";

function groupLabelFor(merchant: MerchantWithGroup, merchantsInSameGroup: MerchantWithGroup[]) {
  return merchant.group?.name || `${merchantsInSameGroup[0]?.name ?? "我的"}集團`;
}

/** 1.1:觸發按鈕上顯示的小尺寸商家 LOGO,沒有 LOGO 時 fallback 成店名首字圓形標誌,
 * 不顯示破圖或空白。 */
function MerchantLogo({ logoUrl, name }: { logoUrl: string | null; name: string }) {
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={`${name} LOGO`}
        className="h-5 w-5 shrink-0 rounded-full border border-border object-cover"
      />
    );
  }
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-brand-foreground">
      {name.slice(0, 1)}
    </span>
  );
}

interface MerchantSwitcherProps {
  /** 使用者決策(2026-09-23):目前這位使用者除了解析出來的角色之外,是不是也能切到服務人員端
   * (管理員/客服同時也是這間商家的服務人員)。true 才會在下拉選單底部多出切換選項。 */
  canSwitchToStaffView?: boolean;
  /** 目前是否正顯示服務人員端內容,決定切換選項的文字方向。 */
  isStaffView?: boolean;
  onToggleView?: () => void;
  /** 2026-09-24:觸發按鈕的外觀。"full" = LOGO + 商家名稱 + 箭頭(預設,原本的樣子);
   * "compact" = 只有 LOGO(頁首用,把橫向空間讓給功能頁名稱)。下拉選單內容兩者完全相同。 */
  variant?: "full" | "compact";
}

export function MerchantSwitcher({
  canSwitchToStaffView = false,
  isStaffView = false,
  onToggleView,
  variant = "full",
}: MerchantSwitcherProps) {
  const { merchants, currentMerchantId, setCurrentMerchantId, isLoading } =
    useMerchantSwitcherState();

  if (isLoading || merchants.length === 0) {
    return null;
  }

  const currentMerchant = merchants.find((m) => m.id === currentMerchantId);
  const hasMultipleMerchants = merchants.length > 1;
  const isCompact = variant === "compact";
  const currentMerchantName = currentMerchant?.name ?? "選擇商家";

  /** 2026-09-23:切換服務人員端/商家端這個選項,附加在下拉選單最下方(見 image 132)。
   *
   * ⚠️ 2026-09-24:這個選項 **不再是唯一的入口**。實機上使用者根本沒有找到它(要先點開商家切換器、
   * 再往下滑到分隔線底下才看得到),導致雙重身分的人完全進不去服務人員端 —— 主要入口已經改成常駐
   * 橫幅 src/routes/DualRoleViewSwitchBar.tsx。這裡保留這個選項(已經習慣的人照樣能用,兩個入口
   * 呼叫同一個 onToggleView),文字跟橫幅上的按鈕統一成「切換到…」。 */
  const viewToggleItem = canSwitchToStaffView ? (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => onToggleView?.()}>
        {isStaffView ? "切換到商家端" : "切換到服務人員端"}
      </DropdownMenuItem>
    </>
  ) : null;

  // 只有一間可管理的商家、也沒有雙重身份可切換時，不需要顯示下拉選單，直接顯示店名即可。
  if (!hasMultipleMerchants && !canSwitchToStaffView) {
    const onlyMerchant = merchants[0]!;
    // compact(頁首)只留 LOGO。這裡沒有下拉選單可以打開,所以商家名稱改放 title 屬性,
    // 滑鼠移上去/長按還是看得到是哪一間店;LOGO 的 alt 本來就是「{店名} LOGO」,讀螢幕的人
    // 照樣聽得到店名(沒有 LOGO 的 fallback 是店名首字,見 MerchantLogo)。
    if (isCompact) {
      return (
        <div
          title={onlyMerchant.name}
          className="flex shrink-0 items-center rounded-md border border-border bg-background p-1.5"
        >
          <MerchantLogo logoUrl={onlyMerchant.logo_url} name={onlyMerchant.name} />
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm">
        <MerchantLogo logoUrl={onlyMerchant.logo_url} name={onlyMerchant.name} />
        <span className="max-w-[10rem] truncate font-medium text-foreground">
          {onlyMerchant.name}
        </span>
      </div>
    );
  }

  const groupedByGroupId = new Map<string, MerchantWithGroup[]>();
  for (const merchant of merchants) {
    const list = groupedByGroupId.get(merchant.group_id) ?? [];
    list.push(merchant);
    groupedByGroupId.set(merchant.group_id, list);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {isCompact ? (
          // 只剩一個圖示的按鈕一定要有 aria-label,否則對讀螢幕的人就是一顆沒有名字的按鈕。
          // 刻意把目前商家名稱也放進 aria-label:compact 版的頁首上看不到店名,如果 label 只寫
          // 「切換商家」,讀螢幕的人就完全不知道現在在哪一間店(要先打開選單才知道)。
          // w-8 px-0 讓它變成 32×32 的正方形按鈕(size="sm" 是 h-8),寬度固定、不可壓縮。
          <Button
            variant="outline"
            size="sm"
            className="w-8 shrink-0 px-0"
            aria-label={`切換商家(目前:${currentMerchantName})`}
            title={currentMerchantName}
          >
            <MerchantLogo logoUrl={currentMerchant?.logo_url ?? null} name={currentMerchantName} />
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="gap-2">
            <MerchantLogo logoUrl={currentMerchant?.logo_url ?? null} name={currentMerchantName} />
            <span className="max-w-[10rem] truncate">{currentMerchantName}</span>
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {hasMultipleMerchants ? (
          Array.from(groupedByGroupId.entries()).map(([groupId, groupMerchants], index) => {
            const firstInGroup = groupMerchants[0];
            if (!firstInGroup) return null;
            return (
              <div key={groupId}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {groupLabelFor(firstInGroup, groupMerchants)}
                </DropdownMenuLabel>
                {groupMerchants.map((merchant) => (
                  <DropdownMenuItem
                    key={merchant.id}
                    onSelect={() => setCurrentMerchantId(merchant.id)}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="truncate">{merchant.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {INDUSTRY_TYPE_LABELS[
                        merchant.industry_type as keyof typeof INDUSTRY_TYPE_LABELS
                      ] ?? merchant.industry_type}
                      {merchant.status === "disabled" ? "・已停用" : ""}
                    </span>
                  </DropdownMenuItem>
                ))}
              </div>
            );
          })
        ) : (
          // 只有一間商家、但有雙重身份可切換時：下拉選單只是為了裝下面的切換選項,
          // 商家名稱純粹當標籤顯示,不需要可點選。
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {currentMerchant?.name ?? "目前商家"}
          </DropdownMenuLabel>
        )}
        {viewToggleItem}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
