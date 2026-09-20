// 模組 12 §4.4:產業轉移精靈(新路由 /app/industry-transfer，僅商家管理員可見)。
// 建立新商家(選新產業) → 選擇要搬遷的會員 → 確認搬遷 → 結果 + 後續提醒。
// 步驟一直接沿用模組 1 既有的 MerchantIntakeForm + createMerchantInGroup，不重複做一個建店表單。

import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant, useRefetchAccessibleMerchants } from "@/modules/merchant/context";
import { createMerchantInGroup } from "@/modules/merchant/api";
import {
  MerchantIntakeForm,
  type MerchantIntakeFormValues,
} from "@/modules/merchant/MerchantIntakeForm";
import { useMerchantMembersList } from "@/modules/members/api";

import { transferMembersToMerchant } from "./api";
import { RequireDataImportAccess } from "./RequireDataImportAccess";

type Step = "new-merchant" | "select-members" | "confirm" | "result";

function IndustryTransferWizardPageInner() {
  const { merchant } = useCurrentMerchant();
  const sourceMerchantId = merchant!.id;
  const refetchAccessibleMerchants = useRefetchAccessibleMerchants();

  const [step, setStep] = useState<Step>("new-merchant");
  const [newMerchantId, setNewMerchantId] = useState<string | null>(null);
  const [newMerchantName, setNewMerchantName] = useState<string>("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [resultCount, setResultCount] = useState<number | null>(null);

  const { data: members, isLoading: membersLoading } = useMerchantMembersList(
    step === "select-members" ? sourceMerchantId : null,
    "",
  );
  const activeMembers = (members ?? []).filter((m) => m.status === "active");

  async function handleCreateMerchant(values: MerchantIntakeFormValues) {
    const id = await createMerchantInGroup({
      groupId: merchant!.group_id,
      name: values.name,
      industryType: values.industryType,
      address: values.address,
      contactEmail: values.contactEmail,
      intro: values.intro,
    });
    setNewMerchantId(id);
    setNewMerchantName(values.name);
    await refetchAccessibleMerchants();
    toast.success("新商家建立成功！接下來選擇要搬遷的會員");
    setStep("select-members");
  }

  function toggleMember(id: string) {
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedMemberIds.size === activeMembers.length) {
      setSelectedMemberIds(new Set());
    } else {
      setSelectedMemberIds(new Set(activeMembers.map((m) => m.id)));
    }
  }

  async function handleConfirmTransfer() {
    if (!newMerchantId) return;
    setSubmitting(true);
    try {
      await transferMembersToMerchant(
        sourceMerchantId,
        newMerchantId,
        Array.from(selectedMemberIds),
      );
      setResultCount(selectedMemberIds.size);
      setStep("result");
      toast.success("會員搬遷完成");
    } catch (err) {
      toast.error("搬遷失敗", { description: getErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-5 py-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">產業轉移</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          建立一間新商家(選新產業)，並選擇性把會員資料/紅利點數歷史搬過去。這不是修改現有商家的
          產業設定——現有商家的產業一旦選定就不能改。
        </p>
      </div>

      {step === "new-merchant" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟一:建立新商家</CardTitle>
            <CardDescription>直接沿用既有的新增分店流程，選擇新的產業模組。</CardDescription>
          </CardHeader>
          <CardContent>
            <MerchantIntakeForm
              submitLabel="建立新商家並繼續"
              submittingLabel="建立中⋯"
              onSubmit={handleCreateMerchant}
            />
          </CardContent>
        </Card>
      )}

      {step === "select-members" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟二:選擇要搬遷的會員</CardTitle>
            <CardDescription>
              列出來源商家目前上架中的會員，勾選要搬到「{newMerchantName}」的會員(支援全選)。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {membersLoading && <p className="text-sm text-muted-foreground">載入中⋯</p>}
            {!membersLoading && activeMembers.length === 0 && (
              <p className="text-sm text-muted-foreground">
                這間商家目前沒有上架中的會員可以搬遷。
              </p>
            )}
            {activeMembers.length > 0 && (
              <>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={selectedMemberIds.size === activeMembers.length}
                    onCheckedChange={toggleSelectAll}
                  />
                  全選({activeMembers.length} 位)
                </label>
                <div className="max-h-96 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {activeMembers.map((m) => (
                    <label
                      key={m.id}
                      className="flex items-center gap-3 rounded-md p-2 hover:bg-muted"
                    >
                      <Checkbox
                        checked={selectedMemberIds.has(m.id)}
                        onCheckedChange={() => toggleMember(m.id)}
                      />
                      <span className="flex-1 text-sm">{m.name}</span>
                      <span className="text-xs text-muted-foreground">{m.phone ?? "(無電話)"}</span>
                      <span className="text-xs text-muted-foreground">{m.pointsBalance} 點</span>
                    </label>
                  ))}
                </div>
              </>
            )}
            <div className="flex justify-end pt-2">
              <Button disabled={selectedMemberIds.size === 0} onClick={() => setStep("confirm")}>
                下一步(已選 {selectedMemberIds.size} 位)
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "confirm" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟三:確認搬遷</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-foreground">
              即將把 {selectedMemberIds.size} 位會員(含紅利點數)搬到「{newMerchantName}
              」。這些會員在
              舊商家的歷史訂單仍然查得到，但不再顯示為可點擊的會員連結(避免新商家看到舊商家的訂單
              明細)。
            </p>
            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => setStep("select-members")}>
                上一步
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button disabled={submitting}>{submitting ? "搬遷中⋯" : "確認搬遷"}</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      確定要搬遷這 {selectedMemberIds.size} 位會員嗎?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      這些會員的資料跟紅利點數會搬到新商家，搬遷後這些會員在舊商家的歷史訂單仍然查
                      得到，但不再顯示為可點擊的會員連結。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void handleConfirmTransfer()}>
                      確認搬遷
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "result" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟四:結果 + 後續提醒</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-foreground">
              已成功把 {resultCount} 位會員(含紅利點數)搬到「{newMerchantName}」。
            </p>
            <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
              服務人員、服務項目、收費設定這次不會自動搬遷，如果新商家需要參考舊資料，請到「報表
              匯出中心」或各自模組的頁面自行匯出留存，再到新商家手動重新設定。
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" asChild>
                <Link to="/app/reports">前往報表匯出中心</Link>
              </Button>
              <Button asChild>
                <Link to="/app">回到首頁</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function IndustryTransferWizardPage() {
  return (
    <RequireDataImportAccess>
      <IndustryTransferWizardPageInner />
    </RequireDataImportAccess>
  );
}
