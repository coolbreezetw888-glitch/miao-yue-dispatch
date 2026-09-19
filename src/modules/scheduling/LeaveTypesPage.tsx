// 對應模組 7(排班與休假管理)規格書 §4.2:假別設定頁(新路由 /app/leave-types)。
// 完全比照 PaymentMethodsPage.tsx/MaterialCostsPage.tsx 的既有寫法:清單(名稱/說明/狀態)+
// 新增/編輯 Dialog 表單(名稱必填、說明選填)+ 下架/重新上架按鈕。

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

function LeaveTypeFormDialog({
  merchantId,
  leaveType,
  trigger,
  onSaved,
}: {
  merchantId: string;
  leaveType: MerchantLeaveType | null;
  trigger: React.ReactNode;
  onSaved: () => void;
}) {
  const isEdit = Boolean(leaveType);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<LeaveTypeFormState>(
    leaveType ? leaveTypeToFormState(leaveType) : EMPTY_FORM,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(leaveType ? leaveTypeToFormState(leaveType) : EMPTY_FORM);
    }
  }, [open, leaveType]);

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
          <DialogTitle>{isEdit ? "編輯假別" : "新增假別"}</DialogTitle>
          <DialogDescription>
            商家自己命名的請假分類,登記請假時可選用。想叫什麼名字、新增幾筆都可以。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="leave-type-name">名稱 *</Label>
            <Input
              id="leave-type-name"
              className="mt-2"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              required
            />
          </div>

          <div>
            <Label htmlFor="leave-type-description">說明文字</Label>
            <Textarea
              id="leave-type-description"
              className="mt-2"
              rows={3}
              placeholder="例如:這個假別適用的情境說明"
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

  const { data: leaveTypes, isLoading } = useQuery({
    queryKey: leaveTypesQueryKey(merchantId),
    queryFn: () => fetchMerchantLeaveTypesAll(merchantId),
  });

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

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">假別設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」自訂的請假分類清單,登記月薪制服務人員請假時可選用。
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>假別</CardTitle>
            <CardDescription>包含已上架與已下架的項目</CardDescription>
          </div>
          <LeaveTypeFormDialog
            merchantId={merchantId}
            leaveType={null}
            trigger={<Button variant="cta">新增假別</Button>}
            onSaved={refetchLeaveTypes}
          />
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : !leaveTypes || leaveTypes.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前還沒有任何假別,點右上角新增一項。</p>
          ) : (
            <ul className="space-y-2">
              {leaveTypes.map((leaveType) => (
                <li
                  key={leaveType.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{leaveType.name}</p>
                    {leaveType.description ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {leaveType.description}
                      </p>
                    ) : null}
                    <div className="mt-1">
                      <Badge variant={leaveType.status === "active" ? "default" : "secondary"}>
                        {leaveType.status === "active" ? "上架中" : "已下架"}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {showDeductionRuleButton ? (
                      <LeaveDeductionRuleDialog
                        merchantId={merchantId}
                        leaveTypeId={leaveType.id}
                        leaveTypeName={leaveType.name}
                        trigger={
                          <Button variant="outline" size="sm">
                            扣款規則
                          </Button>
                        }
                      />
                    ) : null}
                    {leaveType.status === "active" ? (
                      <>
                        <LeaveTypeFormDialog
                          merchantId={merchantId}
                          leaveType={leaveType}
                          trigger={
                            <Button variant="outline" size="sm">
                              編輯
                            </Button>
                          }
                          onSaved={refetchLeaveTypes}
                        />
                        <Button variant="outline" size="sm" onClick={() => handleRemove(leaveType.id)}>
                          下架
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleReactivate(leaveType.id)}
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

export default function LeaveTypesPage() {
  return (
    <RequireTeamLeaveAccess>
      <LeaveTypesPageInner />
    </RequireTeamLeaveAccess>
  );
}
