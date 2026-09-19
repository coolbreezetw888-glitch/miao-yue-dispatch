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
import { Textarea } from "@/components/ui/textarea";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";

import {
  addPaymentMethod,
  fetchMerchantPaymentMethodsAll,
  reactivatePaymentMethod,
  removePaymentMethod,
  updatePaymentMethod,
  type UpsertPaymentMethodInput,
} from "./api";
import { RequirePaymentMethodsAccess } from "./RequirePaymentMethodsAccess";
import type { PaymentMethod } from "./types";

const methodsQueryKey = (merchantId: string) =>
  ["booking-module", "payment-methods-admin", merchantId] as const;

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
