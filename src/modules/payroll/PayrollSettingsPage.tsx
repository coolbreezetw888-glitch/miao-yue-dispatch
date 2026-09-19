// 對應模組 8(薪資與帳務)規格書 §4.1:抽成與薪資設定頁(新路由 /app/payroll-settings)。
// 三個區塊:商家層級設定(抽成基準/商家預設抽成比例/月折算天數)、按件計酬服務人員清單(個人
// 抽成比例覆寫)、月薪制服務人員清單(月薪/月休天數參考)。每個區塊都附帶前端純函式的即時預覽
// 計算機(previewCalculators.ts),純粹輔助理解,不影響任何實際計算——真正的計算永遠以資料庫
// 函式(compute_booking_commission/get_staff_monthly_payroll_summary)為準。

import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
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

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useMerchantStaffList } from "@/modules/staff-agent/context";
import type { MerchantStaff } from "@/modules/staff-agent/types";

import {
  removeStaffCommissionRate,
  upsertMerchantPayrollSettings,
  upsertStaffCommissionRate,
  upsertStaffSalarySettings,
  useMerchantPayrollSettings,
  useStaffCommissionRate,
  useStaffSalarySettings,
} from "./api";
import { previewCommissionAmount, calculateDayRate } from "./previewCalculators";
import { COMMISSION_BASIS_TYPE_LABELS, type CommissionBasisType } from "./types";
import { RequireCommissionSettingsAccess } from "./RequireCommissionSettingsAccess";

const payrollSettingsQueryKey = (merchantId: string) =>
  ["payroll-module", "merchant-payroll-settings", merchantId] as const;

// =========================================================================
// 區塊一:商家層級設定。
// =========================================================================
function MerchantPayrollSettingsCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useMerchantPayrollSettings(merchantId);

  const [basisType, setBasisType] = useState<CommissionBasisType>("gross");
  const [defaultRate, setDefaultRate] = useState("0");
  const [payDays, setPayDays] = useState("30");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setBasisType(settings.commission_basis_type as CommissionBasisType);
    setDefaultRate(String(settings.default_commission_rate_percentage));
    setPayDays(String(settings.pay_days_per_month));
  }, [settings]);

  const numericRate = Number(defaultRate);
  const numericPayDays = Number(payDays);

  async function handleSave() {
    if (Number.isNaN(numericRate) || numericRate < 0 || numericRate > 100) {
      toast.error("商家預設抽成比例必須介於 0~100 之間");
      return;
    }
    if (!Number.isInteger(numericPayDays) || numericPayDays < 1 || numericPayDays > 31) {
      toast.error("月折算天數必須介於 1~31 之間的整數");
      return;
    }
    setSaving(true);
    try {
      await upsertMerchantPayrollSettings(merchantId, {
        commissionBasisType: basisType,
        defaultCommissionRatePercentage: numericRate,
        payDaysPerMonth: numericPayDays,
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
          這裡的設定是所有按件計酬服務人員的預設值,沒有個人覆寫時套用這裡的數字。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : (
          <>
            <div>
              <Label>抽成基準</Label>
              <RadioGroup
                className="mt-2 space-y-2"
                value={basisType}
                onValueChange={(v) => setBasisType(v as CommissionBasisType)}
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
                  <RadioGroupItem
                    value="net_of_material_cost"
                    id="basis-net"
                    className="mt-0.5"
                  />
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
              <Label htmlFor="default-rate">商家預設抽成比例(%)</Label>
              <Input
                id="default-rate"
                className="mt-2 w-32"
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={defaultRate}
                onChange={(e) => setDefaultRate(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                沒有個人覆寫比例的按件計酬服務人員,套用這個比例。目前是 0%,代表還沒設定——請填入
                實際比例,系統不會自動幫你套用任何數字。
              </p>
            </div>

            <div>
              <Label htmlFor="pay-days">月折算天數</Label>
              <Input
                id="pay-days"
                className="mt-2 w-32"
                type="number"
                min={1}
                max={31}
                step="1"
                value={payDays}
                onChange={(e) => setPayDays(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                用來把月薪換算成一天的薪水,一般常見填 30。假別扣款的「扣一天全薪」「扣一天薪水的
                某個百分比」兩種模式會用到這個數字。
              </p>
            </div>

            {!Number.isNaN(numericRate) ? (
              <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                範例試算:一筆服務金額 1000 元的訂單,套用商家預設比例 {numericRate}%,服務人員可以
                拿到 <strong>{previewCommissionAmount(1000, numericRate)}</strong> 元抽成(僅供參考,
                實際金額以訂單完成時系統計算為準)。
              </p>
            ) : null}

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
// 區塊二:按件計酬服務人員清單(個人抽成比例覆寫)。
// =========================================================================
function StaffCommissionRateDialog({
  staff,
  merchantDefaultRate,
  trigger,
  onSaved,
}: {
  staff: MerchantStaff;
  merchantDefaultRate: number;
  trigger: React.ReactNode;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: info, isLoading } = useStaffCommissionRate(open ? staff.id : null);
  const [useOverride, setUseOverride] = useState(false);
  const [rate, setRate] = useState("0");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (info?.hasOverride && info.ratePercentage !== null) {
      setUseOverride(true);
      setRate(String(info.ratePercentage));
    } else {
      setUseOverride(false);
      setRate(String(merchantDefaultRate));
    }
  }, [open, info, merchantDefaultRate]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (useOverride) {
        const numericRate = Number(rate);
        if (Number.isNaN(numericRate) || numericRate < 0 || numericRate > 100) {
          toast.error("抽成比例必須介於 0~100 之間");
          setSaving(false);
          return;
        }
        await upsertStaffCommissionRate(staff.id, numericRate);
      } else {
        await removeStaffCommissionRate(staff.id);
      }
      toast.success("已更新抽成比例設定");
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  const previewRate = useOverride ? Number(rate) : merchantDefaultRate;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{staff.name} 的抽成比例</DialogTitle>
          <DialogDescription>
            可以個別覆寫這位服務人員的抽成比例,不覆寫則套用商家預設比例({merchantDefaultRate}%)。
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <RadioGroup
              value={useOverride ? "override" : "default"}
              onValueChange={(v) => setUseOverride(v === "override")}
              className="space-y-2"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="default" id="commission-mode-default" />
                <Label htmlFor="commission-mode-default" className="font-normal">
                  套用商家預設比例({merchantDefaultRate}%)
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="override" id="commission-mode-override" />
                <Label htmlFor="commission-mode-override" className="font-normal">
                  個別設定比例
                </Label>
              </div>
            </RadioGroup>

            {useOverride ? (
              <div>
                <Label htmlFor="staff-rate">個人抽成比例(%)</Label>
                <Input
                  id="staff-rate"
                  className="mt-2 w-32"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                />
              </div>
            ) : null}

            {!Number.isNaN(previewRate) ? (
              <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                範例試算:一筆服務金額 1000 元的訂單,{staff.name} 可以拿到{" "}
                <strong>{previewCommissionAmount(1000, previewRate)}</strong> 元抽成。
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

function PieceRateStaffSection({
  merchantId,
  merchantDefaultRate,
}: {
  merchantId: string;
  merchantDefaultRate: number;
}) {
  const queryClient = useQueryClient();
  const { data: staffList, isLoading } = useMerchantStaffList(merchantId);
  const pieceRateStaff = (staffList ?? []).filter((s) => s.compensation_type === "piece_rate");

  function refetch() {
    return queryClient.invalidateQueries({ queryKey: ["payroll-module", "staff-commission-rate"] });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>按件計酬服務人員</CardTitle>
        <CardDescription>逐位設定個人抽成比例,沒有設定的人套用商家預設比例</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : pieceRateStaff.length === 0 ? (
          <p className="text-sm text-muted-foreground">目前沒有按件計酬的服務人員。</p>
        ) : (
          <ul className="space-y-2">
            {pieceRateStaff.map((staff) => (
              <StaffCommissionRateRow
                key={staff.id}
                staff={staff}
                merchantDefaultRate={merchantDefaultRate}
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
  staff,
  merchantDefaultRate,
  onSaved,
}: {
  staff: MerchantStaff;
  merchantDefaultRate: number;
  onSaved: () => void;
}) {
  const { data: info } = useStaffCommissionRate(staff.id);
  const displayRate = info?.hasOverride ? info.ratePercentage : merchantDefaultRate;

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{staff.name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {info?.hasOverride
            ? `個人設定 ${displayRate}%`
            : `套用商家預設 ${merchantDefaultRate}%`}
        </p>
      </div>
      <StaffCommissionRateDialog
        staff={staff}
        merchantDefaultRate={merchantDefaultRate}
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
      settings?.monthly_leave_quota_days !== undefined && settings?.monthly_leave_quota_days !== null
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
                只是顯示在師傅報表旁邊當作參考,不會牽動請假扣款計算(假別扣款請到「假別設定」頁面
                個別調整)。
              </p>
            </div>

            {!Number.isNaN(numericBaseSalary) ? (
              <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                依目前月折算天數({payDaysPerMonth} 天)換算,一天薪水約{" "}
                <strong>{dayRate.toFixed(2)}</strong> 元(假別扣款「扣一天全薪」模式會用到這個數字)。
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
  const { data: settings } = useMerchantPayrollSettings(merchantId);

  const merchantDefaultRate = settings
    ? Number(settings.default_commission_rate_percentage)
    : 0;
  const payDaysPerMonth = settings ? Number(settings.pay_days_per_month) : 30;

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
          「{merchant!.name}」的抽成計算基準、按件計酬服務人員個人比例、月薪制服務人員薪資設定。
        </p>
      </div>

      <MerchantPayrollSettingsCard merchantId={merchantId} />
      <PieceRateStaffSection merchantId={merchantId} merchantDefaultRate={merchantDefaultRate} />
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
