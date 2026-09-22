// 模組 11(LINE 通知)共用元件:「可用變數說明 + 即時預覽」UI 模式(SPECS-INDEX #385 完成)。
//
// 這份 UI 原本寫死在 LineEventSettingsPage.tsx(§4.2)內、沒有抽出來。SPECS-INDEX #584(LINE
// 通知§10.1「行銷通知」頁)、#586(服務人員推播通知§13.1「推播事件設定」頁)這兩批商家端調整
// 都要求複用同一套「顯示這個範本目前有哪些可用變數 + 套用範例假資料渲染後長什麼樣子」的呈現
// 方式,這次順手把它抽成共用元件,§4.2/行銷通知頁/推播事件設定頁三處都 import 這個元件,
// 不要三份各寫一份幾乎相同的 JSX(對應 §10.1 規格書明確要求)。
//
// 本元件只負責「怎麼呈現」,不負責「這個範本實際有哪些變數/怎麼渲染範例值」——那些邏輯留在各
// 自模組自己的檔案裡(LINE 通知:templateVariables.ts;推播通知:各自對應的檔案),對應這個
// 專案既有的「前端/Edge Function 之間各自維護一份小型渲染邏輯」慣例延伸出的「呈現邏輯共用、
// 資料定義各自獨立」原則——推播事件設定頁複用這個元件是模組 15 依賴模組 11 對外介面的一部分
// (見 `.project/specs/服務人員推播通知.md` §8.3/§13.1)。

interface TemplateVariableDefinition {
  key: string;
  label: string;
}

interface TemplateVariablePreviewSection {
  /** 這段預覽的標籤,例如推播通知的「標題」「內文」要分開兩段預覽(對應 §13.1 邊界情況:
   * 推播內文寸土寸金,不能像 LINE 訊息合併成一大段文字)。只有單一段落時可以省略(LINE 訊息
   * 本來就是單一段落文字,不需要標籤)。 */
  label?: string;
  /** 套用範例假資料渲染後的文字。 */
  text: string;
}

interface TemplateVariablePreviewProps {
  /** 這個範本目前有哪些可用變數,依呼叫端傳入的清單決定(不同頁面/不同事件可能不一樣,例如
   * 推播通知§13.1 要求「每種事件類型只列出該事件實際會替換到的變數」)。 */
  variables: TemplateVariableDefinition[];
  previews: TemplateVariablePreviewSection[];
  /** 範本是空字串時顯示的提示文字。 */
  emptyText?: string;
}

export function TemplateVariablePreview({
  variables,
  previews,
  emptyText = "(尚未填寫文案)",
}: TemplateVariablePreviewProps) {
  return (
    <>
      <p className="mt-1 text-xs text-muted-foreground">
        可用變數:
        {variables.length === 0
          ? "這個事件目前沒有可用變數"
          : variables.map((v, i) => `${i > 0 ? "、" : ""}{{${v.key}}}(${v.label})`)}
      </p>
      <div className="mt-2 space-y-2 rounded-md border border-dashed border-border px-3 py-2">
        <p className="text-xs text-muted-foreground">即時預覽(套用範例假資料)</p>
        {previews.map((preview, index) => (
          <div key={preview.label ?? index}>
            {preview.label ? (
              <p className="text-xs font-medium text-muted-foreground">{preview.label}</p>
            ) : null}
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {preview.text || emptyText}
            </p>
          </div>
        ))}
      </div>
    </>
  );
}
