// 秒約全站 UI/UX 規範(方案 D)的共用元件 —— 規格書是 .claude/skills/ui-overlay-patterns/SKILL.md。
// 每個檔案開頭都寫了對應 skill 的哪一節;改任何一個都會影響全站,改之前先讀 skill。
//
// | 元件 | 檔案 | skill 節次 |
// |---|---|---|
// | 小卡窗殼(表單版 / 純確認版) | CardDialog.tsx / CardAlertDialog.tsx | 三、兩種窗 → 小卡窗 |
// | 全頁層殼 | FullPageLayer.tsx | 三、兩種窗 → 全頁層 |
// | 底部動作列(等寬) | ActionBar.tsx | 二之三 |
// | 按鈕四階層 | components/ui/button.tsx 的 primary / neutral / danger / text variant | 二之三 |
// | 標籤三類 | Tags.tsx(底層 components/ui/badge.tsx 的新 variant) | 二之四 |
// | 列表卡片 | ListCard.tsx | 二之五 |
// | 明細列 | DetailRows.tsx | 二之六 |
// | 表單欄位(輸入框 / 金額 / 下拉 FieldSelect / 原生 select・time・date・month・color / 多選 ChoiceChip / 單選 ChoiceChipGroup / 開關列) | FormField.tsx | 二之七 |
// | 金額字串解析(送出前驗證) | parseAmountInput.ts | 二之七 |
// | 頁面骨架 + 三種狀態 | PageScaffold.tsx | 二之八 |
// | 路由守衛的等待畫面(全站 22 支守衛共用) | GuardLoading.tsx | 二之八 |
// | 底線式切換列 | UnderlineTabs.tsx | 二之四末段 + 二之八 |
// | 右緣漸層要不要顯示(橫捲提示) | useHorizontalScrollHint.ts | 六 |
// | `?` 說明鈕 / `!` 提醒條 | HelpHint.tsx | 二 |

export * from "./ActionBar";
export * from "./CardAlertDialog";
export * from "./CardDialog";
export * from "./DetailRows";
export * from "./FormField";
export * from "./FullPageLayer";
export * from "./GuardLoading";
export * from "./HelpHint";
export * from "./ListCard";
export * from "./PageScaffold";
export * from "./parseAmountInput";
export * from "./Tags";
export * from "./UnderlineTabs";
export * from "./useHorizontalScrollHint";
