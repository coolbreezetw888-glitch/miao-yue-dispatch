// 對應模組 9(支付方式)v2 規格書 §5.1:付款方式管理頁(新路由 /app/payment-methods)。
// 比照 MaterialCostsPage.tsx 的既有樣式:清單(名稱/說明文字/狀態)+ 新增/編輯/下架/重新上架。
// 取代 v1 塞在 BusinessHoursPage.tsx 裡的 PaymentMethodSettingsCard——這次的資料結構已經升級成
// 「有名稱+說明文字+上架/下架狀態」的完整清單管理,跟料錢成本管理頁是同一等級的功能。
//
// ui-v1-full 第二階段第 2 批(2026-09-29,盤點 #11 / #12):
//   - 新增 / 編輯付款方式(2 欄)→ 小卡窗殼(CardDialog),受控開關;欄位改 FormField / FieldInput /
//     FieldTextarea。
//   - 付款方式列改 ListCard(下架收進 ⋯、可逆不標紅;已下架整張變灰、主要動作換「重新上架」)。
//   - 稅金設定:模式二選一改 ChoiceChipGroup(skill 二之七 單選)、數字改 FormField / FieldInput。
//   - 頁首改 PageHeader、載入中改骨架、空狀態補下一步按鈕。
// **只動外觀與版面,不動任何行為**。

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
  ChoiceChipGroup,
  EmptyState,
  FieldInput,
  FieldTextarea,
  FormField,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";

import {
  addPaymentMethod,
  fetchMerchantPaymentMethodsAll,
  reactivatePaymentMethod,
  removePaymentMethod,
  updatePaymentMethod,
  upsertMerchantTaxSettings,
  type UpsertPaymentMethodInput,
} from "./api";
import { useMerchantTaxSettings } from "./context";
import { RequirePaymentMethodsAccess } from "./RequirePaymentMethodsAccess";
import {
  AMOUNT_ADJUSTMENT_MODE_LABELS,
  type AmountAdjustmentMode,
  type PaymentMethod,
} from "./types";

const methodsQueryKey = (merchantId: string) =>
  ["booking-module", "payment-methods-admin", merchantId] as const;

// 商家端三項調整規格書 §一 1.2/1.3:稅金設定,從 BusinessHoursPage.tsx 搬過來,放在
// 這個頁面最下方(付款方式清單 Card 之後)。RLS 已放寬成同時允許 can_manage_payment_methods,
// 不再要求 can_manage_business_hours,所以這裡不需要額外的權限判斷——能進到這個頁面的人
// (RequirePaymentMethodsAccess 已擋過一次)就能操作這個設定。查無資料時 fallback 成
// DEFAULT_MERCHANT_TAX_SETTINGS(useMerchantTaxSettings 已經處理過)。
function TaxSettingsCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const { data: taxSettings, isLoading } = useMerchantTaxSettings(merchantId);

  const [taxMode, setTaxMode] = useState<AmountAdjustmentMode>("percentage");
  const [taxValue, setTaxValue] = useState("5");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!taxSettings) return;
    setTaxMode(taxSettings.taxMode);
    setTaxValue(String(taxSettings.taxValue));
  }, [taxSettings]);

  async function handleSave() {
    const numericValue = Number(taxValue);
    if (Number.isNaN(numericValue) || numericValue < 0) {
      toast.error("請輸入正確的數字");
      return;
    }
    if (taxMode === "percentage" && numericValue > 100) {
      toast.error("百分比模式下,數字必須介於 0~100 之間");
      return;
    }
    setSaving(true);
    try {
      await upsertMerchantTaxSettings(merchantId, { taxMode, taxValue: numericValue });
      await queryClient.invalidateQueries({
        queryKey: ["booking-module", "merchant-tax-settings", merchantId],
      });
      toast.success("已更新稅金設定");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>稅金設定</CardTitle>
        <CardDescription>
          建單表單開啟稅金開關時,預設帶入這裡的模式跟數字(客服可以針對個別訂單再調整數字,但不能
          改變模式)。模式要改成別種,只能在這裡改。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <LoadingSkeleton variant="lines" rows={2} />
        ) : (
          <>
            <FormField label="稅金模式" required>
              {/* skill 二之七:單選用 ChoiceChipGroup(role="radiogroup")。值直接來自常數白名單
                  (AMOUNT_ADJUSTMENT_MODE_LABELS 的 key),不是 Radix Select,沒有幽靈空值事件,
                  所以原本包在 Select 上的 guardPhantomEmptyChange 這裡不再需要。 */}
              <ChoiceChipGroup
                aria-label="稅金模式"
                value={taxMode}
                onValueChange={setTaxMode}
                options={(Object.keys(AMOUNT_ADJUSTMENT_MODE_LABELS) as AmountAdjustmentMode[]).map(
                  (mode) => ({ value: mode, label: AMOUNT_ADJUSTMENT_MODE_LABELS[mode] }),
                )}
              />
            </FormField>
            <FormField
              label={taxMode === "percentage" ? "稅率(%)" : "稅額(元)"}
              htmlFor="merchant-tax-value"
              required
              helpLabel="說明:稅金數字怎麼填"
              help={
                taxMode === "percentage"
                  ? "填 0~100 的數字,例如 5 代表 5%。"
                  : "填固定金額(元),每筆開啟稅金的訂單都會加上這個數字。"
              }
            >
              <div className="flex items-center gap-2">
                <FieldInput
                  id="merchant-tax-value"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={taxMode === "percentage" ? 100 : undefined}
                  step="0.01"
                  className="max-w-[160px] tabular-nums"
                  value={taxValue}
                  onChange={(e) => setTaxValue(e.target.value)}
                />
                <span className="text-sm text-muted-foreground">
                  {taxMode === "percentage" ? "%" : "元"}
                </span>
              </div>
            </FormField>
            {/* 這一頁唯一的主要動作是頁首的「新增付款方式」,所以這顆儲存用次要樣式(skill 二之三:
                一個畫面只能有一顆主要按鈕)。 */}
            <div>
              <Button
                type="button"
                variant="neutral"
                size="touch"
                disabled={saving}
                onClick={handleSave}
              >
                {saving ? "儲存中⋯" : "儲存稅金設定"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// =========================================================================
// 新增/編輯表單
// =========================================================================
interface MethodFormState {
  name: string;
  description: string;
}

const EMPTY_METHOD_FORM: MethodFormState = { name: "", description: "" };

function methodToFormState(method: PaymentMethod): MethodFormState {
  return { name: method.name, description: method.description ?? "" };
}

const METHOD_FORM_ID = "payment-method-form";

// 小卡窗(盤點 #11 / #12):受控開關,新增與編輯共用同一個元件,只差 method 是不是 null。
function PaymentMethodFormDialog({
  merchantId,
  method,
  open,
  onOpenChange,
  onSaved,
}: {
  merchantId: string;
  method: PaymentMethod | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const isEdit = Boolean(method);
  const [form, setForm] = useState<MethodFormState>(
    method ? methodToFormState(method) : EMPTY_METHOD_FORM,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(method ? methodToFormState(method) : EMPTY_METHOD_FORM);
    }
  }, [open, method]);

  function setField<K extends keyof MethodFormState>(key: K, value: MethodFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("請填寫付款方式名稱");
      return;
    }

    const input: UpsertPaymentMethodInput = {
      name: form.name,
      description: form.description.trim() ? form.description : null,
    };

    setSaving(true);
    try {
      if (isEdit && method) {
        await updatePaymentMethod(method.id, input);
        toast.success("付款方式已更新");
      } else {
        await addPaymentMethod(merchantId, input);
        toast.success("已新增付款方式");
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
          <CardDialogTitle>{isEdit ? "編輯付款方式" : "新增付款方式"}</CardDialogTitle>
          <CardDialogDescription>
            商家自己命名的付款方式項目,建單時可選用。想叫什麼名字、新增幾筆都可以。
          </CardDialogDescription>
        </CardDialogHeader>

        <form id={METHOD_FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FormField label="名稱" htmlFor="payment-method-name" required>
            <FieldInput
              id="payment-method-name"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              required
            />
          </FormField>

          <FormField label="說明文字" htmlFor="payment-method-description">
            <FieldTextarea
              id="payment-method-description"
              rows={3}
              placeholder="例如:收款銀行帳號,或這個項目代表的情境說明"
              value={form.description}
              onChange={(e) => setField("description", e.target.value)}
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
            form={METHOD_FORM_ID}
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
function PaymentMethodsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const { data: methods, isLoading } = useQuery({
    queryKey: methodsQueryKey(merchantId),
    queryFn: () => fetchMerchantPaymentMethodsAll(merchantId),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editingMethod, setEditingMethod] = useState<PaymentMethod | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  function refetchMethods() {
    return queryClient.invalidateQueries({ queryKey: methodsQueryKey(merchantId) });
  }

  async function handleRemoveMethod(id: string) {
    try {
      await removePaymentMethod(id);
      await refetchMethods();
      toast.success("已下架這個付款方式");
    } catch (err) {
      toast.error("下架失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleReactivateMethod(id: string) {
    try {
      await reactivatePaymentMethod(id);
      await refetchMethods();
      toast.success("已重新上架這個付款方式");
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/manage"
        title="付款方式管理"
        description={`「${merchant!.name}」自訂的付款方式清單,建單時可選用。這裡只是標記客戶用什麼方式付款,不會真的串接金流,不會自動收款或對帳。`}
        action={
          <Button type="button" variant="primary" size="touch" onClick={() => setCreateOpen(true)}>
            新增付款方式
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>付款方式</CardTitle>
          <CardDescription>包含已上架與已下架的項目</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingSkeleton variant="cards" rows={3} />
          ) : !methods || methods.length === 0 ? (
            <EmptyState
              title="還沒有任何付款方式"
              description="建立付款方式後,建單時就能標記客戶是怎麼付款的,方便之後對帳。"
              action={
                <Button
                  type="button"
                  variant="primary"
                  size="touch"
                  onClick={() => setCreateOpen(true)}
                >
                  新增第一個付款方式
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {methods.map((method) => (
                <li key={method.id}>
                  {/* skill 二之五:名稱 + 狀態標籤 → 說明文字(商家自填、可折行)→ 右側主要動作 + ⋯。 */}
                  <ListCard
                    title={method.name}
                    state={method.status === "active" ? "default" : "inactive"}
                    tags={
                      method.status === "active" ? (
                        <StatusTag tone="success">上架中</StatusTag>
                      ) : (
                        <StatusTag tone="neutral">已下架</StatusTag>
                      )
                    }
                    meta={method.description ? method.description : undefined}
                    primaryAction={
                      method.status === "active" ? (
                        <Button
                          type="button"
                          variant="neutral"
                          size="card"
                          onClick={() => {
                            setEditingMethod(method);
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
                          onClick={() => handleReactivateMethod(method.id)}
                        >
                          重新上架
                        </Button>
                      )
                    }
                    menuItems={
                      method.status === "active"
                        ? [{ label: "下架", onSelect: () => void handleRemoveMethod(method.id) }]
                        : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <TaxSettingsCard merchantId={merchantId} />

      <PaymentMethodFormDialog
        merchantId={merchantId}
        method={null}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={refetchMethods}
      />
      <PaymentMethodFormDialog
        merchantId={merchantId}
        method={editingMethod}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={refetchMethods}
      />
    </main>
  );
}

export default function PaymentMethodsPage() {
  return (
    <RequirePaymentMethodsAccess>
      <PaymentMethodsPageInner />
    </RequirePaymentMethodsAccess>
  );
}
