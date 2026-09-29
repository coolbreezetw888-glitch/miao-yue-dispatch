// 對應規格書 4.1:服務項目管理頁(新路由 /app/service-items)。
// 服務分類管理小區塊(清單 + 新增/重新命名/刪除)+ 服務項目清單(名稱/金額/類型/工時/分類/狀態)+
// 新增/編輯表單 + 下架/重新上架按鈕。
//
// ui-v1-full 第二階段第 1 批(2026-09-29,盤點 A1 / A2 + O3):
//   - 服務項目「新增 / 編輯」表單(約 5 欄)改用 ui-overlay-patterns 的全頁層殼(FullPageLayer),
//     手機滿版 / 電腦置中面板,底部固定「取消 / 儲存」等寬兩顆。原本手寫的 max-w-lg(O3)隨著
//     Dialog 一起消失,寬度只由共用殼決定。
//   - 表單欄位改用 FormField / FieldInput / FieldAmountInput / ChoiceChipGroup / FieldSelect(skill 二之七)。
//   - 服務分類列、服務項目列改成 ListCard(skill 二之五):右側只放「一顆主要動作 + 一個 ⋯」,
//     刪除 / 下架收進 ⋯ 選單。因為觸發點變成選單項目,確認窗與表單改成受控
//     開關(open / onOpenChange),不再各自包一顆 Trigger。
//   - 頁首改用 PageHeader 骨架、載入中改灰色骨架、空狀態補下一步按鈕(skill 二之八)。
// ui-v1-full 第二階段回填(2026-09-29):類型單選改 ChoiceChipGroup(radiogroup 語意)、所屬分類改
//   共用 FieldSelect(頁面不再自己寫 className 調樣式)、表單副標「名稱、金額、類型、工時皆為必填」用
//   FullPageLayer 的 subtitle 接回來(2026-09-29 主腦裁決補上「名稱」——名稱本來就是必填,副標漏掉
//   一項等於騙人);「下架」是可逆動作 ⇒ ⋯ 選單一般項目、不再標紅
//   (分類「刪除」是真的刪、不可逆 ⇒ 維持紅字)。
// **只動外觀與版面,不動任何行為**:驗證、送出、下架 / 重新上架、刪除分類的邏輯全部照舊。

import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ActionBar,
  AttributeTag,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  ChoiceChipGroup,
  EmptyState,
  FieldAmountInput,
  FieldInput,
  FieldSelect,
  FormField,
  FullPageLayer,
  FullPageLayerClose,
  FullPageLayerContent,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// 2026-09-24 稽核修正(問題 3):Radix Select 幽靈空值事件的共用防護,見該檔案開頭的完整說明。
import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
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
  // 小卡窗範本(盤點 #1):刪除確認改成受控開關——觸發點現在是 ListCard 的 ⋯ 選單項目,不再是
  // 每一列各自包一顆 Trigger。deletingCategory 有值 = 確認窗開著。
  const [deletingCategory, setDeletingCategory] = useState<ServiceCategory | null>(null);

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
          <FieldInput
            aria-label="新增分類名稱"
            placeholder="新增分類名稱"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" disabled={adding} variant="neutral" size="touch">
            新增
          </Button>
        </form>

        {categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            目前還沒有任何分類,可先新增或直接建立未分類的服務項目。
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {categories.map((category) =>
              renamingId === category.id ? (
                <li key={category.id}>
                  {/* 重新命名中:名稱位置換成輸入框,右側是「取消 / 儲存」兩顆。 */}
                  <ListCard
                    title={
                      <FieldInput
                        aria-label="分類名稱"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleRename(category.id);
                          }
                        }}
                        autoFocus
                      />
                    }
                    primaryAction={
                      <>
                        <Button
                          type="button"
                          variant="neutral"
                          size="card"
                          onClick={() => setRenamingId(null)}
                        >
                          取消
                        </Button>
                        <Button
                          type="button"
                          variant="primary"
                          size="card"
                          onClick={() => handleRename(category.id)}
                        >
                          儲存
                        </Button>
                      </>
                    }
                  />
                </li>
              ) : (
                <li key={category.id}>
                  {/* 分類名稱是商家自行輸入的文字,長度不固定;ListCard 的 title 已經 break-words,
                      不會把右側按鈕擠出畫面外。 */}
                  <ListCard
                    title={category.name}
                    primaryAction={
                      <Button
                        type="button"
                        variant="neutral"
                        size="card"
                        onClick={() => {
                          setRenamingId(category.id);
                          setRenameValue(category.name);
                        }}
                      >
                        重新命名
                      </Button>
                    }
                    menuItems={[
                      {
                        label: "刪除",
                        danger: true,
                        onSelect: () => setDeletingCategory(category),
                      },
                    ]}
                  />
                </li>
              ),
            )}
          </ul>
        )}

        {/* 小卡窗範本(盤點 #1):純確認 → CardAlertDialog。確認鈕用 tone="danger"
            (白底紅字淡紅框,skill 二之三:危險動作不做實心紅);取消鈕自動是次要樣式。 */}
        <CardAlertDialog
          open={deletingCategory !== null}
          onOpenChange={(open) => {
            if (!open) setDeletingCategory(null);
          }}
        >
          <CardAlertDialogContent>
            <CardAlertDialogHeader>
              <CardAlertDialogTitle className="break-words">
                確定要刪除「{deletingCategory?.name}」這個分類嗎?
              </CardAlertDialogTitle>
              <CardAlertDialogDescription>
                刪除後,底下的服務項目會變回未分類,不會被刪除。
              </CardAlertDialogDescription>
            </CardAlertDialogHeader>
            <CardAlertDialogFooter>
              <CardAlertDialogCancel>取消</CardAlertDialogCancel>
              <CardAlertDialogAction
                tone="danger"
                onClick={() => {
                  if (deletingCategory) void handleDelete(deletingCategory.id);
                }}
              >
                確定刪除
              </CardAlertDialogAction>
            </CardAlertDialogFooter>
          </CardAlertDialogContent>
        </CardAlertDialog>
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

const ITEM_FORM_ID = "service-item-form";

// 全頁層(盤點 A1 / A2):受控開關,新增與編輯共用同一個元件,只差 item 是不是 null。
function ServiceItemFormDialog({
  merchantId,
  item,
  categories,
  open,
  onOpenChange,
  onSaved,
}: {
  merchantId: string;
  item: ServiceItem | null;
  categories: ServiceCategory[];
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
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(isEdit ? "更新失敗" : "新增失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <FullPageLayer open={open} onOpenChange={onOpenChange}>
      <FullPageLayerContent
        title={isEdit ? "編輯服務項目" : "新增服務項目"}
        subtitle="名稱、金額、類型、工時皆為必填。"
        footer={
          // skill 二之三:底部動作列等寬,階層靠顏色(取消白底 / 儲存實心)。儲存鈕在 <form> 外面,
          // 用 form 屬性指回表單,Enter 鍵與按鈕送出走同一個 handleSubmit。
          <ActionBar>
            <FullPageLayerClose asChild>
              <Button type="button" variant="neutral" size="touch">
                取消
              </Button>
            </FullPageLayerClose>
            <Button
              type="submit"
              form={ITEM_FORM_ID}
              variant="primary"
              size="touch"
              disabled={saving}
            >
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </ActionBar>
        }
      >
        <form id={ITEM_FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-5">
          <FormField label="名稱" htmlFor="item-name" required>
            <FieldInput
              id="item-name"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              required
            />
          </FormField>

          <div className="grid gap-5 sm:grid-cols-2">
            <FormField label="金額" htmlFor="item-price" required>
              {/* skill 二之七:金額靠右、左側放 $、tabular-nums。驗證仍在 handleSubmit(不小於 0 的數字)。 */}
              <FieldAmountInput
                id="item-price"
                value={form.price}
                onChange={(e) => setField("price", e.target.value)}
                required
              />
            </FormField>
            <FormField
              label="工時(分鐘)"
              htmlFor="item-duration"
              required
              helpLabel="說明:工時要怎麼填"
              help="可以填 0,表示這個項目不額外佔用行事曆時段。"
            >
              <FieldInput
                id="item-duration"
                type="number"
                inputMode="numeric"
                min={0}
                step="1"
                className="tabular-nums"
                value={form.durationMinutes}
                onChange={(e) => setField("durationMinutes", e.target.value)}
                required
              />
            </FormField>
          </div>

          <FormField label="類型" required>
            {/* skill 二之七:單選用 ChoiceChipGroup(role="radiogroup",方向鍵可切換),視覺跟多選方塊
                一樣但語意是單選。值直接來自常數白名單,不會有 Radix Select 那種幽靈空值事件。 */}
            <ChoiceChipGroup
              aria-label="類型"
              value={form.itemType}
              onValueChange={(type) => setField("itemType", type)}
              options={(Object.keys(SERVICE_ITEM_TYPE_LABELS) as ServiceItemType[]).map((type) => ({
                value: type,
                label: SERVICE_ITEM_TYPE_LABELS[type],
              }))}
            />
          </FormField>

          <FormField label="所屬分類" htmlFor="item-category">
            {/* skill 二之七:下拉用共用的 FieldSelect(44px / 10px 圓角 / 15px 字由元件決定)。 */}
            <FieldSelect
              id="item-category"
              value={form.categoryId ?? "__uncategorized__"}
              /* 2026-09-24 稽核修正(問題 3):編輯既有服務項目時 form.categoryId 是等資料
                 回來才灌進去的,正是會觸發幽靈空值事件的時序——被洗成空字串的話,原本設好的
                 分類會變成「未分類」並在存檔時真的寫成 null,把商家的分類設定清掉。
                 合法值是 "__uncategorized__" 這個 sentinel 加上資料庫來的動態分類 id,
                 沒有固定白名單,判斷條件是「不是空字串」。 */
              onValueChange={guardPhantomEmptyChange((v) =>
                setField("categoryId", v === "__uncategorized__" ? null : v),
              )}
              options={[
                { value: "__uncategorized__", label: UNCATEGORIZED_LABEL },
                ...categories.map((category) => ({ value: category.id, label: category.name })),
              ]}
            />
          </FormField>
        </form>
      </FullPageLayerContent>
    </FullPageLayer>
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

  // 全頁層的受控開關:新增一顆、編輯一顆(編輯時記住是哪一筆)。關閉時只把 open 關掉、不清掉
  // editingItem,避免關閉動畫期間標題閃成「新增服務項目」。
  const [createOpen, setCreateOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ServiceItem | null>(null);
  const [editOpen, setEditOpen] = useState(false);

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

  const createButton = (
    <Button type="button" variant="primary" size="touch" onClick={() => setCreateOpen(true)}>
      新增服務項目
    </Button>
  );

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/manage"
        title="服務項目管理"
        description={`「${merchant!.name}」的服務分類與服務項目`}
        action={createButton}
      />

      {categoriesLoading ? (
        <LoadingSkeleton variant="cards" rows={2} />
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
        <CardHeader>
          <CardTitle>服務項目</CardTitle>
          <CardDescription>包含已上架與已下架的服務項目</CardDescription>
        </CardHeader>
        <CardContent>
          {itemsLoading ? (
            <LoadingSkeleton variant="cards" rows={3} />
          ) : !items || items.length === 0 ? (
            <EmptyState
              title="還沒有任何服務項目"
              description="建立服務項目後,排預約時就能直接挑選,系統會自動帶入金額與工時。"
              action={
                <Button
                  type="button"
                  variant="primary"
                  size="touch"
                  onClick={() => setCreateOpen(true)}
                >
                  新增第一個服務項目
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {items.map((item) => (
                <li key={item.id}>
                  {/* skill 二之五 列表卡片:名稱 + 狀態標籤 + 屬性標籤 → 次要資訊 → 右側主要動作 + ⋯。
                      已下架整張變灰。主要動作隨狀態換字(編輯 / 重新上架)但位置固定;下架收進 ⋯。
                      「下架」是可逆的(有「重新上架」),所以是一般項目、不標紅(2026-09-29 主腦裁決:
                      只有不可逆的真正刪除才是危險項)。 */}
                  <ListCard
                    title={item.name}
                    state={item.status === "active" ? "default" : "inactive"}
                    tags={
                      <>
                        {item.status === "active" ? (
                          <StatusTag tone="success">上架中</StatusTag>
                        ) : (
                          <StatusTag tone="neutral">已下架</StatusTag>
                        )}
                        <AttributeTag>
                          {SERVICE_ITEM_TYPE_LABELS[item.item_type as ServiceItemType]}
                        </AttributeTag>
                      </>
                    }
                    meta={
                      <>
                        ${Number(item.price).toFixed(0)} ・ {item.duration_minutes} 分鐘 ・{" "}
                        {categoryName(item.category_id)}
                      </>
                    }
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

      <ServiceItemFormDialog
        merchantId={merchantId}
        item={null}
        categories={categories ?? []}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={refetchItems}
      />
      <ServiceItemFormDialog
        merchantId={merchantId}
        item={editingItem}
        categories={categories ?? []}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={refetchItems}
      />
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
