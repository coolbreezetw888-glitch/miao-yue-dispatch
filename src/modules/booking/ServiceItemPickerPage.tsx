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
//
// ─── 第 11 批 F #993:料錢成本也共用這一頁 ───────────────────────────────────────────
// 新增的參數全部是選用的,預設值 = 原本服務項目的行為(服務項目那邊呼叫端一個字不用改):
//   title / showCategoryTabs / showDuration / showDescription / customPriceLabel / priceLabel /
//   emptyText / listLabel / testIdPrefix / customPriceRules。
// 料錢傳「選擇料錢」、不分頁籤、不顯示工時與描述、開關名「自訂成本單價」、testid 前綴 material-picker。
// 數量上限 999(F-1)兩邊共用:+ 到 999 就停、手打超過 ⇒ 該格標紅 + 確認鈕擋住。

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
  pickerQuantityErrors,
  pickerSubtotalErrors,
  resolveDefaultPickerTab,
  setPickerCustomPrice,
  setPickerCustomPriceEnabled,
  setPickerQuantityText,
  stepPickerQuantity,
  togglePickerItem,
  type AppliedPickerSelection,
  type PickerCategory,
  type PickerCustomPriceRules,
  type PickerItem,
  type PickerSubtotalRule,
  type PickerTab,
} from "./serviceItemPickerLogic";
import { ITEM_QUANTITY_MAX } from "./itemQuantity";

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
  // ─── 第 11 批 F #993:以下全部選用,預設 = 服務項目原本的樣子 ───
  /** 標題(預設「選擇項目」)。 */
  title?: string | undefined;
  /** 要不要分類頁籤(預設要;料錢沒有分類 ⇒ false,所有品項一個清單)。 */
  showCategoryTabs?: boolean | undefined;
  /** 卡片要不要顯示「大約 N 分鐘」(預設要)。 */
  showDuration?: boolean | undefined;
  /** 卡片要不要顯示描述(預設要)。 */
  showDescription?: boolean | undefined;
  /** 自訂單價開關的名稱(預設「自訂金額」)。 */
  customPriceLabel?: string | undefined;
  /** 卡片上價格前面的字(預設「固定價格」)。 */
  priceLabel?: string | undefined;
  /** 一個項目都沒有時的說明。 */
  emptyText?: string | undefined;
  /** 清單的無障礙名稱(不分頁籤時用;預設「服務項目」)。 */
  listLabel?: string | undefined;
  /** testid / 元素 id 前綴(預設 picker,整頁本身是 service-item-picker;料錢用 material-picker)。 */
  testIdPrefix?: string | undefined;
  /** 自訂單價的額外限制(料錢:上限 99,999,999.99、小數兩位)。 */
  customPriceRules?: PickerCustomPriceRules | undefined;
  /** 單一項目小計上限(料錢:1,000,000,主腦裁決防溢位);不傳 = 不檢查。 */
  subtotalRule?: PickerSubtotalRule | undefined;
}

const ALL_ITEMS_TAB_KEY = "__all__";

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
  title = "選擇項目",
  showCategoryTabs = true,
  showDuration = true,
  showDescription = true,
  customPriceLabel = "自訂金額",
  priceLabel = "固定價格",
  emptyText = "目前沒有上架中的服務項目。到「服務項目」頁面上架之後，這裡就會出現。",
  listLabel = "服務項目",
  testIdPrefix = "picker",
  customPriceRules,
  subtotalRule,
}: ServiceItemPickerPageProps) {
  const [draft, setDraft] = useState(() =>
    initPickerDraft({ serviceItemIds, itemQuantities, itemUnitPrices, baselinePrice }),
  );
  const tabs = useMemo<PickerTab[]>(
    () =>
      showCategoryTabs
        ? buildPickerTabs(items, categories, uncategorizedLabel)
        : items.length > 0
          ? [{ key: ALL_ITEMS_TAB_KEY, label: listLabel, items }]
          : [],
    [showCategoryTabs, items, categories, uncategorizedLabel, listLabel],
  );
  const [activeTab, setActiveTab] = useState<string | null>(() =>
    resolveDefaultPickerTab(tabs, serviceItemIds),
  );
  const currentTab = tabs.find((tab) => tab.key === activeTab) ?? tabs[0] ?? null;
  const errors = pickerCustomPriceErrors(draft, customPriceRules);
  const quantityErrors = pickerQuantityErrors(draft);
  const subtotalErrors = pickerSubtotalErrors(draft, baselinePrice, subtotalRule);
  const hasPriceError = Object.keys(errors).length > 0;
  const hasQuantityError = Object.keys(quantityErrors).length > 0;
  const hasSubtotalError = Object.keys(subtotalErrors).length > 0;
  const hasError = hasPriceError || hasQuantityError || hasSubtotalError;
  const rootTestId = testIdPrefix === "picker" ? "service-item-picker" : testIdPrefix;

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
      aria-label={title}
      data-testid={rootTestId}
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
            {title}
          </h2>
        </div>
        {showCategoryTabs && tabs.length > 0 ? (
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
          <p className="py-10 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <ul
            className="flex flex-col gap-3"
            aria-label={showCategoryTabs ? `${currentTab.label}的服務項目` : listLabel}
          >
            {currentTab.items.map((item) => {
              const entry = draft.entries[item.id];
              const checked = entry !== undefined;
              const baseline = baselinePrice(item.id) ?? Number(item.price);
              const duration = showDuration ? formatPickerDuration(item.duration_minutes) : null;
              const quantity = entry?.quantity ?? "1";
              const atMin = !checked || Number(quantity) <= 1;
              const atMax = checked && Number(quantity) >= ITEM_QUANTITY_MAX;
              const quantityError = quantityErrors[item.id] ?? subtotalErrors[item.id] ?? null;
              return (
                <li
                  key={item.id}
                  data-testid={`${testIdPrefix}-item-${item.id}`}
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
                          {item.inactive ? (
                            <span className="ml-1 text-[13px] font-normal text-muted-foreground">
                              (已下架)
                            </span>
                          ) : null}
                        </span>
                        {/* #986 第 9 批:名稱下方顯示描述(保留換行、不截斷 —— 這頁就是讓人看清楚選什麼);
                            沒有描述時整行不出現、不留空白。React 文字節點,不解析 HTML。 */}
                        {showDescription && item.description?.trim() ? (
                          <span
                            data-testid={`${testIdPrefix}-item-description-${item.id}`}
                            className="whitespace-pre-line break-words text-[13px] text-muted-foreground"
                          >
                            {item.description}
                          </span>
                        ) : null}
                        <span className="text-[13px] tabular-nums text-muted-foreground">
                          {priceLabel}{" "}
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
                        max={ITEM_QUANTITY_MAX}
                        step={1}
                        aria-label={`「${item.name}」的數量`}
                        aria-invalid={quantityError ? true : undefined}
                        className={cn(
                          "h-9 w-12 rounded-md border border-input bg-muted/40 text-center text-[16px] tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-[15px]",
                          quantityError && "border-destructive",
                        )}
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
                        disabled={atMax}
                        aria-label={`增加「${item.name}」的數量`}
                        onClick={() => setDraft((d) => stepPickerQuantity(d, item.id, 1))}
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  {quantityError ? (
                    <p
                      data-testid={`${testIdPrefix}-quantity-error-${item.id}`}
                      className="-mt-1 px-3 pb-2 text-right text-[13px] text-destructive"
                    >
                      {quantityError}
                    </p>
                  ) : null}

                  {/* 勾選後展開「自訂金額」(就是原本表單上的單價覆寫);取消勾選時收起並清掉。 */}
                  {checked ? (
                    <div className="border-t border-border bg-muted/30 px-3 py-3">
                      <SwitchRow
                        id={`${testIdPrefix}-custom-price-switch-${item.id}`}
                        title={customPriceLabel}
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
                            htmlFor={`${testIdPrefix}-custom-price-${item.id}`}
                            error={errors[item.id] ?? null}
                          >
                            <FieldAmountInput
                              id={`${testIdPrefix}-custom-price-${item.id}`}
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
          {hasPriceError ? (
            <AlertNote>
              {`有項目的${customPriceLabel}填錯了（上面標紅的那幾格），修好之後才能確認。`}
            </AlertNote>
          ) : null}
          {hasSubtotalError && subtotalRule ? <AlertNote>{subtotalRule.message}</AlertNote> : null}
          {hasQuantityError ? (
            <AlertNote>
              {`有項目的數量填錯了（最多 ${ITEM_QUANTITY_MAX}，只能填整數），修好之後才能確認。`}
            </AlertNote>
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
