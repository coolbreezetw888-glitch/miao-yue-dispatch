// 模組 11(LINE 通知)§4.3:發送記錄頁(新路由 /app/line-logs)。
// 表格清單(呼叫 3.18 get_line_notification_log):時間/事件類型/對象/狀態徽章/跳過原因或
// 錯誤內容(可展開)/實際發送內容(可展開)。篩選:事件類型。分頁。

import { useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useCurrentMerchant } from "@/modules/merchant/context";

import { useLineNotificationLog } from "./api";
import { RequireLineNotificationAccess } from "./RequireLineNotificationAccess";
import {
  LINE_LOG_EVENT_TYPE_LABELS,
  LINE_LOG_SKIP_REASON_LABELS,
  LINE_LOG_STATUS_LABELS,
  LINE_TARGET_TYPE_LABELS,
} from "./types";

const PAGE_SIZE = 20;

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" {
  if (status === "sent") return "default";
  if (status === "failed") return "destructive";
  return "secondary";
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", { hour12: false });
}

function LineLogsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;

  const [eventFilter, setEventFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: logs, isLoading } = useLineNotificationLog(
    merchantId,
    eventFilter === "all" ? null : eventFilter,
    page,
    PAGE_SIZE,
  );

  function handleFilterChange(value: string) {
    setEventFilter(value);
    setPage(0);
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">LINE 發送記錄</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          每一次嘗試發送 LINE 通知的完整記錄(成功/失敗/跳過)。
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>記錄</CardTitle>
          <Select value={eventFilter} onValueChange={handleFilterChange}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="篩選事件類型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部事件</SelectItem>
              {Object.entries(LINE_LOG_EVENT_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : !logs || logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前沒有任何發送記錄。</p>
          ) : (
            <ul className="space-y-2">
              {logs.map((log) => (
                <li key={log.id} className="rounded-md border border-border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-foreground">{formatDateTime(log.attempted_at)}</p>
                      <p className="text-xs text-muted-foreground">
                        {LINE_LOG_EVENT_TYPE_LABELS[log.event_type] ?? log.event_type} ・{" "}
                        {LINE_TARGET_TYPE_LABELS[log.target_type] ?? log.target_type}
                      </p>
                    </div>
                    <Badge variant={statusBadgeVariant(log.status)}>
                      {LINE_LOG_STATUS_LABELS[log.status] ?? log.status}
                    </Badge>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-auto px-0 text-xs"
                    onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                  >
                    {expandedId === log.id ? "收合詳情" : "查看詳情"}
                  </Button>
                  {expandedId === log.id ? (
                    <div className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
                      {log.skip_reason ? (
                        <p>
                          跳過原因:{LINE_LOG_SKIP_REASON_LABELS[log.skip_reason] ?? log.skip_reason}
                        </p>
                      ) : null}
                      {log.error_detail ? <p>錯誤內容:{log.error_detail}</p> : null}
                      {log.rendered_message ? (
                        <p className="whitespace-pre-wrap">發送內容:{log.rendered_message}</p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex items-center justify-between">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              上一頁
            </Button>
            <span className="text-xs text-muted-foreground">第 {page + 1} 頁</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!logs || logs.length < PAGE_SIZE}
              onClick={() => setPage((p) => p + 1)}
            >
              下一頁
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

export default function LineLogsPage() {
  return (
    <RequireLineNotificationAccess>
      <LineLogsPageInner />
    </RequireLineNotificationAccess>
  );
}
