// 商家設定頁(4.2)裡的 LOGO 上傳區塊，套用規則 2.6 的格式/大小限制，
// 前端先擋一次（validateLogoFile），Storage bucket 本身也設了同樣限制當第二道防線（3.5）。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 「更換 LOGO」改 ② 次要(這一頁的主要動作是「儲存變更」,一個畫面只能有一顆主要)。
//   - 「支援 PNG / JPG / WEBP,單檔上限 2MB」這種「怎麼填」的說明收進 `?`(skill 二),
//     並順便補上一句原本沒講清楚的事:LOGO 是選完就立刻上傳生效,不用再按下面的「儲存變更」。
// **只動外觀,不動行為**:格式 / 大小驗證、上傳流程、toast 文案照舊。

import { useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";

import { HelpToggle } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { validateLogoFile } from "./api";

interface LogoUploaderProps {
  currentLogoUrl: string | null;
  onUpload: (file: File) => Promise<void>;
}

export function LogoUploader({ currentLogoUrl, onUpload }: LogoUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 讓同一個檔案可以重新選取觸發 onChange
    if (!file) return;

    const validationError = validateLogoFile(file);
    if (validationError) {
      toast.error("檔案不符合要求", { description: validationError });
      return;
    }

    setPreviewUrl(URL.createObjectURL(file));
    setUploading(true);
    try {
      await onUpload(file);
      toast.success("LOGO 已更新");
    } catch (err) {
      // 2026-09-24 深夜巡檢修正:Supabase Storage 回傳的 error 不是 Error 的實例,
      // instanceof 永遠 false,真正的原因(bucket 大小/格式限制、權限)會被吞成「請稍後再試」。
      // 改用共用的 getErrorMessage(),見 platform-admin/getErrorMessage.ts 檔頭說明。
      toast.error("上傳失敗", { description: getErrorMessage(err, "請稍後再試") });
    } finally {
      setUploading(false);
    }
  }

  const displayUrl = previewUrl ?? currentLogoUrl;

  return (
    <div className="flex items-center gap-4">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
        {displayUrl ? (
          <img src={displayUrl} alt="商家 LOGO" className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs text-muted-foreground">無 LOGO</span>
        )}
      </div>
      <div className="min-w-0">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />
        {/* HelpToggle 展開的說明區塊是 basis-full,所以這一列必須是 flex flex-wrap。 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {/* ② 次要:這一頁的主要動作是「儲存變更」(skill 二之三,一個畫面只能有一顆主要)。 */}
          <Button
            type="button"
            variant="neutral"
            size="card"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? "上傳中⋯" : "更換 LOGO"}
          </Button>
          <HelpToggle label="說明:LOGO 可以上傳什麼格式、多大的檔案">
            支援 PNG / JPG / WEBP，單檔上限 2MB。選好檔案就會<strong>立刻上傳並生效</strong>,
            不用再按下面的「儲存變更」。
          </HelpToggle>
        </div>
      </div>
    </div>
  );
}
