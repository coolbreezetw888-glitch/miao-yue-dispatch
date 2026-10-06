// 共用表單:Onboarding(4.1)跟新增分店(4.4)長得幾乎一樣，差別只在送出後呼叫哪個 RPC，
// 所以拆成一個共用表單元件，父層決定 onSubmit 要做什麼。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 五個欄位改 FormField + FieldInput / FieldSelect / FieldTextarea,必填用紅色 `*`。
//   - 🔴 產業模組的下拉補上 guardPhantomEmptyChange(白名單版)—— 這是新使用者註冊完看到的
//     第一個畫面,選好的產業被幽靈空值洗掉會直接卡住開店流程(見 src/lib/radixSelectGuard.ts)。
//   - 「之後可以隨時到商家設定頁重新切換」改成 🟡 常駐 `!`:新開店的人最怕「選錯就定終身」,
//     這句一定要一直看得到(skill 二,第三類)。產業模組的詳細說明收進 `?`。
//   - 送出失敗的錯誤訊息改成 danger 版常駐 `!`(skill 二之七:錯誤要有一行 `!` 說明)。
//   - 送出按鈕改 ① 主要(原本是 variant="cta")。
// **只動外觀,不動行為**:驗證順序、送出的欄位、錯誤訊息的來源(getErrorMessage)全部照舊。

import { useState, type FormEvent } from "react";

import {
  AlertNote,
  FieldInput,
  FieldSelect,
  FieldTextarea,
  FormField,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { guardPhantomEmptyChange } from "@/lib/radixSelectGuard";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { INDUSTRY_TYPES, INDUSTRY_TYPE_DESCRIPTIONS, INDUSTRY_TYPE_LABELS } from "./types";
import type { IndustryType } from "./types";

export interface MerchantIntakeFormValues {
  name: string;
  industryType: IndustryType;
  address: string;
  contactEmail: string;
  intro: string;
}

interface MerchantIntakeFormProps {
  submitLabel: string;
  submittingLabel: string;
  onSubmit: (values: MerchantIntakeFormValues) => Promise<void>;
}

export function MerchantIntakeForm({
  submitLabel,
  submittingLabel,
  onSubmit,
}: MerchantIntakeFormProps) {
  const [name, setName] = useState("");
  const [industryType, setIndustryType] = useState<IndustryType | "">("");
  const [address, setAddress] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [intro, setIntro] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    if (!name.trim()) {
      setErrorMessage("請填寫店名");
      return;
    }
    if (!industryType) {
      setErrorMessage("請選擇產業模組");
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        industryType,
        address,
        contactEmail,
        intro,
      });
    } catch (err) {
      // 2026-09-24 深夜巡檢修正:原本寫 `err instanceof Error ? err.message : ...`,但 Supabase
      // 回傳的 error 只是 JSON.parse 出來的一般物件、不是 Error 的實例,instanceof 永遠 false,
      // 後端真正擋下來的原因(店名重複、權限不足、欄位約束)全部被吞成一句沒有線索的
      // 「建立失敗,請稍後再試」——而這裡正是新使用者註冊完成後看到的第一個畫面(/app/onboarding),
      // 看不到原因就只能一直重試同樣的輸入。完整根因見 platform-admin/getErrorMessage.ts 檔頭。
      setErrorMessage(getErrorMessage(err, "建立失敗，請稍後再試"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <FormField label="店名" htmlFor="merchant-name" required>
        <FieldInput
          id="merchant-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：秒約冷氣水電行"
        />
      </FormField>

      <FormField
        label="產業模組"
        htmlFor="merchant-industry"
        required
        help={
          <>
            決定的是「新增 / 編輯預約時要不要填客戶地址」：
            <strong>到府派工</strong>要填、<strong>到店服務</strong>不用。
            {industryType ? (
              <span className="mt-1 block">{INDUSTRY_TYPE_DESCRIPTIONS[industryType]}</span>
            ) : null}
          </>
        }
        helpLabel="說明：產業模組會影響什麼"
      >
        <FieldSelect<IndustryType>
          id="merchant-industry"
          value={industryType === "" ? undefined : industryType}
          // 固定白名單 ⇒ 最嚴格的那一種 guard 用法(見 src/lib/radixSelectGuard.ts)。
          onValueChange={guardPhantomEmptyChange<IndustryType>(setIndustryType, (v) =>
            INDUSTRY_TYPES.includes(v as IndustryType),
          )}
          placeholder="請選擇這間店的產業模組"
          options={INDUSTRY_TYPES.map((type) => ({
            value: type,
            label: INDUSTRY_TYPE_LABELS[type],
          }))}
        />
      </FormField>
      {/* 🟡 常駐 `!`:現在的狀態跟使用者以為的不一樣 —— 新開店的人最怕「選錯就定終身」,
          這句要一直看得到,不能收進 `?`(skill 二,第三類)。 */}
      <AlertNote>之後可以隨時到「商家設定」頁重新切換，不影響已經建立的訂單資料。</AlertNote>

      <FormField label="地址" htmlFor="merchant-address">
        <FieldInput
          id="merchant-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="選填"
        />
      </FormField>

      <FormField
        label="對外聯絡 Email"
        htmlFor="merchant-contact-email"
        help="這是顯示給客戶看的聯絡信箱，跟你登入帳號用的 Email 是分開的兩件事，可以留空。"
        helpLabel="說明：對外聯絡 Email 跟登入信箱的差別"
      >
        <FieldInput
          id="merchant-contact-email"
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          placeholder="選填"
        />
      </FormField>

      <FormField label="商家簡介" htmlFor="merchant-intro">
        <FieldTextarea
          id="merchant-intro"
          rows={3}
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
          placeholder="選填，簡單介紹這間店"
        />
      </FormField>

      {errorMessage ? (
        // 🔴 skill 二之七:錯誤不能只把框變紅,要有一行 `!` 說明。這裡的錯誤是整份表單層級的
        // (店名沒填 / 產業沒選 / 後端擋下來的原因),所以用 danger 版的常駐 `!`。
        <AlertNote tone="danger">{errorMessage}</AlertNote>
      ) : null}

      {/* 這個畫面唯一的 ① 主要按鈕(skill 二之三)。 */}
      <Button type="submit" variant="primary" size="touch" className="w-full" disabled={submitting}>
        {submitting ? submittingLabel : submitLabel}
      </Button>
    </form>
  );
}
