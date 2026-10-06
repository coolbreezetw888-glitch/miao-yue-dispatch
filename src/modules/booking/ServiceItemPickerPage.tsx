// SPECS-INDEX #979(2026-10-06):建單 / 編輯預約表單的「選擇項目」整頁。
// 規格:.project/specs/建單畫面與下拉刷新-第2批.md 第一節 1.2(參考圖 .project/notes/req979-refs/63.png、64.png)。
// 純邏輯(草稿、頁籤、寫回表單)在 serviceItemPickerLogic.ts,這裡只負責畫面。
//
// ─── 版面:蓋在建單全頁層「裡面」的整頁,不是另一個彈窗 ───────────────────────────────
// ui-overlay-patterns skill「整頁選擇畫面」小節:
//   ・用 `absolute inset-0` 蓋住建單全頁層的整個面板(手機 = 整個螢幕;電腦 = 那塊置中面板,
//     連表單的標題列與底部按鈕列一起蓋住)。不另外開一個 Radix Dialog —— 它是表單的「子畫面」,
//     焦點圈、Esc、遮罩都沿用表單那一層(Esc 由 CalendarPage 攔下來改成「返回」,不會把整張表單關掉)。
//   ・上方:左邊返回箭頭(= 放棄這次修改)、中間標題;標題下方是可以左右滑的分類頁籤(UnderlineTabs pages);
//     中間只有卡片清單會捲動;底部固定一顆大「確認」。
//   ・`data-pull-to-refresh="off"`:手機下拉刷新(#982)碰到這一層一律不觸發(本來表單開著就已經停用,這是保險)。

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, Minus, Plus } from "lucide-react";

import {
  AlertNote,
  FieldAmountInput,
  FormField,
  SwitchRow,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import {
  applyPickerDraft,
  buildPickerTabs,
  formatPickerDuration,
  formatPickerPrice,
  initPickerDraft,
  pickerCustomPriceErrors,
  resolveDefaultPickerTab,
  setPickerCustomPrice,
  setPickerCustomPriceEnabled,
  setPickerQuantityText,
  stepPickerQuantity,
  togglePickerItem,
  type AppliedPickerSelection,
  type PickerCategory,
  type PickerItem,
} from "./serviceItemPickerLogic";

export interface ServiceItemPickerPageProps {
  /** 上架中的服務項目(已下架的不顯示,規格 1.2 第 7 點)。 */
  items: PickerItem[];
  categories: PickerCategory[];
  uncategorizedLabel: string;
  /** 打開整頁那一刻,表單上的狀態(草稿從這裡開始)。 */
  serviceItemIds: string[];
  itemQuantities: Record<string, string>;
  itemUnitPrices: Record<string, string>;
  /** 「原價」:編輯時本來就在單上的項目 = 單價快照;其餘 = service_items.price。查不到回 null。 */
  baselinePrice: (id: string) => number | null;
  onConfirm: (applied: AppliedPickerSelection) => void;
  /** 返回箭頭:放棄這次修改,表單維持打開前的狀態。 */
  onBack: () => void;
}

export function ServiceItemPickerPage({
  items,
  categories,
  uncategorizedLabel,
  serviceItemIds,
  itemQuantities,
  itemUnitPrices,
  baselinePrice,
  onConfirm,
  onBack,
}: ServiceItemPickerPageProps) {
  const [draft, setDraft] = useState(() =>
    initPickerDraft({ serviceItemIds, itemQuantities, itemUnitPrices, baselinePrice }),
  );
  const tabs = useMemo(
    () => buildPickerTabs(items, categories, uncategorizedLabel),
    [items, categories, uncategorizedLabel],
  );
  const [activeTab, setActiveTab] = useState<string | null>(() =>
    resolveDefaultPickerTab(tabs, serviceItemIds),
  );
  const currentTab = tabs.find((tab) => tab.key === activeTab) ?? tabs[0] ?? null;
  const errors = pickerCustomPriceErrors(draft);
  const hasError = Object.keys(errors).length > 0;

  // 開啟時把焦點放在返回箭頭(鍵盤 / 螢幕閱讀器使用者知道自己進到新的一頁)。
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);

  // 整頁裡看不到的已選項目(編輯舊訂單遇到已下架的項目):寫回時原封不動保留。
  const visibleIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const hiddenSelectedIds = serviceItemIds.filter((id) => !visibleIds.has(id));

  function handleConfirm() {
    if (hasError) return;
    onConfirm(
      applyPickerDraft({
        draft,
        previousIds: serviceItemIds,
        previousQuantities: itemQuantities,
        previousUnitPrices: itemUnitPrices,
        hiddenSelectedIds,
        baselinePrice,
      }),
    );
  }

  const selectedCount = draft.order.length;

  return (
    <div
      role="region"
      aria-label="選擇項目"
      data-testid="service-item-picker"
      data-pull-to-refresh="off"
      className="absolute inset-0 z-20 flex min-w-0 flex-col bg-surface"
    >
      <header className="shrink-0 border-b border-border bg-background">
        <div className="relative flex h-[54px] items-center px-2 sm:px-3">
          <button
            ref={backRef}
            type="button"
            onClick={onBack}
            aria-label="返回，不套用這次的修改"
            className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand text-brand-foreground">
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </span>
          </button>
          <h2 className="pointer-events-none absolute inset-x-14 truncate text-center text-base font-bold text-foreground">
            選擇項目
          </h2>
        </div>
        {tabs.length > 0 ? (
          <Tabs value={currentTab?.key ?? ""} onValueChange={setActiveTab} className="px-2">
            <UnderlineTabsList variant="pages">
              {tabs.map((tab) => (
                <UnderlineTabsTrigger key={tab.key} value={tab.key}>
                  {tab.label}
                </UnderlineTabsTrigger>
              ))}
            </UnderlineTabsList>
          </Tabs>
        ) : null}
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
        {!currentTab ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            目前沒有上架中的服務項目。到「服務項目」頁面上架之後，這裡就會出現。
          </p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label={`${currentTab.label}的服務項目`}>
            {currentTab.items.map((item) => {
              const entry = draft.entries[item.id];
              const checked = entry !== undefined;
              const baseline = baselinePrice(item.id) ?? Number(item.price);
              const duration = formatPickerDuration(item.duration_minutes);
              const quantity = entry?.quantity ?? "1";
              const atMin = !checked || Number(quantity) <= 1;
              return (
                <li
                  key={item.id}
                  data-testid={`picker-item-${item.id}`}
                  className={cn(
                    "rounded-xl border bg-card shadow-sm transition-colors",
                    checked ? "border-brand/50" : "border-border",
                  )}
                >
                  <div className="flex items-start gap-2 p-3">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      onClick={() => setDraft((d) => togglePickerItem(d, item.id))}
                      className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2",
                          checked ? "border-brand bg-brand text-brand-foreground" : "border-border",
                        )}
                      >
                        {checked ? <Check className="h-4 w-4" strokeWidth={3} /> : null}
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="break-words text-[15px] font-semibold text-foreground">
                          {item.name}
                        </span>
                        <span className="text-[13px] tabular-nums text-muted-foreground">
                          固定價格{" "}
                          <span className="font-semibold text-destructive/80">
                            {formatPickerPrice(Number(item.price))}
                          </span>
                        </span>
                        {duration ? (
                          <span className="text-[13px] text-brand">{duration}</span>
                        ) : null}
                      </span>
                    </button>

                    {/* 數量:− 數字 +(最少 1)。沒勾選時按 + 會順手勾起來。 */}
                    <div className="flex shrink-0 items-center gap-1 self-center">
                      <Button
                        type="button"
                        variant="neutral"
                        size="cardIcon"
                        disabled={atMin}
                        aria-label={`減少「${item.name}」的數量`}
                        onClick={() => setDraft((d) => stepPickerQuantity(d, item.id, -1))}
                      >
                        <Minus className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        aria-label={`「${item.name}」的數量`}
                        className="h-9 w-12 rounded-md border border-input bg-muted/40 text-center text-[16px] tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-[15px]"
                        value={checked ? quantity : "1"}
                        onChange={(e) =>
                          setDraft((d) => setPickerQuantityText(d, item.id, e.target.value))
                        }
                        onBlur={(e) => {
                          if (!checked || e.target.value.trim() !== "") return;
                          setDraft((d) => setPickerQuantityText(d, item.id, "1"));
                        }}
                      />
                      <Button
                        type="button"
                        variant="neutral"
                        size="cardIcon"
                        aria-label={`增加「${item.name}」的數量`}
                        onClick={() => setDraft((d) => stepPickerQuantity(d, item.id, 1))}
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>

                  {/* 勾選後展開「自訂金額」(就是原本表單上的單價覆寫);取消勾選時收起並清掉。 */}
                  {checked ? (
                    <div className="border-t border-border bg-muted/30 px-3 py-3">
                      <SwitchRow
                        id={`picker-custom-price-switch-${item.id}`}
                        title="自訂金額"
                        description={
                          entry.customPriceEnabled
                            ? "以下方輸入的單價為準。"
                            : `使用原價（${formatPickerPrice(baseline)}）`
                        }
                        checked={entry.customPriceEnabled}
                        onCheckedChange={(enabled) =>
                          setDraft((d) =>
                            setPickerCustomPriceEnabled(d, item.id, enabled, baseline),
                          )
                        }
                        className="bg-background"
                      >
                        {entry.customPriceEnabled ? (
                          <FormField
                            label="單價"
                            htmlFor={`picker-custom-price-${item.id}`}
                            error={errors[item.id] ?? null}
                          >
                            <FieldAmountInput
                              id={`picker-custom-price-${item.id}`}
                              value={entry.customPrice}
                              onChange={(e) =>
                                setDraft((d) => setPickerCustomPrice(d, item.id, e.target.value))
                              }
                            />
                          </FormField>
                        ) : null}
                      </SwitchRow>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="shrink-0 border-t border-border bg-background px-3 pt-2.5 pb-[max(14px,env(safe-area-inset-bottom))] sm:px-4">
        <div className="flex flex-col gap-2.5">
          {hasError ? (
            <AlertNote>有項目的自訂金額填錯了（上面標紅的那幾格），修好之後才能確認。</AlertNote>
          ) : null}
          <Button
            type="button"
            variant="primary"
            size="touch"
            className="w-full"
            disabled={hasError}
            onClick={handleConfirm}
          >
            {selectedCount > 0 ? `確認（已選 ${selectedCount} 項）` : "確認"}
          </Button>
        </div>
      </footer>
    </div>
  );
}
