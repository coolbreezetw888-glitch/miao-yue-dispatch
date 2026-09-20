// 模組 12 §4.2:匯入紀錄頁(新路由 /app/data-import/history，僅商家管理員可見)。
// 清單顯示批次歷史(類型/時間/成功/失敗/略過筆數/狀態)，可以展開看 error_report 明細，
// 尚未復原的批次顯示「復原」按鈕(規則 2.8)。

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  const { data: operations, isLoading } = useMerchantBulkOperations(merchantId);
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

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-5 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">匯入紀錄</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            查看過去的批次匯入/搬遷操作，尚未復原的批次可以按「復原」還原。
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/app/data-import">回到資料匯入</Link>
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">載入中⋯</p>}

      {!isLoading && (operations ?? []).length === 0 && (
        <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
          目前還沒有任何批次操作紀錄。
        </p>
      )}

      <div className="space-y-3">
        {(operations ?? []).map((op) => {
          const errors = parseErrorReport(op.error_report);
          const expanded = expandedId === op.id;
          const rollbackResult = rollbackResults[op.id];
          return (
            <Card key={op.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-base">
                    {BULK_OPERATION_TYPE_LABELS[op.operation_type as BulkOperationType] ??
                      op.operation_type}
                  </CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatDateTime(op.created_at)}
                  </p>
                </div>
                <Badge variant={op.status === "rolled_back" ? "secondary" : "default"}>
                  {op.status === "rolled_back" ? "已復原" : "已完成"}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                  <span>總筆數:{op.total_rows}</span>
                  <span className="text-emerald-600">成功:{op.success_rows}</span>
                  <span className="text-destructive">失敗:{op.failed_rows}</span>
                  <span>略過:{op.skipped_duplicate_rows}</span>
                </div>

                {errors.length > 0 && (
                  <div>
                    <Button
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => setExpandedId(expanded ? null : op.id)}
                    >
                      {expanded ? "收合失敗明細" : `展開失敗明細(${errors.length})`}
                    </Button>
                    {expanded && (
                      <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border">
                        {errors.map((e, i) => (
                          <div
                            key={i}
                            className="border-b border-border p-2 text-xs last:border-b-0"
                          >
                            第 {e.row_number} 列:{e.error_message}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {rollbackResult && (
                  <div className="rounded-md bg-muted p-3 text-xs">
                    <p>
                      復原結果:成功 {rollbackResult.restoredCount} 筆，跳過{" "}
                      {rollbackResult.skippedCount} 筆
                    </p>
                    {rollbackResult.skippedReasons.length > 0 && (
                      <ul className="mt-1 list-disc pl-4">
                        {rollbackResult.skippedReasons.map((r, i) => (
                          <li key={i}>{r.reason}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {op.status !== "rolled_back" && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" size="sm" disabled={rollingBackId === op.id}>
                        {rollingBackId === op.id ? "復原中⋯" : "復原"}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>確定要復原這個批次嗎?</AlertDialogTitle>
                        <AlertDialogDescription>
                          只會復原這個批次自己動過、且之後沒有被其他操作異動過的資料，詳細結果會列出來。
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void handleRollback(op.id)}>
                          確認復原
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </CardContent>
            </Card>
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
