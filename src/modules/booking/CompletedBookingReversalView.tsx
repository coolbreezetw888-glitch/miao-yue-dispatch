// #844 已完成訂單取消/還原 —— 預約詳情全頁層裡的第三個子畫面「確認還原 / 取消」(規格書 §五 5.2~5.3)。
//
// 為什麼是全頁層內的子畫面、不是小卡窗(§5.2,skill 三、分類原則):內容會捲動(跨月警告 + 說明 + 最多
// 6 列連帶影響 + 差額 + warnings + 原因欄 + 通知開關),320px 手機一定超過一個螢幕;小卡窗規格是「不捲動」。
// 比照既有的「相關訂單」「操作記錄」子畫面,在同一個 FullPageLayer 裡切換內容,不疊第三層窗。
//
// 這個檔案只負責「畫」;資料怎麼轉換在 ./completedBookingReversal.ts(有 Vitest),送出與重抓在
// BookingDetailDialog.tsx。商家 / 客戶輸入的字(會員姓名、服務人員姓名、warnings 裡的姓名)
// 一律走 React 文字節點,不用 dangerouslySetInnerHTML。

import {
  ActionBar,
  AlertNote,
  DetailRow,
  DetailSection,
  ErrorState,
  FieldTextarea,
  FormField,
  LoadingSkeleton,
  SwitchRow,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import {
  CANCEL_NOTIFY_SWITCH,
  REVERSAL_REASON_MAX,
  expectedShortfallNote,
  reversalReasonLength,
  type CompletedBookingReversalView,
  type TextSegment,
} from "./completedBookingReversal";
import { BackToDetailLink } from "./StatusChangeLogsView";
import type { CompletedBookingReversalAction } from "./types";

/** 文字段落:strong 的加粗,其餘一般字。全部是 React 文字節點(不解析 HTML)。 */
function SegmentText({ segments }: { segments: TextSegment[] }) {
  return (
    <>
      {segments.map((s, i) =>
        s.strong ? (
          <strong key={i} className="font-bold">
            {s.text}
          </strong>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

export function CompletedBookingReversalContent({
  action,
  loading,
  errorMessage,
  stateChanged,
  view,
  reason,
  onReasonChange,
  reasonError,
  notify,
  onNotifyChange,
  busy,
  onBack,
  onRetry,
}: {
  action: CompletedBookingReversalAction;
  loading: boolean;
  /** 預覽讀取失敗的訊息(後端白話);null = 沒有失敗。 */
  errorMessage: string | null;
  /** 預覽失敗的原因是「狀態已經改變」(別人剛處理過)。 */
  stateChanged: boolean;
  view: CompletedBookingReversalView | null;
  reason: string;
  onReasonChange: (value: string) => void;
  /** 使用者動過原因欄後才顯示的錯誤(一打開就滿屏紅字不友善;按鈕旁的 `!` 一直都在)。 */
  reasonError: string | null;
  notify: boolean;
  onNotifyChange: (value: boolean) => void;
  busy: boolean;
  onBack: () => void;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <BackToDetailLink onBack={onBack} />
        {/* skill 二之八:載入中用灰色骨架,不用「載入中⋯」。 */}
        <LoadingSkeleton variant="lines" rows={8} />
      </div>
    );
  }

  if (errorMessage !== null || !view) {
    return (
      <div className="flex flex-col gap-3">
        <BackToDetailLink onBack={onBack} />
        {/* skill 二之八 出錯:什麼壞了 / 可能原因 / 下一步 +「你的資料沒有遺失」(元件固定加)。 */}
        <ErrorState
          title={stateChanged ? "這筆訂單的狀態已經改變" : "讀不到這次會連帶影響的內容"}
          reason={
            stateChanged
              ? "可能有其他人剛還原、取消或修改過這筆訂單"
              : (errorMessage ?? "可能是網路不穩")
          }
          retryLabel={stateChanged ? "重新整理" : "重試"}
          onRetry={onRetry}
        />
      </div>
    );
  }

  const reasonId = `completed-reversal-reason-${action}`;
  const length = reversalReasonLength(reason);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <BackToDetailLink onBack={onBack} />

      {/* 1. 跨月才有:危險色 `!`,常駐、不可收合,放最上面(§5.3)。 */}
      {view.crossMonthSegments ? (
        <AlertNote tone="danger" data-testid="reversal-cross-month">
          <span className="tabular-nums">
            <SegmentText segments={view.crossMonthSegments} />
          </span>
        </AlertNote>
      ) : null}

      {/* 2. 常駐黃色 `!`:按下去會發生什麼(§3.12 定案文案)。 */}
      <AlertNote data-testid="reversal-explanation">
        <SegmentText segments={view.explanationSegments} />
      </AlertNote>

      {/* 3. 這次會連帶影響(數字 tabular-nums 由 DetailRow 的值欄負責)。 */}
      <DetailSection label="這次會連帶影響">
        {view.impactRows.map((row) => (
          <DetailRow key={row.key} label={row.label}>
            <span className="tabular-nums">{row.value}</span>
          </DetailRow>
        ))}
      </DetailSection>

      {/* 4. 這個入口的預計差額 > 0 才有。 */}
      {view.expectedShortfall > 0 ? (
        <AlertNote data-testid="reversal-expected-shortfall">
          {expectedShortfallNote(view.expectedShortfall)}
        </AlertNote>
      ) : null}

      {/* 5. warnings(後端已寫成白話)。 */}
      {view.warnings.map((w) => (
        <AlertNote key={`warning-${w.code}`} data-testid={`reversal-warning-${w.code}`}>
          {w.message}
        </AlertNote>
      ))}

      {/* 6. 擋下這個入口的原因(匯入單不能還原)。 */}
      {view.blockedReasons.map((b) => (
        <AlertNote key={`blocked-${b.code}`} data-testid={`reversal-blocked-${b.code}`}>
          {b.message}
        </AlertNote>
      ))}

      {/* 7. 原因(必填、上限 500 字、右上角字數;字數算法跟後端一致)。 */}
      <FormField
        label="原因"
        htmlFor={reasonId}
        required
        counter={{ value: length, max: REVERSAL_REASON_MAX }}
        error={reasonError}
      >
        <FieldTextarea
          id={reasonId}
          rows={3}
          value={reason}
          disabled={busy}
          placeholder={action === "revert" ? "例如:誤按完成" : "例如:客人要求作廢這筆紀錄"}
          onChange={(e) => onReasonChange(e.target.value)}
        />
      </FormField>

      {/* 8. 取消路徑才有:通知開關,預設關(Q2 定案 C)。還原一律不發,不顯示開關。 */}
      {action === "cancel" ? (
        <SwitchRow
          title={CANCEL_NOTIFY_SWITCH.title}
          description={CANCEL_NOTIFY_SWITCH.description}
          checked={notify}
          onCheckedChange={onNotifyChange}
          disabled={busy}
        />
      ) : null}
    </div>
  );
}

/** 底部動作列(兩顆等寬):返回 + 確定。確定不能按時,按鈕列上方放黃色 `!` 說明為什麼。 */
export function CompletedBookingReversalFooter({
  view,
  disabledReason,
  busy,
  onBack,
  onConfirm,
}: {
  view: CompletedBookingReversalView | null;
  disabledReason: string | null;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {view && disabledReason ? (
        // skill 二:「為什麼這顆按鈕按不了」用黃色常駐 `!`,不收進 `?`。
        <AlertNote data-testid="reversal-confirm-disabled-reason" className="py-2">
          {disabledReason}
        </AlertNote>
      ) : null}
      <ActionBar>
        <Button type="button" variant="neutral" size="touch" onClick={onBack} disabled={busy}>
          返回
        </Button>
        {view ? (
          <Button
            type="button"
            variant={view.confirmVariant}
            size="touch"
            onClick={onConfirm}
            disabled={busy || disabledReason !== null}
          >
            {view.confirmLabel}
          </Button>
        ) : null}
      </ActionBar>
    </div>
  );
}
