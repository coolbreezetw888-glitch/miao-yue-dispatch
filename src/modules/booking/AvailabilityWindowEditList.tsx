// SPECS-INDEX #1024(第 22 批):服務人員每週可預約時段清單 —— 每一組可以「直接調開始 / 結束時間」。
// 使用者原話:「現在要改時間只能刪掉再新增」,要「跟營業時間設定一樣,直接調開始/結束時間」。
//
// 共用:商家端 編輯服務人員(StaffListPage 的 AvailabilityWindowsEditor,全頁層裡)與
//       服務人員端 休假設定(MyAvailabilityPage 的 WeeklyWindowsSection,一般頁面)。**不要各寫一份。**
//
// 做法:
//   ・每張卡片標題照舊是「星期三 13:00 - 17:00」(= 目前存著的值),下面兩顆時間欄位(跟營業時間設定頁同一個 FieldTime)。
//   ・改了時間 ⇒ 右邊「刪除」換成「還原」+「儲存」(主要動作位置固定,只換字);按「儲存」才寫入。
//     不做「離開欄位就自動存」:放在全頁層裡時,按 Esc 跳出「確定放棄」窗會讓欄位失焦 ⇒ 自動存會在使用者選「放棄」前
//     就把資料寫進去,跟三之六的「放棄」對不起來。
//   ・填錯(開始 >= 結束、跟同一天另一組重疊)⇒ 欄位框變紅 + 下面一行 `!`(二之七),儲存鈕不能按;
//     資料庫也擋同樣兩條(繞過畫面也擋),訊息一字不差。
//   ・有改過還沒儲存 ⇒ onDirtyChange(true),全頁層 Esc / 上方空白條會先問「確定放棄這次輸入？」(三之六)。
//   ・#1036(第 23 批)即時同步:清單在編輯中被重抓(商家改了 / 另一台裝置改了)⇒ 草稿以時段 id 保留,
//     正在改的那一列欄位不會被蓋掉(標題換成新存的值、dirty 改跟新值比);沒在改的列照常換成新值;
//     被別處刪掉的列連同草稿一起消失;那一列正在改的話跳 toast「這組時段已被刪除」(主腦裁決)。

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { FieldError, FieldTime, ListCard } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { updateStaffAvailabilityWindow } from "./api";
import {
  availabilityWindowRangeLabel,
  toHhMm,
  validateAvailabilityWindowEdit,
} from "./availabilityWindowEdit";
import type { StaffAvailabilityWindow } from "./types";

interface Draft {
  start: string;
  end: string;
}

export function AvailabilityWindowEditList({
  windows,
  onChanged,
  onRemove,
  onDirtyChange,
}: {
  windows: readonly StaffAvailabilityWindow[];
  /** 儲存成功後重抓清單(呼叫端各自的 query key)。 */
  onChanged: () => Promise<unknown>;
  /** 刪除這一組(呼叫端既有的刪除流程,含 toast)。 */
  onRemove: (windowId: string) => void;
  /** 有沒有「改了還沒儲存」的時段(給全頁層的 dirty 用;一般頁面可以不傳)。 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(() => new Set());

  // 清單重抓後,已經不存在的那幾組(被刪掉 / 別的分頁刪的)草稿一起丟掉。
  // #1036(第 23 批,主腦裁決):丟掉的是「正在改、還沒存」的那一列 ⇒ 跳一則 toast 告訴使用者為什麼不見了
  //   (比對的是「上一次清單」裡那一列存著的值,草稿跟它不同才算正在改)。
  const windowIds = useMemo(() => new Set(windows.map((w) => w.id)), [windows]);
  const previousWindowsRef = useRef<ReadonlyMap<string, StaffAvailabilityWindow>>(new Map());
  useEffect(() => {
    const previous = previousWindowsRef.current;
    previousWindowsRef.current = new Map(windows.map((w) => [w.id, w]));
    const removedDirty = Object.entries(drafts).some(([id, d]) => {
      if (windowIds.has(id)) return false;
      const old = previous.get(id);
      return !old || d.start !== toHhMm(old.start_time) || d.end !== toHhMm(old.end_time);
    });
    if (removedDirty) toast.warning("這組時段已被刪除");
    setDrafts((prev) => {
      const keys = Object.keys(prev);
      if (keys.every((id) => windowIds.has(id))) return prev;
      const next: Record<string, Draft> = {};
      for (const id of keys) if (windowIds.has(id)) next[id] = prev[id]!;
      return next;
    });
    // 只在清單換了(重抓)時判斷;drafts 刻意不列進依賴,否則每打一個字都會跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowIds]);

  function isRowDirty(w: StaffAvailabilityWindow): boolean {
    const d = drafts[w.id];
    if (!d) return false;
    return d.start !== toHhMm(w.start_time) || d.end !== toHhMm(w.end_time);
  }

  const anyDirty = windows.some(isRowDirty);
  useEffect(() => {
    onDirtyChange?.(anyDirty);
  }, [anyDirty, onDirtyChange]);
  // 卸載時(例如全頁層關掉)把 dirty 還原成 false,不要留一個過期的 true 在呼叫端。
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  function setDraft(w: StaffAvailabilityWindow, patch: Partial<Draft>) {
    setDrafts((prev) => {
      const base = prev[w.id] ?? { start: toHhMm(w.start_time), end: toHhMm(w.end_time) };
      const next = { ...base, ...patch };
      // #1036(第 23 批):改回跟目前存著的值一樣 ⇒ 直接丟掉這份草稿。否則即時同步重抓到「別人改過的新值」時,
      // 這份「其實沒改」的舊草稿會變成 dirty、把舊時間蓋回畫面上。
      if (next.start === toHhMm(w.start_time) && next.end === toHhMm(w.end_time)) {
        if (!(w.id in prev)) return prev;
        const rest = { ...prev };
        delete rest[w.id];
        return rest;
      }
      return { ...prev, [w.id]: next };
    });
  }

  function revert(windowId: string) {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[windowId];
      return next;
    });
  }

  async function save(w: StaffAvailabilityWindow, draft: Draft) {
    const problem = validateAvailabilityWindowEdit(windows, w.id, draft.start, draft.end);
    if (problem) return;
    setSavingIds((prev) => new Set(prev).add(w.id));
    try {
      await updateStaffAvailabilityWindow(w.id, { startTime: draft.start, endTime: draft.end });
      await onChanged();
      revert(w.id);
      toast.success("已更新可預約時段");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(w.id);
        return next;
      });
    }
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="availability-window-list">
      {windows.map((w) => {
        const rangeLabel = availabilityWindowRangeLabel(w);
        const draft = drafts[w.id] ?? { start: toHhMm(w.start_time), end: toHhMm(w.end_time) };
        const dirty = isRowDirty(w);
        const saving = savingIds.has(w.id);
        const problem = dirty
          ? validateAvailabilityWindowEdit(windows, w.id, draft.start, draft.end)
          : null;
        return (
          <li key={w.id} data-testid={`availability-window-${w.id}`}>
            <ListCard
              title={<span className="text-sm font-medium tabular-nums">{rangeLabel}</span>}
              // 主要動作位置固定:沒改 =「刪除」(#870:可逆、不標紅、不收進 ⋯);改了 =「還原」+「儲存」。
              primaryAction={
                dirty ? (
                  <>
                    <Button
                      type="button"
                      variant="text"
                      size="card"
                      disabled={saving}
                      aria-label={`還原${rangeLabel}`}
                      onClick={() => revert(w.id)}
                    >
                      還原
                    </Button>
                    <Button
                      type="button"
                      variant="neutral"
                      size="card"
                      disabled={saving || problem !== null}
                      aria-label={`儲存${rangeLabel}`}
                      onClick={() => void save(w, draft)}
                    >
                      儲存
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="neutral"
                    size="card"
                    aria-label={`刪除${rangeLabel}`}
                    onClick={() => onRemove(w.id)}
                  >
                    刪除
                  </Button>
                )
              }
            >
              <div
                className="group/field mt-2 flex flex-col gap-1.5"
                data-invalid={problem ? "true" : undefined}
              >
                <div className="flex items-center gap-2">
                  <FieldTime
                    aria-label={`${rangeLabel}的開始時間`}
                    className="min-w-0 flex-1 sm:w-36 sm:flex-none"
                    value={draft.start}
                    disabled={saving}
                    aria-invalid={problem ? true : undefined}
                    onChange={(e) => setDraft(w, { start: e.target.value })}
                  />
                  <span className="shrink-0 text-sm text-muted-foreground">至</span>
                  <FieldTime
                    aria-label={`${rangeLabel}的結束時間`}
                    className="min-w-0 flex-1 sm:w-36 sm:flex-none"
                    value={draft.end}
                    disabled={saving}
                    aria-invalid={problem ? true : undefined}
                    onChange={(e) => setDraft(w, { end: e.target.value })}
                  />
                </div>
                {problem ? <FieldError>{problem}</FieldError> : null}
              </div>
            </ListCard>
          </li>
        );
      })}
    </ul>
  );
}
