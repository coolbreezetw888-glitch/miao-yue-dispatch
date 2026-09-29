// 模組 11(LINE 通知)§4.3:發送記錄頁(新路由 /app/line-logs)。
// 清單(呼叫 3.18 get_line_notification_log):時間/事件類型/對象/狀態徽章/跳過原因或
// 錯誤內容(可展開)/實際發送內容(可展開)。篩選:事件類型。分頁。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader;載入中改灰色骨架;沒有記錄改 EmptyState(圖示 + 還沒有什麼 + 有了之後
//     能幹嘛 + 一顆下一步按鈕,帶去「LINE 通知設定」)(二之八)。
//   - 每一筆記錄改 ListCard(二之五:一張卡一筆資料,右側只放「一顆主要動作 + ⋯」)——
//     主要動作就是「查看詳情 / 收合詳情」,展開的內容放在卡片內(ListCard 的 children)。
//   - 狀態徽章改 StatusTag(二之四):成功 = success、失敗 = danger、跳過 = neutral。
//   - 展開後的詳情改用明細列 DetailRow(二之六:左邊淡標籤、右邊粗值,兩側都能折行)。
//   - 事件類型篩選改 FieldSelect(二之七的統一下拉樣式),並套上 guardPhantomEmptyChange
//     (src/lib/radixSelectGuard.ts 自己就寫「新加 Select 時建議直接套,一律套上沒有副作用」)。
//     選項是寫死的白名單("all" + 固定的事件類型標籤表),所以用最嚴格的白名單那一種用法 ——
//     萬一被幽靈空值洗掉,篩選會變成空字串、查詢直接查不到東西,防起來成本是一行。
//   - 上一頁 / 下一頁改 ② 次要按鈕;頁碼加 tabular-nums。
//
// **只動外觀,不動行為**:查詢參數(篩選 / 分頁 / PAGE_SIZE)、換篩選時回到第一頁、
// 下一頁的停用條件(不足一頁就是最後一頁)全部照舊。

import { useState } from "react";
import { Link } from "react-router-dom";
import { MessageSquare } from "lucide-react";

import {
  DetailRow,
  EmptyState,
  ErrorState,
  FieldSelect,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
  type StatusTone,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
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

/** skill 二之四 狀態配色:正常 = 綠系 / 結束或停用 = 灰系 / 出事 = 紅系。 */
function statusTone(status: string): StatusTone {
  if (status === "sent") return "success";
  if (status === "failed") return "danger";
  return "neutral";
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

  // 🔴 2026-09-30(品管第二次打回,🟡 第 3 項):原本只取 isLoading,查詢失敗時 logs 是
  // undefined ⇒ 畫成「還沒有任何發送記錄」,商家以為通知從來沒發過(查問題時最需要這頁的時候
  // 反而被誤導)。一律要有 isError 分支,排在空狀態之前。
  const {
    data: logs,
    isLoading,
    isError,
    refetch: refetchLogs,
  } = useLineNotificationLog(
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
      <PageHeader
        backTo="/app/manage"
        title="LINE 發送記錄"
        description="每一次嘗試發送 LINE 通知的完整記錄(成功/失敗/跳過)。"
      />

      <Card>
        <CardHeader className="gap-3">
          <CardTitle>記錄</CardTitle>
          {/* 選項是寫死的白名單 ⇒ 用最嚴格的那一種 guard 用法(見檔頭說明)。 */}
          <FieldSelect
            aria-label="篩選事件類型"
            value={eventFilter}
            onValueChange={guardPhantomEmptyChange(
              handleFilterChange,
              (v) => v === "all" || v in LINE_LOG_EVENT_TYPE_LABELS,
            )}
            placeholder="篩選事件類型"
            options={[
              { value: "all", label: "全部事件" },
              ...Object.entries(LINE_LOG_EVENT_TYPE_LABELS).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <LoadingSkeleton variant="cards" rows={4} />
          ) : isError ? (
            <ErrorState
              title="讀不到發送記錄"
              reason="可能是網路斷了;現在先不顯示記錄,避免你把空白當成「通知從來沒發過」"
              onRetry={() => void refetchLogs()}
            />
          ) : !logs || logs.length === 0 ? (
            <EmptyState
              icon={<MessageSquare className="h-6 w-6" aria-hidden="true" />}
              title={eventFilter === "all" ? "還沒有任何發送記錄" : "這個事件還沒有發送記錄"}
              description="每次系統嘗試發 LINE 通知都會記在這裡,包含成功、失敗與被跳過的原因,查問題時從這裡看最快。"
              action={
                <Button asChild variant="primary" size="touch">
                  <Link to="/app/line-events">去看 LINE 通知設定</Link>
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {logs.map((log) => {
                const expanded = expandedId === log.id;
                return (
                  <li key={log.id}>
                    <ListCard
                      title={
                        <span className="tabular-nums">{formatDateTime(log.attempted_at)}</span>
                      }
                      tags={
                        <StatusTag tone={statusTone(log.status)}>
                          {LINE_LOG_STATUS_LABELS[log.status] ?? log.status}
                        </StatusTag>
                      }
                      meta={
                        <>
                          {LINE_LOG_EVENT_TYPE_LABELS[log.event_type] ?? log.event_type} ・{" "}
                          {LINE_TARGET_TYPE_LABELS[log.target_type] ?? log.target_type}
                        </>
                      }
                      primaryAction={
                        <Button
                          type="button"
                          variant="neutral"
                          size="card"
                          aria-expanded={expanded}
                          onClick={() => setExpandedId(expanded ? null : log.id)}
                        >
                          {expanded ? "收合詳情" : "查看詳情"}
                        </Button>
                      }
                    >
                      {expanded ? (
                        // skill 二之六 明細列:左邊淡標籤、右邊粗值,兩側都能折行。
                        <div className="mt-2.5 flex flex-col gap-1.5 border-t border-border pt-2.5">
                          {log.skip_reason ? (
                            <DetailRow label="跳過原因" size="sm">
                              {LINE_LOG_SKIP_REASON_LABELS[log.skip_reason] ?? log.skip_reason}
                            </DetailRow>
                          ) : null}
                          {log.error_detail ? (
                            <DetailRow label="錯誤內容" size="sm">
                              {log.error_detail}
                            </DetailRow>
                          ) : null}
                          {log.rendered_message ? (
                            <div>
                              <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
                                實際發送內容
                              </p>
                              <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 px-3 py-2 text-[13px] leading-relaxed text-foreground">
                                {log.rendered_message}
                              </p>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </ListCard>
                  </li>
                );
              })}
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

export default function LineLogsPage() {
  return (
    <RequireLineNotificationAccess>
      <LineLogsPageInner />
    </RequireLineNotificationAccess>
  );
}
