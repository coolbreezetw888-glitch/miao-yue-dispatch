// 共用表單:Onboarding(4.1)跟新增分店(4.4)長得幾乎一樣，差別只在送出後呼叫哪個 RPC，
// 所以拆成一個共用表單元件，父層決定 onSubmit 要做什麼。

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
      setErrorMessage(err instanceof Error ? err.message : "建立失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <Label htmlFor="merchant-name">店名 *</Label>
        <Input
          id="merchant-name"
          required
          className="mt-2"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如:秒約冷氣水電行"
        />
      </div>

      <div>
        <Label htmlFor="merchant-industry">產業模組 *</Label>
        <Select value={industryType} onValueChange={(v) => setIndustryType(v as IndustryType)}>
          <SelectTrigger id="merchant-industry" className="mt-2">
            <SelectValue placeholder="請選擇這間店的產業模組" />
          </SelectTrigger>
          <SelectContent>
            {INDUSTRY_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {INDUSTRY_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {industryType ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {INDUSTRY_TYPE_DESCRIPTIONS[industryType]}
          </p>
        ) : null}
        <p className="mt-2 rounded-md bg-muted px-3 py-2 text-xs font-medium text-foreground">
          注意:產業模組一旦選定送出後就無法修改。如果之後真的要換產業,需要另外開一間新分店重新設定。
        </p>
      </div>

      <div>
        <Label htmlFor="merchant-address">地址</Label>
        <Input
          id="merchant-address"
          className="mt-2"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="選填"
        />
      </div>

      <div>
        <Label htmlFor="merchant-contact-email">對外聯絡 Email</Label>
        <Input
          id="merchant-contact-email"
          type="email"
          className="mt-2"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          placeholder="顯示給客戶看的聯絡信箱,跟你登入帳號的 Email 是分開的"
        />
      </div>

      <div>
        <Label htmlFor="merchant-intro">商家簡介</Label>
        <Textarea
          id="merchant-intro"
          className="mt-2"
          rows={3}
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
          placeholder="選填,簡單介紹這間店"
        />
      </div>

      {errorMessage ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}

      <Button type="submit" variant="cta" size="lg" className="w-full" disabled={submitting}>
        {submitting ? submittingLabel : submitLabel}
      </Button>
    </form>
  );
}
