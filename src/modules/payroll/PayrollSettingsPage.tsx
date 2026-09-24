// 對應模組 8(薪資與帳務)規格書 §4.1:抽成與薪資設定頁(新路由 /app/payroll-settings)。
// 三個區塊:商家層級設定(抽成基準/月折算天數)、抽成制服務人員清單(服務項目層級抽成設定)、
// 月薪制服務人員清單(月薪/月休天數參考)。每個區塊都附帶前端純函式的即時預覽計算機
// (previewCalculators.ts),純粹輔助理解,不影響任何實際計算——真正的計算永遠以資料庫
// 函式(compute_booking_commission/get_staff_monthly_payroll_summary)為準。
//
// 商家端三項調整規格書 §二 2.8.1/2.8.2:「商家預設抽成比例」欄位已經拿掉,抽成制服務人員的
// 抽成改成逐一服務項目分開設定(StaffServiceCommissionDialog),取代原本單一比例的
// StaffCommissionRateDialog。可接服務開關直接複用模組 3 既有的 addStaffServiceItem/
// removeStaffServiceItem/fetchStaffServiceItemIds(src/modules/staff-agent/api.ts,決策4——
// 複用既有介面,不重新發明)。

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

// 2026-09-24 稽核修正(問題 3):Radix Select 幽靈空值事件的共用防護,見該檔案開頭的完整說明。
import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useMerchantStaffList } from "@/modules/staff-agent/context";
import {
  addStaffServiceItem,
  fetchStaffServiceItemIds,
  removeStaffServiceItem,
} from "@/modules/staff-agent/api";
import type { MerchantStaff } from "@/modules/staff-agent/types";
import { useMerchantServiceItems } from "@/modules/service-items/context";
import type { ServiceItem } from "@/modules/service-items/types";

import {
  batchApplyStaffServiceCommissionRates,
  upsertMerchantPayrollSettings,
  upsertStaffSalarySettings,
  upsertStaffServiceCommissionRate,
  useMerchantPayrollSettings,
  useStaffSalarySettings,
  useStaffServiceCommissionRates,
} from "./api";
import { previewServiceCommission, calculateDayRate, getDaysInMonth } from "./previewCalculators";
import {
  COMMISSION_BASIS_TYPE_LABELS,
  COMMISSION_MODE_LABELS,
  type CommissionBasisType,
  type CommissionMode,
  type StaffServiceCommissionRate,
} from "./types";
import { RequireCommissionSettingsAccess } from "./RequireCommissionSettingsAccess";

const payrollSettingsQueryKey = (merchantId: string) =>
  ["payroll-module", "merchant-payroll-settings", merchantId] as const;

const staffServiceItemIdsQueryKey = (staffId: string) =>
  ["payroll-module", "staff-service-item-ids", staffId] as const;

// =========================================================================
// 區塊一:商家層級設定。
// =========================================================================
function MerchantPayrollSettingsCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useMerchantPayrollSettings(merchantId);

  const [basisType, setBasisType] = useState<CommissionBasisType>("gross");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setBasisType(settings.commission_basis_type as CommissionBasisType);
  }, [settings]);

  async function handleSave() {
    setSaving(true);
    try {
      await upsertMerchantPayrollSettings(merchantId, {
        commissionBasisType: basisType,
      });
      await queryClient.invalidateQueries({ queryKey: payrollSettingsQueryKey(merchantId) });
      toast.success("已更新抽成與薪資設定");
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>商家層級設定</CardTitle>
        <CardDescription>
          抽成計算基準,套用到所有抽成制服務人員;每個人實際抽成多少,到下方「抽成制服務人員」
          逐一設定。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : (
          <>
            <div>
              <Label>【抽成制】抽成基準</Label>
              {/* 2026-09-24 稽核修正(問題 3)的防禦性套用:這是 RadioGroup 不是 Select,
                  Radix RadioGroup 內部用的是隱藏的 <input type="radio">,**沒有**那個會補發
                  空字串的隱藏原生 <select>,所以嚴格說沒有幽靈空值事件的問題。
                  這裡仍然一併套上同一支防護,理由是:(1) basisType 一樣是 useEffect 等資料
                  回來才灌進去的,套上零風險;(2) 全專案的「值變更入口」寫法一致,之後有人把
                  RadioGroup 改成 Select 時不會漏掉防護。判斷條件用白名單。 */}
              <RadioGroup
                className="mt-2 space-y-2"
                value={basisType}
                onValueChange={guardPhantomEmptyChange<CommissionBasisType>(
                  setBasisType,
                  (v) => v in COMMISSION_BASIS_TYPE_LABELS,
                )}
              >
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="gross" id="basis-gross" className="mt-0.5" />
                  <Label htmlFor="basis-gross" className="font-normal">
                    {COMMISSION_BASIS_TYPE_LABELS.gross}
                    <span className="block text-xs text-muted-foreground">
                      以訂單金額(已扣折扣、排除稅金)全額當作抽成基準,不扣除料錢成本。
                    </span>
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="net_of_material_cost" id="basis-net" className="mt-0.5" />
                  <Label htmlFor="basis-net" className="font-normal">
                    {COMMISSION_BASIS_TYPE_LABELS.net_of_material_cost}
                    <span className="block text-xs text-muted-foreground">
                      再扣除這筆訂單登記的料錢成本後,剩下的金額才當作抽成基準。到府派工這類會用到
                      料錢成本的商家可以考慮這個選項。
                    </span>
                  </Label>
                </div>
              </RadioGroup>
            </div>

            <div>
              <Label>【月薪制】月折算天數</Label>
              {/* §十 10.1:這次拿掉商家手動填寫的固定天數,改成系統依「當月實際天數」自動計算
                  (28~31 天),不需要另外設定,也不再是這裡可以編輯的欄位。 */}
              <p className="mt-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                月折算天數依系統自動依當月實際天數計算(28~31 天),不需要另外設定。假別扣款的「扣
                一天全薪」「扣一天薪水的某個百分比」兩種模式會用到這個數字,每個月會依那個月的實際
                天數自動換算,不是固定的一個數字。
              </p>
            </div>

            <Button type="button" size="sm" disabled={saving} onClick={handleSave}>
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// =========================================================================
// 區塊二:抽成制服務人員清單(服務項目層級抽成設定)。
// =========================================================================

/** 單一服務項目那一列:開關(可接服務)+ 開關=開時顯示模式下拉選單/數值輸入框(決策6:
 * 開關=關時直接不渲染這兩個欄位,不是顯示但 disable)。 */
function ServiceCommissionRow({
  staffId,
  item,
  checked,
  rate,
  onToggle,
  onRateChanged,
}: {
  staffId: string;
  item: ServiceItem;
  checked: boolean;
  rate: StaffServiceCommissionRate | null | undefined;
  onToggle: (checked: boolean) => void;
  onRateChanged: () => void;
}) {
  const [mode, setMode] = useState<CommissionMode>(
    (rate?.commission_mode as CommissionMode) ?? "percentage",
  );
  const [value, setValue] = useState(rate ? String(rate.commission_value) : "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMode((rate?.commission_mode as CommissionMode) ?? "percentage");
    setValue(rate ? String(rate.commission_value) : "");
  }, [rate]);

  const hasRate = Boolean(rate);
  const numericValue = Number(value);
  const previewAmount = previewServiceCommission(
    Number(item.price),
    mode,
    Number.isFinite(numericValue) ? numericValue : 0,
    1,
  );

  async function persist(nextMode: CommissionMode, nextValueRaw: string) {
    if (nextValueRaw.trim() === "") return; // 空白視為還在輸入,onBlur 空白時不強制寫入 0
    const numeric = Number(nextValueRaw);
    if (Number.isNaN(numeric) || numeric < 0) {
      toast.error("抽成數值必須是不小於 0 的數字");
      return;
    }
    if (nextMode === "percentage" && numeric > 100) {
      toast.error("百分比模式下,數字必須介於 0~100 之間");
      return;
    }
    setSaving(true);
    try {
      await upsertStaffServiceCommissionRate(staffId, item.id, {
        commissionMode: nextMode,
        commissionValue: numeric,
      });
      onRateChanged();
    } catch (err) {
      toast.error("更新抽成設定失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="space-y-2 rounded-md border border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
          <p className="text-xs text-muted-foreground">原價 {Number(item.price)} 元</p>
        </div>
        <Switch checked={checked} onCheckedChange={onToggle} />
      </div>

      {checked ? (
        <div className="flex flex-wrap items-center gap-2">
          {/* 2026-09-24 稽核修正(問題 3):這個 Select 特別危險——onValueChange 裡會**立刻
              呼叫 API 存檔**(void persist(...)),所以一次幽靈空值事件不只是畫面變空白,
              而是直接把一筆不合法的抽成模式寫進資料庫。
              合法值是固定常數清單,用白名單判斷(取 COMMISSION_MODE_LABELS 的 key)。 */}
          <Select
            value={mode}
            disabled={saving}
            onValueChange={guardPhantomEmptyChange<CommissionMode>(
              (nextMode) => {
                setMode(nextMode);
                void persist(nextMode, value);
              },
              (v) => v in COMMISSION_MODE_LABELS,
            )}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="percentage">{COMMISSION_MODE_LABELS.percentage}</SelectItem>
              <SelectItem value="fixed_amount">{COMMISSION_MODE_LABELS.fixed_amount}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="number"
            min={0}
            max={mode === "percentage" ? 100 : undefined}
            step="0.01"
            className="w-28"
            disabled={saving}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => void persist(mode, value)}
          />
          <span className="text-xs text-muted-foreground">
            {mode === "percentage" ? "%" : "元/件"}
          </span>
          {!hasRate ? (
            <span className="text-xs text-warn">尚未設定,目前抽成 0 元</span>
          ) : (
            <span className="text-xs text-muted-foreground">試算:1 件約 {previewAmount} 元</span>
          )}
        </div>
      ) : null}
    </li>
  );
}

function StaffServiceCommissionDialog({
  merchantId,
  staff,
  trigger,
  onSaved,
}: {
  merchantId: string;
  staff: MerchantStaff;
  trigger: React.ReactNode;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const serviceItemIdsKey = staffServiceItemIdsQueryKey(staff.id);
  const { data: serviceItemIds } = useQuery({
    queryKey: serviceItemIdsKey,
    queryFn: () => fetchStaffServiceItemIds(staff.id),
    enabled: open,
  });

  // 決策4/§2.8.2:逐一列出這間商家所有 status='active' 的服務項目(對外介面
  // useMerchantServiceItems),不是只列這位服務人員已經接的項目——商家可能想直接在這裡新增
  // 這位服務人員可以接的項目。
  const { data: activeServiceItems, isLoading: itemsLoading } = useMerchantServiceItems(
    open ? merchantId : null,
  );
  const { data: ratesMap } = useStaffServiceCommissionRates(open ? staff.id : null);

  const [batchMode, setBatchMode] = useState<CommissionMode>("percentage");
  const [batchValue, setBatchValue] = useState("0");
  const [batchApplying, setBatchApplying] = useState(false);

  const selectedIds = useMemo(() => new Set(serviceItemIds ?? []), [serviceItemIds]);

  async function refetchAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: serviceItemIdsKey }),
      queryClient.invalidateQueries({
        queryKey: ["payroll-module", "staff-service-commission-rates", staff.id],
      }),
    ]);
    onSaved();
  }

  async function handleToggleServiceItem(serviceItemId: string, checked: boolean) {
    try {
      if (checked) {
        await addStaffServiceItem(staff.id, serviceItemId);
      } else {
        await removeStaffServiceItem(staff.id, serviceItemId);
      }
      await refetchAll();
    } catch (err) {
      toast.error("更新可接服務失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleBatchApply() {
    const numericValue = Number(batchValue);
    if (Number.isNaN(numericValue) || numericValue < 0) {
      toast.error("請輸入不小於 0 的數字");
      return;
    }
    if (batchMode === "percentage" && numericValue > 100) {
      toast.error("百分比模式下,數字必須介於 0~100 之間");
      return;
    }
    const targetIds = Array.from(selectedIds);
    if (targetIds.length === 0) {
      toast.error("這位服務人員目前沒有任何可接服務項目,請先開啟下方的可接服務開關");
      return;
    }
    setBatchApplying(true);
    try {
      await batchApplyStaffServiceCommissionRates(staff.id, targetIds, batchMode, numericValue);
      await refetchAll();
      toast.success("已批量套用抽成設定");
    } catch (err) {
      toast.error("批量套用失敗", { description: getErrorMessage(err) });
    } finally {
      setBatchApplying(false);
    }
  }

  const numericBatchValue = Number(batchValue);
  const batchPreviewAmount = previewServiceCommission(
    1000,
    batchMode,
    Number.isFinite(numericBatchValue) ? numericBatchValue : 0,
    1,
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{staff.name} 的抽成設定</DialogTitle>
          <DialogDescription>
            逐一設定「可接服務」開關與每個服務項目的抽成,或先用下方批量套用一個統一的比例/金額,
            再個別調整成不同的比例或金額。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-3 rounded-md border border-border p-4">
            <p className="text-sm font-medium text-foreground">整體抽成(批量套用)</p>
            {/* 同上:RadioGroup 本身沒有幽靈空值事件的問題,這裡是為了寫法一致而一併套上。 */}
            <RadioGroup
              className="flex flex-wrap gap-4"
              value={batchMode}
              onValueChange={guardPhantomEmptyChange<CommissionMode>(
                setBatchMode,
                (v) => v in COMMISSION_MODE_LABELS,
              )}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="percentage" id="batch-mode-percentage" />
                <Label htmlFor="batch-mode-percentage" className="font-normal">
                  {COMMISSION_MODE_LABELS.percentage}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="fixed_amount" id="batch-mode-fixed" />
                <Label htmlFor="batch-mode-fixed" className="font-normal">
                  {COMMISSION_MODE_LABELS.fixed_amount}
                </Label>
              </div>
            </RadioGroup>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="number"
                min={0}
                max={batchMode === "percentage" ? 100 : undefined}
                step="0.01"
                className="w-32"
                value={batchValue}
                onChange={(e) => setBatchValue(e.target.value)}
              />
              <span className="text-sm text-muted-foreground">
                {batchMode === "percentage" ? "%" : "元/件"}
              </span>
              <Button type="button" size="sm" disabled={batchApplying} onClick={handleBatchApply}>
                {batchApplying ? "套用中⋯" : "批量套用"}
              </Button>
            </div>
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              範例:一筆原價 1000 元、1 件的服務,套用這個設定可以拿到{" "}
              <strong>{batchPreviewAmount}</strong> 元抽成(僅供參考;只會套用到目前開關=開的
              項目,關掉的項目不受影響)。
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">可接服務 & 抽成設定</p>
            {itemsLoading ? (
              <p className="text-sm text-muted-foreground">載入中⋯</p>
            ) : !activeServiceItems || activeServiceItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">這間商家目前沒有上架中的服務項目。</p>
            ) : (
              <ul className="space-y-2">
                {activeServiceItems.map((item) => (
                  <ServiceCommissionRow
                    key={item.id}
                    staffId={staff.id}
                    item={item}
                    checked={selectedIds.has(item.id)}
                    rate={ratesMap?.get(item.id)}
                    onToggle={(checked) => handleToggleServiceItem(item.id, checked)}
                    onRateChanged={refetchAll}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" size="sm" onClick={() => setOpen(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PieceRateStaffSection({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const { data: staffList, isLoading } = useMerchantStaffList(merchantId);
  const pieceRateStaff = (staffList ?? []).filter((s) => s.compensation_type === "piece_rate");

  function refetch() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: ["payroll-module", "staff-service-item-ids"] }),
      queryClient.invalidateQueries({
        queryKey: ["payroll-module", "staff-service-commission-rates"],
      }),
    ]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>抽成制服務人員</CardTitle>
        <CardDescription>
          逐一設定每位服務人員每個服務項目的抽成,沒有設定的項目視為 0 元
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : pieceRateStaff.length === 0 ? (
          <p className="text-sm text-muted-foreground">目前沒有抽成制的服務人員。</p>
        ) : (
          <ul className="space-y-2">
            {pieceRateStaff.map((staff) => (
              <StaffCommissionRateRow
                key={staff.id}
                merchantId={merchantId}
                staff={staff}
                onSaved={refetch}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StaffCommissionRateRow({
  merchantId,
  staff,
  onSaved,
}: {
  merchantId: string;
  staff: MerchantStaff;
  onSaved: () => void;
}) {
  const { data: serviceItemIds } = useQuery({
    queryKey: staffServiceItemIdsQueryKey(staff.id),
    queryFn: () => fetchStaffServiceItemIds(staff.id),
  });
  const { data: ratesMap } = useStaffServiceCommissionRates(staff.id);

  const total = serviceItemIds?.length ?? 0;
  const configured = (serviceItemIds ?? []).filter((id) => ratesMap?.has(id)).length;
  const unconfigured = total - configured;

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{staff.name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {total === 0
            ? "尚未設定任何可接服務項目"
            : `已設定 ${configured} 項服務的抽成,${unconfigured} 項尚未設定`}
        </p>
      </div>
      <StaffServiceCommissionDialog
        merchantId={merchantId}
        staff={staff}
        trigger={
          <Button variant="outline" size="sm">
            編輯
          </Button>
        }
        onSaved={onSaved}
      />
    </li>
  );
}

// =========================================================================
// 區塊三:月薪制服務人員清單(月薪/月休天數參考)。
// =========================================================================
function StaffSalarySettingsDialog({
  staff,
  payDaysPerMonth,
  trigger,
  onSaved,
}: {
  staff: MerchantStaff;
  payDaysPerMonth: number;
  trigger: React.ReactNode;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: settings, isLoading } = useStaffSalarySettings(open ? staff.id : null);
  const [baseSalary, setBaseSalary] = useState("0");
  const [quotaDays, setQuotaDays] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBaseSalary(settings ? String(settings.monthly_base_salary) : "0");
    setQuotaDays(
      settings?.monthly_leave_quota_days !== undefined &&
        settings?.monthly_leave_quota_days !== null
        ? String(settings.monthly_leave_quota_days)
        : "",
    );
  }, [open, settings]);

  const numericBaseSalary = Number(baseSalary);
  const dayRate = calculateDayRate(numericBaseSalary, payDaysPerMonth);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (Number.isNaN(numericBaseSalary) || numericBaseSalary < 0) {
      toast.error("月薪金額不可為負數");
      return;
    }
    const numericQuota = quotaDays.trim() ? Number(quotaDays) : null;
    if (numericQuota !== null && (Number.isNaN(numericQuota) || numericQuota < 0)) {
      toast.error("月休天數不可為負數");
      return;
    }
    setSaving(true);
    try {
      await upsertStaffSalarySettings(staff.id, {
        monthlyBaseSalary: numericBaseSalary,
        monthlyLeaveQuotaDays: numericQuota,
      });
      toast.success("已更新薪資設定");
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{staff.name} 的薪資設定</DialogTitle>
          <DialogDescription>月薪金額 + 月休天數(僅供參考,不影響扣款計算)。</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="base-salary">月薪金額(元)</Label>
              <Input
                id="base-salary"
                className="mt-2 w-40"
                type="number"
                min={0}
                step="1"
                value={baseSalary}
                onChange={(e) => setBaseSalary(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="quota-days">月休天數(參考,選填)</Label>
              <Input
                id="quota-days"
                className="mt-2 w-40"
                type="number"
                min={0}
                step="0.5"
                value={quotaDays}
                onChange={(e) => setQuotaDays(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                只是顯示在服務人員報表旁邊當作參考,不會牽動請假扣款計算(假別扣款請到「月薪人員假別設定」
                頁面個別調整)。
              </p>
            </div>

            {!Number.isNaN(numericBaseSalary) ? (
              <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                試算:以本月 {payDaysPerMonth} 天換算,一天薪水約{" "}
                <strong>{dayRate.toFixed(2)}</strong> 元。這就是假別扣款會用到的「一天薪水」;
                天數由系統依請假當月自動換算,不用另外設定(詳見上方「【月薪制】月折算天數」)。
              </p>
            ) : null}

            <DialogFooter>
              <Button type="submit" disabled={saving}>
                {saving ? "儲存中⋯" : "儲存"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MonthlySalaryStaffSection({
  merchantId,
  payDaysPerMonth,
}: {
  merchantId: string;
  payDaysPerMonth: number;
}) {
  const queryClient = useQueryClient();
  const { data: staffList, isLoading } = useMerchantStaffList(merchantId);
  const monthlySalaryStaff = (staffList ?? []).filter(
    (s) => s.compensation_type === "monthly_salary",
  );

  function refetch() {
    return queryClient.invalidateQueries({ queryKey: ["payroll-module", "staff-salary-settings"] });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>月薪制服務人員</CardTitle>
        <CardDescription>逐位設定月薪金額與月休天數(參考用)</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : monthlySalaryStaff.length === 0 ? (
          <p className="text-sm text-muted-foreground">目前沒有月薪制的服務人員。</p>
        ) : (
          <ul className="space-y-2">
            {monthlySalaryStaff.map((staff) => (
              <MonthlySalaryStaffRow
                key={staff.id}
                staff={staff}
                payDaysPerMonth={payDaysPerMonth}
                onSaved={refetch}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function MonthlySalaryStaffRow({
  staff,
  payDaysPerMonth,
  onSaved,
}: {
  staff: MerchantStaff;
  payDaysPerMonth: number;
  onSaved: () => void;
}) {
  const { data: settings } = useStaffSalarySettings(staff.id);

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{staff.name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          月薪 {settings ? Number(settings.monthly_base_salary) : 0} 元
          {settings?.monthly_leave_quota_days !== undefined &&
          settings?.monthly_leave_quota_days !== null
            ? `,月休 ${settings.monthly_leave_quota_days} 天(參考)`
            : ""}
        </p>
      </div>
      <StaffSalarySettingsDialog
        staff={staff}
        payDaysPerMonth={payDaysPerMonth}
        trigger={
          <Button variant="outline" size="sm">
            編輯
          </Button>
        }
        onSaved={onSaved}
      />
    </li>
  );
}

// =========================================================================
// 主頁面
// =========================================================================
function PayrollSettingsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;

  // §十 10.1:「月折算天數」不再是商家設定值,改成系統依當月實際天數動態計算。這裡只是給下面
  // 月薪制服務人員區塊的「即時預覽計算機」用「本月」的實際天數試算,純粹輔助理解,不是任何寫入
  // 依據——真正的計算永遠以資料庫函式(private.compute_staff_payroll)在查詢當下實際那個年月
  // 算出的天數為準。
  const now = new Date();
  const payDaysPerMonth = getDaysInMonth(now.getFullYear(), now.getMonth() + 1);

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">抽成與薪資設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」的抽成計算基準、抽成制服務人員的服務項目抽成、月薪制服務人員薪資
          設定。
        </p>
      </div>

      <MerchantPayrollSettingsCard merchantId={merchantId} />
      <PieceRateStaffSection merchantId={merchantId} />
      <MonthlySalaryStaffSection merchantId={merchantId} payDaysPerMonth={payDaysPerMonth} />
    </main>
  );
}

export default function PayrollSettingsPage() {
  return (
    <RequireCommissionSettingsAccess>
      <PayrollSettingsPageInner />
    </RequireCommissionSettingsAccess>
  );
}
