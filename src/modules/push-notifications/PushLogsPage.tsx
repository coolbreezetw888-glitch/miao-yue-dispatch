// SPECS-INDEX #778:推播發送記錄頁(新路由 /app/push-logs)。
// 結構、篩選、分頁完全照抄模組 11 的 LineLogsPage.tsx;不同的地方只有兩點,都是為了讓非工程
// 背景的老闆看得懂:
//   1. 「為什麼沒發成功」用 PUSH_LOG_SKIP_REASON_LABELS 的白話說明顯示,而且**不收在「查看詳情」裡**
//      —— 這一頁存在的唯一理由就是這句話,不能再讓人多點一下才看得到。底下再補一行「可以怎麼做」。
//   2. 原始記錄是「一個身份一列」(同一個人同時是客服又是服務人員時,一件事會有兩列),畫面上
//      群組成「一件事一組、底下列出通知到誰」,並明講「這兩列是同一個人,手機只會收到一次」。
//      群組邏輯在 pushLogView.ts,這裡只負責渲染。

import { useMemo, useState } from "react";
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

import { usePushLogRecipientDirectory, usePushNotificationLog } from "./api";
import {
  formatSameUserNote,
  groupPushLogRows,
  type PushLogEventGroup,
  type PushLogGroupSummaryKind,
  type PushLogRecipientView,
  type RecipientDirectory,
} from "./pushLogView";
import { RequirePushNotificationAccess } from "./RequirePushNotificationAccess";
import { PUSH_NOTIFICATION_EVENT_LABELS } from "./types";

const PAGE_SIZE = 20;
const EMPTY_DIRECTORY: RecipientDirectory = new Map();

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

function summaryBadgeVariant(kind: PushLogGroupSummaryKind): BadgeVariant {
  switch (kind) {
    case "all_sent":
      return "default";
    case "failed":
      return "destructive";
    case "partial":
      return "outline";
    default:
      return "secondary";
  }
}

function recipientBadgeVariant(recipient: PushLogRecipientView): BadgeVariant {
  switch (recipient.outcome) {
    case "sent":
      return "default";
    case "failed":
      return "destructive";
    case "partially_sent":
      return "outline";
    default:
      return "secondary";
  }
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", { hour12: false });
}

function RecipientLine({ recipient }: { recipient: PushLogRecipientView }) {
  const who = recipient.roleLabel
    ? recipient.name
      ? `${recipient.roleLabel} ${recipient.name}`
      : recipient.roleLabel
    : "整件事";
  return (
    <li
      data-testid="push-log-recipient"
      data-outcome={recipient.outcome}
      className="rounded-md bg-muted/40 px-3 py-2"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm text-foreground">
          <span className="font-medium">{who}</span>
          <span className="text-muted-foreground"> — </span>
          <span data-testid="push-log-recipient-detail">{recipient.detail}</span>
        </p>
        <Badge variant={recipientBadgeVariant(recipient)} className="shrink-0">
          {recipient.statusLabel}
        </Badge>
      </div>
      {recipient.hint ? (
        <p data-testid="push-log-recipient-hint" className="mt-1 text-xs text-muted-foreground">
          可以怎麼做:{recipient.hint}
        </p>
      ) : null}
    </li>
  );
}

function EventGroupItem({
  group,
  expanded,
  onToggle,
}: {
  group: PushLogEventGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      data-testid="push-log-group"
      data-summary={group.summary.kind}
      className="rounded-md border border-border px-3 py-2 text-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-foreground">{formatDateTime(group.attempted_at)}</p>
          <p className="text-xs text-muted-foreground">
            {PUSH_NOTIFICATION_EVENT_LABELS[
              group.event_type as keyof typeof PUSH_NOTIFICATION_EVENT_LABELS
            ] ?? group.event_type}
            {group.rendered_title ? ` ・ ${group.rendered_title}` : null}
          </p>
        </div>
        <Badge variant={summaryBadgeVariant(group.summary.kind)} className="shrink-0">
          {group.summary.label}
        </Badge>
      </div>

      <ul className="mt-2 space-y-1">
        {group.recipients.map((recipient) => (
          <RecipientLine key={recipient.row.id} recipient={recipient} />
        ))}
      </ul>

      {group.sameUserNotes.map((note) => (
        <p
          key={note.userId}
          data-testid="push-log-same-user-note"
          className="mt-2 text-xs text-muted-foreground"
        >
          {formatSameUserNote(note)}
        </p>
      ))}

      {group.rendered_body ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 h-auto px-0 text-xs"
            onClick={onToggle}
          >
            {expanded ? "收合通知內容" : "查看通知內容"}
          </Button>
          {expanded ? (
            <div className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
              {group.rendered_title ? <p>標題:{group.rendered_title}</p> : null}
              <p className="whitespace-pre-wrap">內容:{group.rendered_body}</p>
            </div>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

function PushLogsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;

  const [eventFilter, setEventFilter] = useState<string>("all");
  const [outcomeFilter, setOutcomeFilter] = useState<"all" | "problems">("all");
  const [page, setPage] = useState(0);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const { data: logs, isLoading } = usePushNotificationLog(
    merchantId,
    {
      eventType: eventFilter === "all" ? null : eventFilter,
      problemsOnly: outcomeFilter === "problems",
    },
    page,
    PAGE_SIZE,
  );
  // 名冊查不到(還在載入、或沒權限)時先用空的,畫面退回只顯示角色,不等它。
  const { data: directory } = usePushLogRecipientDirectory(merchantId);

  const groups = useMemo(
    () => groupPushLogRows(logs ?? [], directory ?? EMPTY_DIRECTORY),
    [logs, directory],
  );

  function handleEventFilterChange(value: string) {
    setEventFilter(value);
    setPage(0);
  }

  function handleOutcomeFilterChange(value: string) {
    setOutcomeFilter(value === "problems" ? "problems" : "all");
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
        <h1 className="text-2xl font-bold tracking-tight text-foreground">推播發送記錄</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          每一次嘗試發送手機推播的記錄。沒發成功的會直接寫出原因,以及可以怎麼處理。
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>記錄</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Select value={outcomeFilter} onValueChange={handleOutcomeFilterChange}>
              <SelectTrigger className="w-40" aria-label="篩選結果">
                <SelectValue placeholder="篩選結果" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部結果</SelectItem>
                <SelectItem value="problems">只看沒發成功的</SelectItem>
              </SelectContent>
            </Select>
            <Select value={eventFilter} onValueChange={handleEventFilterChange}>
              <SelectTrigger className="w-48" aria-label="篩選事件類型">
                <SelectValue placeholder="篩選事件類型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部事件</SelectItem>
                {Object.entries(PUSH_NOTIFICATION_EVENT_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : !logs || logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {outcomeFilter === "problems"
                ? "這個範圍內沒有沒發成功的記錄。"
                : "目前沒有任何發送記錄。"}
            </p>
          ) : (
            <ul className="space-y-2">
              {groups.map((group) => (
                <EventGroupItem
                  key={group.key}
                  group={group}
                  expanded={expandedKey === group.key}
                  onToggle={() => setExpandedKey(expandedKey === group.key ? null : group.key)}
                />
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

export default function PushLogsPage() {
  return (
    <RequirePushNotificationAccess>
      <PushLogsPageInner />
    </RequirePushNotificationAccess>
  );
}
