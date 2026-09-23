// 模組 11(LINE 通知)§4.4:行銷通知頁(新路由 /app/line-marketing,僅商家管理員可見;
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

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useMerchantMemberTiers } from "@/modules/members/api";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { RequireMerchantAdmin } from "@/modules/staff-agent/RequireMerchantAdmin";

import { sendMarketingMessage, useMarketableMembers, type MarketableMember } from "./api";
import {
  computeFinalRecipientIds,
  isTierFullySelected,
  toggleTierSelection,
} from "./memberSelection";
import { TemplateVariablePreview } from "./TemplateVariablePreview";
import {
  LINE_MARKETING_TEMPLATE_VARIABLE_DEFINITIONS,
  previewLineMarketingTemplate,
} from "./templateVariables";

// LINE 文字訊息上限 5000 字(規格書「本模組明確不做的事」一節,engineer 動工前已查證,2026-09-20
// 官方文件仍列 5000 字上限)。
const MESSAGE_MAX_LENGTH = 5000;

function LineMarketingPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const navigate = useNavigate();

  const { data: members, isLoading } = useMarketableMembers(merchantId);
  // §10.2:「依會員分類批量選擇」依賴 #615 會員分級,只需要目前還在使用中的等級(下架的等級
  // 不該再出現在批量選擇的清單裡)。
  const { data: tiers } = useMerchantMemberTiers(merchantId, true);

  const [search, setSearch] = useState("");
  const [excludeSearch, setExcludeSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const memberList: MarketableMember[] = members ?? [];

  const filteredMembers = useMemo(() => {
    const term = search.trim();
    if (!term) return memberList;
    return memberList.filter((m) => m.name.includes(term) || (m.phone ?? "").includes(term));
  }, [memberList, search]);

  // §10.2「排除清單」:可以手動排除的名單來源就是「已綁定 LINE 的會員」全體(跟單獨選擇同一份
  // 名單),黑名單會員另外用唯讀的「系統自動排除」區塊顯示,不出現在這個手動排除的可勾選清單裡
  // (避免同一個人同時出現在兩個排除區塊造成混淆)。
  const excludableMembers = useMemo(
    () => memberList.filter((m) => !m.isBlacklisted),
    [memberList],
  );
  const filteredExcludableMembers = useMemo(() => {
    const term = excludeSearch.trim();
    if (!term) return excludableMembers;
    return excludableMembers.filter(
      (m) => m.name.includes(term) || (m.phone ?? "").includes(term),
    );
  }, [excludableMembers, excludeSearch]);

  const blacklistedMembers = useMemo(
    () => memberList.filter((m) => m.isBlacklisted),
    [memberList],
  );

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
        `已送出:成功 ${result.sentCount} 筆、失敗 ${result.failedCount} 筆、跳過 ${result.skippedCount} 筆`,
      );
      navigate("/app/line-logs");
    } catch (err) {
      toast.error("發送失敗", { description: getErrorMessage(err) });
    } finally {
      setSending(false);
    }
  }

  const canSend = finalRecipientIds.length > 0 && message.trim().length > 0;

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">行銷通知</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          手動挑選已綁定 LINE 的會員名單,發送一次性的自訂文字訊息(不是自動化排程)。
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>選擇會員</CardTitle>
          <CardDescription>只列出已綁定 LINE 的會員,還沒綁定的會員不會出現在這裡。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : memberList.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前沒有任何會員完成 LINE 綁定。</p>
          ) : (
            <Tabs defaultValue="individual">
              <TabsList>
                <TabsTrigger value="individual">單獨選擇</TabsTrigger>
                <TabsTrigger value="by-tier">依會員分類批量選擇</TabsTrigger>
              </TabsList>

              <TabsContent value="individual" className="space-y-3">
                <Input
                  placeholder="輸入姓名/電話搜尋"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {filteredMembers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">找不到符合搜尋條件的會員。</p>
                ) : (
                  <ul
                    className="max-h-72 space-y-1 overflow-y-auto"
                    data-testid="line-marketing-individual-list"
                  >
                    {filteredMembers.map((m) => (
                      <li key={m.id}>
                        <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                          <Checkbox
                            checked={selectedIds.includes(m.id)}
                            onCheckedChange={(v) => toggleSelected(m.id, v === true)}
                          />
                          <span className="text-foreground">{m.name}</span>
                          {m.phone ? (
                            <span className="text-xs text-muted-foreground">{m.phone}</span>
                          ) : null}
                          {m.isBlacklisted ? (
                            <span className="text-xs text-destructive">
                              (黑名單,將自動從送出名單排除)
                            </span>
                          ) : null}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="by-tier" className="space-y-3">
                {!tiers || tiers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    這個商家目前還沒有設定任何會員等級,請先到會員系統設定頁新增等級。
                  </p>
                ) : (
                  <ul className="space-y-1" data-testid="line-marketing-tier-list">
                    {tiers.map((tier) => {
                      const tierMemberCount = memberList.filter(
                        (m) => m.tierId === tier.id,
                      ).length;
                      return (
                        <li key={tier.id}>
                          <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                            <Checkbox
                              checked={isTierFullySelected(memberList, tier.id, selectedIds)}
                              onCheckedChange={(v) => toggleTier(tier.id, v === true)}
                            />
                            <span className="text-foreground">{tier.name}</span>
                            <span className="text-xs text-muted-foreground">
                              ({tierMemberCount} 位已綁定 LINE 的會員)
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  勾選等級會把該等級底下所有已綁定 LINE 的會員一次整批選入名單,也可以跟「單獨選擇」
                  分頁的選取結果並存。
                </p>
              </TabsContent>
            </Tabs>
          )}
          <p className="text-xs text-muted-foreground">
            目前選取 {selectedIds.length} 位會員(單獨選擇 + 依分類批量選擇合計,尚未扣除下方排除清單)
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>排除清單</CardTitle>
          <CardDescription>
            這裡排除的會員,即使符合上面「單獨選擇」或「依分類批量選擇」的條件,最終送出名單裡也不會包含。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">系統自動排除(黑名單客戶)</p>
            {blacklistedMembers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                目前已綁定 LINE 的會員裡沒有黑名單客戶。
              </p>
            ) : (
              <ul
                className="max-h-40 space-y-1 overflow-y-auto"
                data-testid="line-marketing-blacklist-list"
              >
                {blacklistedMembers.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
                  >
                    <span>{m.name}</span>
                    {m.phone ? <span className="text-xs">{m.phone}</span> : null}
                    <span className="text-xs">(黑名單客戶,不需要手動勾選,已自動排除)</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">手動排除</p>
            <Input
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
                className="max-h-40 space-y-1 overflow-y-auto"
                data-testid="line-marketing-manual-exclude-list"
              >
                {filteredExcludableMembers.map((m) => (
                  <li key={m.id}>
                    <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                      <Checkbox
                        checked={excludedIds.includes(m.id)}
                        onCheckedChange={(v) => toggleExcluded(m.id, v === true)}
                      />
                      <span className="text-foreground">{m.name}</span>
                      {m.phone ? <span className="text-xs text-muted-foreground">{m.phone}</span> : null}
                    </label>
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
        <CardContent className="space-y-2">
          <Textarea
            rows={5}
            maxLength={MESSAGE_MAX_LENGTH}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="輸入要發送的訊息內容,可搭配下方的可用變數"
          />
          <p className="text-right text-xs text-muted-foreground">
            {message.length} / {MESSAGE_MAX_LENGTH}
          </p>
          <TemplateVariablePreview
            variables={LINE_MARKETING_TEMPLATE_VARIABLE_DEFINITIONS}
            previews={[{ text: previewLineMarketingTemplate(message) }]}
          />

          <p className="text-sm text-muted-foreground">
            實際會送出 {finalRecipientIds.length} 位會員(已扣除排除清單與黑名單客戶)
          </p>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" disabled={!canSend || sending}>
                {sending ? "發送中⋯" : "發送"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>確定要發送嗎?</AlertDialogTitle>
                <AlertDialogDescription>
                  即將發送給 {finalRecipientIds.length} 位會員,確定要送出嗎?送出後無法收回。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>再想想</AlertDialogCancel>
                <AlertDialogAction onClick={handleSend}>確定發送</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    </main>
  );
}

export default function LineMarketingPage() {
  return (
    <RequireMerchantAdmin>
      <LineMarketingPageInner />
    </RequireMerchantAdmin>
  );
}
