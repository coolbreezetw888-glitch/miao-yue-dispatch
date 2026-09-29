// 模組 12 §4.2:匯入紀錄頁(新路由 /app/data-import/history，僅商家管理員可見)。
// 清單顯示批次歷史(類型/時間/成功/失敗/略過筆數/狀態)，可以展開看 error_report 明細，
// 尚未復原的批次顯示「復原」按鈕(規則 2.8)。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader,「回到資料匯入」從一顆按鈕改成骨架自帶的 `‹ 返回` 一行小字
//     (二之八:返回是一行小字,不是按鈕)。
//   - 每一個批次改 ListCard(二之五:一張卡一筆資料,右側只放「一顆主要動作 + 一個 ⋯」),
//     筆數與失敗明細放在卡片內;狀態改 StatusTag(二之四)。
//   - 載入中改灰色骨架、沒有紀錄改 EmptyState(二之八)。
//   - 🔴「成功」原本寫死 text-emerald-600(硬編色碼),改用語意色 token text-success-strong;
//     skill 一明講「不要在元件裡寫死品牌色」,而且寫死的顏色在深色模式下對比會不夠。
//   - 復原確認窗改小卡窗殼 CardAlertDialog(三、兩種窗)。
//     🔴 這是全批唯一標紅的動作:復原會把這個批次匯進來的資料真的刪掉,而且**復原本身不能再
//        復原**(不可逆)—— 這正是 skill 二之三 ③ 危險 的定義。第 1 / 2 批「可逆動作不標紅」
//        的裁決講的是下架 / 移除 / 停用 / 解除綁定那一類**有路可以回頭**的動作,不適用在這裡。
//        樣式仍是白底紅字淡紅框,不做實心紅(實心紅會讓最危險的變成視覺上最好按的那一顆)。
//   - 筆數全部加 tabular-nums(二之六第 5 點)。
//
// **只動外觀,不動行為**:復原的 API 呼叫與結果顯示、失敗明細的解析(parseErrorReport)、
// 哪些批次才顯示復原按鈕、toast 文案全部照舊。

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { History } from "lucide-react";

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
  EmptyState,
  ErrorState,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";

import { parseErrorReport, rollbackBulkOperation, useMerchantBulkOperations } from "./api";
import { RequireDataImportAccess } from "./RequireDataImportAccess";
import { BULK_OPERATION_TYPE_LABELS, type BulkOperationType, type RollbackResult } from "./types";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", { hour12: false });
}

function ImportHistoryPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();
  // 🔴 2026-09-30(品管第二次打回,🟡 第 3 項):原本只取 isLoading,查詢失敗時 operations 是
  // undefined ⇒ 畫成「還沒有任何批次操作紀錄」。這頁特別危險:商家來這頁通常就是為了**復原一批
  // 匯錯的資料**,看到「沒有紀錄」會以為那批匯入沒成功、於是再匯一次(重複匯入)。
  // isError 分支排在空狀態之前。
  const {
    data: operations,
    isLoading,
    isError,
    refetch: refetchOperations,
  } = useMerchantBulkOperations(merchantId);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rollbackResults, setRollbackResults] = useState<Record<string, RollbackResult>>({});
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);

  async function handleRollback(operationId: string) {
    setRollingBackId(operationId);
    try {
      const result = await rollbackBulkOperation(operationId);
      setRollbackResults((prev) => ({ ...prev, [operationId]: result }));
      await queryClient.invalidateQueries({
        queryKey: ["data-tools-module", "bulk-operations", merchantId],
      });
      toast.success(`復原完成:成功復原 ${result.restoredCount} 筆，跳過 ${result.skippedCount} 筆`);
    } catch (err) {
      toast.error("復原失敗", { description: getErrorMessage(err) });
    } finally {
      setRollingBackId(null);
    }
  }

  const operationList = operations ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-5 py-10">
      <PageHeader
        backTo="/app/data-import"
        backLabel="回到資料匯入"
        title="匯入紀錄"
        description="查看過去的批次匯入/搬遷操作，尚未復原的批次可以按「復原」還原。"
      />

      {isLoading ? <LoadingSkeleton variant="cards" rows={3} /> : null}

      {!isLoading && isError ? (
        <ErrorState
          title="讀不到匯入紀錄"
          reason="可能是網路斷了;現在先不顯示紀錄,避免你把空白當成「那批匯入沒成功」而重複匯一次"
          onRetry={() => void refetchOperations()}
        />
      ) : null}

      {!isLoading && !isError && operationList.length === 0 ? (
        <EmptyState
          icon={<History className="h-6 w-6" aria-hidden="true" />}
          title="還沒有任何批次操作紀錄"
          description="用 CSV 匯入客戶、服務項目或服務人員之後,每一個批次都會記在這裡,發現匯錯了可以整批復原。"
          action={
            <Button asChild variant="primary" size="touch">
              <Link to="/app/data-import">去匯入資料</Link>
            </Button>
          }
        />
      ) : null}

      <div className="flex flex-col gap-2.5">
        {operationList.map((op) => {
          const errors = parseErrorReport(op.error_report);
          const expanded = expandedId === op.id;
          const rollbackResult = rollbackResults[op.id];
          const rolledBack = op.status === "rolled_back";
          return (
            <ListCard
              key={op.id}
              state={rolledBack ? "inactive" : "default"}
              title={
                BULK_OPERATION_TYPE_LABELS[op.operation_type as BulkOperationType] ??
                op.operation_type
              }
              tags={
                <StatusTag tone={rolledBack ? "neutral" : "success"}>
                  {rolledBack ? "已復原" : "已完成"}
                </StatusTag>
              }
              meta={formatDateTime(op.created_at)}
              primaryAction={
                rolledBack ? undefined : (
                  <CardAlertDialog>
                    <CardAlertDialogTrigger asChild>
                      {/* 🔴 ③ 危險(白底紅字淡紅框):復原會真的刪掉這批匯進來的資料,而且不能再復原。 */}
                      <Button
                        type="button"
                        variant="danger"
                        size="card"
                        disabled={rollingBackId === op.id}
                      >
                        {rollingBackId === op.id ? "復原中⋯" : "復原"}
                      </Button>
                    </CardAlertDialogTrigger>
                    <CardAlertDialogContent>
                      <CardAlertDialogHeader>
                        <CardAlertDialogTitle>確定要復原這個批次嗎?</CardAlertDialogTitle>
                        <CardAlertDialogDescription>
                          只會復原這個批次自己動過、且之後沒有被其他操作異動過的資料，詳細結果會列出來。
                        </CardAlertDialogDescription>
                      </CardAlertDialogHeader>
                      {/* 🟡 常駐 `!`:按下去會發生什麼不可逆的事(skill 二,第二類)。 */}
                      <AlertNote>
                        這批匯進來的資料會被移除,<strong>復原之後沒辦法再復原回來</strong>。
                      </AlertNote>
                      <CardAlertDialogFooter>
                        <CardAlertDialogCancel>取消</CardAlertDialogCancel>
                        <CardAlertDialogAction
                          tone="danger"
                          onClick={() => void handleRollback(op.id)}
                        >
                          確認復原
                        </CardAlertDialogAction>
                      </CardAlertDialogFooter>
                    </CardAlertDialogContent>
                  </CardAlertDialog>
                )
              }
            >
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] tabular-nums text-muted-foreground">
                <span>總筆數:{op.total_rows}</span>
                {/* 語意色 token,不寫死 emerald(深色模式下寫死的色碼對比會不夠)。 */}
                <span className="text-success-strong">成功:{op.success_rows}</span>
                <span className="text-destructive-strong">失敗:{op.failed_rows}</span>
                <span>略過:{op.skipped_duplicate_rows}</span>
              </div>

              {errors.length > 0 ? (
                <div className="mt-2">
                  <Button
                    type="button"
                    variant="text"
                    size="card"
                    className="px-0"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : op.id)}
                  >
                    {expanded ? "收合失敗明細" : `展開失敗明細(${errors.length})`}
                  </Button>
                  {expanded ? (
                    <div className="mt-1.5 max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
                      {errors.map((e, i) => (
                        <div key={i} className="break-words px-3 py-2 text-xs leading-relaxed">
                          <span className="tabular-nums">第 {e.row_number} 列</span>:
                          {e.error_message}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {rollbackResult ? (
                <div className="mt-2 rounded-md bg-muted px-3 py-2.5 text-xs leading-relaxed">
                  <p className="tabular-nums">
                    復原結果:成功 {rollbackResult.restoredCount} 筆，跳過{" "}
                    {rollbackResult.skippedCount} 筆
                  </p>
                  {rollbackResult.skippedReasons.length > 0 ? (
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {rollbackResult.skippedReasons.map((r, i) => (
                        <li key={i} className="break-words">
                          {r.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </ListCard>
          );
        })}
      </div>
    </div>
  );
}

export default function ImportHistoryPage() {
  return (
    <RequireDataImportAccess>
      <ImportHistoryPageInner />
    </RequireDataImportAccess>
  );
}
