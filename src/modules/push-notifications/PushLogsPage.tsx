// SPECS-INDEX #778:推播發送記錄頁(新路由 /app/push-logs)。
// 結構、篩選、分頁完全照抄模組 11 的 LineLogsPage.tsx;不同的地方只有兩點,都是為了讓非工程
// 背景的老闆看得懂:
//   1. 「為什麼沒發成功」用 PUSH_LOG_SKIP_REASON_LABELS 的白話說明顯示,而且**不收在「查看詳情」裡**
//      —— 這一頁存在的唯一理由就是這句話,不能再讓人多點一下才看得到。底下再補一行「可以怎麼做」。
//   2. 原始記錄是「一個身份一列」(同一個人同時是客服又是服務人員時,一件事會有兩列),畫面上
//      群組成「一件事一組、底下列出通知到誰」,並明講「這兩列是同一個人,手機只會收到一次」。
//      群組邏輯在 pushLogView.ts,這裡只負責渲染。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill,做法與 LINE 發送記錄頁
// (LineLogsPage)刻意一致 —— 兩頁本來就是同一個結構,長得不一樣只會讓人以為是兩種東西。
//   - 頁首改 PageHeader;載入中改灰色骨架;沒有記錄改 EmptyState(二之八)。
//   - 狀態徽章改 StatusTag(二之四):全部送達 = success、部分送達 = warning、
//     失敗 = danger、沒有發送 = neutral。🔴「部分送達」刻意跟「全部送達」不同色調,
//     這是這一頁存在的理由(老闆要一眼看出「有人沒收到」)。
//   - 「結果」篩選只有兩個選項 ⇒ 改成底線式**篩選列**(variant="filter",一眼全部看到,
//     不捲不換行);事件類型有五個選項且會再增加 ⇒ 維持下拉,改用 FieldSelect 的統一樣式。
//     📌 兩個篩選都**沒有**加 guardPhantomEmptyChange:選項是寫死的白名單,不是資料庫的動態值
//     (FieldSelect 的 JSDoc 說明的就是這個判斷標準)。
//   - 展開 / 收合、上一頁 / 下一頁改 ② 次要按鈕;時間與頁碼加 tabular-nums。
//
// **只動外觀,不動行為**:查詢參數、群組邏輯(pushLogView.ts)、白話原因不收進「查看詳情」、
// 同一個人兩列的提示、所有 data-testid 與 data-outcome / data-summary 屬性全部照舊。

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BellRing } from "lucide-react";

import {
  EmptyState,
  FieldSelect,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
  UnderlineTabsList,
  UnderlineTabsTrigger,
  type StatusTone,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";

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

/** skill 二之四 狀態配色:正常 = 綠系 / 要注意 = 黃系 / 出事 = 紅系 / 結束或沒做事 = 灰系。
 *  🔴「部分送達」必須跟「全部送達」不同色調 —— 這一頁存在的理由就是讓老闆一眼看出「有人沒收到」。 */
function summaryTone(kind: PushLogGroupSummaryKind): StatusTone {
  switch (kind) {
    case "all_sent":
      return "success";
    case "failed":
      return "danger";
    case "partial":
      return "warning";
    default:
      return "neutral";
  }
}

function recipientTone(recipient: PushLogRecipientView): StatusTone {
  switch (recipient.outcome) {
    case "sent":
      return "success";
    case "failed":
      return "danger";
    case "partially_sent":
      return "warning";
    default:
      return "neutral";
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
        <StatusTag tone={recipientTone(recipient)} className="shrink-0">
          {recipient.statusLabel}
        </StatusTag>
      </div>
      {recipient.hint ? (
        <p
          data-testid="push-log-recipient-hint"
          className="mt-1 text-xs leading-relaxed text-muted-foreground"
        >
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
      className="rounded-xl border border-border bg-card px-3.5 py-3 text-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="tabular-nums text-foreground">{formatDateTime(group.attempted_at)}</p>
          <p className="break-words text-xs text-muted-foreground">
            {PUSH_NOTIFICATION_EVENT_LABELS[
              group.event_type as keyof typeof PUSH_NOTIFICATION_EVENT_LABELS
            ] ?? group.event_type}
            {group.rendered_title ? ` ・ ${group.rendered_title}` : null}
          </p>
        </div>
        <StatusTag tone={summaryTone(group.summary.kind)} className="shrink-0">
          {group.summary.label}
        </StatusTag>
      </div>

      <ul className="mt-2.5 flex flex-col gap-1.5">
        {group.recipients.map((recipient) => (
          <RecipientLine key={recipient.row.id} recipient={recipient} />
        ))}
      </ul>

      {group.sameUserNotes.map((note) => (
        <p
          key={note.userId}
          data-testid="push-log-same-user-note"
          className="mt-2 text-xs leading-relaxed text-muted-foreground"
        >
          {formatSameUserNote(note)}
        </p>
      ))}

      {group.rendered_body ? (
        <>
          <Button
            type="button"
            variant="neutral"
            size="card"
            className="mt-2.5"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? "收合通知內容" : "查看通知內容"}
          </Button>
          {expanded ? (
            <div className="mt-2.5 flex flex-col gap-1 border-t border-border pt-2.5 text-xs leading-relaxed text-muted-foreground">
              {group.rendered_title ? (
                <p className="break-words">標題:{group.rendered_title}</p>
              ) : null}
              <p className="whitespace-pre-wrap break-words">內容:{group.rendered_body}</p>
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
      <PageHeader
        backTo="/app/manage"
        title="推播發送記錄"
        description="每一次嘗試發送手機推播的記錄。沒發成功的會直接寫出原因,以及可以怎麼處理。"
      />

      <Card>
        <CardHeader className="gap-3">
          <CardTitle>記錄</CardTitle>
          {/* 只有兩個選項的「結果」⇒ 底線式篩選列:必須一眼全部看到,不捲不換行(二之四末段)。 */}
          <Tabs value={outcomeFilter} onValueChange={handleOutcomeFilterChange}>
            <UnderlineTabsList variant="filter">
              <UnderlineTabsTrigger value="all">全部結果</UnderlineTabsTrigger>
              <UnderlineTabsTrigger value="problems">只看沒發成功的</UnderlineTabsTrigger>
            </UnderlineTabsList>
          </Tabs>
          {/* 事件類型有五個且會再增加 ⇒ 維持下拉。選項是寫死白名單,不需要 guard。 */}
          <FieldSelect
            aria-label="篩選事件類型"
            value={eventFilter}
            onValueChange={handleEventFilterChange}
            placeholder="篩選事件類型"
            options={[
              { value: "all", label: "全部事件" },
              ...Object.entries(PUSH_NOTIFICATION_EVENT_LABELS).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <LoadingSkeleton variant="cards" rows={4} />
          ) : !logs || logs.length === 0 ? (
            <EmptyState
              icon={<BellRing className="h-6 w-6" aria-hidden="true" />}
              title={
                outcomeFilter === "problems" ? "這個範圍內沒有沒發成功的記錄" : "還沒有任何發送記錄"
              }
              description={
                outcomeFilter === "problems"
                  ? "全部都發出去了,或是這個範圍內還沒有任何推播。切回「全部結果」可以看完整記錄。"
                  : "每次系統嘗試發推播都會記在這裡,沒發成功的會直接寫出原因與可以怎麼處理。"
              }
              action={
                <Button asChild variant="primary" size="touch">
                  <Link to="/app/push-events">去看推播通知設定</Link>
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
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

          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="neutral"
              size="card"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              上一頁
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">第 {page + 1} 頁</span>
            <Button
              type="button"
              variant="neutral"
              size="card"
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
