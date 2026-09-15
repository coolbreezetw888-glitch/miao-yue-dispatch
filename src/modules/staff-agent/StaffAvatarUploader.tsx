// 對應規格書 4.2 邊界情況:服務人員頭像上傳,改寫自模組 1 LogoUploader.tsx,
// 格式/大小限制沿用同樣標準(見 api.ts 的 validateAvatarFile)。

import { useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { validateAvatarFile } from "./api";

interface StaffAvatarUploaderProps {
  currentAvatarUrl: string | null;
  onUpload: (file: File) => Promise<void>;
}

export function StaffAvatarUploader({ currentAvatarUrl, onUpload }: StaffAvatarUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 讓同一個檔案可以重新選取觸發 onChange
    if (!file) return;

    const validationError = validateAvatarFile(file);
    if (validationError) {
      toast.error("檔案不符合要求", { description: validationError });
      return;
    }

    setPreviewUrl(URL.createObjectURL(file));
    setUploading(true);
    try {
      await onUpload(file);
      toast.success("頭像已更新");
    } catch (err) {
      toast.error("上傳失敗", {
        description: err instanceof Error ? err.message : "請稍後再試",
      });
    } finally {
      setUploading(false);
    }
  }

  const displayUrl = previewUrl ?? currentAvatarUrl;

  return (
    <div className="flex items-center gap-4">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted">
        {displayUrl ? (
          <img src={displayUrl} alt="服務人員頭像" className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs text-muted-foreground">無照片</span>
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
          {uploading ? "上傳中⋯" : "上傳頭像"}
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">支援 PNG / JPG / WEBP,單檔上限 2MB</p>
      </div>
    </div>
  );
}
