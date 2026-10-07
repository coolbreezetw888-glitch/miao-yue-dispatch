// 對應建單功能擴充規格書 5.4:料錢成本管理頁(新路由 /app/material-costs)。
// 比照模組 4 服務項目管理頁的既有樣式:清單(名稱/金額/狀態)+ 新增/編輯/下架/重新上架。
//
// ui-v1-full 第二階段第 2 批(2026-09-29,盤點 #9 / #10):
//   - 新增 / 編輯品項(2 欄)→ ui-overlay-patterns 的小卡窗殼(CardDialog),受控開關,
//     底部「取消 / 儲存」手機各半、電腦靠右;欄位改 FormField / FieldInput / FieldAmountInput。
//   - 品項列改 ListCard(skill 二之五):右側只放「編輯」+ ⋯(下架收進 ⋯,可逆 ⇒ 不標紅);
//     已下架整張變灰、主要動作換成「重新上架」。
//   - 料錢成本功能開關改 SwitchRow(skill 二之七「開關做成一整列」)。
//   - 頁首改 PageHeader、載入中改骨架、空狀態補下一步按鈕(skill 二之八)。
// **只動外觀與版面,不動任何行為**:驗證、送出、下架 / 重新上架、功能開關的邏輯全部照舊。

import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  CardDialog,
  CardDialogClose,
  CardDialogContent,
  CardDialogDescription,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
  AlertNote,
  EmptyState,
  ErrorState,
  FieldAmountInput,
  FieldInput,
  FormField,
  HelpToggle,
  ListCard,
  LoadingSkeleton,
  OnOffStateText,
  PageHeader,
  parseAmountInput,
  StatusTag,
  SwitchRow,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { getFeatureFlag, setFeatureFlag } from "@/modules/merchant/api";

import {
  addMaterialCostItem,
  fetchMaterialCostCommissionSetting,
  fetchMerchantMaterialCostItemsAll,
  materialCostCommissionSettingQueryKey,
  setMaterialCostAffectsCommission,
  reactivateMaterialCostItem,
  removeMaterialCostItem,
  updateMaterialCostItem,
  MATERIAL_COST_ENABLED_FEATURE_KEY,
  type UpsertMaterialCostItemInput,
} from "./api";
import { MATERIAL_COST_COMMISSION_COPY } from "./materialCostCommissionCopy";
import { RequireMaterialCostsAccess } from "./RequireMaterialCostsAccess";
import type { MaterialCostItem } from "./types";

const itemsQueryKey = (merchantId: string) =>
  ["booking-module", "material-cost-items-admin", merchantId] as const;

// #985 第 8 批:「料錢成本功能」開關跟下面「料錢影響服務人員抽成」那一列共用同一份查詢
// (同一個 queryKey,react-query 只會發一次請求)。
const materialCostEnabledQueryKey = (merchantId: string) =>
  ["booking-module", "material-cost-enabled", merchantId] as const;

async function fetchMaterialCostEnabled(merchantId: string): Promise<boolean> {
  const value = await getFeatureFlag(merchantId, MATERIAL_COST_ENABLED_FEATURE_KEY);
  // 規格書(建單功能擴充)2.3:查無資料一律視為關閉(預設值關閉)。
  return value ?? false;
}

// 商家端三項調整規格書 §一 1.2/1.3:料錢成本功能開關,從 BusinessHoursPage.tsx 搬過來,
// 放在這個頁面最上方(料錢成本品項清單 Card 之前)。RLS 已放寬成同時允許
// can_manage_material_costs,不再要求 can_manage_business_hours,所以這裡不需要額外的
// 權限判斷——能進到這個頁面的人(RequireMaterialCostsAccess 已擋過一次)就能操作這個開關。
// #998 第 11 批 I:匯出給 vitest 直接 render(狀態字顏色斷言);頁面用法不變。
export function MaterialCostEnabledToggle({ merchantId }: { merchantId: string }) {
  const featureFlagQueryKey = materialCostEnabledQueryKey(merchantId);
  const queryClient = useQueryClient();
  const {
    data: enabled,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: featureFlagQueryKey,
    queryFn: () => fetchMaterialCostEnabled(merchantId),
  });

  async function handleToggle(checked: boolean) {
    try {
      await setFeatureFlag(merchantId, MATERIAL_COST_ENABLED_FEATURE_KEY, checked);
      await queryClient.invalidateQueries({ queryKey: featureFlagQueryKey });
      toast.success("已更新設定");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>料錢成本功能</CardTitle>
        <CardDescription>
          開啟後，建單/編輯表單會出現「料錢成本」勾選區塊，可以記錄這次服務預期會用掉的材料成本
          (不是訂單金額計算)。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingSkeleton variant="lines" rows={1} />
        ) : isError ? (
          // 🔴 2026-09-30 QA:讀不到設定時不可以直接顯示成「已關閉」——那是把「不知道」講成
          // 「確定是關的」,商家會以為自己的設定被清掉。
          <ErrorState
            title="讀不到料錢成本功能的開關狀態"
            reason="可能是網路斷了；現在畫面上不會顯示開或關，避免給你錯誤的訊息"
            onRetry={() => void refetch()}
          />
        ) : (
          // skill 二之七:開關做成一整列(左邊標題 + 一行說明,右邊開關)。
          // 原本的「已開啟 / 已關閉」狀態文字保留在說明列,不讓人只看開關猜狀態。
          <SwitchRow
            title="啟用料錢成本功能"
            // #998 第 11 批 I:「目前已開啟 / 目前已關閉」變色粗體(開綠、關紅),後半句照舊灰字;整句文字不變。
            description={
              <>
                <OnOffStateText
                  on={enabled === true}
                  onText="目前已開啟"
                  offText="目前已關閉"
                  testId="material-cost-feature-state"
                />
                {enabled
                  ? "，建單表單會出現「料錢成本」區塊。"
                  : "，建單表單不會出現「料錢成本」區塊。"}
              </>
            }
            checked={enabled ?? false}
            onCheckedChange={handleToggle}
          />
        )}
      </CardContent>
    </Card>
  );
}

// =========================================================================
// SPECS-INDEX #985 第 8 批 8-1 / 8-2:「料錢影響服務人員抽成」開關。
// 資料庫沿用 merchant_payroll_settings.commission_basis_type(開啟 = 扣料錢),讀寫走 RPC;
// 能不能改由資料庫回傳的 can_edit 決定(管理員或「抽成與薪資設定」權限),後端 RPC 也會再擋一次。
// =========================================================================
export function MaterialCostCommissionToggle({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const settingQuery = useQuery({
    queryKey: materialCostCommissionSettingQueryKey(merchantId),
    queryFn: () => fetchMaterialCostCommissionSetting(merchantId),
  });
  const featureQuery = useQuery({
    queryKey: materialCostEnabledQueryKey(merchantId),
    queryFn: () => fetchMaterialCostEnabled(merchantId),
  });

  // 確認窗:記住「要切成哪個值」;null = 沒開。開關本身的值永遠來自資料庫,不先樂觀改,
  // 所以按取消或送出失敗時,開關自然停在原值。
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  // 只有確定讀到「功能是關的」才變灰;讀取中 / 讀不到時不猜。
  const featureOff = featureQuery.data === false;
  const setting = settingQuery.data;
  const canEdit = setting?.canEdit === true;

  async function handleConfirm() {
    if (pendingValue === null) return;
    setSaving(true);
    try {
      await setMaterialCostAffectsCommission(merchantId, pendingValue);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: materialCostCommissionSettingQueryKey(merchantId),
        }),
        queryClient.invalidateQueries({
          queryKey: ["payroll-module", "merchant-payroll-settings", merchantId],
        }),
      ]);
      toast.success("已更新");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
      setPendingValue(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        {/* HelpToggle 展開的說明區塊是 basis-full,所以標題列必須是 flex flex-wrap。 */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
          <CardTitle>料錢與服務人員抽成</CardTitle>
          <HelpToggle label="說明：料錢影響抽成的開關會影響哪些訂單">
            {MATERIAL_COST_COMMISSION_COPY.help}
          </HelpToggle>
        </div>
      </CardHeader>
      <CardContent>
        {settingQuery.isLoading ? (
          <LoadingSkeleton variant="lines" rows={1} />
        ) : settingQuery.isError || !setting ? (
          // 8-2:讀不到時不顯示開關(不能顯示預設值讓人誤以為是自己的設定)。
          <ErrorState
            title="讀不到料錢影響抽成的設定"
            reason="可能是網路斷了；現在畫面上不會顯示開或關，避免給你錯誤的訊息"
            onRetry={() => void settingQuery.refetch()}
          />
        ) : (
          <SwitchRow
            id="material-cost-affects-commission"
            title={MATERIAL_COST_COMMISSION_COPY.title}
            description={MATERIAL_COST_COMMISSION_COPY.description}
            checked={setting.affectsCommission}
            onCheckedChange={(next) => setPendingValue(next)}
            disabled={!canEdit || featureOff || saving}
          >
            {featureOff || !canEdit ? (
              <div className="flex flex-col gap-2">
                {featureOff ? (
                  <AlertNote>{MATERIAL_COST_COMMISSION_COPY.featureOffNote}</AlertNote>
                ) : null}
                {!canEdit ? (
                  <AlertNote>{MATERIAL_COST_COMMISSION_COPY.noPermissionNote}</AlertNote>
                ) : null}
              </div>
            ) : null}
          </SwitchRow>
        )}
      </CardContent>

      <CardDialog
        open={pendingValue !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setPendingValue(null);
        }}
      >
        <CardDialogContent>
          <CardDialogHeader>
            <CardDialogTitle>
              {MATERIAL_COST_COMMISSION_COPY.confirmTitle(pendingValue ?? false)}
            </CardDialogTitle>
            <CardDialogDescription>
              {MATERIAL_COST_COMMISSION_COPY.confirmBody(pendingValue ?? false)}
            </CardDialogDescription>
          </CardDialogHeader>
          <CardDialogFooter>
            <CardDialogClose asChild>
              <Button type="button" variant="neutral" size="touch" disabled={saving}>
                取消
              </Button>
            </CardDialogClose>
            <Button
              type="button"
              variant="primary"
              size="touch"
              disabled={saving}
              onClick={() => void handleConfirm()}
            >
              {saving ? "儲存中⋯" : "確定"}
            </Button>
          </CardDialogFooter>
        </CardDialogContent>
      </CardDialog>
    </Card>
  );
}

// =========================================================================
// 新增/編輯表單
// =========================================================================
interface ItemFormState {
  name: string;
  amount: string;
}

const EMPTY_ITEM_FORM: ItemFormState = { name: "", amount: "" };

function itemToFormState(item: MaterialCostItem): ItemFormState {
  return { name: item.name, amount: String(item.amount) };
}

const ITEM_FORM_ID = "material-cost-item-form";

// 小卡窗(盤點 #9 / #10):受控開關,新增與編輯共用同一個元件,只差 item 是不是 null。
function MaterialCostItemFormDialog({
  merchantId,
  item,
  open,
  onOpenChange,
  onSaved,
}: {
  merchantId: string;
  item: MaterialCostItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const isEdit = Boolean(item);
  const [form, setForm] = useState<ItemFormState>(item ? itemToFormState(item) : EMPTY_ITEM_FORM);
  const [saving, setSaving] = useState(false);
  // 金額的欄位級錯誤(skill 二之七:框變紅 + 下面一行 `!` 說明,不只變紅、也不只跳 toast)。
  const [amountError, setAmountError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(item ? itemToFormState(item) : EMPTY_ITEM_FORM);
      setAmountError(null);
    }
  }, [open, item]);

  function setField<K extends keyof ItemFormState>(key: K, value: ItemFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("請填寫品項名稱");
      return;
    }
    // 🔴 2026-09-30:這裡原本是 `Number(form.amount)` + `Number.isNaN`,但 FieldAmountInput 是
    // type="text"(沒有原生 min / step),所以 `1e3`、`0x10`、`Infinity` 都會被 Number() 放行。
    // 改用共用的 parseAmountInput(規則與白話錯誤訊息都在那支函式裡)。這一欄原本沒有 step,
    // 允許小數(料錢成本可能是 12.5 元),所以不傳 integerOnly。
    const parsed = parseAmountInput(form.amount);
    if (!parsed.ok) {
      setAmountError(parsed.error);
      return;
    }
    setAmountError(null);
    const amount = parsed.value;

    const input: UpsertMaterialCostItemInput = { name: form.name, amount };

    setSaving(true);
    try {
      if (isEdit && item) {
        await updateMaterialCostItem(item.id, input);
        toast.success("料錢成本品項已更新");
      } else {
        await addMaterialCostItem(merchantId, input);
        toast.success("已新增料錢成本品項");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(isEdit ? "更新失敗" : "新增失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <CardDialog open={open} onOpenChange={onOpenChange}>
      <CardDialogContent>
        <CardDialogHeader>
          <CardDialogTitle>{isEdit ? "編輯料錢成本品項" : "新增料錢成本品項"}</CardDialogTitle>
          <CardDialogDescription>
            記錄「這次服務預期會用掉的材料成本」，不等於訂單金額計算。
          </CardDialogDescription>
        </CardDialogHeader>

        <form id={ITEM_FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FormField label="名稱" htmlFor="material-cost-name" required>
            <FieldInput
              id="material-cost-name"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              required
            />
          </FormField>

          <FormField
            label="金額"
            htmlFor="material-cost-amount"
            required
            error={amountError}
            help="只能填數字和小數點，例如 120 或 12.5。"
            helpLabel="說明：金額要怎麼填"
          >
            {/* skill 二之七:金額靠右、左側放 $、tabular-nums。驗證走 parseAmountInput(handleSubmit)。 */}
            <FieldAmountInput
              id="material-cost-amount"
              value={form.amount}
              onChange={(e) => {
                setField("amount", e.target.value);
                if (amountError) setAmountError(null);
              }}
              required
            />
          </FormField>
        </form>

        <CardDialogFooter>
          <CardDialogClose asChild>
            <Button type="button" variant="neutral" size="touch">
              取消
            </Button>
          </CardDialogClose>
          <Button
            type="submit"
            form={ITEM_FORM_ID}
            variant="primary"
            size="touch"
            disabled={saving}
          >
            {saving ? "儲存中⋯" : "儲存"}
          </Button>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
  );
}

// =========================================================================
// 主頁面
// =========================================================================
function MaterialCostsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const {
    data: items,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: itemsQueryKey(merchantId),
    queryFn: () => fetchMerchantMaterialCostItemsAll(merchantId),
  });

  // 小卡窗的受控開關:新增一顆、編輯一顆(編輯時記住是哪一筆)。關閉時只把 open 關掉、不清掉
  // editingItem,避免關閉動畫期間標題閃成「新增」。
  const [createOpen, setCreateOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<MaterialCostItem | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  function refetchItems() {
    return queryClient.invalidateQueries({ queryKey: itemsQueryKey(merchantId) });
  }

  async function handleRemoveItem(itemId: string) {
    try {
      await removeMaterialCostItem(itemId);
      await refetchItems();
      toast.success("已下架料錢成本品項");
    } catch (err) {
      toast.error("下架失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleReactivateItem(itemId: string) {
    try {
      await reactivateMaterialCostItem(itemId);
      await refetchItems();
      toast.success("已重新上架這個品項");
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/manage"
        helpMode
        title="料錢成本管理"
        description={`「${merchant!.name}」自訂的料錢成本品項清單與功能開關，建單時可選用。`}
        action={
          <Button type="button" variant="primary" size="touch" onClick={() => setCreateOpen(true)}>
            新增品項
          </Button>
        }
      />

      <MaterialCostEnabledToggle merchantId={merchantId} />

      {/* #985 第 8 批 8-1:緊接在「料錢成本功能」正下方。 */}
      <MaterialCostCommissionToggle merchantId={merchantId} />

      <Card>
        <CardHeader>
          <CardTitle>料錢成本品項</CardTitle>
          <CardDescription>包含已上架與已下架的品項</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingSkeleton variant="cards" rows={3} />
          ) : isError ? (
            // 🔴 2026-09-30 QA:原本只判斷 isLoading 和「空」,查詢失敗會偽裝成「還沒有任何品項」,
            // 商家會以為自己的品項不見了。skill 二之八 出錯:什麼壞了 / 可能原因 / 下一步。
            <ErrorState
              title="讀不到料錢成本品項"
              reason="可能是網路斷了，或你沒有管理料錢成本的權限"
              onRetry={() => void refetch()}
            />
          ) : !items || items.length === 0 ? (
            // 下一步(頁首的「新增品項」)就在同一個畫面上、一眼看得到 ⇒ 依 EmptyState.action 的
            // 唯一豁免,這裡不放第二顆主要按鈕(一個畫面只能有一顆),用一句話指路就好。
            <EmptyState
              title="還沒有任何料錢成本品項"
              description="建立品項後，建單時就能勾選這次會用掉的材料，方便之後算成本。請用右上角的「新增品項」建立第一個。"
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {items.map((item) => (
                <li key={item.id}>
                  {/* skill 二之五 列表卡片:名稱 + 狀態標籤 → 金額 → 右側主要動作 + ⋯。已下架整張變灰。
                      「下架」可逆(有「重新上架」)⇒ ⋯ 一般項目、不標紅。 */}
                  <ListCard
                    title={item.name}
                    state={item.status === "active" ? "default" : "inactive"}
                    tags={
                      item.status === "active" ? (
                        <StatusTag tone="success">上架中</StatusTag>
                      ) : (
                        <StatusTag tone="neutral">已下架</StatusTag>
                      )
                    }
                    meta={<>${Number(item.amount).toFixed(0)}</>}
                    primaryAction={
                      item.status === "active" ? (
                        <Button
                          type="button"
                          variant="neutral"
                          size="card"
                          onClick={() => {
                            setEditingItem(item);
                            setEditOpen(true);
                          }}
                        >
                          編輯
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="neutral"
                          size="card"
                          onClick={() => handleReactivateItem(item.id)}
                        >
                          重新上架
                        </Button>
                      )
                    }
                    menuItems={
                      item.status === "active"
                        ? [{ label: "下架", onSelect: () => void handleRemoveItem(item.id) }]
                        : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <MaterialCostItemFormDialog
        merchantId={merchantId}
        item={null}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={refetchItems}
      />
      <MaterialCostItemFormDialog
        merchantId={merchantId}
        item={editingItem}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={refetchItems}
      />
    </main>
  );
}

export default function MaterialCostsPage() {
  return (
    <RequireMaterialCostsAccess>
      <MaterialCostsPageInner />
    </RequireMaterialCostsAccess>
  );
}
