// 模組 11(LINE 通知)§4.1:LINE 串接設定頁(新路由 /app/line-settings,僅商家管理員可見)。
// 目前連線狀態卡片 + 憑證表單(儲存並測試連線)+ 加好友連結 + 解除串接。

import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { RequireMerchantAdmin } from "@/modules/staff-agent/RequireMerchantAdmin";

import {
  disconnectMerchantLine,
  setMerchantLineCredentials,
  testLineConnection,
  useMerchantLineConfigStatus,
} from "./api";

const configStatusQueryKey = (merchantId: string) =>
  ["line-notifications-module", "config-status", merchantId] as const;

function LineSettingsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useMerchantLineConfigStatus(merchantId);

  const [channelId, setChannelId] = useState("");
  const [channelSecret, setChannelSecret] = useState("");
  const [channelAccessToken, setChannelAccessToken] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [copyLabel, setCopyLabel] = useState("複製");

  useEffect(() => {
    if (status) {
      setChannelId(status.channelId ?? "");
    }
  }, [status]);

  function refetchStatus() {
    return queryClient.invalidateQueries({ queryKey: configStatusQueryKey(merchantId) });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!channelId.trim() || !channelSecret.trim() || !channelAccessToken.trim()) {
      toast.error("請完整填寫 Channel ID / Channel Secret / Channel Access Token");
      return;
    }
    setSaving(true);
    setTestResult(null);
    try {
      await setMerchantLineCredentials({
        merchantId,
        channelId: channelId.trim(),
        channelSecret: channelSecret.trim(),
        channelAccessToken: channelAccessToken.trim(),
      });
      toast.success("已儲存憑證,開始測試連線⋯");
      await refetchStatus();

      const result = await testLineConnection(merchantId);
      setTestResult(result);
      if (result.success) {
        toast.success(result.message);
        setChannelSecret("");
        setChannelAccessToken("");
      } else {
        toast.error(result.message);
      }
      await refetchStatus();
    } catch (err) {
      toast.error("儲存或測試連線失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await disconnectMerchantLine(merchantId);
      toast.success("已解除 LINE 串接");
      setChannelId("");
      setChannelSecret("");
      setChannelAccessToken("");
      setTestResult(null);
      await refetchStatus();
    } catch (err) {
      toast.error("解除串接失敗", { description: getErrorMessage(err) });
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleCopyAddFriendUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopyLabel("已複製");
      setTimeout(() => setCopyLabel("複製"), 1500);
    } catch {
      toast.error("複製失敗,請手動抄寫連結");
    }
  }

  const addFriendUrl = status?.lineBotBasicId
    ? `https://line.me/R/ti/p/@${status.lineBotBasicId}`
    : null;

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">LINE 串接設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          串接你自己申請的 LINE 官方帳號,之後訂單/請假等通知才能真正送出。
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>目前連線狀態</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {isLoading ? (
            <p className="text-muted-foreground">載入中⋯</p>
          ) : status?.isConnected ? (
            <>
              <div className="flex items-center gap-2">
                <Badge variant="default">已連線</Badge>
                <span className="text-foreground">
                  {status.displayName}
                  {status.lineBotBasicId ? `(@${status.lineBotBasicId})` : ""}
                </span>
              </div>
              {addFriendUrl ? (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">加好友連結:</span>
                  <a
                    href={addFriendUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand hover:underline"
                  >
                    {addFriendUrl}
                  </a>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCopyAddFriendUrl(addFriendUrl)}
                  >
                    {copyLabel}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <Badge variant="secondary">尚未串接</Badge>
          )}
          {status?.lastTestedAt ? (
            <p className="text-xs text-muted-foreground">
              最後測試時間:
              {new Date(status.lastTestedAt).toLocaleString("zh-TW", { hour12: false })}
              {status.lastTestResult ? `・${status.lastTestResult}` : ""}
            </p>
          ) : null}

          {status?.isConnected ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" size="sm" disabled={disconnecting}>
                  解除串接
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>確定要解除 LINE 串接嗎?</AlertDialogTitle>
                  <AlertDialogDescription>
                    解除後不會刪除通知設定/文案範本/發送記錄/已綁定的 LINE 帳號,重新填入正確憑證就能
                    立刻恢復運作。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>再想想</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDisconnect}>確定解除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{status?.isConnected ? "重新設定憑證" : "設定憑證"}</CardTitle>
          <CardDescription>
            請到{" "}
            <a
              href="https://developers.line.biz/console/"
              target="_blank"
              rel="noreferrer"
              className="text-brand hover:underline"
            >
              LINE Developers Console
            </a>{" "}
            建立一個 Messaging API 頻道,在「Basic settings」找到 Channel ID/Channel Secret,在
            「Messaging API」分頁點擊「Issue」核發一組 Channel Access Token。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="line-channel-id">Channel ID *</Label>
              <Input
                id="line-channel-id"
                className="mt-2"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="line-channel-secret">Channel Secret *</Label>
              <div className="mt-2 flex gap-2">
                <Input
                  id="line-channel-secret"
                  type={showSecret ? "text" : "password"}
                  value={channelSecret}
                  onChange={(e) => setChannelSecret(e.target.value)}
                  placeholder={status?.isConnected ? "(已設定,重新輸入以更換)" : undefined}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowSecret((v) => !v)}
                >
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label htmlFor="line-channel-token">Channel Access Token *</Label>
              <div className="mt-2 flex gap-2">
                <Input
                  id="line-channel-token"
                  type={showToken ? "text" : "password"}
                  value={channelAccessToken}
                  onChange={(e) => setChannelAccessToken(e.target.value)}
                  placeholder={
                    status?.channelAccessTokenMasked
                      ? `(目前:${status.channelAccessTokenMasked},重新輸入以更換)`
                      : undefined
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowToken((v) => !v)}
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            {testResult ? (
              <p className={testResult.success ? "text-sm text-cta" : "text-sm text-destructive"}>
                {testResult.message}
              </p>
            ) : null}

            <Button type="submit" disabled={saving}>
              {saving ? "處理中⋯" : "儲存並測試連線"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export default function LineSettingsPage() {
  return (
    <RequireMerchantAdmin>
      <LineSettingsPageInner />
    </RequireMerchantAdmin>
  );
}
