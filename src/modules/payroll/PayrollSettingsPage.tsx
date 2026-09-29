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
//
// ui-v1-full 第二階段第 2 批(2026-09-29,盤點 A6 / Q1):
//   - 抽成制 > 編輯(A6,每個服務項目一列)→ 全頁層 FullPageLayer size="wide";每一列改 SwitchRow
//     (開關開著才展開「模式 / 數值」),模式二選一改 ChoiceChipGroup;「尚未設定,目前抽成 0 元」改 `!` 常駐。
//   - 月薪制 > 編輯(Q1,只有 2 欄)→ **全頁層**(2026-09-29 使用者裁決:跟並排的抽成制編輯保持一致,
//     不要照「3 欄以內」規則改回小卡窗)。
//   - 商家層級設定:抽成基準二選一改 ChoiceChipGroup(每個選項含一行說明,直向排列);月折算天數的長說明
//     收進 `?`,常駐只留一句結論。
//   - 兩份服務人員清單改 ListCard:「編輯」是唯一主要動作;抽成制人員有尚未設定抽成的項目時整張變黃 +
//     待辦標籤(skill 二之五「需要處理的卡片整張變黃」)。
//   - 頁首改 PageHeader、載入中改骨架、空狀態改 EmptyState(+ 前往服務人員管理)。
// **只動外觀與版面,不動任何行為**:驗證、寫入時機(下拉切換立即存、數值 onBlur 存)、批量套用照舊。

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ActionBar,
  AlertNote,
  AttributeTag,
  ChoiceChipGroup,
  EmptyState,
  ErrorState,
  FieldAmountInput,
  FieldInput,
  FormField,
  FullPageLayer,
  FullPageLayerClose,
  FullPageLayerContent,
  ListCard,
  LoadingSkeleton,
  PageHeader,
  parseAmountInput,
  SwitchRow,
  TodoTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
  fetchStaffServiceCommissionRates,
  staffServiceCommissionRatesQueryKey,
  upsertMerchantPayrollSettings,
  upsertStaffSalarySettings,
  upsertStaffServiceCommissionRate,
  useMerchantPayrollSettings,
  useStaffSalarySettings,
  useStaffServiceCommissionRates,
} from "./api";
import {
  merchantUsesPieceRateCommission,
  shouldFlagCommissionAttention,
} from "./commissionAttention";
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

/** 抽成模式二選一的選項(比例 / 固定金額),白名單直接取 COMMISSION_MODE_LABELS 的 key。 */
const COMMISSION_MODE_OPTIONS = (Object.keys(COMMISSION_MODE_LABELS) as CommissionMode[]).map(
  (mode) => ({ value: mode, label: COMMISSION_MODE_LABELS[mode] }),
);

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
      <CardContent className="flex flex-col gap-5">
        {isLoading ? (
          <LoadingSkeleton variant="lines" rows={3} />
        ) : (
          <>
            <FormField label="【抽成制】抽成基準" required>
              {/* skill 二之七:單選用 ChoiceChipGroup(radiogroup 語意)。兩個選項各帶一行說明,所以直向
                  排列、每顆佔滿一行。值來自常數白名單,不是 Radix Select,沒有幽靈空值事件,原本
                  「為了寫法一致」套在 RadioGroup 上的 guardPhantomEmptyChange 這裡不再需要。 */}
              <ChoiceChipGroup
                aria-label="抽成基準"
                className="flex-col items-stretch"
                value={basisType}
                onValueChange={setBasisType}
                options={[
                  {
                    value: "gross",
                    label: (
                      <span className="flex flex-col items-start gap-0.5 text-left">
                        <span>{COMMISSION_BASIS_TYPE_LABELS.gross}</span>
                        <span className="text-xs font-normal leading-snug text-muted-foreground">
                          以訂單金額(已扣折扣、排除稅金)全額當作抽成基準,不扣除料錢成本。
                        </span>
                      </span>
                    ),
                  },
                  {
                    value: "net_of_material_cost",
                    label: (
                      <span className="flex flex-col items-start gap-0.5 text-left">
                        <span>{COMMISSION_BASIS_TYPE_LABELS.net_of_material_cost}</span>
                        <span className="text-xs font-normal leading-snug text-muted-foreground">
                          再扣除這筆訂單登記的料錢成本後,剩下的金額才當作抽成基準。到府派工這類會用到
                          料錢成本的商家可以考慮這個選項。
                        </span>
                      </span>
                    ),
                  },
                ]}
              />
            </FormField>

            {/* §十 10.1:這次拿掉商家手動填寫的固定天數,改成系統依「當月實際天數」自動計算
                (28~31 天),不需要另外設定,也不再是這裡可以編輯的欄位。
                skill 二:「規則怎麼算」屬於看過一次就懂的說明 ⇒ 收進 `?`,常駐只留一句結論。 */}
            <FormField
              label="【月薪制】月折算天數"
              helpLabel="說明:月折算天數怎麼算"
              help="假別扣款的「扣一天全薪」「扣一天薪水的某個百分比」兩種模式會用到這個數字,每個月會依那個月的實際天數自動換算,不是固定的一個數字。"
            >
              <p className="text-sm text-muted-foreground">
                系統依當月實際天數自動計算(28~31 天),不需要另外設定。
              </p>
            </FormField>

            <div>
              {/* 這一頁唯一的主要按鈕(skill 二之三:一個畫面只能有一顆)。 */}
              <Button
                type="button"
                variant="primary"
                size="touch"
                disabled={saving}
                onClick={handleSave}
              >
                {saving ? "儲存中⋯" : "儲存"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// =========================================================================
// 區塊二:抽成制服務人員清單(服務項目層級抽成設定)。
// =========================================================================

/** 單一服務項目那一列:開關(可接服務)+ 開關=開時顯示模式選擇/數值輸入框(決策6:
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

  const valueInputId = `commission-value-${item.id}`;

  return (
    <li>
      {/* skill 二之七:開關做成一整列(左邊「項目名稱 + 原價」、右邊開關),開著才展開底下的設定。 */}
      <SwitchRow
        title={item.name}
        description={`原價 ${Number(item.price)} 元`}
        checked={checked}
        onCheckedChange={onToggle}
      >
        {checked ? (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="抽成模式">
                {/* 2026-09-24 稽核修正(問題 3)當時的 Select 特別危險——onValueChange 裡會**立刻
                    呼叫 API 存檔**,一次幽靈空值事件就會把不合法的模式寫進資料庫。現在改成
                    ChoiceChipGroup(只有真的點擊 / 鍵盤切換才會觸發),沒有幽靈事件的問題,
                    所以不再需要 guardPhantomEmptyChange;「切換立即存檔」的行為照舊。 */}
                <ChoiceChipGroup
                  aria-label={`${item.name} 的抽成模式`}
                  value={mode}
                  disabled={saving}
                  onValueChange={(nextMode) => {
                    setMode(nextMode);
                    void persist(nextMode, value);
                  }}
                  options={COMMISSION_MODE_OPTIONS}
                />
              </FormField>
              <FormField
                label={mode === "percentage" ? "抽成比例(%)" : "每件抽成(元)"}
                htmlFor={valueInputId}
              >
                <FieldInput
                  id={valueInputId}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={mode === "percentage" ? 100 : undefined}
                  step="0.01"
                  className="tabular-nums"
                  disabled={saving}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onBlur={() => void persist(mode, value)}
                />
              </FormField>
            </div>
            {!hasRate ? (
              // skill 二:「現在的狀態跟使用者以為的不一樣」(開關開了,但抽成其實是 0)⇒ `!` 常駐。
              <AlertNote>尚未設定抽成,這個項目目前抽成 0 元。</AlertNote>
            ) : (
              <p className="text-xs tabular-nums text-muted-foreground">
                試算:1 件約 {previewAmount} 元
              </p>
            )}
          </div>
        ) : null}
      </SwitchRow>
    </li>
  );
}

// 全頁層(盤點 A6):受控開關,由 StaffCommissionRateRow 的「編輯」開啟。
function StaffServiceCommissionDialog({
  merchantId,
  staff,
  open,
  onOpenChange,
  onSaved,
}: {
  merchantId: string;
  staff: MerchantStaff;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
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
    <FullPageLayer open={open} onOpenChange={onOpenChange}>
      {/* size="wide":每個服務項目一列(開關 + 模式 + 數值),560px 的電腦面板會太擠。 */}
      <FullPageLayerContent
        size="wide"
        title={`${staff.name} 的抽成設定`}
        subtitle="逐一設定「可接服務」開關與每個服務項目的抽成,或先用批量套用一個統一的比例/金額,再個別調整。每一格改完會立刻存檔。"
        footer={
          <ActionBar>
            <FullPageLayerClose asChild>
              <Button type="button" variant="primary" size="touch">
                完成
              </Button>
            </FullPageLayerClose>
          </ActionBar>
        }
      >
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <p className="text-sm font-semibold text-foreground">整體抽成(批量套用)</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="模式">
                <ChoiceChipGroup
                  aria-label="批量套用的抽成模式"
                  value={batchMode}
                  onValueChange={setBatchMode}
                  options={COMMISSION_MODE_OPTIONS}
                />
              </FormField>
              <FormField
                label={batchMode === "percentage" ? "抽成比例(%)" : "每件抽成(元)"}
                htmlFor="batch-commission-value"
              >
                <FieldInput
                  id="batch-commission-value"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={batchMode === "percentage" ? 100 : undefined}
                  step="0.01"
                  className="tabular-nums"
                  value={batchValue}
                  onChange={(e) => setBatchValue(e.target.value)}
                />
              </FormField>
            </div>
            <div>
              <Button
                type="button"
                variant="neutral"
                size="touch"
                disabled={batchApplying}
                onClick={handleBatchApply}
              >
                {batchApplying ? "套用中⋯" : "批量套用到已開啟的項目"}
              </Button>
            </div>
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground tabular-nums">
              範例:一筆原價 1000 元、1 件的服務,套用這個設定可以拿到{" "}
              <strong>{batchPreviewAmount}</strong> 元抽成(僅供參考;只會套用到目前開關=開的
              項目,關掉的項目不受影響)。
            </p>
          </section>

          <section className="flex flex-col gap-2.5">
            <p className="text-sm font-semibold text-foreground">可接服務 & 抽成設定</p>
            {itemsLoading ? (
              <LoadingSkeleton variant="cards" rows={3} />
            ) : !activeServiceItems || activeServiceItems.length === 0 ? (
              <EmptyState
                title="這間商家目前沒有上架中的服務項目"
                description="先到服務項目管理新增並上架服務項目,回來這裡才有東西可以設定抽成。"
                action={
                  <Button asChild variant="neutral" size="touch">
                    <Link to="/app/service-items">前往服務項目管理</Link>
                  </Button>
                }
              />
            ) : (
              <ul className="flex flex-col gap-2.5">
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
          </section>
        </div>
      </FullPageLayerContent>
    </FullPageLayer>
  );
}

function PieceRateStaffSection({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const {
    data: staffList,
    isLoading,
    isError,
    refetch: refetchStaffList,
  } = useMerchantStaffList(merchantId);
  const pieceRateStaff = (staffList ?? []).filter((s) => s.compensation_type === "piece_rate");

  // 🔴 2026-09-30 QA:黃卡的守門條件要看「整份名單」,不是單一張卡自己算(理由與規則寫在
  // commissionAttention.ts)。所以這裡先把每一位的「可接服務數 / 已設抽成數」都撈出來,
  // 算出「這家商家到底有沒有在用逐項抽成」,再往下傳給每一張卡。
  // queryKey 跟下面每張卡自己用的那兩個 query 完全相同 ⇒ react-query 去重,不會多打 API。
  const serviceItemIdQueries = useQueries({
    queries: pieceRateStaff.map((staff) => ({
      queryKey: staffServiceItemIdsQueryKey(staff.id),
      queryFn: () => fetchStaffServiceItemIds(staff.id),
    })),
  });
  const rateQueries = useQueries({
    queries: pieceRateStaff.map((staff) => ({
      queryKey: staffServiceCommissionRatesQueryKey(staff.id),
      queryFn: () => fetchStaffServiceCommissionRates(staff.id),
    })),
  });
  const coverages = pieceRateStaff.map((_staff, i) => {
    const ids = serviceItemIdQueries[i]?.data ?? [];
    const rates = rateQueries[i]?.data;
    return {
      total: ids.length,
      configured: ids.filter((id) => rates?.has(id)).length,
    };
  });
  // 還在載入時先當成「沒在用」——寧可晚幾百毫秒才把該黃的標黃,也不要先閃一整頁黃色。
  const usesCommission = merchantUsesPieceRateCommission(coverages);

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
          <LoadingSkeleton variant="cards" rows={2} />
        ) : isError ? (
          // 🔴 2026-09-30 QA:原本查詢失敗會偽裝成「目前沒有抽成制的服務人員」。skill 二之八 出錯。
          <ErrorState
            title="讀不到服務人員名單"
            reason="可能是網路斷了,或你沒有查看服務人員的權限"
            onRetry={() => void refetchStaffList()}
          />
        ) : pieceRateStaff.length === 0 ? (
          <EmptyState
            title="目前沒有抽成制的服務人員"
            description="服務人員的計酬類型在服務人員管理裡設定,設成抽成制之後會列在這裡。"
            action={
              <Button asChild variant="neutral" size="touch">
                <Link to="/app/staff">前往服務人員管理</Link>
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2.5">
            {pieceRateStaff.map((staff) => (
              <StaffCommissionRateRow
                key={staff.id}
                merchantId={merchantId}
                staff={staff}
                merchantUsesCommission={usesCommission}
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
  merchantUsesCommission,
  onSaved,
}: {
  merchantId: string;
  staff: MerchantStaff;
  /** 這家商家整份名單裡有沒有任何一項抽成設定過(黃卡的守門條件,由 PieceRateStaffSection 算)。 */
  merchantUsesCommission: boolean;
  onSaved: () => void;
}) {
  const { data: serviceItemIds } = useQuery({
    queryKey: staffServiceItemIdsQueryKey(staff.id),
    queryFn: () => fetchStaffServiceItemIds(staff.id),
  });
  const { data: ratesMap } = useStaffServiceCommissionRates(staff.id);
  const [editOpen, setEditOpen] = useState(false);

  const total = serviceItemIds?.length ?? 0;
  const configured = (serviceItemIds ?? []).filter((id) => ratesMap?.has(id)).length;
  const unconfigured = total - configured;
  // skill 二之五:需要處理的卡片整張變黃(+ 待辦標籤)——沒有可接服務、或有項目還沒設抽成,
  // 都是「這個人的抽成算出來會是 0」的狀態,商家要去處理。
  // 🔴 但**先過守門條件**:「逐項抽成」是選配功能,沒在用的商家每一位都永遠「沒設抽成」,
  // 原本會讓整份名單永久全黃(= 黃色失去意義)。規則與使用者裁決寫在 commissionAttention.ts。
  const needsAttention = shouldFlagCommissionAttention(
    { total, configured },
    merchantUsesCommission,
  );

  return (
    <li>
      <ListCard
        title={staff.name}
        state={needsAttention ? "attention" : "default"}
        tags={
          // 標籤文字不變(資訊仍然要看得到),只有「要不要用警示色」跟著守門條件走:
          // 沒在用逐項抽成的商家 ⇒ 降成中性的屬性標籤(方角灰底,skill 二之四)。
          total === 0 ? (
            needsAttention ? (
              <TodoTag>尚未設定可接服務</TodoTag>
            ) : (
              <AttributeTag>尚未設定可接服務</AttributeTag>
            )
          ) : unconfigured > 0 ? (
            needsAttention ? (
              <TodoTag>{unconfigured} 項尚未設定抽成</TodoTag>
            ) : (
              <AttributeTag>{unconfigured} 項尚未設定抽成</AttributeTag>
            )
          ) : undefined
        }
        meta={
          total === 0
            ? "尚未設定任何可接服務項目"
            : `已設定 ${configured} 項服務的抽成,${unconfigured} 項尚未設定`
        }
        primaryAction={
          <Button type="button" variant="neutral" size="card" onClick={() => setEditOpen(true)}>
            編輯
          </Button>
        }
      />
      <StaffServiceCommissionDialog
        merchantId={merchantId}
        staff={staff}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={onSaved}
      />
    </li>
  );
}

// =========================================================================
// 區塊三:月薪制服務人員清單(月薪/月休天數參考)。
// =========================================================================
const SALARY_FORM_ID = "staff-salary-form";

// 全頁層(盤點 Q1,2026-09-29 使用者裁決:雖然只有 2 欄,跟並排的抽成制編輯一致 ⇒ 全頁層,不要改回小卡窗)。
function StaffSalarySettingsDialog({
  staff,
  payDaysPerMonth,
  open,
  onOpenChange,
  onSaved,
}: {
  staff: MerchantStaff;
  payDaysPerMonth: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { data: settings, isLoading } = useStaffSalarySettings(open ? staff.id : null);
  const [baseSalary, setBaseSalary] = useState("0");
  const [quotaDays, setQuotaDays] = useState("");
  const [saving, setSaving] = useState(false);
  // 月薪的欄位級錯誤(skill 二之七:框變紅 + 下面一行 `!` 說明)。
  const [baseSalaryError, setBaseSalaryError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBaseSalaryError(null);
    setBaseSalary(settings ? String(settings.monthly_base_salary) : "0");
    setQuotaDays(
      settings?.monthly_leave_quota_days !== undefined &&
        settings?.monthly_leave_quota_days !== null
        ? String(settings.monthly_leave_quota_days)
        : "",
    );
  }, [open, settings]);

  // 🔴 2026-09-30:月薪欄位換成 FieldAmountInput(type="text")之後原生的 min={0} step="1" 就沒了,
  // 所以解析一律走 parseAmountInput,並且傳 integerOnly(這一欄原本是 step="1",月薪不收小數)。
  // 試算文字也讀同一個解析結果,避免「畫面上算得出來、按儲存卻被擋」這種矛盾。
  const parsedBaseSalary = parseAmountInput(baseSalary, { integerOnly: true });
  const numericBaseSalary = parsedBaseSalary.ok ? parsedBaseSalary.value : Number.NaN;
  const dayRate = calculateDayRate(numericBaseSalary, payDaysPerMonth);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!parsedBaseSalary.ok) {
      setBaseSalaryError(parsedBaseSalary.error);
      return;
    }
    setBaseSalaryError(null);
    const numericQuota = quotaDays.trim() ? Number(quotaDays) : null;
    if (numericQuota !== null && (Number.isNaN(numericQuota) || numericQuota < 0)) {
      toast.error("月休天數不可為負數");
      return;
    }
    setSaving(true);
    try {
      await upsertStaffSalarySettings(staff.id, {
        monthlyBaseSalary: parsedBaseSalary.value,
        monthlyLeaveQuotaDays: numericQuota,
      });
      toast.success("已更新薪資設定");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <FullPageLayer open={open} onOpenChange={onOpenChange}>
      <FullPageLayerContent
        title={`${staff.name} 的薪資設定`}
        subtitle="月薪金額 + 月休天數(僅供參考,不影響扣款計算)。"
        footer={
          <ActionBar>
            <FullPageLayerClose asChild>
              <Button type="button" variant="neutral" size="touch">
                取消
              </Button>
            </FullPageLayerClose>
            <Button
              type="submit"
              form={SALARY_FORM_ID}
              variant="primary"
              size="touch"
              disabled={saving || isLoading}
            >
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </ActionBar>
        }
      >
        {isLoading ? (
          <LoadingSkeleton variant="lines" rows={3} />
        ) : (
          <form id={SALARY_FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-5">
            <FormField
              label="月薪金額"
              htmlFor="base-salary"
              required
              error={baseSalaryError}
              helpLabel="說明:月薪金額要怎麼填"
              help="只能填整數(不含小數點),例如 30000。"
            >
              <FieldAmountInput
                id="base-salary"
                value={baseSalary}
                onChange={(e) => {
                  setBaseSalary(e.target.value);
                  if (baseSalaryError) setBaseSalaryError(null);
                }}
              />
            </FormField>
            <FormField
              label="月休天數(參考,選填)"
              htmlFor="quota-days"
              helpLabel="說明:月休天數會用在哪裡"
              help="只是顯示在服務人員報表旁邊當作參考,不會牽動請假扣款計算(假別扣款請到「月薪人員假別設定」頁面個別調整)。"
            >
              <FieldInput
                id="quota-days"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.5"
                className="tabular-nums"
                value={quotaDays}
                onChange={(e) => setQuotaDays(e.target.value)}
              />
            </FormField>

            {!Number.isNaN(numericBaseSalary) ? (
              <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground tabular-nums">
                試算:以本月 {payDaysPerMonth} 天換算,一天薪水約{" "}
                <strong>{dayRate.toFixed(2)}</strong> 元。這就是假別扣款會用到的「一天薪水」;
                天數由系統依請假當月自動換算,不用另外設定(詳見上方「【月薪制】月折算天數」)。
              </p>
            ) : null}
          </form>
        )}
      </FullPageLayerContent>
    </FullPageLayer>
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
          <LoadingSkeleton variant="cards" rows={2} />
        ) : monthlySalaryStaff.length === 0 ? (
          <EmptyState
            title="目前沒有月薪制的服務人員"
            description="服務人員的計酬類型在服務人員管理裡設定,設成月薪制之後會列在這裡。"
            action={
              <Button asChild variant="neutral" size="touch">
                <Link to="/app/staff">前往服務人員管理</Link>
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2.5">
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
  const [editOpen, setEditOpen] = useState(false);

  return (
    <li>
      <ListCard
        title={staff.name}
        meta={
          <>
            月薪 {settings ? Number(settings.monthly_base_salary) : 0} 元
            {settings?.monthly_leave_quota_days !== undefined &&
            settings?.monthly_leave_quota_days !== null
              ? `,月休 ${settings.monthly_leave_quota_days} 天(參考)`
              : ""}
          </>
        }
        primaryAction={
          <Button type="button" variant="neutral" size="card" onClick={() => setEditOpen(true)}>
            編輯
          </Button>
        }
      />
      <StaffSalarySettingsDialog
        staff={staff}
        payDaysPerMonth={payDaysPerMonth}
        open={editOpen}
        onOpenChange={setEditOpen}
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
      <PageHeader
        backTo="/app/manage"
        title="抽成與薪資設定"
        description={`「${merchant!.name}」的抽成計算基準、抽成制服務人員的服務項目抽成、月薪制服務人員薪資設定。`}
      />

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
