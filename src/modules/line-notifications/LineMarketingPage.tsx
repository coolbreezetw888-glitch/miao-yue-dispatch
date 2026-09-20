// 模組 11(LINE 通知)§4.4:行銷再通知頁(新路由 /app/line-marketing,僅商家管理員可見)。
// 會員多選清單(只顯示 line_bound=true 的會員,搜尋姓名/電話)+ 自訂訊息文字框(附字數統計)+
// 「發送」按鈕(規則 2.6 二次確認)+ 發送後導向 4.3 發送記錄頁(篩選 marketing_manual)。

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
import { Textarea } from "@/components/ui/textarea";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { RequireMerchantAdmin } from "@/modules/staff-agent/RequireMerchantAdmin";

import { sendMarketingMessage, useMarketableMembers } from "./api";

// LINE 文字訊息上限 5000 字(規格書「本模組明確不做的事」一節,engineer 動工前已查證,2026-09-20
// 官方文件仍列 5000 字上限)。
const MESSAGE_MAX_LENGTH = 5000;

function LineMarketingPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const navigate = useNavigate();

  const { data: members, isLoading } = useMarketableMembers(merchantId);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const filteredMembers = useMemo(() => {
    if (!members) return [];
    const term = search.trim();
    if (!term) return members;
    return members.filter((m) => m.name.includes(term) || (m.phone ?? "").includes(term));
  }, [members, search]);

  function toggleSelected(memberId: string, checked: boolean) {
    setSelectedIds((prev) =>
      checked ? [...prev, memberId] : prev.filter((id) => id !== memberId),
    );
  }

  async function handleSend() {
    if (selectedIds.length === 0 || !message.trim()) return;
    setSending(true);
    try {
      const result = await sendMarketingMessage({
        merchantId,
        memberIds: selectedIds,
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

  const canSend = selectedIds.length > 0 && message.trim().length > 0;

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">行銷再通知</h1>
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
          <Input
            placeholder="輸入姓名/電話搜尋"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : !members || members.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前沒有任何會員完成 LINE 綁定。</p>
          ) : filteredMembers.length === 0 ? (
            <p className="text-sm text-muted-foreground">找不到符合搜尋條件的會員。</p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {filteredMembers.map((m) => (
                <li key={m.id}>
                  <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                    <Checkbox
                      checked={selectedIds.includes(m.id)}
                      onCheckedChange={(v) => toggleSelected(m.id, v === true)}
                    />
                    <span className="text-foreground">{m.name}</span>
                    {m.phone ? <span className="text-xs text-muted-foreground">{m.phone}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">已選擇 {selectedIds.length} 位會員</p>
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
            placeholder="支援 {{member_name}} 變數,會自動替換成每位會員的姓名"
          />
          <p className="text-right text-xs text-muted-foreground">
            {message.length} / {MESSAGE_MAX_LENGTH}
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
                  即將發送給 {selectedIds.length} 位會員,確定要送出嗎?送出後無法收回。
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
