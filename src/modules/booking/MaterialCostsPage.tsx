// 對應建單功能擴充規格書 5.4:料錢成本管理頁(新路由 /app/material-costs)。
// 比照模組 4 服務項目管理頁的既有樣式:清單(名稱/金額/狀態)+ 新增/編輯/下架/重新上架。

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

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";

import {
  addMaterialCostItem,
  fetchMerchantMaterialCostItemsAll,
  reactivateMaterialCostItem,
  removeMaterialCostItem,
  updateMaterialCostItem,
  type UpsertMaterialCostItemInput,
} from "./api";
import { RequireMaterialCostsAccess } from "./RequireMaterialCostsAccess";
import type { MaterialCostItem } from "./types";

const itemsQueryKey = (merchantId: string) =>
  ["booking-module", "material-cost-items-admin", merchantId] as const;

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

function MaterialCostItemFormDialog({
  merchantId,
  item,
  trigger,
  onSaved,
}: {
  merchantId: string;
  item: MaterialCostItem | null;
  trigger: React.ReactNode;
  onSaved: () => void;
}) {
  const isEdit = Boolean(item);
  const [open, setOpen] = useState(false);
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
          <DialogTitle>{isEdit ? "編輯料錢成本品項" : "新增料錢成本品項"}</DialogTitle>
          <DialogDescription>
            記錄「這次服務預期會用掉的材料成本」,不等於訂單金額計算。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="material-cost-name">名稱 *</Label>
            <Input
              id="material-cost-name"
              className="mt-2"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              required
            />
          </div>

          <div>
            <Label htmlFor="material-cost-amount">金額 *</Label>
            <Input
              id="material-cost-amount"
              type="number"
              min={0}
              step="0.01"
              className="mt-2"
              value={form.amount}
              onChange={(e) => setField("amount", e.target.value)}
              required
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
function MaterialCostsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const { data: items, isLoading } = useQuery({
    queryKey: itemsQueryKey(merchantId),
    queryFn: () => fetchMerchantMaterialCostItemsAll(merchantId),
  });

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
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">料錢成本管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」自訂的料錢成本品項清單,建單時可選用。這是成本記錄,不是訂單金額計算。
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>料錢成本品項</CardTitle>
            <CardDescription>包含已上架與已下架的品項</CardDescription>
          </div>
          <MaterialCostItemFormDialog
            merchantId={merchantId}
            item={null}
            trigger={<Button variant="cta">新增品項</Button>}
            onSaved={refetchItems}
          />
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : !items || items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              目前還沒有任何料錢成本品項,點右上角新增一項。
            </p>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      ${Number(item.amount).toFixed(0)}
                    </p>
                    <div className="mt-1">
                      <Badge variant={item.status === "active" ? "default" : "secondary"}>
                        {item.status === "active" ? "上架中" : "已下架"}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {item.status === "active" ? (
                      <>
                        <MaterialCostItemFormDialog
                          merchantId={merchantId}
                          item={item}
                          trigger={
                            <Button variant="outline" size="sm">
                              編輯
                            </Button>
                          }
                          onSaved={refetchItems}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRemoveItem(item.id)}
                        >
                          下架
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleReactivateItem(item.id)}
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

export default function MaterialCostsPage() {
  return (
    <RequireMaterialCostsAccess>
      <MaterialCostsPageInner />
    </RequireMaterialCostsAccess>
  );
}
