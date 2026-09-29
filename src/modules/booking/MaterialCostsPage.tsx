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
  EmptyState,
  FieldAmountInput,
  FieldInput,
  FormField,
  ListCard,
  LoadingSkeleton,
  PageHeader,
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
  fetchMerchantMaterialCostItemsAll,
  reactivateMaterialCostItem,
  removeMaterialCostItem,
  updateMaterialCostItem,
  MATERIAL_COST_ENABLED_FEATURE_KEY,
  type UpsertMaterialCostItemInput,
} from "./api";
import { RequireMaterialCostsAccess } from "./RequireMaterialCostsAccess";
import type { MaterialCostItem } from "./types";

const itemsQueryKey = (merchantId: string) =>
  ["booking-module", "material-cost-items-admin", merchantId] as const;

// 商家端三項調整規格書 §一 1.2/1.3:料錢成本功能開關,從 BusinessHoursPage.tsx 搬過來,
// 放在這個頁面最上方(料錢成本品項清單 Card 之前)。RLS 已放寬成同時允許
// can_manage_material_costs,不再要求 can_manage_business_hours,所以這裡不需要額外的
// 權限判斷——能進到這個頁面的人(RequireMaterialCostsAccess 已擋過一次)就能操作這個開關。
function MaterialCostEnabledToggle({ merchantId }: { merchantId: string }) {
  const featureFlagQueryKey = ["booking-module", "material-cost-enabled", merchantId] as const;
  const queryClient = useQueryClient();
  const { data: enabled, isLoading } = useQuery({
    queryKey: featureFlagQueryKey,
    queryFn: async () => {
      const value = await getFeatureFlag(merchantId, MATERIAL_COST_ENABLED_FEATURE_KEY);
      // 規格書(建單功能擴充)2.3:查無資料一律視為關閉(預設值關閉)。
      return value ?? false;
    },
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
          開啟後,建單/編輯表單會出現「料錢成本」勾選區塊,可以記錄這次服務預期會用掉的材料成本
          (不是訂單金額計算)。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingSkeleton variant="lines" rows={1} />
        ) : (
          // skill 二之七:開關做成一整列(左邊標題 + 一行說明,右邊開關)。
          // 原本的「已開啟 / 已關閉」狀態文字保留在說明列,不讓人只看開關猜狀態。
          <SwitchRow
            title="啟用料錢成本功能"
            description={
              enabled
                ? "目前已開啟,建單表單會出現「料錢成本」區塊。"
                : "目前已關閉,建單表單不會出現「料錢成本」區塊。"
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

  useEffect(() => {
    if (open) {
      setForm(item ? itemToFormState(item) : EMPTY_ITEM_FORM);
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
    const amount = Number(form.amount);
    if (form.amount.trim() === "" || Number.isNaN(amount) || amount < 0) {
      toast.error("金額必須是不小於 0 的數字");
      return;
    }

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
            記錄「這次服務預期會用掉的材料成本」,不等於訂單金額計算。
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

          <FormField label="金額" htmlFor="material-cost-amount" required>
            {/* skill 二之七:金額靠右、左側放 $、tabular-nums。驗證仍在 handleSubmit(不小於 0 的數字)。 */}
            <FieldAmountInput
              id="material-cost-amount"
              value={form.amount}
              onChange={(e) => setField("amount", e.target.value)}
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

  const { data: items, isLoading } = useQuery({
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
        title="料錢成本管理"
        description={`「${merchant!.name}」自訂的料錢成本品項清單,建單時可選用。這是成本記錄,不是訂單金額計算。`}
        action={
          <Button type="button" variant="primary" size="touch" onClick={() => setCreateOpen(true)}>
            新增品項
          </Button>
        }
      />

      <MaterialCostEnabledToggle merchantId={merchantId} />

      <Card>
        <CardHeader>
          <CardTitle>料錢成本品項</CardTitle>
          <CardDescription>包含已上架與已下架的品項</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingSkeleton variant="cards" rows={3} />
          ) : !items || items.length === 0 ? (
            <EmptyState
              title="還沒有任何料錢成本品項"
              description="建立品項後,建單時就能勾選這次會用掉的材料,方便之後算成本。"
              action={
                <Button
                  type="button"
                  variant="primary"
                  size="touch"
                  onClick={() => setCreateOpen(true)}
                >
                  新增第一個品項
                </Button>
              }
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
