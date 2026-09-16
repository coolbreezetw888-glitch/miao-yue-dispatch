// 對應規格書 4.1:商家整體營業時間設定頁(新路由 /app/business-hours)。
// 一週七天,每天一個「公休 / 營業(開始-結束)」設定列;同頁放「嚴格工時衝突檢查」開關(規則 2.4)。

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

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

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2.5">
      <span className="w-16 shrink-0 text-sm font-medium text-foreground">
        星期{DAY_OF_WEEK_LABELS[dayOfWeek]}
      </span>

      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Switch
          checked={!form.isClosed}
          disabled={saving}
          onCheckedChange={(checked) => {
            const next = { ...form, isClosed: !checked };
            setForm(next);
            void persist(next);
          }}
        />
        {form.isClosed ? "公休" : "營業中"}
      </label>

      {!form.isClosed ? (
        <div className="flex items-center gap-2 text-sm">
          <input
            type="time"
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            value={form.openTime}
            disabled={saving}
            onChange={(e) => setForm((prev) => ({ ...prev, openTime: e.target.value }))}
            onBlur={() => void persist(form)}
          />
          <span className="text-muted-foreground">至</span>
          <input
            type="time"
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            value={form.closeTime}
            disabled={saving}
            onChange={(e) => setForm((prev) => ({ ...prev, closeTime: e.target.value }))}
            onBlur={() => void persist(form)}
          />
        </div>
      ) : null}
    </div>
  );
}

function StrictConflictCheckToggle({ merchantId }: { merchantId: string }) {
  const featureFlagQueryKey = ["booking-module", "strict-conflict-check", merchantId] as const;
  const queryClient = useQueryClient();
  const { data: enabled, isLoading } = useQuery({
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
        <label className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5">
          <span className="text-sm text-foreground">
            {isLoading ? "載入中⋯" : enabled ? "已開啟(擋下重疊預約)" : "已關閉(允許重疊預約)"}
          </span>
          <Switch checked={enabled ?? true} disabled={isLoading} onCheckedChange={handleToggle} />
        </label>
      </CardContent>
    </Card>
  );
}

function BusinessHoursPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const { data: rows, isLoading } = useMerchantBusinessHours(merchantId);

  function refetch() {
    return queryClient.invalidateQueries({ queryKey: businessHoursQueryKey(merchantId) });
  }

  const rowsByDay = new Map((rows ?? []).map((r) => [r.day_of_week, r]));
  const hasAnySetting = (rows?.length ?? 0) > 0;

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">營業時間設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」的每週營業時間,是預約系統的最外層邊界。
        </p>
      </div>

      {!isLoading && !hasAnySetting ? (
        <p className="rounded-md border border-dashed border-warn/50 bg-warn/10 px-3 py-3 text-sm text-warn">
          尚未設定營業時間,目前所有日期都無法被預約,請先完成以下設定。
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>每週營業時間</CardTitle>
          <CardDescription>沒有設定的那一天視為公休,無法建立預約。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
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
