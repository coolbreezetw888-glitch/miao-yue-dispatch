// 模組 11(LINE 通知)§4.4:行銷通知頁(新路由 /app/line-marketing;
// SPECS-INDEX #976 第 3 批(2026-10-06)起:商家管理員,或「再行銷通知」(line_marketing)權限開啟的客服可見,
// 守衛改用 RequireLineMarketingAccess,改前是 RequireMerchantAdmin;
// §10.1/SPECS-INDEX #584 改名前叫「行銷再通知頁」)。
// 會員多選清單(只顯示 line_bound=true 的會員,搜尋姓名/電話)+ 自訂訊息文字框(附字數統計)+
// 可用變數說明/即時預覽(§10.1,複用 §4.2/§385 既有的 TemplateVariablePreview 共用元件)+
// 「發送」按鈕(規則 2.6 二次確認)+ 發送後導向 4.3 發送記錄頁(篩選 marketing_manual)。
//
// §10.2(SPECS-INDEX #612)疊加:會員選擇從「只有單獨選擇」擴充成三種並存的選擇方式——
//   1. 單獨選擇(既有,不變)。
//   2. 依會員分類批量選擇(新增,依賴 #615 會員分級):勾選一個或多個等級,自動整批選入該
//      等級底下所有已綁定 LINE 的會員。
//   3. 排除清單(新增,依賴 #616 會員黑名單):黑名單客戶預設自動排除(唯讀顯示,不提供手動
//      取消排除的機制——這是待確認事項,見 memberSelection.ts 檔案開頭說明,不要自行假設答案);
//      商家也可以額外手動排除任何其他已綁定 LINE 的會員。
// 三種模式的實際選取/排除計算邏輯抽成 memberSelection.ts 的純函式,方便 Vitest 直接測試。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader;載入中改灰色骨架;沒有任何已綁定會員改 EmptyState(二之八)。
//   - 「單獨選擇 / 依會員分類批量選擇」改底線式切換列,variant="pages"(這是**內容分頁列**:
//     進去看另一塊內容,放不下可以橫向捲;不是篩選列。二之四末段的兩種列規則)。
//   - 會員 / 等級的打勾方框改成整條寬的可點方塊 ChoiceChip(二之七:手機好按),
//     每條至少 44px 觸控目標(一、核心原則)。
//   - 搜尋框改 FieldInput;訊息內容改 FormField + FieldTextarea,字數改用 FormField 的
//     counter(右上角 `34 / 5000`,二之七),不再自己在右下角放一行小字。
//   - 「可用變數」改成三欄說明表 + 「會員實際會收到」預覽框(二之七,做在共用元件裡)。
//   - 發送二次確認改小卡窗殼 CardAlertDialog(三、兩種窗)。🔴 發送**不標紅**:紅色只留給
//     「會刪東西」的不可逆動作,發送訊息不刪任何東西(第 1 / 2 批已定案的裁決)。
//     「送出後無法收回」這句改用 🟡 常駐 `!`,因為它正是「按下去會發生什麼不可逆的事」(二)。
//   - 「發送」是這一頁唯一的 ① 主要按鈕(二之三)。
//
// **只動外觀,不動行為**:選取 / 排除的計算(memberSelection.ts)、黑名單自動排除、送出的
// 名單與訊息、送出後導向發送記錄頁、字數上限 5000 全部照舊。
//
// 客戶端第 5 批 5-B(#1047,C5-P01):行銷改成「每位開著優惠通知的聯絡人各發一則」。
//   - 名單每位會員多一行「可收到 X 人」(preview_line_marketing_recipients,整份名單算一次)。
//   - 發送確認窗改成「即將發送給 N 位會員，共 M 則訊息（會用掉 M 則官方帳號額度），確定要送出嗎？」,
//     打開確認窗時用「最後要送的名單」重新算一次;一則都不會發 ⇒ 確定鈕停用 + 常駐 `!` 說明原因。

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Users } from "lucide-react";

import {
  AlertNote,
  AttributeTag,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  CardAlertDialogTrigger,
  ChoiceChip,
  EmptyState,
  ErrorState,
  FieldInput,
  FieldTextarea,
  FormField,
  LoadingSkeleton,
  PageHeader,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent } from "@/components/ui/tabs";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useMerchantMemberTiers } from "@/modules/members/api";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

import {
  sendMarketingMessage,
  useLineMarketingPreview,
  useMarketableMembers,
  type MarketableMember,
} from "./api";
import {
  formatMarketingConfirmText,
  formatReachableCount,
  formatUnreachableNote,
  MARKETING_NOBODY_NOTE,
  MARKETING_PREVIEW_FAILED_NOTE,
} from "./marketingPreview";
import {
  computeFinalRecipientIds,
  isTierFullySelected,
  toggleTierSelection,
} from "./memberSelection";
import { RequireLineMarketingAccess } from "./RequireLineMarketingAccess";
import { TemplateVariablePreview } from "./TemplateVariablePreview";
import {
  LINE_MARKETING_TEMPLATE_PREVIEW_SAMPLE_VALUES,
  LINE_MARKETING_TEMPLATE_VARIABLE_DEFINITIONS,
  previewLineMarketingTemplate,
} from "./templateVariables";

// LINE 文字訊息上限 5000 字(規格書「本模組明確不做的事」一節,engineer 動工前已查證,2026-09-20
// 官方文件仍列 5000 字上限)。
const MESSAGE_MAX_LENGTH = 5000;

/** 可點的整條寬方塊(skill 二之七「多選用可點的方塊」)。清單型的多選一條一條堆,所以撐滿寬度、
 *  內容靠左、至少 44px 高(一、核心原則的觸控目標)。 */
const LIST_CHIP_CLASS = "min-h-11 w-full justify-start text-left";

function LineMarketingPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const navigate = useNavigate();
  // #976 第 3 批:發送後原本一律導向「LINE 發送記錄」頁,但那一頁的守衛看 line_notification ——
  // 只開了 line_marketing 的客服會被那邊導回首頁,看起來像「發送失敗」。看得到記錄頁的人(管理員或
  // line_notification 客服)照舊導過去;看不到的人改回功能頁(結果已經在 toast 顯示)。
  const { data: role } = useCurrentMerchantRole();
  const { data: canManageLineNotification } = useAgentPermission("line_notification");
  const canViewLineLogs = role === "admin" || canManageLineNotification === true;

  // 🔴 2026-09-30(品管第二次打回,🟡 第 3 項):原本只取 isLoading,查詢失敗時 members 是
  // undefined ⇒ 畫成「還沒有任何會員完成 LINE 綁定」,商家以為綁定資料全沒了。
  // isError 分支排在空狀態之前。
  const {
    data: members,
    isLoading,
    isError,
    refetch: refetchMarketableMembers,
  } = useMarketableMembers(merchantId);
  // §10.2:「依會員分類批量選擇」依賴 #615 會員分級,只需要目前還在使用中的等級(下架的等級
  // 不該再出現在批量選擇的清單裡)。
  const { data: tiers } = useMerchantMemberTiers(merchantId, true);

  const [search, setSearch] = useState("");
  const [excludeSearch, setExcludeSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const memberList: MarketableMember[] = useMemo(() => members ?? [], [members]);
  // C5-P01:整份名單每位會員「可收到 X 人」(算一次;失敗就不顯示那行,不擋操作)。
  const allMemberIds = useMemo(() => memberList.map((m) => m.id), [memberList]);
  const { data: listPreview } = useLineMarketingPreview(
    merchantId,
    allMemberIds,
    allMemberIds.length > 0,
  );

  const filteredMembers = useMemo(() => {
    const term = search.trim();
    if (!term) return memberList;
    return memberList.filter((m) => m.name.includes(term) || (m.phone ?? "").includes(term));
  }, [memberList, search]);

  // §10.2「排除清單」:可以手動排除的名單來源就是「已綁定 LINE 的會員」全體(跟單獨選擇同一份
  // 名單),黑名單會員另外用唯讀的「系統自動排除」區塊顯示,不出現在這個手動排除的可勾選清單裡
  // (避免同一個人同時出現在兩個排除區塊造成混淆)。
  const excludableMembers = useMemo(() => memberList.filter((m) => !m.isBlacklisted), [memberList]);
  const filteredExcludableMembers = useMemo(() => {
    const term = excludeSearch.trim();
    if (!term) return excludableMembers;
    return excludableMembers.filter((m) => m.name.includes(term) || (m.phone ?? "").includes(term));
  }, [excludableMembers, excludeSearch]);

  const blacklistedMembers = useMemo(() => memberList.filter((m) => m.isBlacklisted), [memberList]);

  const finalRecipientIds = useMemo(
    () => computeFinalRecipientIds(memberList, selectedIds, excludedIds),
    [memberList, selectedIds, excludedIds],
  );

  function toggleSelected(memberId: string, checked: boolean) {
    setSelectedIds((prev) =>
      checked ? [...prev, memberId] : prev.filter((id) => id !== memberId),
    );
  }

  function toggleTier(tierId: string, checked: boolean) {
    setSelectedIds((prev) => toggleTierSelection(memberList, tierId, prev, checked));
  }

  function toggleExcluded(memberId: string, checked: boolean) {
    setExcludedIds((prev) =>
      checked ? [...prev, memberId] : prev.filter((id) => id !== memberId),
    );
  }

  async function handleSend() {
    if (finalRecipientIds.length === 0 || !message.trim()) return;
    setSending(true);
    try {
      const result = await sendMarketingMessage({
        merchantId,
        memberIds: finalRecipientIds,
        message: message.trim(),
      });
      toast.success(
        `已送出：成功 ${result.sentCount} 筆、失敗 ${result.failedCount} 筆、跳過 ${result.skippedCount} 筆`,
      );
      navigate(canViewLineLogs ? "/app/line-logs" : "/app/manage");
    } catch (err) {
      toast.error("發送失敗", { description: getErrorMessage(err) });
    } finally {
      setSending(false);
    }
  }

  const canSend = finalRecipientIds.length > 0 && message.trim().length > 0;

  // C5-P01:確認窗打開時用最後要送的名單重新算則數。
  const confirmPreview = useLineMarketingPreview(merchantId, finalRecipientIds, confirmOpen);
  const confirmReady = confirmPreview.data !== undefined;
  const nobodyReachable = confirmReady && confirmPreview.data.messageCount === 0;

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/manage"
        helpMode
        title="再行銷通知"
        description="挑選已綁定 LINE 的會員名單，發送一次性的自訂文字訊息（不是自動化排程）。"
      />

      <Card>
        <CardHeader>
          <CardTitle>選擇會員</CardTitle>
          <CardDescription>
            只列出已綁定 LINE 的會員，還沒綁定的會員不會出現在這裡。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {isLoading ? (
            <LoadingSkeleton variant="cards" rows={3} />
          ) : isError ? (
            <ErrorState
              title="讀不到已綁定 LINE 的會員名單"
              reason="可能是網路斷了；現在先不顯示名單，避免你把空白當成「會員的 LINE 綁定都不見了」"
              onRetry={() => void refetchMarketableMembers()}
            />
          ) : memberList.length === 0 ? (
            <EmptyState
              icon={<Users className="h-6 w-6" aria-hidden="true" />}
              title="還沒有任何會員完成 LINE 綁定"
              description="會員在 LINE 加商家官方帳號好友、傳送綁定碼之後就會出現在這裡，才能收到行銷訊息。綁定碼在「會員管理 > 會員詳情頁」產生。"
            />
          ) : (
            <Tabs defaultValue="individual">
              {/* 內容分頁列(進去看另一塊內容)⇒ variant="pages",放不下可以橫向捲。 */}
              <UnderlineTabsList variant="pages">
                <UnderlineTabsTrigger value="individual">單獨選擇</UnderlineTabsTrigger>
                <UnderlineTabsTrigger value="by-tier">依會員分類批量選擇</UnderlineTabsTrigger>
              </UnderlineTabsList>

              <TabsContent value="individual" className="mt-3 flex flex-col gap-3">
                <FieldInput
                  aria-label="輸入姓名或電話搜尋會員"
                  placeholder="輸入姓名/電話搜尋"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {filteredMembers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">找不到符合搜尋條件的會員。</p>
                ) : (
                  <ul
                    className="flex max-h-72 flex-col gap-1.5 overflow-y-auto"
                    data-testid="line-marketing-individual-list"
                  >
                    {filteredMembers.map((m) => (
                      <li key={m.id}>
                        <ChoiceChip
                          className={LIST_CHIP_CLASS}
                          selected={selectedIds.includes(m.id)}
                          onClick={() => toggleSelected(m.id, !selectedIds.includes(m.id))}
                        >
                          <span className="min-w-0 break-words">{m.name}</span>
                          {m.phone ? (
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {m.phone}
                            </span>
                          ) : null}
                          {m.isBlacklisted ? (
                            <AttributeTag wrap>黑名單・會自動從送出名單排除</AttributeTag>
                          ) : null}
                          {!m.isBlacklisted && listPreview ? (
                            <span
                              className="text-xs tabular-nums text-muted-foreground"
                              data-testid="line-marketing-reachable"
                            >
                              {formatReachableCount(listPreview.perMember.get(m.id))}
                            </span>
                          ) : null}
                        </ChoiceChip>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="by-tier" className="mt-3 flex flex-col gap-3">
                {!tiers || tiers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    這個商家目前還沒有設定任何會員等級，請先到會員系統設定頁新增等級。
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5" data-testid="line-marketing-tier-list">
                    {tiers.map((tier) => {
                      const tierMemberCount = memberList.filter((m) => m.tierId === tier.id).length;
                      const tierSelected = isTierFullySelected(memberList, tier.id, selectedIds);
                      return (
                        <li key={tier.id}>
                          <ChoiceChip
                            className={LIST_CHIP_CLASS}
                            selected={tierSelected}
                            onClick={() => toggleTier(tier.id, !tierSelected)}
                          >
                            <span className="min-w-0 break-words">{tier.name}</span>
                            <span className="text-xs tabular-nums text-muted-foreground">
                              ({tierMemberCount} 位已綁定 LINE 的會員)
                            </span>
                          </ChoiceChip>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  勾選等級會把該等級底下所有已綁定 LINE
                  的會員一次整批選入名單，也可以跟「單獨選擇」分頁的選取結果並存。
                </p>
              </TabsContent>
            </Tabs>
          )}
          <p className="text-xs leading-relaxed tabular-nums text-muted-foreground">
            目前選取 {selectedIds.length} 位會員(單獨選擇 +
            依分類批量選擇合計，尚未扣除下方排除清單)
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>排除清單</CardTitle>
          <CardDescription>
            這裡排除的會員，即使符合上面「單獨選擇」或「依分類批量選擇」的條件，最終送出名單裡也不會包含。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-semibold text-foreground">系統自動排除(黑名單客戶)</p>
            {blacklistedMembers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                目前已綁定 LINE 的會員裡沒有黑名單客戶。
              </p>
            ) : (
              <ul
                className="flex max-h-40 flex-col gap-1.5 overflow-y-auto"
                data-testid="line-marketing-blacklist-list"
              >
                {blacklistedMembers.map((m) => (
                  <li
                    key={m.id}
                    className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
                  >
                    <span className="min-w-0 break-words">{m.name}</span>
                    {m.phone ? <span className="text-xs tabular-nums">{m.phone}</span> : null}
                    <AttributeTag wrap>黑名單客戶・已自動排除，不需要手動勾選</AttributeTag>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-semibold text-foreground">手動排除</p>
            <FieldInput
              aria-label="輸入姓名或電話搜尋要排除的會員"
              placeholder="輸入姓名/電話搜尋要排除的會員"
              value={excludeSearch}
              onChange={(e) => setExcludeSearch(e.target.value)}
            />
            {excludableMembers.length === 0 ? (
              <p className="text-xs text-muted-foreground">沒有其他可以手動排除的會員。</p>
            ) : filteredExcludableMembers.length === 0 ? (
              <p className="text-xs text-muted-foreground">找不到符合搜尋條件的會員。</p>
            ) : (
              <ul
                className="flex max-h-40 flex-col gap-1.5 overflow-y-auto"
                data-testid="line-marketing-manual-exclude-list"
              >
                {filteredExcludableMembers.map((m) => (
                  <li key={m.id}>
                    <ChoiceChip
                      className={LIST_CHIP_CLASS}
                      selected={excludedIds.includes(m.id)}
                      onClick={() => toggleExcluded(m.id, !excludedIds.includes(m.id))}
                    >
                      <span className="min-w-0 break-words">{m.name}</span>
                      {m.phone ? (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {m.phone}
                        </span>
                      ) : null}
                    </ChoiceChip>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>訊息內容</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <FormField
            label="要發送的訊息"
            htmlFor="line-marketing-message"
            counter={{ value: message.length, max: MESSAGE_MAX_LENGTH }}
          >
            <FieldTextarea
              id="line-marketing-message"
              rows={5}
              maxLength={MESSAGE_MAX_LENGTH}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="輸入要發送的訊息內容，可搭配下方的可用變數"
            />
          </FormField>
          {/* skill 二之七:變數說明要完整(三欄:變數 / 中文意思 / 範例值)+ 預覽框。 */}
          <TemplateVariablePreview
            variables={LINE_MARKETING_TEMPLATE_VARIABLE_DEFINITIONS}
            sampleValues={LINE_MARKETING_TEMPLATE_PREVIEW_SAMPLE_VALUES}
            recipientLabel="會員"
            previews={[{ text: previewLineMarketingTemplate(message) }]}
          />

          <p className="text-sm tabular-nums text-muted-foreground">
            實際會送出 {finalRecipientIds.length} 位會員(已扣除排除清單與黑名單客戶)
          </p>

          <CardAlertDialog
            open={confirmOpen}
            onOpenChange={(open) => {
              if (!sending) setConfirmOpen(open);
            }}
          >
            <CardAlertDialogTrigger asChild>
              {/* 這一頁唯一的 ① 主要按鈕(skill 二之三)。 */}
              <Button
                type="button"
                variant="primary"
                size="touch"
                className="self-start"
                disabled={!canSend || sending}
              >
                {sending ? "發送中⋯" : "發送"}
              </Button>
            </CardAlertDialogTrigger>
            <CardAlertDialogContent data-testid="line-marketing-confirm">
              <CardAlertDialogHeader>
                <CardAlertDialogTitle>確定要發送嗎？</CardAlertDialogTitle>
                <CardAlertDialogDescription data-testid="line-marketing-confirm-text">
                  {confirmPreview.isLoading
                    ? "正在計算會用掉幾則官方帳號額度⋯"
                    : confirmPreview.data
                      ? formatMarketingConfirmText(
                          confirmPreview.data.memberCount,
                          confirmPreview.data.messageCount,
                        )
                      : `即將發送給 ${finalRecipientIds.length} 位會員，確定要送出嗎？`}
                </CardAlertDialogDescription>
              </CardAlertDialogHeader>
              {confirmPreview.data && !nobodyReachable ? (
                formatUnreachableNote(finalRecipientIds.length, confirmPreview.data.memberCount) ? (
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    {formatUnreachableNote(
                      finalRecipientIds.length,
                      confirmPreview.data.memberCount,
                    )}
                  </p>
                ) : null
              ) : null}
              {confirmPreview.isError ? (
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  {MARKETING_PREVIEW_FAILED_NOTE}
                </p>
              ) : null}
              {/* 🟡 常駐 `!`:為什麼確定鈕按不了(skill 二,第一類)。 */}
              {nobodyReachable ? (
                <AlertNote data-testid="line-marketing-nobody">{MARKETING_NOBODY_NOTE}</AlertNote>
              ) : (
                // 🟡 常駐 `!`:按下去會發生什麼不可逆的事(skill 二,第二類)。
                <AlertNote>訊息一旦送到會員的 LINE 就無法收回，也不能編輯。</AlertNote>
              )}
              <CardAlertDialogFooter>
                <CardAlertDialogCancel disabled={sending}>再想想</CardAlertDialogCancel>
                <CardAlertDialogAction
                  disabled={sending || confirmPreview.isLoading || nobodyReachable}
                  onClick={(e) => {
                    e.preventDefault();
                    void handleSend().then(() => setConfirmOpen(false));
                  }}
                  data-testid="line-marketing-confirm-send"
                >
                  {sending ? "發送中⋯" : "確定發送"}
                </CardAlertDialogAction>
              </CardAlertDialogFooter>
            </CardAlertDialogContent>
          </CardAlertDialog>
        </CardContent>
      </Card>
    </main>
  );
}

export default function LineMarketingPage() {
  return (
    <RequireLineMarketingAccess>
      <LineMarketingPageInner />
    </RequireLineMarketingAccess>
  );
}
