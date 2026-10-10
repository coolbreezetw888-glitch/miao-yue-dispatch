// SPECS-INDEX #1052 H2-12:上傳圖片(商家 LOGO、服務人員頭像)的副檔名一律由實際的檔案類型(MIME)決定,
// 不再沿用使用者原本的檔名 —— 檔名可以亂取,檔案類型才是瀏覽器與 Storage 白名單實際檢查的東西。

const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** 依 MIME 回傳副檔名(png / jpg / webp)。呼叫前各上傳函式已經擋過格式,這裡遇到其他類型一樣擋下。 */
export function imageExtensionForMime(mimeType: string): string {
  const ext = IMAGE_EXTENSION_BY_MIME[mimeType];
  if (!ext) throw new Error("只能上傳 PNG、JPG 或 WEBP 格式的圖片");
  return ext;
}
