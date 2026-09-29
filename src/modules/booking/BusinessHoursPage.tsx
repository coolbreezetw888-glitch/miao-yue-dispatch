// 對應規格書 4.1:商家整體營業時間設定頁(新路由 /app/business-hours)。
// 一週七天,每天一個「公休 / 營業(開始-結束)」設定列;同頁放「嚴格工時衝突檢查」開關(規則 2.4)。
//
// ui-v1-full 第二階段第 2 批(2026-09-29):這一頁沒有彈窗,只套用頁面層級的規範——
//   - 每一天改成 SwitchRow(skill 二之七「開關做成一整列」):左邊「星期幾 + 公休 / 營業中」、右邊開關,
//     營業時把兩顆 FieldTime 放在開關列底下(一樣是窄螢幕垂直堆、不撐寬卡片)。
//   - 嚴格工時衝突檢查開關改 SwitchRow;「尚未設定營業時間」提醒改 `!` 常駐(AlertNote)。
//   - 頁首改 PageHeader、載入中改骨架。
// **只動外觀與版面,不動任何行為**:persist 的驗證與寫入時機(切開關立即存、時間欄 onBlur 存)照舊。

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertNote,
  ErrorState,
  FieldTime,
  LoadingSkeleton,
  PageHeader,
  SwitchRow,
} from "@/components/patterns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { getFeatureFlag, setFeatureFlag } from "@/modules/merchant/api";

import { upsertMerchantBusinessHours, STRICT_CONFLICT_CHECK_FEATURE_KEY } from "./api";
import { useMerchantBusinessHours } from "./context";
import { RequireBusinessHoursAccess } from "./RequireBusinessHoursAccess";
import { DAY_OF_WEEK_LABELS, type MerchantBusinessHours } from "./types";

const businessHoursQueryKey = (merchantId: string) =>
  ["booking-module", "business-hours", merchantId] as const;

interface DayFormState {
  isClosed: boolean;
  openTime: string;
  closeTime: string;
}

const DEFAULT_DAY_FORM: DayFormState = { isClosed: true, openTime: "09:00", closeTime: "18:00" };

function toFormState(row: MerchantBusinessHours | undefined): DayFormState {
  if (!row) return DEFAULT_DAY_FORM;
  return {
    isClosed: row.is_closed,
    openTime: row.open_time?.slice(0, 5) ?? "09:00",
    closeTime: row.close_time?.slice(0, 5) ?? "18:00",
  };
}

function DayRow({
  merchantId,
  dayOfWeek,
  row,
  onSaved,
}: {
  merchantId: string;
  dayOfWeek: number;
  row: MerchantBusinessHours | undefined;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<DayFormState>(toFormState(row));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(toFormState(row));
  }, [row]);

  async function persist(next: DayFormState) {
    if (!next.isClosed && next.openTime >= next.closeTime) {
      toast.error("開始時間必須早於結束時間");
      return;
    }
    setSaving(true);
    try {
      await upsertMerchantBusinessHours(merchantId, {
        dayOfWeek,
        isClosed: next.isClosed,
        openTime: next.isClosed ? null : next.openTime,
        closeTime: next.isClosed ? null : next.closeTime,
      });
      onSaved();
    } catch (err) {
      toast.error("更新營業時間失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  // 對應規格書「首頁外殼與主題色優化」三:兩顆原生 <input type="time"> 加起來的最小內容寬度比手機
  // 螢幕窄的卡片還寬,以前跟「日期 + 開關」擠在同一個 flex-wrap 容器裡會把整頁撐寬。現在改成
  // SwitchRow:開關列自己一行,時間欄放在它底下(children),寬度需求不再依賴撐開卡片本身。
  // 時間欄用共用的 FieldTime(px-2 + 歸零 picker indicator 邊距,320px 兩顆並排才不截字)。
  return (
    <SwitchRow
      title={`星期${DAY_OF_WEEK_LABELS[dayOfWeek]}`}
      description={form.isClosed ? "公休" : "營業中"}
      checked={!form.isClosed}
      disabled={saving}
      onCheckedChange={(checked) => {
        const next = { ...form, isClosed: !checked };
        setForm(next);
        void persist(next);
      }}
    >
      {!form.isClosed ? (
        <div className="flex items-center gap-2">
          <FieldTime
            aria-label={`星期${DAY_OF_WEEK_LABELS[dayOfWeek]}開始營業時間`}
            className="min-w-0 flex-1 sm:w-36 sm:flex-none"
            value={form.openTime}
            disabled={saving}
            onChange={(e) => setForm((prev) => ({ ...prev, openTime: e.target.value }))}
            onBlur={() => void persist(form)}
          />
          <span className="shrink-0 text-sm text-muted-foreground">至</span>
          <FieldTime
            aria-label={`星期${DAY_OF_WEEK_LABELS[dayOfWeek]}結束營業時間`}
            className="min-w-0 flex-1 sm:w-36 sm:flex-none"
            value={form.closeTime}
            disabled={saving}
            onChange={(e) => setForm((prev) => ({ ...prev, closeTime: e.target.value }))}
            onBlur={() => void persist(form)}
          />
        </div>
      ) : null}
    </SwitchRow>
  );
}

function StrictConflictCheckToggle({ merchantId }: { merchantId: string }) {
  const featureFlagQueryKey = ["booking-module", "strict-conflict-check", merchantId] as const;
  const queryClient = useQueryClient();
  const {
    data: enabled,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: featureFlagQueryKey,
    queryFn: async () => {
      const value = await getFeatureFlag(merchantId, STRICT_CONFLICT_CHECK_FEATURE_KEY);
      // 規格書 1.4:查無資料時前端視為預設開啟。
      return value ?? true;
    },
  });

  async function handleToggle(checked: boolean) {
    try {
      await setFeatureFlag(merchantId, STRICT_CONFLICT_CHECK_FEATURE_KEY, checked);
      await queryClient.invalidateQueries({ queryKey: featureFlagQueryKey });
      toast.success("已更新設定");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>嚴格工時衝突檢查</CardTitle>
        <CardDescription>
          開啟後,同一位服務人員(含在其他商家有登記、電話號碼相同的同一人)不能有兩筆時間重疊的預約。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingSkeleton variant="lines" rows={1} />
        ) : isError ? (
          // 🔴 2026-09-30 QA:讀不到時原本會顯示成「已開啟」(那是查無資料時的預設值),
          // 把「不知道」講成「確定開著」。出錯就不顯示開關狀態。
          <ErrorState
            title="讀不到嚴格工時衝突檢查的開關狀態"
            reason="可能是網路斷了;現在畫面上不會顯示開或關,避免給你錯誤的訊息"
            onRetry={() => void refetch()}
          />
        ) : (
          <SwitchRow
            title="啟用嚴格工時衝突檢查"
            description={
              (enabled ?? true) ? "目前已開啟,會擋下時間重疊的預約。" : "目前已關閉,允許重疊預約。"
            }
            checked={enabled ?? true}
            onCheckedChange={handleToggle}
          />
        )}
      </CardContent>
    </Card>
  );
}

function BusinessHoursPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  // refetchRows 是 react-query 自己的重抓(ErrorState 的「重試」用);下面那個 refetch() 是
  // 「存完之後讓清單失效」的既有函式,兩個不一樣,名字要分開。
  const {
    data: rows,
    isLoading,
    isError,
    refetch: refetchRows,
  } = useMerchantBusinessHours(merchantId);

  function refetch() {
    return queryClient.invalidateQueries({ queryKey: businessHoursQueryKey(merchantId) });
  }

  const rowsByDay = new Map((rows ?? []).map((r) => [r.day_of_week, r]));
  const hasAnySetting = (rows?.length ?? 0) > 0;

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/manage"
        title="營業時間設定"
        description={`「${merchant!.name}」的每週營業時間,是預約系統的最外層邊界。`}
      />

      {/* skill 二:「現在的狀態跟使用者以為的不一樣」(以為能預約其實整個關著)⇒ `!` 常駐,不可收合。
          🔴 2026-09-30 QA:這一條原本只看 `!isLoading && !hasAnySetting`,但查詢失敗時 rows 是
          undefined ⇒ hasAnySetting 也是 false ⇒ 會跳出「尚未設定營業時間,目前所有日期都無法被
          預約」這個**假警報**,商家明明設好了卻被告知全部關著。所以要多一個 `!isError`——
          讀不到資料的時候我們根本不知道有沒有設定,不能亂講。 */}
      {!isLoading && !isError && !hasAnySetting ? (
        <AlertNote>尚未設定營業時間,目前所有日期都無法被預約,請先完成以下設定。</AlertNote>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>每週營業時間</CardTitle>
          <CardDescription>沒有設定的那一天視為公休,無法建立預約。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          {isLoading ? (
            <LoadingSkeleton variant="lines" rows={7} />
          ) : isError ? (
            // 🔴 2026-09-30 QA:讀不到時原本會把七天全部畫成「公休」(rows 是 undefined),
            // 商家會以為自己的營業時間被清空,而且一動開關就真的寫進去了。出錯就不給表單。
            <ErrorState
              title="讀不到營業時間設定"
              reason="可能是網路斷了,或你沒有管理營業時間的權限;現在先不顯示每一天的設定,避免你把空白當成真的沒設定"
              onRetry={() => void refetchRows()}
            />
          ) : (
            [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => (
              <DayRow
                key={dayOfWeek}
                merchantId={merchantId}
                dayOfWeek={dayOfWeek}
                row={rowsByDay.get(dayOfWeek)}
                onSaved={refetch}
              />
            ))
          )}
        </CardContent>
      </Card>

      <StrictConflictCheckToggle merchantId={merchantId} />
    </main>
  );
}

export default function BusinessHoursPage() {
  return (
    <RequireBusinessHoursAccess>
      <BusinessHoursPageInner />
    </RequireBusinessHoursAccess>
  );
}
