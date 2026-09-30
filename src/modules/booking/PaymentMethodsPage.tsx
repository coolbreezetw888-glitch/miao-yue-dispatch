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
  AlertNote,
  CardDialog,
  CardDialogClose,
  CardDialogContent,
  CardDialogDescription,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
  ChoiceChipGroup,
  EmptyState,
  ErrorState,
  FieldInput,
  FieldTextarea,
  FormField,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  parseAmountInput,
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
  const { data: taxSettings, isLoading, isError, refetch } = useMerchantTaxSettings(merchantId);

  const [taxMode, setTaxMode] = useState<AmountAdjustmentMode>("percentage");
  const [taxValue, setTaxValue] = useState("5");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!taxSettings) return;
    setTaxMode(taxSettings.taxMode);
    setTaxValue(String(taxSettings.taxValue));
  }, [taxSettings]);

  // 🔴 2026-09-30:原本是 `Number(taxValue)` + `Number.isNaN` + `< 0`,那個組合放行了
  // 固定金額模式的 `Infinity`(`Number.isNaN(Infinity)` 是 false、`Infinity < 0` 也是 false),
  // 以及 `1e3` → 1000、`0x10` → 16。這一欄是原生 `type="number"`,但這張卡沒有 `<form>`、
  // 儲存鈕是 `type="button"` + onClick ⇒ 原生 min / max 從來不會觸發,擋不住任何東西。
  // 改走全站共用的 parseAmountInput(百分比模式順便把 0~100 的上限交給它一起檢查)。
  //
  // 🔴 2026-09-30(使用者實機巡檢批):解析從 handleSave 裡面搬到**渲染時**算,錯誤改成
  // `FormField error=`(欄位框變紅 + 下面一行 `!` 說明),不再用 toast.error(skill 二之七:
  // 「錯誤:框變紅 + 下面一行 `!` 說明」)。理由跟本輪其他 4 處(建單 / 服務項目 / 點數頁 /
  // 點數面板)完全一樣:
  //   ① toast 會自己消失,使用者回頭改欄位時已經看不到錯誤說的是哪一格、要改成什麼。
  //   ② toast 出現在畫面角落,離出錯的欄位很遠。
  //   ③ 即時算 ⇒ **一改內容錯誤就自己清掉**,不用再按一次儲存才知道改對了沒。
  // 順帶把儲存鈕在有錯時 disabled;按鈕變灰一定要說明原因(skill 二之三)⇒ 配一條常駐 `!`。
  const parsedTax = parseAmountInput(taxValue, taxMode === "percentage" ? { max: 100 } : {});

  async function handleSave() {
    // 錯誤已經即時顯示在欄位下面、儲存鈕也 disabled,這裡是防呆,不是主要防線。
    if (!parsedTax.ok) return;
    const numericValue = parsedTax.value;
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
        ) : isError ? (
          // 🔴 2026-09-30 QA:讀不到稅金設定時,原本會直接顯示元件的預設值(百分比 / 5%),
          // 使用者以為那是自己存過的設定,一按儲存就把真實設定覆寫掉。出錯就不給表單。
          <ErrorState
            title="讀不到稅金設定"
            reason="可能是網路斷了;現在先不顯示欄位,避免你把畫面上的預設值當成自己的設定存回去"
            onRetry={() => void refetch()}
          />
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
              error={parsedTax.ok ? null : parsedTax.error}
              helpLabel="說明:稅金數字怎麼填"
              help={
                taxMode === "percentage"
                  ? "填 0~100 的數字,例如 5 代表 5%。"
                  : "填固定金額(元),每筆開啟稅金的訂單都會加上這個數字。"
              }
            >
              <div className="flex items-center gap-2">
                {/* 🔴 這一欄刻意**維持 type="number"**,跟全站其他金額欄位不一致是有理由的
                    (2026-09-30 主腦裁決,不要「順手統一」掉):
                      1. 它在百分比模式下裝的是**百分比**,不是金額——不該有 `$` 前綴,所以
                         用不到 FieldAmountInput(那個元件的重點就是左側 `$`)。
                      2. 它同時要吃 0~100(百分比)跟任意金額(固定金額)兩種範圍,原生的
                         min / max 會隨 taxMode 換,是這裡最省事也最不會錯的做法。
                    🔴 **全站 FieldAmountInput(type="text")的完整清單,要靠 parseAmountInput 驗證**
                    ——2026-09-30 這份清單只列了前 3 個,建單表單那 4 個被漏掉,結果那 4 格整批沒接上
                    驗證(折扣填 `abc` 會讓最終金額變 NaN 還能送出)。**新增 FieldAmountInput 使用點時
                    一定要把它加進這份清單**,不然下一次還是會漏:
                      1. 料錢成本金額(`MaterialCostsPage.tsx`)
                      2. 每天扣固定金額(`LeaveDeductionRuleDialog.tsx`,integerOnly)
                      3. 月薪(`PayrollSettingsPage.tsx`,integerOnly)
                      4. 服務項目價格(`ServiceItemsPage.tsx`)
                      5~8. 建單 / 編輯預約表單 4 格(`CalendarPage.tsx`):自訂總金額、折扣金額、
                         稅額、每個已選服務項目的單價 —— 解析集中在 `bookingAmountFields.ts`
                    這一欄(商家稅金設定)不是 FieldAmountInput,但它**也不能靠原生約束**:
                    🔴 原生 min / max 只在「外面包著 `<form>`、送出鈕是 `type="submit"`」時才會觸發,
                    而這張稅金設定卡沒有 `<form>`、儲存鈕是 `type="button"` + onClick
                    ⇒ 原生約束從來不會跑。所以它的 handleSave 一樣改用 parseAmountInput
                    (2026-09-30,原本的 `Number()` + `Number.isNaN` 放行了固定金額模式的 `Infinity`)。 */}
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
            {/* 🔴 2026-09-30:填錯時擋住儲存,不能只顯示紅字。按鈕變灰就要說明原因(skill 二之三)。 */}
            {parsedTax.ok ? null : (
              <AlertNote>
                上面的稅金數字填錯了(標紅那一格),修好之後才能儲存。
                {taxMode === "percentage"
                  ? "百分比模式只能填 0~100 的數字,例如 5。"
                  : "固定金額模式只能填 0 以上的數字,例如 30。"}
              </AlertNote>
            )}
            {/* 這一頁唯一的主要動作是頁首的「新增付款方式」,所以這顆儲存用次要樣式(skill 二之三:
                一個畫面只能有一顆主要按鈕)。 */}
            <div>
              <Button
                type="button"
                variant="neutral"
                size="touch"
                disabled={saving || !parsedTax.ok}
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

  const {
    data: methods,
    isLoading,
    isError,
    refetch,
  } = useQuery({
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
          ) : isError ? (
            // 🔴 2026-09-30 QA:原本查詢失敗會偽裝成「還沒有任何付款方式」。skill 二之八 出錯。
            <ErrorState
              title="讀不到付款方式"
              reason="可能是網路斷了,或你沒有管理付款方式的權限"
              onRetry={() => void refetch()}
            />
          ) : !methods || methods.length === 0 ? (
            // 下一步(頁首的「新增付款方式」)就在同一個畫面上 ⇒ 不放第二顆主要按鈕,改用一句話指路。
            <EmptyState
              title="還沒有任何付款方式"
              description="建立付款方式後,建單時就能標記客戶是怎麼付款的,方便之後對帳。請用右上角的「新增付款方式」建立第一個。"
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
