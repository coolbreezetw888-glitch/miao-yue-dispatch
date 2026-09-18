// 對應規格書 4.1:商家整體營業時間設定頁(新路由 /app/business-hours)。
// 一週七天,每天一個「公休 / 營業(開始-結束)」設定列;同頁放「嚴格工時衝突檢查」開關(規則 2.4)。

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { getFeatureFlag, setFeatureFlag } from "@/modules/merchant/api";

import {
  upsertMerchantBusinessHours,
  upsertMerchantTaxSettings,
  MATERIAL_COST_ENABLED_FEATURE_KEY,
  STRICT_CONFLICT_CHECK_FEATURE_KEY,
} from "./api";
import {
  useMerchantBusinessHours,
  useMerchantPaymentMethodSettings,
  useMerchantTaxSettings,
  upsertMerchantPaymentMethodSetting,
} from "./context";
import { RequireBusinessHoursAccess } from "./RequireBusinessHoursAccess";
import {
  AMOUNT_ADJUSTMENT_MODE_LABELS,
  DAY_OF_WEEK_LABELS,
  DEFAULT_MERCHANT_PAYMENT_METHOD_SETTINGS,
  PAYMENT_METHOD_CODES,
  PAYMENT_METHOD_OPTIONS,
  type AmountAdjustmentMode,
  type MerchantBusinessHours,
  type PaymentMethodCode,
} from "./types";

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

  // 對應規格書「首頁外殼與主題色優化」三:根因是這一列在手機寬度下,
  // 「日期+開關」跟「時間區間選擇器」擠在同一個 flex-wrap 容器裡當「同一個」flex item,
  // 兩個原生 <input type="time"> 加起來的最小內容寬度比手機螢幕窄的卡片還寬,flex-wrap
  // 只能整組換行,不會把這組內部拆開,於是這個 item 自己把整個頁面 body 撐寬到需要左右拉。
  // 修正方式:改成「窄螢幕垂直堆疊(日期/開關一行,時間選擇器另起一行)、sm 以上維持原本橫向排列」,
  // 讓這一列的寬度需求不再依賴撐開卡片本身,而是自然往下換行,不是靠橫向捲動解決。
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
      <div className="flex items-center gap-3">
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
      </div>

      {!form.isClosed ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input
            type="time"
            className="min-w-0 rounded-md border border-input bg-background px-2 py-1 text-sm"
            value={form.openTime}
            disabled={saving}
            onChange={(e) => setForm((prev) => ({ ...prev, openTime: e.target.value }))}
            onBlur={() => void persist(form)}
          />
          <span className="text-muted-foreground">至</span>
          <input
            type="time"
            className="min-w-0 rounded-md border border-input bg-background px-2 py-1 text-sm"
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

// 建單功能擴充規格書 5.5/決策記錄 4:料錢成本功能開關。寫入權限比照 strict_conflict_check
// (規則 2.4/1.4),歸在 business_hours 這個 section_key 底下——這個頁面本身已經被
// RequireBusinessHoursAccess 擋過一次,能進到這頁的人(管理員或被授權 business_hours 的客服)
// 本來就有權限操作這個開關,不需要在元件內再另外判斷一次。
function MaterialCostEnabledToggle({ merchantId }: { merchantId: string }) {
  const featureFlagQueryKey = ["booking-module", "material-cost-enabled", merchantId] as const;
  const queryClient = useQueryClient();
  const { data: enabled, isLoading } = useQuery({
    queryKey: featureFlagQueryKey,
    queryFn: async () => {
      const value = await getFeatureFlag(merchantId, MATERIAL_COST_ENABLED_FEATURE_KEY);
      // 規格書 2.3:查無資料一律視為關閉(預設值關閉)。
      return value ?? false;
    },
  });

  async function handleToggle(checked: boolean) {
    try {
      await setFeatureFlag(merchantId, MATERIAL_COST_ENABLED_FEATURE_KEY, checked);
      await queryClient.invalidateQueries({ queryKey: featureFlagQueryKey });
      toast.success("已更新設定");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>料錢成本功能</CardTitle>
        <CardDescription>
          開啟後,建單/編輯表單會出現「料錢成本」勾選區塊,可以記錄這次服務預期會用掉的材料成本
          (不是訂單金額計算)。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <label className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5">
          <span className="text-sm text-foreground">
            {isLoading ? "載入中⋯" : enabled ? "已開啟" : "已關閉"}
          </span>
          <Switch checked={enabled ?? false} disabled={isLoading} onCheckedChange={handleToggle} />
        </label>
      </CardContent>
    </Card>
  );
}

// 模組 6(訂單管理)§4.7:商家稅金設定畫面。比照上面 MaterialCostEnabledToggle 的既有做法——
// 這個頁面本身已經被 RequireBusinessHoursAccess 擋過一次,能進到這頁的人(管理員或被授權
// business_hours 的客服)本來就有權限操作這個設定,不需要在元件內再另外判斷一次。
// 查無資料時 fallback 成 DEFAULT_MERCHANT_TAX_SETTINGS(useMerchantTaxSettings 已經處理過)。
function TaxSettingsCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const { data: taxSettings, isLoading } = useMerchantTaxSettings(merchantId);

  const [taxMode, setTaxMode] = useState<AmountAdjustmentMode>("percentage");
  const [taxValue, setTaxValue] = useState("5");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!taxSettings) return;
    setTaxMode(taxSettings.taxMode);
    setTaxValue(String(taxSettings.taxValue));
  }, [taxSettings]);

  async function handleSave() {
    const numericValue = Number(taxValue);
    if (Number.isNaN(numericValue) || numericValue < 0) {
      toast.error("請輸入正確的數字");
      return;
    }
    if (taxMode === "percentage" && numericValue > 100) {
      toast.error("百分比模式下,數字必須介於 0~100 之間");
      return;
    }
    setSaving(true);
    try {
      await upsertMerchantTaxSettings(merchantId, { taxMode, taxValue: numericValue });
      await queryClient.invalidateQueries({
        queryKey: ["booking-module", "merchant-tax-settings", merchantId],
      });
      toast.success("已更新稅金設定");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>稅金設定</CardTitle>
        <CardDescription>
          建單表單開啟稅金開關時,預設帶入這裡的模式跟數字(客服可以針對個別訂單再調整數字,但不能
          改變模式)。模式要改成別種,只能在這裡改。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={taxMode} onValueChange={(v) => setTaxMode(v as AmountAdjustmentMode)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed">{AMOUNT_ADJUSTMENT_MODE_LABELS.fixed}</SelectItem>
                <SelectItem value="percentage">{AMOUNT_ADJUSTMENT_MODE_LABELS.percentage}</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="number"
              min={0}
              max={taxMode === "percentage" ? 100 : undefined}
              step="0.01"
              className="w-32"
              value={taxValue}
              onChange={(e) => setTaxValue(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">
              {taxMode === "percentage" ? "%(0~100 的數字)" : "元(固定金額)"}
            </span>
            <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// 模組 9(支付方式)§3.1:商家層級「開放哪些付款方式」設定卡片,比照上面 TaxSettingsCard/
// MaterialCostEnabledToggle 的既有做法——這個頁面本身已經被 RequireBusinessHoursAccess 擋過一次,
// 能進到這頁的人本來就有權限操作這個設定,不需要在元件內再另外判斷一次。查無任何既有列(新商家/
// 從未設定過)時,畫面初始渲染套用 §1.3 的 fallback(現場付款打勾、其餘不打勾),不是全部不打勾
// (useMerchantPaymentMethodSettings 已經處理過 fallback)。每個核取方塊各自獨立呼叫 API
// (逐項 upsert),不做整批儲存按鈕——比照 MaterialCostEnabledToggle/StrictConflictCheckToggle
// 的既有互動模式(勾選即生效)。
function PaymentMethodSettingsCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["booking-module", "merchant-payment-method-settings", merchantId] as const;
  const { data: settings, isLoading } = useMerchantPaymentMethodSettings(merchantId);
  // 載入中或還沒回來時,先用 fallback 預設值渲染,避免畫面閃爍成「全部沒勾選」誤導使用者以為
  // 現場付款也要重新勾一次才生效(§3.1 邊界情況)。
  const effectiveSettings = settings ?? DEFAULT_MERCHANT_PAYMENT_METHOD_SETTINGS;

  async function handleToggle(code: PaymentMethodCode, checked: boolean) {
    try {
      await upsertMerchantPaymentMethodSetting(merchantId, code, checked);
      await queryClient.invalidateQueries({ queryKey });
      toast.success("已更新設定");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>付款方式設定</CardTitle>
        <CardDescription>
          勾選這間商家要開放客服在建單時選擇的付款方式。這裡只是標記客戶用什麼方式付款,
          不會真的串接金流,不會自動收款或對帳。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : (
          <div className="space-y-2">
            {PAYMENT_METHOD_CODES.map((code) => (
              <label
                key={code}
                className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5 text-sm text-foreground"
              >
                <Checkbox
                  checked={effectiveSettings[code]}
                  onCheckedChange={(checked) => void handleToggle(code, checked === true)}
                />
                {PAYMENT_METHOD_OPTIONS[code]}
              </label>
            ))}
          </div>
        )}
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
      <MaterialCostEnabledToggle merchantId={merchantId} />
      <TaxSettingsCard merchantId={merchantId} />
      <PaymentMethodSettingsCard merchantId={merchantId} />
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
