// 商家設定頁(4.2)裡的 LOGO 上傳區塊，套用規則 2.6 的格式/大小限制，
// 前端先擋一次（validateLogoFile），Storage bucket 本身也設了同樣限制當第二道防線（3.5）。

import { useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
      toast.error("上傳失敗", {
        description: err instanceof Error ? err.message : "請稍後再試",
      });
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
      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? "上傳中⋯" : "更換 LOGO"}
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">支援 PNG / JPG / WEBP，單檔上限 2MB</p>
      </div>
    </div>
  );
}
