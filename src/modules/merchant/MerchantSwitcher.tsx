// 對應規格書 4.5:分店切換器元件。
// 只有在使用者能存取的商家超過一間時才顯示切換器，否則只顯示目前商家名稱即可(不需要切換 UI)。
// 邊界情況:使用者可能同時是不同集團底下商家的管理員(規格書 4.5 邊界情況)，
// 這裡用「有沒有集團名稱」分組，同一個集團底下的商家歸在一起、用集團名稱當群組標題；
// 集團沒有填 name 的話，用底下第一間商家的店名代替群組標題，方便使用者辨識是哪個集團。
//
// 2026-09-16 對應規格書「首頁外殼與主題色優化」1.1:這個元件搬進 AppLayout.tsx 常駐頂端列左側,
// 取代原本的秒約 LOGO,使用者要求「顯示店家自己的 LOGO」——觸發按鈕上補上目前操作中商家的
// logo_url(沒有 LOGO 時 fallback 成店名首字圓形標誌),不重新設計下拉選單內容本身。

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

export function MerchantSwitcher() {
  const { merchants, currentMerchantId, setCurrentMerchantId, isLoading } =
    useMerchantSwitcherState();

  if (isLoading || merchants.length === 0) {
    return null;
  }

  const currentMerchant = merchants.find((m) => m.id === currentMerchantId);

  // 只有一間可管理的商家時，不需要顯示切換 UI，直接顯示店名即可。
  const onlyMerchant = merchants.length === 1 ? merchants[0] : undefined;
  if (onlyMerchant) {
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
        <Button variant="outline" size="sm" className="gap-2">
          <MerchantLogo
            logoUrl={currentMerchant?.logo_url ?? null}
            name={currentMerchant?.name ?? "選擇商家"}
          />
          <span className="max-w-[10rem] truncate">{currentMerchant?.name ?? "選擇商家"}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {Array.from(groupedByGroupId.entries()).map(([groupId, groupMerchants], index) => {
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
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
