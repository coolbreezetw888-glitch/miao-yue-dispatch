// SPECS-INDEX #1025 FG1-U06 第 3 點(QA L1):產業轉移精靈「選會員」空狀態的說明。
// 平台沒開通「資料匯入」⇒ 不提資料匯入(整個看不到的功能不出現在說明裡)。

/** 「選會員」步驟沒有上架中會員時的說明文字。dataImportFeatureOn 只有確定開通(true)才提資料匯入。 */
export function emptyActiveMembersDescription(dataImportFeatureOn: boolean): string {
  return dataImportFeatureOn
    ? "只有「上架中」的會員可以搬到新商家。要先在會員管理把會員上架，或是先用資料匯入把客戶匯進來。"
    : "只有「上架中」的會員可以搬到新商家。要先在會員管理把會員上架。";
}
