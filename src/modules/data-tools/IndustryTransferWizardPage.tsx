// 模組 12 §4.4:產業轉移精靈(新路由 /app/industry-transfer，僅商家管理員可見)。
// 建立新商家(選新產業) → 選擇要搬遷的會員 → 確認搬遷 → 結果 + 後續提醒。
// 步驟一直接沿用模組 1 既有的 MerchantIntakeForm + createMerchantInGroup，不重複做一個建店表單。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader(`‹ 返回功能` 一行小字仍然保留,跟精靈每個步驟裡的「上一步」是兩件事)。
//   - 會員勾選從打勾方框改成整條寬的可點方塊 ChoiceChip(二之七:手機好按),每條至少 44px;
//     「全選」也一樣。載入中改灰色骨架、沒有可搬遷會員改 EmptyState(二之八)。
//   - 每個步驟只有一顆 ① 主要按鈕(下一步 / 確認搬遷 / 回到首頁),「上一步」是 ② 次要(二之三)。
//   - 搬遷確認窗改小卡窗殼 CardAlertDialog;🔴 **不標紅**:搬遷不刪任何資料(舊商家的歷史訂單
//     仍然查得到),紅色只留給真正刪除(第 1 / 2 批已定案的裁決)。「搬過去之後舊商家就看不到
//     可點擊的會員連結」屬於「按下去會發生什麼不可逆的事」⇒ 用 🟡 常駐 `!`。
//   - 步驟四的「這次不會自動搬遷什麼」也改成常駐 `!`:那正是「現在的狀態跟使用者以為的不一樣」
//     (老闆會以為整間店都搬過去了)。
//   - 點數加 tabular-nums(二之六第 5 點)。
//
// **只動外觀,不動行為**:四個步驟的流程、建店與搬遷的 API 呼叫、全選邏輯、toast 文案照舊。

import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import {
  AlertNote,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  CardAlertDialogTrigger,
  ChoiceChip,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PageHeader,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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

  // 🔴 2026-09-30(品管第二次打回,🟡 第 3 項):原本只取 isLoading,查詢失敗時 members 是
  // undefined ⇒ 畫成「這間商家目前沒有上架中的會員可以搬遷」,商家以為來源商家是空的、
  // 於是直接跳過這一步(搬遷精靈裡跳過等於資料沒搬過去)。isError 分支排在空狀態之前。
  const {
    data: members,
    isLoading: membersLoading,
    isError: membersError,
    refetch: refetchSourceMembers,
  } = useMerchantMembersList(step === "select-members" ? sourceMerchantId : null, "");
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
      {/* SPECS-INDEX #600(§10.1):規格書明講這次調整項目雖然沒有明確指名這個頁面，但為了
          三個「資料工具」模組底下的精靈頁面一致，一併補上同樣的「← 返回功能」,跟精靈本身
          每個步驟裡的「上一步」按鈕是兩件不同的事，位置分開避免混淆。 */}
      <PageHeader
        backTo="/app/manage"
        title="產業轉移"
        description="建立一間新商家(選新產業)，並選擇性把會員資料/紅利點數歷史搬過去。這不是修改現有商家的產業設定——現有商家的產業一旦選定就不能改。"
      />

      {step === "new-merchant" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟一：建立新商家</CardTitle>
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
            <CardTitle>步驟二：選擇要搬遷的會員</CardTitle>
            <CardDescription>
              列出來源商家目前上架中的會員，勾選要搬到「{newMerchantName}」的會員(支援全選)。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {membersLoading ? <LoadingSkeleton variant="cards" rows={3} /> : null}
            {!membersLoading && membersError ? (
              <ErrorState
                title="讀不到來源商家的會員名單"
                reason="可能是網路斷了；現在先不顯示名單，避免你把空白當成「這間商家沒有會員」而直接跳過這一步"
                onRetry={() => void refetchSourceMembers()}
              />
            ) : null}
            {!membersLoading && !membersError && activeMembers.length === 0 ? (
              <EmptyState
                title="這間商家目前沒有上架中的會員可以搬遷"
                description="只有「上架中」的會員可以搬到新商家。要先在會員管理把會員上架，或是先用資料匯入把客戶匯進來。"
                action={
                  <Button asChild variant="primary" size="touch">
                    <Link to="/app/members">去看會員管理</Link>
                  </Button>
                }
              />
            ) : null}
            {activeMembers.length > 0 ? (
              <>
                {/* 可點的方塊(skill 二之七),不用打勾方框。全選也用同一種外觀,一眼看得出是同一組操作。 */}
                <ChoiceChip
                  className="min-h-11 w-full justify-start text-left"
                  selected={selectedMemberIds.size === activeMembers.length}
                  onClick={toggleSelectAll}
                >
                  <span className="font-semibold">全選({activeMembers.length} 位)</span>
                </ChoiceChip>
                <ul className="flex max-h-96 flex-col gap-1.5 overflow-y-auto">
                  {activeMembers.map((m) => (
                    <li key={m.id}>
                      <ChoiceChip
                        className="min-h-11 w-full justify-start text-left"
                        selected={selectedMemberIds.has(m.id)}
                        onClick={() => toggleMember(m.id)}
                      >
                        <span className="min-w-0 flex-1 break-words">{m.name}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {m.phone ?? "(無電話)"}
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {m.pointsBalance} 點
                        </span>
                      </ChoiceChip>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <div className="flex justify-end pt-1">
              {/* 這個步驟唯一的 ① 主要按鈕(skill 二之三)。 */}
              <Button
                type="button"
                variant="primary"
                size="touch"
                disabled={selectedMemberIds.size === 0}
                onClick={() => setStep("confirm")}
              >
                下一步(已選 {selectedMemberIds.size} 位)
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "confirm" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟三：確認搬遷</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed tabular-nums text-foreground">
              即將把 {selectedMemberIds.size} 位會員(含紅利點數)搬到「{newMerchantName}」。
            </p>
            {/* 🟡 常駐 `!`:按下去會發生什麼不可逆的事(skill 二,第二類)。 */}
            <AlertNote>
              這些會員在舊商家的歷史訂單仍然查得到，但
              <strong>不再顯示為可點擊的會員連結</strong>
              (避免新商家看到舊商家的訂單明細)。
            </AlertNote>
            <div className="flex justify-between gap-2 pt-1">
              <Button
                type="button"
                variant="neutral"
                size="touch"
                onClick={() => setStep("select-members")}
              >
                上一步
              </Button>
              <CardAlertDialog>
                <CardAlertDialogTrigger asChild>
                  {/* 這個步驟唯一的 ① 主要按鈕。🔴 不標紅:搬遷不刪任何資料。 */}
                  <Button type="button" variant="primary" size="touch" disabled={submitting}>
                    {submitting ? "搬遷中⋯" : "確認搬遷"}
                  </Button>
                </CardAlertDialogTrigger>
                <CardAlertDialogContent>
                  <CardAlertDialogHeader>
                    <CardAlertDialogTitle>
                      確定要搬遷這 {selectedMemberIds.size} 位會員嗎？
                    </CardAlertDialogTitle>
                    <CardAlertDialogDescription>
                      這些會員的資料跟紅利點數會搬到新商家。
                    </CardAlertDialogDescription>
                  </CardAlertDialogHeader>
                  <AlertNote>
                    搬遷後這些會員在舊商家的歷史訂單仍然查得到，但不再顯示為可點擊的會員連結。
                  </AlertNote>
                  <CardAlertDialogFooter>
                    <CardAlertDialogCancel>取消</CardAlertDialogCancel>
                    <CardAlertDialogAction onClick={() => void handleConfirmTransfer()}>
                      確認搬遷
                    </CardAlertDialogAction>
                  </CardAlertDialogFooter>
                </CardAlertDialogContent>
              </CardAlertDialog>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "result" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟四：結果 + 後續提醒</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed tabular-nums text-foreground">
              已成功把 {resultCount} 位會員(含紅利點數)搬到「{newMerchantName}」。
            </p>
            {/* 🟡 常駐 `!`:現在的狀態跟使用者以為的不一樣(老闆會以為整間店都搬過去了)。 */}
            <AlertNote>
              <strong>服務人員、服務項目、收費設定這次不會自動搬遷。</strong>
              如果新商家需要參考舊資料，請到「報表匯出中心」或各自模組的頁面自行匯出留存，再到新商家
              手動重新設定。
            </AlertNote>
            <div className="flex justify-end gap-2 pt-1">
              <Button asChild variant="neutral" size="touch">
                <Link to="/app/reports">前往報表匯出中心</Link>
              </Button>
              {/* 這個步驟唯一的 ① 主要按鈕。 */}
              <Button asChild variant="primary" size="touch">
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
