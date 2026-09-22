// 模組 12 §4.1:匯入精靈(新路由 /app/data-import，僅商家管理員可見)。
// 上傳 CSV → 欄位對應 → 數值對應(僅歷史訂單需要) → 預覽 → 確認匯入 → 結果報告。
// 涵蓋會員匯入(3.1)跟歷史訂單匯入(3.4)兩種類型，共用同一套精靈骨架(名詞對照「匯入精靈」)。

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { isValidTaiwanMobilePhone, TW_MOBILE_PHONE_ERROR_MESSAGE } from "@/lib/validation";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { addMerchantStaff } from "@/modules/staff-agent/api";
import { useMerchantStaffList } from "@/modules/staff-agent/context";

import { importHistoricalBookingsBatch, importMembersBatch, parseErrorReport } from "./api";
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
    "王師傅",
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
  // ⚠️ 跨模組異動說明(2026-09-22,模組 10 會員與紅利 SPECS-INDEX #618 疊加,由該批次的
  // engineer 順手修正,已在回報時提出讓主腦知悉,不是本模組自己的規劃):
  // merchant_member_settings.phone_required_to_create 這個開關已經被 #618 移除(電話不再是
  // create_member/update_member 的必填欄位,改成純查詢索引,見會員與紅利.md §10.2/§10.6)。
  // 原本這裡讀取這個設定值來決定步驟四預覽要不要擋下「缺電話」的資料列,現在後端已經不會再擋,
  // 這裡跟著改成一律不要求電話——不然步驟四預覽會顯示跟後端實際驗證邏輯不一致的錯誤訊息。
  // 這個常數維持存在(而不是直接刪掉下面的 if 判斷式),是為了在程式碼裡留下清楚的變更紀錄,
  // 方便之後模組 12 的維護者一眼看懂「這裡曾經有必填檢查,後來因為模組 10 的決策而移除」。
  const phoneRequiredForMembers = false;

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

  function rowLooksValid(row: Record<string, unknown>): { ok: boolean; reason?: string } {
    if (importKind === "members") {
      if (!row["name"]) return { ok: false, reason: "缺少姓名" };
      if (phoneRequiredForMembers && !row["phone"]) {
        return { ok: false, reason: "這個商家要求建立會員時必須填寫電話" };
      }
      return { ok: true };
    }
    if (!row["customer_name"]) return { ok: false, reason: "缺少客戶姓名" };
    if (!row["customer_phone"]) return { ok: false, reason: "缺少客戶電話" };
    if (!row["staff_id"]) return { ok: false, reason: "服務人員尚未完成對應" };
    if (!row["start_at"] || Number.isNaN(Date.parse(String(row["start_at"])))) {
      return { ok: false, reason: "預約時間格式無法辨識" };
    }
    if (
      row["final_amount"] === undefined ||
      row["final_amount"] === "" ||
      Number.isNaN(Number(row["final_amount"]))
    ) {
      return { ok: false, reason: "訂單金額缺漏或格式錯誤" };
    }
    return { ok: true };
  }

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
    const headers = Array.from(new Set(rawFailedRows.flatMap((r) => Object.keys(r))));
    const rows = rawFailedRows.map((r) =>
      headers.map((h) => (r[h] === undefined || r[h] === null ? "" : String(r[h]))),
    );
    const csv = buildCsvContent(headers, rows);
    downloadCsv("匯入失敗清單.csv", csv);
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
      <div>
        {/* SPECS-INDEX #600(§10.1):固定導回「功能」主頁，跟精靈本身每個步驟裡的「上一步」按鈕
            是兩件不同的事——「上一步」留在匯入流程內、回到前一個步驟；這顆「← 返回功能」是離開
            整個匯入流程。比照既有頁面(例如付款方式管理)的統一寫法與文案。 */}
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">資料匯入</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            上傳 CSV，把舊系統的資料匯入到秒約——這是一個通用欄位對應工具，不是一鍵搬家，商家需要
            自己先把舊系統資料匯出成 CSV。
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/app/data-import/history">匯入紀錄</Link>
        </Button>
      </div>

      {/* 步驟一:選擇匯入類型 */}
      {step === "type" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟一:選擇匯入類型</CardTitle>
            <CardDescription>
              請先確認匯出的 CSV 為 UTF-8 編碼;如果用 Excel 另存新檔，請選擇「CSV
              UTF-8(逗號分隔)」格式。 單批匯入上限 {MAX_ROWS} 筆，筆數過多請分批匯入。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row">
            <Button
              variant={importKind === "members" ? "default" : "outline"}
              className="flex-1"
              onClick={() => {
                setImportKind("members");
                setStep("upload");
              }}
            >
              會員資料
            </Button>
            <Button
              variant={importKind === "historical_bookings" ? "default" : "outline"}
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
            <CardTitle>步驟二:上傳 CSV + 欄位對應</CardTitle>
            <CardDescription>
              上傳檔案後，把 CSV 欄位對應到秒約的欄位，必填欄位有星號標示。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* SPECS-INDEX #603(§10.4):會員/歷史訂單各自提供專屬模板,不是通用單一模板。 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed border-border p-3">
              <p className="text-sm text-muted-foreground">
                {importKind === "members" ? (
                  <>
                    還沒整理好 CSV?可以先下載範例模板對照欄位。這個商家目前
                    {phoneRequiredForMembers ? "要求" : "不要求"}建立會員時必填電話。
                  </>
                ) : (
                  <>
                    還沒整理好 CSV?可以先下載範例模板對照欄位。服務時長沒填預設
                    60 分鐘,訂單狀態沒填預設「已完成」,付款方式為選填(留空也能成功匯入)。
                  </>
                )}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={handleDownloadTemplate}>
                下載 CSV 模板
              </Button>
            </div>

            <div>
              <Label htmlFor="csv-file">CSV 檔案</Label>
              <Input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                className="mt-2"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFileUpload(file);
                }}
              />
            </div>

            {parsed && (
              <>
                <p className="text-sm text-muted-foreground">
                  已解析 {parsed.rows.length} 筆資料，共 {parsed.headers.length} 欄。
                </p>

                {importKind === "members" && (
                  <div>
                    <Label>寫入模式</Label>
                    <Select
                      value={writeMode}
                      onValueChange={(v) => setWriteMode(v as MemberImportWriteMode)}
                    >
                      <SelectTrigger className="mt-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="insert_only">
                          只新增，電話重複則略過(較安全，預設)
                        </SelectItem>
                        <SelectItem value="upsert_by_phone">電話重複時更新既有會員資料</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="space-y-3">
                  {targetFields
                    .filter((f) => f.key !== "staff_name" || importKind === "historical_bookings")
                    .map((field) => (
                      <div
                        key={field.key}
                        className="flex items-center gap-3"
                        data-testid={`mapping-row-${field.key}`}
                      >
                        <Label className="w-56 shrink-0 text-sm">
                          {field.label}
                          {field.required && <span className="text-destructive"> *</span>}
                        </Label>
                        <Select
                          value={mapping[field.key] || "__none__"}
                          onValueChange={(v) => handleMappingChange(field.key, v)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="不對應" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">不對應</SelectItem>
                            {parsed.headers.map((h) => (
                              <SelectItem key={h} value={h}>
                                {h}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                </div>
              </>
            )}

            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => setStep("type")}>
                上一步
              </Button>
              <Button
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
            <CardTitle>步驟三:服務人員數值對應</CardTitle>
            <CardDescription>
              CSV 裡每一個不重複的服務人員文字值，請選擇對應到既有服務人員，或建立一筆新的服務人員
              (姓名+手機號碼)。如果中途離開沒完成匯入，已建立的新服務人員不會被自動刪除。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {distinctStaffNames.length === 0 && (
              <p className="text-sm text-muted-foreground">
                請先回到上一步，把「服務人員」欄位對應到 CSV 裡的一欄。
              </p>
            )}
            {distinctStaffNames.map((name) => (
              <div key={name} className="flex items-center gap-3" data-testid={`staff-mapping-${name}`}>
                <span className="w-40 shrink-0 truncate text-sm font-medium">{name}</span>
                {staffValueMapping[name] ? (
                  <span className="text-sm text-muted-foreground">
                    已對應:
                    {staffList?.find((s) => s.id === staffValueMapping[name])?.name ??
                      "(新建立的服務人員)"}
                  </span>
                ) : (
                  <>
                    <Select
                      onValueChange={(v) =>
                        setStaffValueMapping((prev) => ({ ...prev, [name]: v }))
                      }
                    >
                      <SelectTrigger className="max-w-xs">
                        <SelectValue placeholder="選擇既有服務人員" />
                      </SelectTrigger>
                      <SelectContent>
                        {(staffList ?? []).map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* SPECS-INDEX #632:建立新服務人員現在需要手機號碼(09 開頭共 10 碼),
                        跟既有服務人員管理頁的新增表單套用同一套必填+格式驗證規則。 */}
                    <Input
                      type="tel"
                      placeholder="手機號碼,例如 0912345678"
                      className="w-44 shrink-0"
                      data-testid={`staff-new-phone-${name}`}
                      value={newStaffPhoneDrafts[name] ?? ""}
                      onChange={(e) =>
                        setNewStaffPhoneDrafts((prev) => ({ ...prev, [name]: e.target.value }))
                      }
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleCreateNewStaff(name)}
                    >
                      建立新服務人員
                    </Button>
                  </>
                )}
              </div>
            ))}

            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => setStep("upload")}>
                上一步
              </Button>
              <Button disabled={!canGoToPreview()} onClick={() => setStep("preview")}>
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
            <CardTitle>步驟四:預覽</CardTitle>
            <CardDescription>顯示前 20 筆解析結果，確認沒問題後再正式匯入。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
                    const validity = rowLooksValid(row);
                    return (
                      <TableRow key={idx}>
                        <TableCell>
                          {validity.ok ? (
                            <span className="text-emerald-600">看起來會成功</span>
                          ) : (
                            <span className="text-destructive">{validity.reason}</span>
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
              <p className="text-xs text-muted-foreground">
                沒有填服務時長的資料列，會使用系統預設工時(60 分鐘)，非精確歷史資料。
              </p>
            )}

            <div className="flex justify-between pt-2">
              <Button
                variant="outline"
                onClick={() =>
                  setStep(importKind === "historical_bookings" ? "value-mapping" : "upload")
                }
              >
                上一步
              </Button>
              <Button onClick={() => setStep("confirm")}>下一步</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 步驟五:確認匯入 */}
      {step === "confirm" && (
        <Card>
          <CardHeader>
            <CardTitle>步驟五:確認匯入</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-foreground">
              即將匯入 {mappedRows.length} 筆資料，匯入後可以在「匯入紀錄」頁面復原，但復原有時效與
              條件限制(如果這筆資料之後被使用或編輯過，就無法自動復原)。
            </p>
            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => setStep("preview")}>
                上一步
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button disabled={submitting}>{submitting ? "匯入中⋯" : "確認匯入"}</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>確定要匯入這 {mappedRows.length} 筆資料嗎?</AlertDialogTitle>
                    <AlertDialogDescription>
                      送出後會立即寫入資料庫，之後可以在「匯入紀錄」頁面查看結果並視情況復原。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void handleConfirmImport()}>
                      確認匯入
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 步驟六:結果報告 */}
      {step === "result" && result && (
        <Card>
          <CardHeader>
            <CardTitle>步驟六:結果報告</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-md border border-border p-3 text-center">
                <p className="text-2xl font-bold">{result.total}</p>
                <p className="text-xs text-muted-foreground">總筆數</p>
              </div>
              <div className="rounded-md border border-border p-3 text-center">
                <p className="text-2xl font-bold text-emerald-600">{result.success}</p>
                <p className="text-xs text-muted-foreground">成功</p>
              </div>
              <div className="rounded-md border border-border p-3 text-center">
                <p className="text-2xl font-bold text-destructive">{result.failed}</p>
                <p className="text-xs text-muted-foreground">失敗</p>
              </div>
              <div className="rounded-md border border-border p-3 text-center">
                <p className="text-2xl font-bold">{result.skipped}</p>
                <p className="text-xs text-muted-foreground">略過(重複)</p>
              </div>
            </div>

            {result.errors.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">失敗清單</p>
                  <Button variant="outline" size="sm" onClick={handleDownloadFailedRows}>
                    下載失敗清單 CSV
                  </Button>
                </div>
                <div className="max-h-64 overflow-y-auto rounded-md border border-border">
                  {result.errors.map((e, i) => (
                    <div key={i} className="border-b border-border p-2 text-sm last:border-b-0">
                      <p className="font-medium">
                        第 {e.row_number} 列:{e.error_message}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={resetWizard}>
                再匯入一次
              </Button>
              <Button asChild>
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
