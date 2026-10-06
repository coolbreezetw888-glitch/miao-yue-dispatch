// 模組 12 §4.1:匯入精靈(新路由 /app/data-import，僅商家管理員可見)。
// 上傳 CSV → 欄位對應 → 數值對應(僅歷史訂單需要) → 預覽 → 確認匯入 → 結果報告。
// 涵蓋會員匯入(3.1)跟歷史訂單匯入(3.4)兩種類型，共用同一套精靈骨架(名詞對照「匯入精靈」)。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader;「匯入紀錄」不是這一頁的主要動作、而是去另一個頁面 ⇒ ② 次要(二之三)。
//   - 所有欄位改 FormField + 共用欄位元件(FieldInput / FieldSelect);必填用紅色 `*`。
//   - 🔴 欄位對應的下拉與「選擇既有服務人員」的下拉,選項都來自使用者上傳的 CSV 表頭 / 資料庫的
//     服務人員清單(動態值)⇒ 一律套 guardPhantomEmptyChange。這一頁踩到幽靈空值的風險最高:
//     CSV 解析完成之後才會有表頭可選(值是在掛載之後才灌進來的),正是 radixSelectGuard.ts 開頭
//     描述的那個時序。欄位對應被洗成空字串 = 商家對好的欄位突然不見了,而且完全不知道為什麼。
//   - 每個步驟只有一顆 ① 主要按鈕(下一步 / 確認匯入 / 查看匯入紀錄),「上一步」是 ② 次要。
//     步驟一的「會員資料 / 歷史訂單」是**兩個地位相同的選項**,所以兩顆都用 ② 次要 ——
//     沒有哪一個是「你最可能要做的那件事」,硬把其中一顆做成主要反而是誤導。
//   - 確認匯入窗改小卡窗殼 CardAlertDialog;🔴 **不標紅**:匯入不刪任何資料,而且「匯入紀錄」
//     頁面可以復原(有條件)。「送出後會立即寫入資料庫」「復原有時效與條件限制」屬於
//     「按下去會發生什麼不可逆的事」⇒ 用 🟡 常駐 `!`(二)。
//   - 🔴 兩處寫死的 text-emerald-600 改用語意色 token text-success-strong(skill 一:不要在
//     元件裡寫死顏色;寫死的色碼在深色模式下對比會不夠)。
//   - 🔴 用語:歷史訂單 CSS 模板的示範服務人員姓名從「王」姓加冷氣業舊稱的寫法改成「陳美美」。skill 二之二明寫
//     「畫面文字、通知訊息、錯誤訊息、示範資料、CSV 範本一律用『服務人員』」,不可以用舊稱
//     (舊稱是冷氣產業的講法,這套系統要給美甲 / 美容 / 寵物美容 / 到府清潔各行各業用)。
//
// 📌 步驟四「預覽」刻意**維持多欄表格**,沒有改成卡片(skill 一「列表一律卡片式」的例外):
//    這張表的用途是「檢查我的 CSS 欄位有沒有對到正確的秒約欄位」,必須讓同一欄的值上下對齊才
//    看得出對錯 —— 換成一張卡一筆就失去這個功能。它不是「一筆資料一張卡、可以操作」的名單。
//    這是 skill 沒有寫到的情境,已列入回報請主腦裁決。
//
// **只動外觀,不動行為**:六個步驟的流程與可否前進的判斷(canGoToPreview)、CSV 解析與筆數上限、
// 欄位對應、建立新服務人員的驗證、匯入 API 呼叫、失敗清單下載、所有 data-testid 全部照舊。

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import {
  AlertNote,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  CardAlertDialogTrigger,
  FieldInput,
  FieldSelect,
  FormField,
  PageHeader,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  buildCsvContent,
  downloadCsv,
  parseCsv,
  applyColumnMapping,
  type ParsedCsv,
} from "@/lib/csv";
import { supabase } from "@/integrations/supabase/client";
import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { isValidTaiwanMobilePhone, TW_MOBILE_PHONE_ERROR_MESSAGE } from "@/lib/validation";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { addMerchantStaff } from "@/modules/staff-agent/api";
import { useMerchantStaffList } from "@/modules/staff-agent/context";

import { importHistoricalBookingsBatch, importMembersBatch, parseErrorReport } from "./api";
import { buildFailedRowsCsv } from "./failedRowsCsv";
import { checkImportRowPreview, phoneRequiredForMembers } from "./importRowPreview";
import { RequireDataImportAccess } from "./RequireDataImportAccess";
import {
  HISTORICAL_BOOKING_IMPORT_TARGET_FIELDS,
  MEMBER_IMPORT_TARGET_FIELDS,
  type BulkOperationErrorItem,
  type ColumnMapping,
  type ImportKind,
  type MemberImportWriteMode,
} from "./types";

const MAX_ROWS = 2000;

// SPECS-INDEX #603(§10.4):會員/歷史訂單各自的 CSV 模板。欄位對照 types.ts 的
// MEMBER_IMPORT_TARGET_FIELDS/HISTORICAL_BOOKING_IMPORT_TARGET_FIELDS(實際匯入解析邏輯的
// 目標欄位),確保模板不是自說自話。歷史訂單模板依規格書 §10.4 只列出核心 9 個欄位(不含
// Email/服務內容描述/小計折扣稅金分項/付款方式/會員電話這些進階選填欄位——這些欄位商家如果
// 需要，可以在步驟二自行把 CSV 多加的欄位對應上去，不影響模板本身的最小可用性)。
// ⚠️ 維護提醒:之後 3.1/3.4 的欄位對應邏輯如果調整，這兩個模板要同步更新。
function buildMemberImportTemplate(): { filename: string; csv: string } {
  const headers = ["姓名", "電話", "Email", "生日", "備註", "推薦人電話/推薦碼", "起始點數餘額"];
  const example = [
    "王小明",
    "0912345678",
    "example@example.com",
    "1990-01-01",
    "VIP 客戶",
    "0922333444",
    "100",
  ];
  return { filename: "會員資料匯入模板.csv", csv: buildCsvContent(headers, [example]) };
}

function buildHistoricalBookingImportTemplate(): { filename: string; csv: string } {
  const headers = [
    "客戶姓名",
    "客戶電話",
    "服務人員",
    "預約日期時間",
    "服務時長分鐘數",
    "訂單狀態",
    "最終金額",
    "客戶地址",
    "客戶備註",
  ];
  const example = [
    "陳小華",
    "0933222111",
    // 🔴 skill 二之二:示範資料與 CSV 範本一律用「服務人員」的用語,不可以出現舊稱
    //    (舊稱是冷氣產業的講法,這套系統要給美甲 / 美容 / 寵物美容 / 到府清潔各行各業用)。
    "陳美美",
    "2024-01-15 14:00",
    "90",
    "已完成",
    "1200",
    "台北市中山區示範路1號",
    "首次來店",
  ];
  return { filename: "歷史訂單匯入模板.csv", csv: buildCsvContent(headers, [example]) };
}

type WizardStep = "type" | "upload" | "value-mapping" | "preview" | "confirm" | "result";

interface ImportResultSummary {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  errors: BulkOperationErrorItem[];
}

function ImportWizardPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const { data: staffList } = useMerchantStaffList(merchantId);
  // 步驟四預覽的逐列預檢(原本的 rowLooksValid)在 SPECS-INDEX #824 抽到 ./importRowPreview.ts,
  // 讓它能被 Vitest 單獨測試;#618 那段「電話不再必填」的變更紀錄也一起搬過去了。

  const [step, setStep] = useState<WizardStep>("type");
  const [importKind, setImportKind] = useState<ImportKind | null>(null);
  const [writeMode, setWriteMode] = useState<MemberImportWriteMode>("insert_only");
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [staffValueMapping, setStaffValueMapping] = useState<Record<string, string>>({});
  // SPECS-INDEX #632:步驟三「建立新服務人員」現在需要另外收集一個手機號碼(§595/§596 之後
  // merchant_staff.phone 已經是 NOT NULL + 格式檢查),每個不重複的服務人員文字值各自有自己的
  // 輸入框草稿值,key 是 CSV 裡的服務人員文字姓名(跟 staffValueMapping 用同一組 key)。
  const [newStaffPhoneDrafts, setNewStaffPhoneDrafts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResultSummary | null>(null);
  const [rawFailedRows, setRawFailedRows] = useState<Record<string, unknown>[]>([]);

  const targetFields =
    importKind === "members"
      ? MEMBER_IMPORT_TARGET_FIELDS
      : HISTORICAL_BOOKING_IMPORT_TARGET_FIELDS;

  const staffColumnHeader = mapping["staff_name"];
  const staffColumnIndex =
    parsed && staffColumnHeader ? parsed.headers.indexOf(staffColumnHeader) : -1;

  const distinctStaffNames = useMemo(() => {
    if (!parsed || staffColumnIndex < 0) return [];
    const set = new Set<string>();
    for (const row of parsed.rows) {
      const v = (row[staffColumnIndex] ?? "").trim();
      if (v) set.add(v);
    }
    return Array.from(set);
  }, [parsed, staffColumnIndex]);

  const mappedRows = useMemo(() => {
    if (!parsed) return [];
    const rows = applyColumnMapping(parsed.headers, parsed.rows, mapping);
    return rows.map((row, idx) => {
      const withRowNumber: Record<string, unknown> = { ...row, row_number: idx + 1 };
      if (importKind === "historical_bookings") {
        const staffName = row["staff_name"];
        withRowNumber["staff_id"] = staffName ? (staffValueMapping[staffName] ?? null) : null;
        delete withRowNumber["staff_name"];
      }
      if (importKind === "members" && row["starting_points_balance"] !== undefined) {
        const n = Number(row["starting_points_balance"]);
        withRowNumber["starting_points_balance"] =
          row["starting_points_balance"] === "" || Number.isNaN(n) ? null : n;
      }
      return withRowNumber;
    });
  }, [parsed, mapping, importKind, staffValueMapping]);

  async function handleFileUpload(file: File) {
    try {
      const result = await parseCsv(file);
      if (result.rows.length > MAX_ROWS) {
        toast.error(
          `檔案筆數過多(${result.rows.length} 筆)，單批匯入最多 ${MAX_ROWS} 筆，請分批匯入`,
        );
        return;
      }
      if (result.rows.length === 0) {
        toast.error("這個檔案沒有任何資料列");
        return;
      }
      setParsed(result);
      setMapping({});
      setStaffValueMapping({});
    } catch (err) {
      toast.error("讀取檔案失敗", { description: getErrorMessage(err) });
    }
  }

  function handleMappingChange(fieldKey: string, header: string) {
    setMapping((prev) => ({ ...prev, [fieldKey]: header === "__none__" ? "" : header }));
  }

  async function handleCreateNewStaff(name: string) {
    // SPECS-INDEX #632:merchant_staff.phone 現在是 NOT NULL + 台灣手機號碼格式檢查(09 開頭
    // 共 10 碼),這裡套用跟既有服務人員新增表單(StaffListPage.tsx §8.1)、客服邀請表單
    // (AgentListPage.tsx §8.2)完全相同的驗證規則,共用同一支 isValidTaiwanMobilePhone,
    // 不重寫一份新的正規表示式判斷(§8.3 邊界情況的既有要求)。
    const trimmedPhone = (newStaffPhoneDrafts[name] ?? "").trim();
    if (!trimmedPhone) {
      toast.error("請填寫這位新服務人員的手機號碼");
      return;
    }
    if (!isValidTaiwanMobilePhone(trimmedPhone)) {
      toast.error(TW_MOBILE_PHONE_ERROR_MESSAGE);
      return;
    }
    try {
      const created = await addMerchantStaff(merchantId, { name, phone: trimmedPhone });
      setStaffValueMapping((prev) => ({ ...prev, [name]: created.id }));
      toast.success(`已建立新服務人員「${name}」`);
    } catch (err) {
      toast.error("建立服務人員失敗", { description: getErrorMessage(err) });
    }
  }

  function canGoToPreview(): boolean {
    if (!parsed) return false;
    const requiredFields = targetFields.filter((f) => f.required && f.key !== "staff_name");
    for (const f of requiredFields) {
      if (!mapping[f.key]) return false;
    }
    if (importKind === "historical_bookings") {
      if (!mapping["staff_name"]) return false;
      if (distinctStaffNames.some((name) => !staffValueMapping[name])) return false;
    }
    return true;
  }

  async function handleConfirmImport() {
    if (!importKind) return;
    setSubmitting(true);
    try {
      let operationId: string;
      if (importKind === "members") {
        operationId = await importMembersBatch(merchantId, writeMode, mappedRows);
      } else {
        operationId = await importHistoricalBookingsBatch(merchantId, mappedRows);
      }

      // 4.1 步驟五送出後直接查詢這次批次的統計結果，顯示在步驟六(結果報告)。這裡直接查詢
      // merchant_bulk_operations 是本模組(模組 12)自己的資料表，不是繞過其他模組的邊界。
      const { data, error } = await supabase
        .from("merchant_bulk_operations")
        .select("total_rows, success_rows, failed_rows, skipped_duplicate_rows, error_report")
        .eq("id", operationId)
        .single();
      if (error) throw error;

      const errors = parseErrorReport(data.error_report);
      setResult({
        total: data.total_rows,
        success: data.success_rows,
        failed: data.failed_rows,
        skipped: data.skipped_duplicate_rows,
        errors,
      });
      setRawFailedRows(errors.map((e) => e.raw_data));
      setStep("result");
      toast.success("匯入完成");
    } catch (err) {
      toast.error("匯入失敗", { description: getErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }

  function handleDownloadTemplate() {
    if (!importKind) return;
    const { filename, csv } =
      importKind === "members"
        ? buildMemberImportTemplate()
        : buildHistoricalBookingImportTemplate();
    downloadCsv(filename, csv);
  }

  function handleDownloadFailedRows() {
    if (rawFailedRows.length === 0) return;
    // SPECS-INDEX #925:組裝邏輯抽到 ./failedRowsCsv.ts(公式注入防護 + number 維持 number)。
    downloadCsv("匯入失敗清單.csv", buildFailedRowsCsv(rawFailedRows));
  }

  function resetWizard() {
    setStep("type");
    setImportKind(null);
    setParsed(null);
    setMapping({});
    setStaffValueMapping({});
    setResult(null);
    setRawFailedRows([]);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-10">
      {/* SPECS-INDEX #600(§10.1):固定導回「功能」主頁，跟精靈本身每個步驟裡的「上一步」按鈕
          是兩件不同的事——「上一步」留在匯入流程內、回到前一個步驟；這顆「← 返回功能」是離開
          整個匯入流程。比照既有頁面(例如付款方式管理)的統一寫法與文案。 */}
      <PageHeader
        backTo="/app/manage"
        helpMode
        title="資料匯入"
        description="上傳 CSV，把舊系統的資料匯入——這是通用的欄位對應工具，不是一鍵搬家，商家需要先自己把舊系統資料匯出成 CSV。匯入後可以查看匯入紀錄，也可以一鍵復原。"
        action={
          // 去另一個頁面,不是這一頁的主要動作 ⇒ ② 次要(skill 二之三)。
          <Button asChild variant="neutral" size="touch">
            <Link to="/app/data-import/history">匯入紀錄</Link>
          </Button>
        }
      />

      {/* 步驟一:選擇匯入類型 */}
      {step === "type" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟一：選擇匯入類型</CardTitle>
            <CardDescription>
              請先確認匯出的 CSV 為 UTF-8 編碼；如果用 Excel 另存新檔，請選擇「CSV
              UTF-8(逗號分隔)」格式。 單批匯入上限 {MAX_ROWS} 筆，筆數過多請分批匯入。
            </CardDescription>
          </CardHeader>
          {/* 兩個地位相同的選項 ⇒ 兩顆都用 ② 次要、等寬(skill 二之三:沒有哪一個是「你最可能
              要做的那件事」,硬把其中一顆做成主要反而是誤導)。 */}
          <CardContent className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="neutral"
              size="touch"
              className="flex-1"
              onClick={() => {
                setImportKind("members");
                setStep("upload");
              }}
            >
              會員資料
            </Button>
            <Button
              type="button"
              variant="neutral"
              size="touch"
              className="flex-1"
              onClick={() => {
                setImportKind("historical_bookings");
                setStep("upload");
              }}
            >
              歷史訂單
            </Button>
          </CardContent>
        </Card>
      )}

      {/* 步驟二:上傳 CSV + 欄位對應 */}
      {step === "upload" && importKind && (
        <Card>
          <CardHeader>
            <CardTitle>步驟二：上傳 CSV + 欄位對應</CardTitle>
            <CardDescription>
              上傳檔案後，把 CSV 欄位對應到秒約的欄位，必填欄位有星號標示。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* SPECS-INDEX #603(§10.4):會員/歷史訂單各自提供專屬模板,不是通用單一模板。 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed border-border bg-muted/30 p-3">
              <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted-foreground">
                {importKind === "members" ? (
                  <>
                    還沒整理好 CSV？可以先下載範例模板對照欄位。這個商家目前
                    {phoneRequiredForMembers ? "要求" : "不要求"}建立會員時必填電話。
                  </>
                ) : (
                  <>
                    還沒整理好 CSV？可以先下載範例模板對照欄位。服務時長沒填預設 60
                    分鐘，訂單狀態沒填預設「已完成」，付款方式為選填(留空也能成功匯入)。
                  </>
                )}
              </p>
              <Button type="button" variant="neutral" size="card" onClick={handleDownloadTemplate}>
                下載 CSV 模板
              </Button>
            </div>

            <FormField label="CSV 檔案" htmlFor="csv-file" required>
              <FieldInput
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                className="file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-[13px] file:font-semibold"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFileUpload(file);
                }}
              />
            </FormField>

            {parsed && (
              <>
                <p className="text-sm tabular-nums text-muted-foreground">
                  已解析 {parsed.rows.length} 筆資料，共 {parsed.headers.length} 欄。
                </p>

                {importKind === "members" && (
                  <FormField
                    label="寫入模式"
                    htmlFor="import-write-mode"
                    help={
                      <>
                        <strong>只新增</strong>：CSV 裡的電話如果系統已經有了，就整列跳過不動，
                        既有資料一定不會被改到(不確定時選這個)。
                        <br />
                        <strong>電話重複時更新</strong>：CSV 會蓋掉系統既有那一筆會員的資料。
                      </>
                    }
                    helpLabel="說明：兩種寫入模式的差別是什麼"
                  >
                    <FieldSelect<MemberImportWriteMode>
                      id="import-write-mode"
                      value={writeMode}
                      // 固定白名單 ⇒ 最嚴格的那一種 guard 用法。
                      onValueChange={guardPhantomEmptyChange<MemberImportWriteMode>(
                        setWriteMode,
                        (v) => v === "insert_only" || v === "upsert_by_phone",
                      )}
                      options={[
                        { value: "insert_only", label: "只新增，電話重複則略過(較安全，預設)" },
                        { value: "upsert_by_phone", label: "電話重複時更新既有會員資料" },
                      ]}
                    />
                  </FormField>
                )}

                <div className="flex flex-col gap-3">
                  {targetFields
                    .filter((f) => f.key !== "staff_name" || importKind === "historical_bookings")
                    .map((field) => (
                      // 320px 下「秒約欄位名稱 + 下拉」並排會把下拉擠爆 ⇒ 手機直向堆疊、電腦並排
                      // (skill 一:同一份設計靠 CSS 換行,不做兩份)。
                      <div
                        key={field.key}
                        className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3"
                        data-testid={`mapping-row-${field.key}`}
                      >
                        <Label
                          htmlFor={`mapping-select-${field.key}`}
                          className="text-[13px] font-semibold text-foreground sm:w-56 sm:shrink-0"
                        >
                          {field.label}
                          {field.required && (
                            <span className="text-destructive" aria-hidden="true">
                              {" "}
                              *
                            </span>
                          )}
                        </Label>
                        <div className="min-w-0 flex-1">
                          <FieldSelect
                            id={`mapping-select-${field.key}`}
                            value={mapping[field.key] || "__none__"}
                            // 選項是使用者上傳的 CSV 表頭(解析完才灌進來的動態值)⇒ 一定要 guard。
                            onValueChange={guardPhantomEmptyChange((v) =>
                              handleMappingChange(field.key, v),
                            )}
                            placeholder="不對應"
                            options={[
                              { value: "__none__", label: "不對應" },
                              ...parsed.headers.map((h) => ({ value: h, label: h })),
                            ]}
                          />
                        </div>
                      </div>
                    ))}
                </div>
              </>
            )}

            <div className="flex justify-between gap-2 pt-1">
              <Button type="button" variant="neutral" size="touch" onClick={() => setStep("type")}>
                上一步
              </Button>
              {/* 這個步驟唯一的 ① 主要按鈕(skill 二之三)。 */}
              <Button
                type="button"
                variant="primary"
                size="touch"
                disabled={!parsed || !mapping[importKind === "members" ? "name" : "customer_name"]}
                onClick={() =>
                  setStep(importKind === "historical_bookings" ? "value-mapping" : "preview")
                }
              >
                下一步
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 步驟三:數值對應(僅歷史訂單匯入需要) */}
      {step === "value-mapping" && importKind === "historical_bookings" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟三：服務人員數值對應</CardTitle>
            <CardDescription>
              CSV 裡每一個不重複的服務人員文字值，請選擇對應到既有服務人員，或建立一筆新的服務人員
              (姓名+手機號碼)。如果中途離開沒完成匯入，已建立的新服務人員不會被自動刪除。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {distinctStaffNames.length === 0 && (
              // 🟡 常駐 `!`:為什麼這一步是空的 / 為什麼不能往下(skill 二)。
              <AlertNote>請先回到上一步，把「服務人員」欄位對應到 CSV 裡的一欄。</AlertNote>
            )}
            {distinctStaffNames.map((name) => (
              // 一列有「CSV 裡的名字 + 下拉 + 手機 + 按鈕」四個東西,320px 下絕對排不進一列
              // ⇒ 手機直向堆疊、電腦並排(skill 一)。
              <div
                key={name}
                className="flex flex-col gap-2 rounded-lg border border-border px-3.5 py-3"
                data-testid={`staff-mapping-${name}`}
              >
                <span className="min-w-0 break-words text-sm font-semibold text-foreground">
                  {name}
                </span>
                {staffValueMapping[name] ? (
                  <span className="text-[13px] text-muted-foreground">
                    已對應：
                    {staffList?.find((s) => s.id === staffValueMapping[name])?.name ??
                      "(新建立的服務人員)"}
                  </span>
                ) : (
                  <>
                    <FieldSelect
                      aria-label={`「${name}」要對應到哪一位既有服務人員`}
                      // 選項來自資料庫(動態清單)⇒ 只擋空字串的那一種 guard 用法。
                      onValueChange={guardPhantomEmptyChange((v) =>
                        setStaffValueMapping((prev) => ({ ...prev, [name]: v })),
                      )}
                      placeholder="選擇既有服務人員"
                      options={(staffList ?? []).map((s) => ({ value: s.id, label: s.name }))}
                    />
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      {/* SPECS-INDEX #632:建立新服務人員現在需要手機號碼(09 開頭共 10 碼),
                          跟既有服務人員管理頁的新增表單套用同一套必填+格式驗證規則。 */}
                      <FieldInput
                        type="tel"
                        inputMode="numeric"
                        aria-label={`「${name}」如果要建立成新服務人員，他的手機號碼`}
                        placeholder="手機號碼，例如 0912345678"
                        className="min-w-0 flex-1 tabular-nums"
                        data-testid={`staff-new-phone-${name}`}
                        value={newStaffPhoneDrafts[name] ?? ""}
                        onChange={(e) =>
                          setNewStaffPhoneDrafts((prev) => ({ ...prev, [name]: e.target.value }))
                        }
                      />
                      <Button
                        type="button"
                        variant="neutral"
                        size="touch"
                        className="shrink-0"
                        onClick={() => void handleCreateNewStaff(name)}
                      >
                        建立新服務人員
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))}

            <div className="flex justify-between gap-2 pt-1">
              <Button
                type="button"
                variant="neutral"
                size="touch"
                onClick={() => setStep("upload")}
              >
                上一步
              </Button>
              {/* 這個步驟唯一的 ① 主要按鈕。 */}
              <Button
                type="button"
                variant="primary"
                size="touch"
                disabled={!canGoToPreview()}
                onClick={() => setStep("preview")}
              >
                下一步
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 步驟四:預覽 */}
      {step === "preview" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟四：預覽</CardTitle>
            <CardDescription>顯示前 20 筆解析結果，確認沒問題後再正式匯入。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* 📌 這裡刻意維持多欄表格(skill 一「列表一律卡片式」的例外,理由見檔頭說明):
                這張表的用途是「檢查我的 CSV 欄位有沒有對到正確的秒約欄位」,同一欄的值必須上下
                對齊才看得出對錯。放不下就整塊橫向捲(比照 skill 六行事曆的服務人員欄做法)。 */}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>狀態</TableHead>
                    {targetFields
                      .filter((f) => f.key !== "staff_name")
                      .map((f) => (
                        <TableHead key={f.key}>{f.label}</TableHead>
                      ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mappedRows.slice(0, 20).map((row, idx) => {
                    const validity = checkImportRowPreview(importKind, row);
                    return (
                      <TableRow key={idx}>
                        <TableCell>
                          {validity.ok ? (
                            // 語意色 token,不寫死 emerald(深色模式下寫死的色碼對比會不夠)。
                            <span className="font-semibold text-success-strong">看起來會成功</span>
                          ) : (
                            <span className="font-semibold text-destructive-strong">
                              {validity.reason}
                            </span>
                          )}
                        </TableCell>
                        {targetFields
                          .filter((f) => f.key !== "staff_name")
                          .map((f) => (
                            <TableCell key={f.key}>{String(row[f.key] ?? "")}</TableCell>
                          ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {importKind === "historical_bookings" && (
              // 🟡 常駐 `!`:匯進去的結果跟商家以為的不一樣(他會以為工時是空的)(skill 二)。
              <AlertNote>
                沒有填服務時長的資料列，會使用系統預設工時(60 分鐘)，非精確歷史資料。
              </AlertNote>
            )}

            <div className="flex justify-between gap-2 pt-1">
              <Button
                type="button"
                variant="neutral"
                size="touch"
                onClick={() =>
                  setStep(importKind === "historical_bookings" ? "value-mapping" : "upload")
                }
              >
                上一步
              </Button>
              {/* 這個步驟唯一的 ① 主要按鈕。 */}
              <Button
                type="button"
                variant="primary"
                size="touch"
                onClick={() => setStep("confirm")}
              >
                下一步
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 步驟五:確認匯入 */}
      {step === "confirm" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟五：確認匯入</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed tabular-nums text-foreground">
              即將匯入 {mappedRows.length} 筆資料。
            </p>
            {/* 🟡 常駐 `!`:按下去會發生什麼不可逆的事(skill 二,第二類)。 */}
            <AlertNote>
              匯入後可以在「匯入紀錄」頁面復原，但
              <strong>復原有時效與條件限制</strong>
              ——如果這筆資料之後被使用或編輯過，就無法自動復原。
            </AlertNote>
            <div className="flex justify-between gap-2 pt-1">
              <Button
                type="button"
                variant="neutral"
                size="touch"
                onClick={() => setStep("preview")}
              >
                上一步
              </Button>
              <CardAlertDialog>
                <CardAlertDialogTrigger asChild>
                  {/* 這個步驟唯一的 ① 主要按鈕。🔴 不標紅:匯入不刪任何資料。 */}
                  <Button type="button" variant="primary" size="touch" disabled={submitting}>
                    {submitting ? "匯入中⋯" : "確認匯入"}
                  </Button>
                </CardAlertDialogTrigger>
                <CardAlertDialogContent>
                  <CardAlertDialogHeader>
                    <CardAlertDialogTitle>
                      確定要匯入這 {mappedRows.length} 筆資料嗎？
                    </CardAlertDialogTitle>
                    <CardAlertDialogDescription>
                      送出後會立即寫入資料庫，之後可以在「匯入紀錄」頁面查看結果並視情況復原。
                    </CardAlertDialogDescription>
                  </CardAlertDialogHeader>
                  <CardAlertDialogFooter>
                    <CardAlertDialogCancel>取消</CardAlertDialogCancel>
                    <CardAlertDialogAction onClick={() => void handleConfirmImport()}>
                      確認匯入
                    </CardAlertDialogAction>
                  </CardAlertDialogFooter>
                </CardAlertDialogContent>
              </CardAlertDialog>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 步驟六:結果報告 */}
      {step === "result" && result && (
        <Card>
          <CardHeader>
            <CardTitle>步驟六：結果報告</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* ⚠️ 這四塊統計方塊的 `rounded-md border` 與 `text-2xl` 是 e2e 的選擇器
                (e2e/data-import-members.spec.ts 的 readStat 用
                `.rounded-md.border` + `p.text-2xl` 取值),改 class 會讓 e2e 抓不到,
                所以這次刻意不動這兩個 class(#849 要統一處理 e2e 選擇器時再一起改)。 */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-md border border-border p-3 text-center">
                <p className="text-2xl font-bold tabular-nums">{result.total}</p>
                <p className="text-xs text-muted-foreground">總筆數</p>
              </div>
              <div className="rounded-md border border-border p-3 text-center">
                <p className="text-2xl font-bold tabular-nums text-success-strong">
                  {result.success}
                </p>
                <p className="text-xs text-muted-foreground">成功</p>
              </div>
              <div className="rounded-md border border-border p-3 text-center">
                <p className="text-2xl font-bold tabular-nums text-destructive-strong">
                  {result.failed}
                </p>
                <p className="text-xs text-muted-foreground">失敗</p>
              </div>
              <div className="rounded-md border border-border p-3 text-center">
                <p className="text-2xl font-bold tabular-nums">{result.skipped}</p>
                <p className="text-xs text-muted-foreground">略過(重複)</p>
              </div>
            </div>

            {result.errors.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[13px] font-semibold text-foreground">失敗清單</p>
                  <Button
                    type="button"
                    variant="neutral"
                    size="card"
                    onClick={handleDownloadFailedRows}
                  >
                    下載失敗清單 CSV
                  </Button>
                </div>
                <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
                  {result.errors.map((e, i) => (
                    <div key={i} className="px-3 py-2 text-[13px] leading-relaxed">
                      <p className="break-words">
                        <span className="font-semibold tabular-nums">第 {e.row_number} 列</span>：
                        {e.error_message}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-between gap-2 pt-1">
              <Button type="button" variant="neutral" size="touch" onClick={resetWizard}>
                再匯入一次
              </Button>
              {/* 這個步驟唯一的 ① 主要按鈕。 */}
              <Button asChild variant="primary" size="touch">
                <Link to="/app/data-import/history">查看匯入紀錄</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function ImportWizardPage() {
  return (
    <RequireDataImportAccess>
      <ImportWizardPageInner />
    </RequireDataImportAccess>
  );
}
