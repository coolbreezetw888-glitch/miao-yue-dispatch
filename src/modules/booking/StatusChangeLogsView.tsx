// 預約詳情全頁層裡的「操作記錄」子畫面 + 子畫面共用的「‹ 返回訂單詳情」。
// #844 批次 1 從 BookingDetailDialog.tsx 原樣搬出來(外觀、行為不變),目的是讓 Vitest 能直接
// render 這個子畫面驗「原因:…」那一行,不用把整個預約詳情(查詢、權限、通知)一起掛起來。
import { ChevronLeft } from "lucide-react";

import { EmptyState, ListCard, LoadingSkeleton } from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { isoToTaipeiDateTimeWithSeconds } from "./dateUtils";
import { statusChangeLogNoteText, statusChangeLogText } from "./statusChangeLogDisplay";
import type { BookingStatusChangeLog } from "./types";

/** 子畫面左上角的「‹ 返回訂單詳情」:skill 二之八的骨架寫法(一行小字,不是按鈕)。 */
export function BackToDetailLink({ onBack }: { onBack: () => void }) {
  return (
    <Button
      type="button"
      variant="text"
      size="card"
      className="-ml-2 self-start px-2"
      onClick={onBack}
    >
      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      返回訂單詳情
    </Button>
  );
}

// ---------------------------------------------------------------------------
// 模組 6 §9.1(SPECS-INDEX #597):操作記錄清單畫面,套用在同一顆 Dialog 裡(比照 §3.3 相關訂單
// 的既有互動模式,不另外疊一層彈窗)。
// ---------------------------------------------------------------------------
// 每一列的文字對照(含 #844 §4.6「還原完成」「取消已完成訂單」與原因)在 ./statusChangeLogDisplay。
export function StatusChangeLogsView({
  loading,
  logs,
  onBack,
}: {
  loading: boolean;
  logs: BookingStatusChangeLog[];
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <BackToDetailLink onBack={onBack} />
      {loading ? (
        <LoadingSkeleton variant="cards" rows={3} />
      ) : logs.length === 0 ? (
        <EmptyState
          title="目前沒有任何操作紀錄"
          description="之後有人確認、完成或取消這筆訂單,會記在這裡,可以查是誰、什麼時候改的。"
          action={
            <Button type="button" variant="neutral" size="touch" onClick={onBack}>
              返回訂單詳情
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {logs.map((log) => {
            const noteText = statusChangeLogNoteText(log);
            return (
              <li key={log.id}>
                <ListCard
                  title={
                    <span className="text-sm font-medium">
                      {log.actorNameSnapshot} {statusChangeLogText(log)}
                    </span>
                  }
                  meta={isoToTaipeiDateTimeWithSeconds(log.createdAt)}
                >
                  {/* #844 §4.6:有原因時在該列下方顯示「原因:…」(灰色 13px,skill 二之六) */}
                  {noteText ? (
                    <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
                      {noteText}
                    </p>
                  ) : null}
                </ListCard>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
