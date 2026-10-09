// #1035 彈性計薪 C 批(自由公式)— 規則卡選了「自訂公式（進階）」時的欄位:公式輸入、插入欄位、即時檢查、試算。
// 規格書:母版 .project/specs/彈性計薪.md PC-U01、PC-F01~F03、PX-03。
//
// 🔴 前端不做任何公式求值(沒有 eval / new Function / 自己的解析器):
//    即時檢查與試算一律呼叫資料庫 preview_bonus_formula(跟報表同一套編譯器與計算器)。
// 🔴 試算的範例數字只是店家自己填來看看,不會存起來;真正的金額以報表為準。
// 版面依 ui-overlay-patterns:說明範例收進 `?`;「指定服務以 0 計算」這類「狀態跟你以為的不一樣」用 `!` 常駐。

import { useEffect, useMemo, useRef, useState } from "react";

import {
  AlertNote,
  ChoiceChipGroup,
  FieldInput,
  FieldMonth,
  FieldSelect,
  FieldTextarea,
  FormField,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import type { MerchantStaff } from "@/modules/staff-agent/types";

import { previewBonusFormula } from "./api";
import {
  BONUS_FORMULA_SNIPPETS,
  BONUS_FORMULA_TEXT_MAX,
  bonusFlagNotes,
  bonusFormulaItemSnippet,
  bonusFormulaServiceNameProblem,
  formatBonusNumber,
  insertFormulaSnippet,
  parseFormulaSample,
  type BonusFormulaCheckState,
  type BonusFormulaSnippet,
  type BonusFormulaSampleKey as SampleKey,
} from "./bonusRuleLogic";
import type { BonusFormulaPreview } from "./types";

type TestMode = "sample" | "staff";

const TEST_MODE_OPTIONS: ReadonlyArray<{ value: TestMode; label: string }> = [
  { value: "sample", label: "用範例數字" },
  { value: "staff", label: "用月薪人員的實際數字" },
];

const SAMPLE_FIELDS: ReadonlyArray<{ key: SampleKey; label: string; placeholder: string }> = [
  { key: "orders", label: "完成單數", placeholder: "例：12" },
  { key: "units", label: "完成數量", placeholder: "例：15" },
  { key: "revenue", label: "業績（元）", placeholder: "例：120000" },
  { key: "salary", label: "月薪（元）", placeholder: "例：30000" },
  { key: "leave_days", label: "請假天數", placeholder: "例：1" },
];

const FORMULA_HELP_INTRO =
  "可以用的欄位：完成單數、完成數量、業績、月薪、請假天數；可以用 + - * / 、括號、比較（> >= < <= = <>，成立算 1、不成立算 0），以及 IF、MIN、MAX。系統只照公式算數字，不會執行任何程式。";
const FORMULA_HELP_EXAMPLES: ReadonlyArray<{ formula: string; meaning: string }> = [
  { formula: "MAX(完成數量 - 10, 0) * 300", meaning: "超過 10 份之後，每份 300 元" },
  { formula: "IF(業績 >= 100000, 業績 * 0.03, 0)", meaning: "業績滿 10 萬，整筆業績給 3%" },
  { formula: "MIN(完成單數 * 100, 5000)", meaning: "每單 100 元，最多 5,000 元" },
];
const FORMULA_HELP_ITEMS =
  '數量("服務名稱")、業績("服務名稱") 只算某一種服務；名稱要跟「服務項目」裡的完全一樣。百分比請寫成小數（5% 寫 0.05），數字不要加千分位逗號。';

function monthInputValue(month: string): string {
  return month.slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function FormulaHelp() {
  return (
    <div className="flex flex-col gap-2">
      <p>{FORMULA_HELP_INTRO}</p>
      <ul className="flex flex-col gap-1">
        {FORMULA_HELP_EXAMPLES.map((ex) => (
          <li key={`formula-example-${ex.formula}`}>
            <code className="rounded bg-background/60 px-1 font-mono">{ex.formula}</code>
            <span>{`：${ex.meaning}`}</span>
          </li>
        ))}
      </ul>
      <p>{FORMULA_HELP_ITEMS}</p>
    </div>
  );
}

export function BonusFormulaFields({
  index,
  ruleKey,
  text,
  draftError,
  merchantId,
  monthlyStaff,
  thisMonth,
  serviceOptions,
  onTextChange,
  onCheckChange,
}: {
  index: number;
  ruleKey: string;
  text: string;
  /** 送出前的體驗驗證錯誤(空白、超過字數)。 */
  draftError: string | undefined;
  merchantId: string;
  monthlyStaff: MerchantStaff[];
  thisMonth: string;
  serviceOptions: Array<{ value: string; label: string; removed: boolean }>;
  onTextChange: (text: string) => void;
  onCheckChange: (state: BonusFormulaCheckState | undefined) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [check, setCheck] = useState<BonusFormulaCheckState | undefined>(undefined);
  const [insertNote, setInsertNote] = useState<string | null>(null);
  const [pickerFn, setPickerFn] = useState<"數量" | "業績" | null>(null);
  const checkSeq = useRef(0);
  const onCheckRef = useRef(onCheckChange);
  onCheckRef.current = onCheckChange;
  const prefix = `bonus-formula-${ruleKey}`;

  // 即時檢查:停止輸入 600ms 後呼叫資料庫編譯(PC-U01)。
  useEffect(() => {
    const current = ++checkSeq.current;
    if (text.trim() === "") {
      setCheck(undefined);
      onCheckRef.current(undefined);
      return;
    }
    const checking: BonusFormulaCheckState = { status: "checking" };
    setCheck(checking);
    onCheckRef.current(checking);
    const timer = setTimeout(() => {
      previewBonusFormula({ merchantId, text })
        .then((r) => {
          if (checkSeq.current !== current) return;
          const next: BonusFormulaCheckState = r.ok
            ? { status: "ok" }
            : { status: "error", message: r.message ?? "公式有錯誤。" };
          setCheck(next);
          onCheckRef.current(next);
        })
        .catch((err: unknown) => {
          if (checkSeq.current !== current) return;
          const next: BonusFormulaCheckState = {
            status: "error",
            message: `檢查失敗：${getErrorMessage(err)}`,
          };
          setCheck(next);
          onCheckRef.current(next);
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [text, merchantId]);

  function insert(snippet: BonusFormulaSnippet) {
    const el = textareaRef.current;
    const res = insertFormulaSnippet(text, el?.selectionStart, el?.selectionEnd, snippet);
    if (!res) {
      setInsertNote(`公式最多 ${BONUS_FORMULA_TEXT_MAX} 個字，放不下「${snippet.label}」。`);
      return;
    }
    setInsertNote(null);
    onTextChange(res.text);
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(res.caret, res.caret);
    });
  }

  const charCount = [...text].length;
  const fieldError = draftError ?? (check?.status === "error" ? check.message : null);

  return (
    <div className="flex flex-col gap-4" data-testid="bonus-formula-fields">
      <FormField
        label="公式"
        htmlFor={`${prefix}-text`}
        required
        error={fieldError}
        help={<FormulaHelp />}
        helpLabel="說明：自訂公式怎麼寫"
        counter={{ value: charCount, max: BONUS_FORMULA_TEXT_MAX }}
      >
        <FieldTextarea
          id={`${prefix}-text`}
          ref={textareaRef}
          className="font-mono"
          value={text}
          maxLength={BONUS_FORMULA_TEXT_MAX}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="例：MAX(完成數量 - 10, 0) * 300"
          aria-label={`第 ${index + 1} 條的公式`}
          data-testid="bonus-formula-input"
          onChange={(e) => {
            setInsertNote(null);
            onTextChange(e.target.value);
          }}
        />
        {check?.status === "ok" && !draftError ? (
          <p className="text-xs font-semibold text-success-strong" data-testid="bonus-formula-ok">
            ✓ 公式可以使用
          </p>
        ) : check?.status === "checking" ? (
          <p className="text-xs text-muted-foreground">檢查中⋯</p>
        ) : null}
      </FormField>

      <div className="flex flex-col gap-2">
        <p className="text-[13px] font-semibold text-foreground">插入欄位</p>
        <div className="flex flex-wrap gap-2" data-testid="bonus-formula-snippets">
          {BONUS_FORMULA_SNIPPETS.map((s) => (
            <Button
              key={`snippet-${s.label}`}
              type="button"
              variant="neutral"
              size="card"
              className="font-mono"
              onClick={() => insert(s)}
            >
              {s.label}
            </Button>
          ))}
          <Button
            key="snippet-item-units"
            type="button"
            variant="neutral"
            size="card"
            className="font-mono"
            aria-expanded={pickerFn === "數量"}
            onClick={() => setPickerFn((v) => (v === "數量" ? null : "數量"))}
          >
            {'數量("")'}
          </Button>
          <Button
            key="snippet-item-revenue"
            type="button"
            variant="neutral"
            size="card"
            className="font-mono"
            aria-expanded={pickerFn === "業績"}
            onClick={() => setPickerFn((v) => (v === "業績" ? null : "業績"))}
          >
            {'業績("")'}
          </Button>
        </div>
        {pickerFn ? (
          <div
            className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-2.5"
            data-testid="bonus-formula-service-picker"
          >
            <p className="text-xs text-muted-foreground">{`選一個服務，插入 ${pickerFn}("服務名稱")：`}</p>
            {serviceOptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">這間店還沒有服務項目。</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {serviceOptions.map((o) => (
                  <Button
                    key={`picker-${o.value}`}
                    type="button"
                    variant="neutral"
                    size="card"
                    onClick={() => {
                      const problem = bonusFormulaServiceNameProblem(o.label);
                      if (problem) {
                        setInsertNote(problem);
                        return;
                      }
                      insert(bonusFormulaItemSnippet(pickerFn, o.label));
                      setPickerFn(null);
                    }}
                  >
                    {o.removed ? `${o.label}（已下架）` : o.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        ) : null}
        {insertNote ? <AlertNote>{insertNote}</AlertNote> : null}
      </div>

      <FormulaTester
        prefix={prefix}
        merchantId={merchantId}
        text={text}
        ready={check?.status === "ok" && !draftError}
        monthlyStaff={monthlyStaff}
        thisMonth={thisMonth}
      />
    </div>
  );
}

function FormulaTester({
  prefix,
  merchantId,
  text,
  ready,
  monthlyStaff,
  thisMonth,
}: {
  prefix: string;
  merchantId: string;
  text: string;
  ready: boolean;
  monthlyStaff: MerchantStaff[];
  thisMonth: string;
}) {
  const [mode, setMode] = useState<TestMode>("sample");
  const [sample, setSample] = useState<Record<SampleKey, string>>({
    orders: "",
    units: "",
    revenue: "",
    salary: "",
    leave_days: "",
  });
  const [staffId, setStaffId] = useState<string>(monthlyStaff[0]?.id ?? "");
  const [month, setMonth] = useState<string>(monthInputValue(thisMonth));
  const [result, setResult] = useState<BonusFormulaPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!staffId && monthlyStaff[0]) setStaffId(monthlyStaff[0].id);
  }, [monthlyStaff, staffId]);

  const parsedSample = useMemo(() => parseFormulaSample(sample), [sample]);
  const sampleKey = parsedSample ? JSON.stringify(parsedSample) : null;
  const canRun =
    ready && (mode === "sample" ? parsedSample !== null : Boolean(staffId) && Boolean(month));

  useEffect(() => {
    const current = ++seq.current;
    if (!canRun) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      previewBonusFormula(
        mode === "sample"
          ? { merchantId, text, sample: parsedSample }
          : { merchantId, text, staffId, month: `${month}-01` },
      )
        .then((r) => {
          if (seq.current !== current) return;
          setResult(r);
          setError(r.ok ? null : (r.message ?? "公式有錯誤。"));
        })
        .catch((err: unknown) => {
          if (seq.current !== current) return;
          setResult(null);
          setError(getErrorMessage(err));
        })
        .finally(() => {
          if (seq.current === current) setLoading(false);
        });
    }, 600);
    return () => clearTimeout(timer);
    // parsedSample 用 sampleKey 判斷有沒有變。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRun, mode, sampleKey, staffId, month, text, merchantId]);

  const notes = bonusFlagNotes(result?.flags);
  const vars = result?.vars_used ?? null;

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-dashed border-border bg-muted/20 p-3"
      data-testid="bonus-formula-tester"
    >
      <p className="text-[13px] font-semibold text-foreground">試算這條公式</p>
      <ChoiceChipGroup<TestMode>
        aria-label="試算用的數字"
        value={mode}
        onValueChange={setMode}
        options={TEST_MODE_OPTIONS}
      />
      {mode === "sample" ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {SAMPLE_FIELDS.map((f) => (
            <FormField
              key={`sample-${f.key}`}
              label={f.label}
              htmlFor={`${prefix}-sample-${f.key}`}
            >
              <FieldInput
                id={`${prefix}-sample-${f.key}`}
                inputMode="decimal"
                className="tabular-nums"
                placeholder={f.placeholder}
                value={sample[f.key]}
                onChange={(e) => setSample((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </FormField>
          ))}
        </div>
      ) : monthlyStaff.length === 0 ? (
        <p className="text-sm text-muted-foreground">沒有月薪人員可以試算</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="月薪人員" htmlFor={`${prefix}-staff`}>
            <FieldSelect
              id={`${prefix}-staff`}
              value={staffId}
              onValueChange={guardPhantomEmptyChange(setStaffId)}
              options={monthlyStaff.map((s) => ({ value: s.id, label: s.name }))}
            />
          </FormField>
          <FormField label="月份" htmlFor={`${prefix}-month`}>
            <FieldMonth
              id={`${prefix}-month`}
              value={month}
              min={shiftMonth(thisMonth, -23)}
              max={monthInputValue(thisMonth)}
              onChange={(e) => {
                if (e.target.value) setMonth(e.target.value);
              }}
            />
          </FormField>
        </div>
      )}
      {mode === "sample" && parsedSample === null ? (
        <p className="text-xs text-destructive-strong">
          範例數字請填 0～1,000,000,000 之間的數字，最多 4 位小數。
        </p>
      ) : null}

      {!ready ? (
        <p className="text-sm text-muted-foreground">公式檢查通過後會自動試算。</p>
      ) : loading && !result ? (
        <p className="text-sm text-muted-foreground">試算中⋯</p>
      ) : error ? (
        <AlertNote tone="danger">{error}</AlertNote>
      ) : result && result.ok && result.value !== null ? (
        <div className="flex flex-col gap-2" data-testid="bonus-formula-result">
          <p className="text-sm text-foreground">
            <span>試算結果：</span>
            <span className="font-semibold tabular-nums">{`${formatBonusNumber(Number(result.value))} 元`}</span>
          </p>
          {mode === "staff" && vars ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {`用到的數字：完成單數 ${formatBonusNumber(Number(vars.orders))}、完成數量 ${formatBonusNumber(Number(vars.units))}、業績 ${formatBonusNumber(Number(vars.revenue))} 元、月薪 ${formatBonusNumber(Number(vars.salary))} 元、請假天數 ${formatBonusNumber(Number(vars.leave_days))}`}
              {vars.items
                .map(
                  (it) =>
                    `；「${it.name}」數量 ${formatBonusNumber(Number(it.units))}、業績 ${formatBonusNumber(Number(it.revenue))} 元`,
                )
                .join("")}
            </p>
          ) : null}
          {notes.map((n) => (
            <AlertNote key={`formula-flag-${n}`}>{n}</AlertNote>
          ))}
        </div>
      ) : null}
    </div>
  );
}
