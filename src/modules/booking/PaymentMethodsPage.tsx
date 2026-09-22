// 對應模組 9(支付方式)v2 規格書 §5.1:付款方式管理頁(新路由 /app/payment-methods)。
// 比照 MaterialCostsPage.tsx 的既有樣式:清單(名稱/說明文字/狀態)+ 新增/編輯/下架/重新上架。
// 取代 v1 塞在 BusinessHoursPage.tsx 裡的 PaymentMethodSettingsCard——這次的資料結構已經升級成
// 「有名稱+說明文字+上架/下架狀態」的完整清單管理,跟料錢成本管理頁是同一等級的功能。

import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

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
import { AMOUNT_ADJUSTMENT_MODE_LABELS, type AmountAdjustmentMode, type PaymentMethod } from "./types";

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
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={taxMode} onValueChange={(v) => setTaxMode(v as AmountAdjustmentMode)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed">{AMOUNT_ADJUSTMENT_MODE_LABELS.fixed}</SelectItem>
                <SelectItem value="percentage">{AMOUNT_ADJUSTMENT_MODE_LABELS.percentage}</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={0}
              max={taxMode === "percentage" ? 100 : undefined}
              step="0.01"
              className="w-32"
              value={taxValue}
              onChange={(e) => setTaxValue(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">
              {taxMode === "percentage" ? "%(0~100 的數字)" : "元(固定金額)"}
            </span>
            <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </div>
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

function PaymentMethodFormDialog({
  merchantId,
  method,
  trigger,
  onSaved,
}: {
  merchantId: string;
  method: PaymentMethod | null;
  trigger: React.ReactNode;
  onSaved: () => void;
}) {
  const isEdit = Boolean(method);
  const [open, setOpen] = useState(false);
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
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error(isEdit ? "更新失敗" : "新增失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "編輯付款方式" : "新增付款方式"}</DialogTitle>
          <DialogDescription>
            商家自己命名的付款方式項目,建單時可選用。想叫什麼名字、新增幾筆都可以。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="payment-method-name">名稱 *</Label>
            <Input
              id="payment-method-name"
              className="mt-2"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              required
            />
          </div>

          <div>
            <Label htmlFor="payment-method-description">說明文字</Label>
            <Textarea
              id="payment-method-description"
              className="mt-2"
              rows={3}
              placeholder="例如:收款銀行帳號,或這個項目代表的情境說明"
              value={form.description}
              onChange={(e) => setField("description", e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">付款方式管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」自訂的付款方式清單,建單時可選用。這裡只是標記客戶用什麼方式付款,
          不會真的串接金流,不會自動收款或對帳。
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>付款方式</CardTitle>
            <CardDescription>包含已上架與已下架的項目</CardDescription>
          </div>
          <PaymentMethodFormDialog
            merchantId={merchantId}
            method={null}
            trigger={<Button variant="cta">新增付款方式</Button>}
            onSaved={refetchMethods}
          />
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : !methods || methods.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              目前還沒有任何付款方式,點右上角新增一項。
            </p>
          ) : (
            <ul className="space-y-2">
              {methods.map((method) => (
                <li
                  key={method.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{method.name}</p>
                    {method.description ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {method.description}
                      </p>
                    ) : null}
                    <div className="mt-1">
                      <Badge variant={method.status === "active" ? "default" : "secondary"}>
                        {method.status === "active" ? "上架中" : "已下架"}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {method.status === "active" ? (
                      <>
                        <PaymentMethodFormDialog
                          merchantId={merchantId}
                          method={method}
                          trigger={
                            <Button variant="outline" size="sm">
                              編輯
                            </Button>
                          }
                          onSaved={refetchMethods}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRemoveMethod(method.id)}
                        >
                          下架
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleReactivateMethod(method.id)}
                      >
                        重新上架
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <TaxSettingsCard merchantId={merchantId} />
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
