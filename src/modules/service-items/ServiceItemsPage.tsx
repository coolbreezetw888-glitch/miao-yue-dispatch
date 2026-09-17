// 對應規格書 4.1:服務項目管理頁(新路由 /app/service-items)。
// 服務分類管理小區塊(清單 + 新增/重新命名/刪除)+ 服務項目清單(名稱/金額/類型/工時/分類/狀態)+
// 新增/編輯表單 + 下架/重新上架按鈕。

import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";

import {
  addServiceCategory,
  addServiceItem,
  deleteServiceCategory,
  fetchMerchantServiceItemsAll,
  fetchServiceCategories,
  reactivateServiceItem,
  removeServiceItem,
  renameServiceCategory,
  updateServiceItem,
  type UpsertServiceItemInput,
} from "./api";
import { RequireServiceItemsAccess } from "./RequireServiceItemsAccess";
import {
  SERVICE_ITEM_TYPE_LABELS,
  UNCATEGORIZED_LABEL,
  type ServiceCategory,
  type ServiceItem,
  type ServiceItemType,
} from "./types";

const categoriesQueryKey = (merchantId: string) =>
  ["service-items-module", "categories-admin", merchantId] as const;
const itemsQueryKey = (merchantId: string) =>
  ["service-items-module", "items-admin", merchantId] as const;

// =========================================================================
// 服務分類管理小區塊
// =========================================================================
function CategoryManager({
  merchantId,
  categories,
  onChanged,
}: {
  merchantId: string;
  categories: ServiceCategory[];
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) {
      toast.error("請輸入分類名稱");
      return;
    }
    setAdding(true);
    try {
      await addServiceCategory(merchantId, newName);
      setNewName("");
      onChanged();
      toast.success("已新增分類");
    } catch (err) {
      toast.error("新增分類失敗", { description: getErrorMessage(err) });
    } finally {
      setAdding(false);
    }
  }

  async function handleRename(categoryId: string) {
    if (!renameValue.trim()) {
      toast.error("請輸入分類名稱");
      return;
    }
    try {
      await renameServiceCategory(categoryId, renameValue);
      setRenamingId(null);
      onChanged();
      toast.success("已更新分類名稱");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleDelete(categoryId: string) {
    try {
      await deleteServiceCategory(categoryId);
      onChanged();
      toast.success("已刪除分類");
    } catch (err) {
      toast.error("刪除失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>服務分類</CardTitle>
        <CardDescription>數量無上限,自行新增管理。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleAdd} className="flex gap-2">
          <Input
            placeholder="新增分類名稱"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Button type="submit" disabled={adding} variant="outline">
            新增
          </Button>
        </form>

        {categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            目前還沒有任何分類,可先新增或直接建立未分類的服務項目。
          </p>
        ) : (
          <ul className="space-y-2">
            {categories.map((category) => (
              <li
                key={category.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              >
                {renamingId === category.id ? (
                  <div className="flex flex-1 gap-2">
                    <Input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      autoFocus
                    />
                    <Button size="sm" onClick={() => handleRename(category.id)}>
                      儲存
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setRenamingId(null)}>
                      取消
                    </Button>
                  </div>
                ) : (
                  <>
                    {/* 手機版容器寬度溢出修正:分類名稱是商家自行輸入的文字,長度不固定,
                        加 min-w-0 break-words 讓它願意縮小換行,不會把右側按鈕擠出畫面外。 */}
                    <span className="min-w-0 break-words text-sm text-foreground">
                      {category.name}
                    </span>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setRenamingId(category.id);
                          setRenameValue(category.name);
                        }}
                      >
                        重新命名
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="outline">
                            刪除
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              確定要刪除「{category.name}」這個分類嗎?
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              刪除後,底下的服務項目會變回未分類,不會被刪除。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDelete(category.id)}>
                              確定刪除
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// =========================================================================
// 服務項目新增/編輯表單
// =========================================================================
interface ItemFormState {
  name: string;
  price: string;
  itemType: ServiceItemType;
  durationMinutes: string;
  categoryId: string | null;
}

const EMPTY_ITEM_FORM: ItemFormState = {
  name: "",
  price: "",
  itemType: "primary",
  durationMinutes: "0",
  categoryId: null,
};

function itemToFormState(item: ServiceItem): ItemFormState {
  return {
    name: item.name,
    price: String(item.price),
    itemType: item.item_type as ServiceItemType,
    durationMinutes: String(item.duration_minutes),
    categoryId: item.category_id,
  };
}

function ServiceItemFormDialog({
  merchantId,
  item,
  categories,
  trigger,
  onSaved,
}: {
  merchantId: string;
  item: ServiceItem | null;
  categories: ServiceCategory[];
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
      toast.error("請填寫服務項目名稱");
      return;
    }
    const price = Number(form.price);
    if (form.price.trim() === "" || Number.isNaN(price) || price < 0) {
      toast.error("金額必須是不小於 0 的數字");
      return;
    }
    const durationMinutes = Number(form.durationMinutes);
    if (
      form.durationMinutes.trim() === "" ||
      Number.isNaN(durationMinutes) ||
      durationMinutes < 0 ||
      !Number.isInteger(durationMinutes)
    ) {
      toast.error("工時必須是不小於 0 的整數分鐘數");
      return;
    }

    const input: UpsertServiceItemInput = {
      name: form.name,
      price,
      itemType: form.itemType,
      durationMinutes,
      categoryId: form.categoryId,
    };

    setSaving(true);
    try {
      if (isEdit && item) {
        await updateServiceItem(item.id, input);
        toast.success("服務項目已更新");
      } else {
        await addServiceItem(merchantId, input);
        toast.success("已新增服務項目");
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "編輯服務項目" : "新增服務項目"}</DialogTitle>
          <DialogDescription>金額、類型、工時皆為必填。</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="item-name">名稱 *</Label>
            <Input
              id="item-name"
              className="mt-2"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              required
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="item-price">金額 *</Label>
              <Input
                id="item-price"
                type="number"
                min={0}
                step="0.01"
                className="mt-2"
                value={form.price}
                onChange={(e) => setField("price", e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="item-duration">工時(分鐘) *</Label>
              <Input
                id="item-duration"
                type="number"
                min={0}
                step="1"
                className="mt-2"
                value={form.durationMinutes}
                onChange={(e) => setField("durationMinutes", e.target.value)}
                required
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                可以填 0,表示這個項目不額外佔用行事曆時段。
              </p>
            </div>
          </div>

          <div>
            <Label>類型 *</Label>
            <RadioGroup
              className="mt-2 flex gap-6"
              value={form.itemType}
              onValueChange={(v) => setField("itemType", v as ServiceItemType)}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="primary" id="item-type-primary" />
                <Label htmlFor="item-type-primary" className="font-normal">
                  主要服務
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="addon" id="item-type-addon" />
                <Label htmlFor="item-type-addon" className="font-normal">
                  加價服務
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div>
            <Label htmlFor="item-category">所屬分類</Label>
            <Select
              value={form.categoryId ?? "__uncategorized__"}
              onValueChange={(v) => setField("categoryId", v === "__uncategorized__" ? null : v)}
            >
              <SelectTrigger id="item-category" className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__uncategorized__">{UNCATEGORIZED_LABEL}</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
function ServiceItemsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const { data: categories, isLoading: categoriesLoading } = useQuery({
    queryKey: categoriesQueryKey(merchantId),
    queryFn: () => fetchServiceCategories(merchantId),
  });

  const { data: items, isLoading: itemsLoading } = useQuery({
    queryKey: itemsQueryKey(merchantId),
    queryFn: () => fetchMerchantServiceItemsAll(merchantId),
  });

  function refetchCategories() {
    return queryClient.invalidateQueries({ queryKey: categoriesQueryKey(merchantId) });
  }

  function refetchItems() {
    return queryClient.invalidateQueries({ queryKey: itemsQueryKey(merchantId) });
  }

  function categoryName(categoryId: string | null): string {
    if (!categoryId) return UNCATEGORIZED_LABEL;
    return categories?.find((c) => c.id === categoryId)?.name ?? UNCATEGORIZED_LABEL;
  }

  async function handleRemoveItem(itemId: string) {
    try {
      await removeServiceItem(itemId);
      await refetchItems();
      toast.success("已下架服務項目");
    } catch (err) {
      toast.error("下架失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleReactivateItem(itemId: string) {
    try {
      await reactivateServiceItem(itemId);
      await refetchItems();
      toast.success("已重新上架這個服務項目");
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
        <h1 className="text-2xl font-bold tracking-tight text-foreground">服務項目管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」的服務分類與服務項目
        </p>
      </div>

      {categoriesLoading ? (
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      ) : (
        <CategoryManager
          merchantId={merchantId}
          categories={categories ?? []}
          onChanged={() => {
            void refetchCategories();
            void refetchItems();
          }}
        />
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>服務項目</CardTitle>
            <CardDescription>包含已上架與已下架的服務項目</CardDescription>
          </div>
          <ServiceItemFormDialog
            merchantId={merchantId}
            item={null}
            categories={categories ?? []}
            trigger={<Button variant="cta">新增服務項目</Button>}
            onSaved={refetchItems}
          />
        </CardHeader>
        <CardContent>
          {itemsLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : !items || items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              目前還沒有任何服務項目,點右上角新增一項。
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
                    {/* 手機版容器寬度溢出修正(編號 190):這行串接了金額/類型/工時/分類名稱,
                        分類名稱是商家自訂文字、長度不固定,加 break-words 讓整行願意換行,
                        不會被撐開、蓋住右側的編輯/下架按鈕。 */}
                    <p className="mt-0.5 break-words text-xs text-muted-foreground">
                      ${Number(item.price).toFixed(0)} ・{" "}
                      {SERVICE_ITEM_TYPE_LABELS[item.item_type as ServiceItemType]} ・{" "}
                      {item.duration_minutes} 分鐘 ・ {categoryName(item.category_id)}
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
                        <ServiceItemFormDialog
                          merchantId={merchantId}
                          item={item}
                          categories={categories ?? []}
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

export default function ServiceItemsPage() {
  return (
    <RequireServiceItemsAccess>
      <ServiceItemsPageInner />
    </RequireServiceItemsAccess>
  );
}
