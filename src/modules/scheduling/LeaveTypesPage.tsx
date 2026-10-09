// 對應模組 7(排班與休假管理)規格書 §4.2:假別設定頁(新路由 /app/leave-types)。
// 完全比照 PaymentMethodsPage.tsx/MaterialCostsPage.tsx 的既有寫法:清單(名稱/說明/狀態)+
// 新增/編輯表單(名稱必填、說明選填)+ 下架/重新上架。
//
// ui-v1-full 第二階段第 2 批(2026-09-29,盤點 #13 / #14 / #15):
//   - 新增 / 編輯假別(2 欄)→ 小卡窗殼(CardDialog),受控開關;欄位改 FormField / FieldInput /
//     FieldTextarea。
//   - 假別列改 ListCard:主要動作永遠是「編輯」(已下架換「重新上架」),「扣款規則」(依 commission_settings
//     權限顯示)與「下架」收進 ⋯;下架可逆 ⇒ 不標紅。扣款規則小卡窗(LeaveDeductionRuleDialog)因此改成
//     受控開關,由這一頁記住「現在在設定哪一個假別」。
//   - 頁首改 PageHeader、載入中改骨架、空狀態補下一步按鈕。
// **只動外觀與版面,不動任何行為**:權限判斷、驗證、送出、下架 / 重新上架照舊。

import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
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
  ErrorState,
  FieldInput,
  FieldTextarea,
  FormField,
  ListCard,
  type ListCardMenuItem,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
  useFormDirty,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";
import { LeaveDeductionRuleDialog } from "@/modules/payroll/LeaveDeductionRuleDialog";

import {
  addLeaveType,
  fetchMerchantLeaveTypesAll,
  reactivateLeaveType,
  removeLeaveType,
  updateLeaveType,
  type UpsertLeaveTypeInput,
} from "./api";
import { RequireTeamLeaveAccess } from "./RequireTeamLeaveAccess";
import type { MerchantLeaveType } from "./types";

const leaveTypesQueryKey = (merchantId: string) =>
  ["scheduling-module", "leave-types-admin", merchantId] as const;

// =========================================================================
// 新增/編輯表單
// =========================================================================
interface LeaveTypeFormState {
  name: string;
  description: string;
}

const EMPTY_FORM: LeaveTypeFormState = { name: "", description: "" };

function leaveTypeToFormState(leaveType: MerchantLeaveType): LeaveTypeFormState {
  return { name: leaveType.name, description: leaveType.description ?? "" };
}

const LEAVE_TYPE_FORM_ID = "leave-type-form";

// 小卡窗(盤點 #13 / #14):受控開關,新增與編輯共用同一個元件,只差 leaveType 是不是 null。
function LeaveTypeFormDialog({
  merchantId,
  leaveType,
  open,
  onOpenChange,
  onSaved,
}: {
  merchantId: string;
  leaveType: MerchantLeaveType | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const isEdit = Boolean(leaveType);
  const [form, setForm] = useState<LeaveTypeFormState>(
    leaveType ? leaveTypeToFormState(leaveType) : EMPTY_FORM,
  );
  const [saving, setSaving] = useState(false);
  // 第 11 批 J(#995):填過資料(跟打開時不同)⇒ Esc / 上方空白先問放棄。
  const formDirty = useFormDirty(form);
  const markFormClean = formDirty.markClean;

  useEffect(() => {
    if (open) {
      const initial = leaveType ? leaveTypeToFormState(leaveType) : EMPTY_FORM;
      setForm(initial);
      markFormClean(initial);
    }
  }, [open, leaveType, markFormClean]);

  function setField<K extends keyof LeaveTypeFormState>(key: K, value: LeaveTypeFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("請填寫假別名稱");
      return;
    }

    const input: UpsertLeaveTypeInput = {
      name: form.name,
      description: form.description.trim() ? form.description : null,
    };

    setSaving(true);
    try {
      if (isEdit && leaveType) {
        await updateLeaveType(leaveType.id, input);
        toast.success("假別已更新");
      } else {
        await addLeaveType(merchantId, input);
        toast.success("已新增假別");
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
      <CardDialogContent dirty={formDirty.dirty}>
        <CardDialogHeader>
          <CardDialogTitle>{isEdit ? "編輯假別" : "新增假別"}</CardDialogTitle>
          <CardDialogDescription>
            商家自己命名的請假分類，登記請假時可選用。想叫什麼名字、新增幾筆都可以。
          </CardDialogDescription>
        </CardDialogHeader>

        <form id={LEAVE_TYPE_FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FormField label="名稱" htmlFor="leave-type-name" required>
            <FieldInput
              id="leave-type-name"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              required
            />
          </FormField>

          <FormField label="說明文字" htmlFor="leave-type-description">
            <FieldTextarea
              id="leave-type-description"
              rows={3}
              placeholder="例如：這個假別適用的情境說明"
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
            form={LEAVE_TYPE_FORM_ID}
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
function LeaveTypesPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  // 模組 8(薪資與帳務)§4.2:「扣款規則」按鈕依 commission_settings 權限顯示,跟這個頁面本身
  // 依 team_leave 權限顯示的守衛(RequireTeamLeaveAccess)是兩把獨立的鑰匙——能進到這個頁面
  // 管理假別,不代表一定能設定假別的扣款規則。
  const { data: merchantRole } = useCurrentMerchantRole();
  const { data: canManageCommissionSettings } = useAgentPermission("commission_settings");
  const showDeductionRuleButton = merchantRole === "admin" || canManageCommissionSettings === true;

  const {
    data: leaveTypes,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: leaveTypesQueryKey(merchantId),
    queryFn: () => fetchMerchantLeaveTypesAll(merchantId),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editingLeaveType, setEditingLeaveType] = useState<MerchantLeaveType | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  // 扣款規則小卡窗(盤點 #15):記住目前在設定哪一個假別;關閉時只關 open、不清掉 target,避免關閉
  // 動畫期間標題閃成空字串。
  const [deductionRuleTarget, setDeductionRuleTarget] = useState<MerchantLeaveType | null>(null);
  const [deductionRuleOpen, setDeductionRuleOpen] = useState(false);

  function refetchLeaveTypes() {
    return queryClient.invalidateQueries({ queryKey: leaveTypesQueryKey(merchantId) });
  }

  async function handleRemove(id: string) {
    try {
      await removeLeaveType(id);
      await refetchLeaveTypes();
      toast.success("已下架這個假別");
    } catch (err) {
      toast.error("下架失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleReactivate(id: string) {
    try {
      await reactivateLeaveType(id);
      await refetchLeaveTypes();
      toast.success("已重新上架這個假別");
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    }
  }

  function menuItemsFor(leaveType: MerchantLeaveType): ListCardMenuItem[] | undefined {
    const items: ListCardMenuItem[] = [];
    if (showDeductionRuleButton) {
      items.push({
        label: "扣款規則",
        onSelect: () => {
          setDeductionRuleTarget(leaveType);
          setDeductionRuleOpen(true);
        },
      });
    }
    if (leaveType.status === "active") {
      // 「下架」可逆(有「重新上架」)⇒ 一般項目,不標紅(2026-09-29 主腦裁決)。
      items.push({ label: "下架", onSelect: () => void handleRemove(leaveType.id) });
    }
    return items.length > 0 ? items : undefined;
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      {/* 2026-09-24 使用者指定:標題加上「月薪人員」前綴,讓商家一眼看出這份假別清單只跟月薪制
          服務人員有關(抽成制服務人員不走請假登記,走的是自己的可預約時段設定)。
          2026-09-24 主腦裁決:三處(這裡的頁面標題 <h1> / src/routes/appLayoutLogic.ts 的
          /app/leave-types 頁首標題 / src/routes/ManagePage.tsx 的功能卡片 label)已統一成
          「月薪人員假別設定」。
          ⚠️ 之後改任一處,另外兩處要同步改——appLayoutLogic.ts 的規則是「頁首標題一律取各頁面
             <h1> 現在顯示的文字」(PageHeader 的 title 就是渲染成 <h1>),只改這裡不改那邊,
             頁首跟內文就會對不起來。 */}
      <PageHeader
        backTo="/app/manage"
        helpMode
        title="月薪人員假別設定"
        description={
          <>
            {`「${merchant!.name}」自訂的請假分類清單，登記月薪制、日薪制、時薪制服務人員請假時可選用；假別的扣款規則也在這一頁設定(扣款只套用在月薪制)。` +
              "這一頁只負責「有哪些假別可以選」，實際的請假登記不在這裡。如果要幫某位服務人員登記或取消請假，" +
              "請到「請假紀錄」那一頁操作；只有商家管理員，或有「月薪人員假別設定」權限的客服可以登記，服務人員本人沒有辦法自己登記。"}
            {/* 頁內導向照 MemberDetailPage.tsx「查看完整點數紀錄 →」那條既有慣例
                (react-router <Link> + text-brand hover:underline + 箭頭結尾),不另創寫法。 */}
            <Link to="/app/leave-records" className="mt-1.5 block text-brand hover:underline">
              前往「請假紀錄」登記請假 →
            </Link>
          </>
        }
        action={
          <Button type="button" variant="primary" size="touch" onClick={() => setCreateOpen(true)}>
            新增假別
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>假別</CardTitle>
          <CardDescription>包含已上架與已下架的項目</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingSkeleton variant="cards" rows={3} />
          ) : isError ? (
            // 🔴 2026-09-30 QA:原本查詢失敗會偽裝成「還沒有任何假別」,商家會以為假別被刪掉了。
            <ErrorState
              title="讀不到假別清單"
              reason="可能是網路斷了，或你沒有管理假別的權限"
              onRetry={() => void refetch()}
            />
          ) : !leaveTypes || leaveTypes.length === 0 ? (
            // 下一步(頁首的「新增假別」)就在同一個畫面上 ⇒ 不放第二顆主要按鈕,改用一句話指路。
            <EmptyState
              title="還沒有任何假別"
              description="建立假別後，在「請假紀錄」幫服務人員登記請假時就能選用。請用右上角的「新增假別」建立第一個。"
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {leaveTypes.map((leaveType) => (
                <li key={leaveType.id}>
                  {/* skill 二之五:名稱 + 狀態標籤 → 說明文字 → 右側「編輯」+ ⋯(扣款規則 / 下架)。
                      「編輯」永遠是主要動作;已下架那一筆才換成「重新上架」。 */}
                  <ListCard
                    title={leaveType.name}
                    state={leaveType.status === "active" ? "default" : "inactive"}
                    tags={
                      leaveType.status === "active" ? (
                        <StatusTag tone="success">上架中</StatusTag>
                      ) : (
                        <StatusTag tone="neutral">已下架</StatusTag>
                      )
                    }
                    meta={leaveType.description ? leaveType.description : undefined}
                    primaryAction={
                      leaveType.status === "active" ? (
                        <Button
                          type="button"
                          variant="neutral"
                          size="card"
                          onClick={() => {
                            setEditingLeaveType(leaveType);
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
                          onClick={() => handleReactivate(leaveType.id)}
                        >
                          重新上架
                        </Button>
                      )
                    }
                    menuItems={menuItemsFor(leaveType)}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <LeaveTypeFormDialog
        merchantId={merchantId}
        leaveType={null}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={refetchLeaveTypes}
      />
      <LeaveTypeFormDialog
        merchantId={merchantId}
        leaveType={editingLeaveType}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={refetchLeaveTypes}
      />
      {deductionRuleTarget ? (
        <LeaveDeductionRuleDialog
          merchantId={merchantId}
          leaveTypeId={deductionRuleTarget.id}
          leaveTypeName={deductionRuleTarget.name}
          open={deductionRuleOpen}
          onOpenChange={setDeductionRuleOpen}
        />
      ) : null}
    </main>
  );
}

export default function LeaveTypesPage() {
  return (
    <RequireTeamLeaveAccess>
      <LeaveTypesPageInner />
    </RequireTeamLeaveAccess>
  );
}
