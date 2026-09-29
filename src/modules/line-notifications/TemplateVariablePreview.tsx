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
//
// ─────────────────────────────────────────────────────────────────────────────
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill 二之七「🔴 變數說明要完整
// (不能只列變數名)」。
//
// 使用者 2026-09-29 原話:「變數的部分有點太簡短,需要做成一個說明,變數的中文意思代表什麼?
// 範例,還有預覽結果」。所以原本那一行「可用變數:{{merchant_name}}(商家名稱)、…」擠成一段
// 灰色小字的做法不合格,改成 skill 指定的三欄說明表:
//
//     | 變數 | 中文意思 | 範例值 |
//
// 底下再接一個「○○○實際會收到」的預覽框(把變數代入範例值後的完整結果)。
// 三欄的「範例值」跟預覽框用的是**同一份範例假資料**(呼叫端傳 sampleValues),所以商家在表格裡
// 看到的值,跟預覽框裡實際被代進去的值一定一致 —— 兩邊各給一份假資料是之後最容易走鐘的地方。
//
// 📌 為什麼這個說明區塊維持常駐、不收進 `?`:skill 二之七是**點名要求**做出這個區塊
//    (「可用變數要做成一個說明區塊,三欄 … 底下再加一個預覽框」),把規格指定的區塊藏進 `?`
//    等於沒做。`?` 的用途是「看過一次就懂、可以收起來的補充」,不是用來藏規格要求的內容。
// 📌 320px 下的做法:table-fixed + 三欄各自 break-all / break-words,變數欄的
//    `{{merchant_name}}` 會折成兩行而不是把後面兩欄擠成 0 寬(比照 skill 二之六明細列踩過的坑:
//    兩側都可能是長文字,不能只讓其中一側 shrink-0)。
// ─────────────────────────────────────────────────────────────────────────────

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
  /**
   * skill 二之七:三欄說明表「範例值」那一欄要顯示的值。傳的**必須是呼叫端自己模組用來渲染
   * `previews` 的那一份範例假資料**,表格跟預覽框才會一致。沒有對應 key 的變數顯示 `—`。
   */
  sampleValues?: Record<string, string>;
  /**
   * skill 二之七:預覽框上方那句「○○○實際會收到」的主體。例:`"會員"`(行銷通知)、
   * `"服務人員"`(推播)、`"收到通知的人"`(LINE 事件通知,對象依設定可能是客戶或服務人員)。
   */
  recipientLabel?: string;
}

export function TemplateVariablePreview({
  variables,
  previews,
  emptyText = "(尚未填寫文案)",
  sampleValues,
  recipientLabel = "收到通知的人",
}: TemplateVariablePreviewProps) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {/* skill 二之七:三欄說明表 —— 變數 / 中文意思 / 範例值。 */}
      <div className="rounded-md border border-info/30 bg-info-soft px-3 py-2.5">
        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-info-strong">
          可用變數
        </p>
        {variables.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-info-strong">
            這個事件目前沒有可用變數,文案裡打什麼就會原封不動送出去。
          </p>
        ) : (
          <table className="w-full table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[40%]" />
              <col className="w-[26%]" />
              <col className="w-[34%]" />
            </colgroup>
            <thead>
              <tr className="text-[11px] font-semibold text-info-strong/70">
                <th scope="col" className="pb-1 pr-1.5 font-semibold">
                  變數
                </th>
                <th scope="col" className="pb-1 pr-1.5 font-semibold">
                  中文意思
                </th>
                <th scope="col" className="pb-1 font-semibold">
                  範例值
                </th>
              </tr>
            </thead>
            <tbody className="align-top">
              {variables.map((variable) => (
                <tr key={variable.key} className="border-t border-info/20">
                  <td className="py-1 pr-1.5">
                    <code className="break-all font-mono text-[11px] font-semibold text-info-strong">
                      {`{{${variable.key}}}`}
                    </code>
                  </td>
                  <td className="break-words py-1 pr-1.5 text-[11px] text-info-strong">
                    {variable.label}
                  </td>
                  <td className="break-words py-1 text-[11px] text-info-strong/80">
                    {sampleValues?.[variable.key] ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* skill 二之七:把變數代入範例值後的完整結果 —— 「○○○實際會收到」。 */}
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2.5">
        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
          {recipientLabel}實際會收到
        </p>
        <div className="flex flex-col gap-2">
          {previews.map((preview, index) => (
            <div key={preview.label ?? index}>
              {preview.label ? (
                <p className="text-[11px] font-semibold text-muted-foreground">{preview.label}</p>
              ) : null}
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">
                {preview.text || emptyText}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
