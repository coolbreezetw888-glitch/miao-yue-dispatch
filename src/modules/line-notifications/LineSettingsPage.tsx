// 模組 11(LINE 通知)§4.1:LINE 串接設定頁(新路由 /app/line-settings,僅商家管理員可見)。
// 目前連線狀態卡片 + 憑證表單(儲存並測試連線)+ 加好友連結 + 解除串接。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 頁首改 PageHeader;載入中改灰色骨架(二之八)。
//   - 「已連線 / 尚未串接」由 Badge 改成 StatusTag(二之四)。
//   - 「解除串接」確認窗改小卡窗殼 CardAlertDialog(三、兩種窗);🔴 解除串接是**可逆**的
//     (視窗裡自己就寫「重新填入正確憑證就能立刻恢復」,通知設定 / 文案 / 記錄 / 綁定都不會刪),
//     所以按鈕與確認鈕都**不標紅**,用 ② 次要 / ① 主要 —— 紅色只留給真正不可逆的刪除
//     (第 1 / 2 批已定案的裁決)。
//   - 三個憑證欄位改 FormField + FieldInput,必填用紅色 `*`(不寫「(必填)」);眼睛切換鈕做成
//     跟欄位同高的 44px 觸控目標(二之七)。
//   - 「儲存並測試連線」是這一頁唯一的 ① 主要按鈕(二之三)。
//   - 測試連線的結果:失敗改用 🟡 常駐 `!`(AlertNote tone="danger")而不是一行紅字 ——
//     「為什麼不能用」屬於絕對不能收起來的那一類(二)。成功維持一行綠字(那是好消息,
//     不需要警示框搶版面)。
//
// **只動外觀,不動行為**:儲存 → 自動測試連線的流程、成功後清空 secret/token、解除串接的
// API 呼叫、加好友連結的組法(buildLineAddFriendUrl)、複製按鈕的 1.5 秒回饋全部照舊。

import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";

import {
  AlertNote,
  ErrorState,
  GuardLoading,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  CardAlertDialogTrigger,
  FieldInput,
  FormField,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
} from "@/components/patterns";
import { OfficialLineAtLink } from "@/components/OfficialLineAtLink";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { MERCHANT_FEATURE_KEYS, useMerchantFeatures } from "@/modules/merchant/features";
import { RequireMerchantAdmin } from "@/modules/staff-agent/RequireMerchantAdmin";

import {
  disconnectMerchantLine,
  setMerchantLineCredentials,
  testLineConnection,
  useMerchantLineConfigStatus,
} from "./api";
import { buildLineAddFriendUrl } from "./lineBindingViewLogic";
import { LineLoginSettingsCard } from "./LineLoginSettingsCard";

const configStatusQueryKey = (merchantId: string) =>
  ["line-notifications-module", "config-status", merchantId] as const;

/** 密碼欄位右側的眼睛切換鈕:跟欄位同高(44px)才符合 skill 二之三的觸控目標。 */
function RevealToggle({
  shown,
  label,
  onToggle,
}: {
  shown: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="neutral"
      size="icon"
      aria-label={label}
      aria-pressed={shown}
      className="h-11 w-11 shrink-0 rounded-md"
      onClick={onToggle}
    >
      {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </Button>
  );
}

/**
 * SPECS-INDEX #1025 FG-2(主腦裁決 1):平台沒開「LINE 通知」時,這頁仍然進得來,但**只顯示「LINE 登入」設定卡**
 * (客人用 LINE 登入會員中心不受影響,店家也可能只想用 LINE 登入)。
 * 查證:LINE 登入用的是自己的 LINE Login channel(Channel ID / Secret 存在 LINE 登入設定,由 LineLoginSettingsCard
 * 管理;customer-line-login 只讀那一組),**不需要** Messaging API 的憑證 ⇒ 官方帳號連線狀態、憑證表單、
 * 加好友連結、解除串接這些通知用的內容全部藏起來(資料保留,重新打開功能後原樣出現)。
 *   true      ⇒ 完整頁面(行為不變)
 *   false     ⇒ 只有 LINE 登入設定卡
 *   undefined ⇒ 讀取中只顯示骨架;讀取失敗顯示可重試的錯誤(不擅自顯示通知相關內容)
 */
function LineSettingsPageInner() {
  const { merchant } = useCurrentMerchant();
  const { hasFeature, isError, refetch } = useMerchantFeatures();
  const lineNotifications = hasFeature(MERCHANT_FEATURE_KEYS.lineNotifications);

  if (lineNotifications === true) return <LineSettingsFullView />;
  if (lineNotifications === false) {
    return (
      <main
        className="mx-auto max-w-2xl space-y-6 px-5 py-12"
        data-testid="line-settings-login-only"
      >
        <PageHeader
          backTo="/app/manage"
          title="LINE 串接設定"
          description="設定客人用 LINE 登入會員中心。"
        />
        <LineLoginSettingsCard merchantId={merchant!.id} showNotificationHints={false} />
      </main>
    );
  }
  if (isError) {
    return (
      <div className="mx-auto w-full max-w-2xl px-5 pt-10">
        <ErrorState
          title="讀不到這個頁面的設定"
          reason="可能是網路不穩定，請稍後再試一次"
          onRetry={() => void refetch()}
        />
      </div>
    );
  }
  return <GuardLoading />;
}

function LineSettingsFullView() {
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
      toast.success("已儲存憑證，開始測試連線⋯");
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
      toast.error("複製失敗，請手動抄寫連結");
    }
  }

  // ⚠️ 2026-09-24 修掉一個壞連結:原本是 `https://line.me/R/ti/p/@${status.lineBotBasicId}`
  //    直接字串拼接。但 LINE 官方帳號的 basic id 在 LINE 後台慣例上就是顯示成 `@abcd1234`,
  //    商家照著複製貼上的機率很高,拼出來就變成 `https://line.me/R/ti/p/@@abcd1234` —— 這個連結
  //    點進去找不到帳號,而且因為連結長得「很像對的」,很難被發現是壞的。
  //    改用共用的 buildLineAddFriendUrl(它會把開頭的 @ 正規化掉,有單元測試涵蓋帶 @/不帶 @/
  //    空值三種輸入)。
  //    ⚠️ 這一頁的資料來源**維持不變**:仍然走管理員專用的 useMerchantLineConfigStatus,
  //    管理員原本看得到的串接管理資訊(channel_id、遮蔽過的 access token、最後測試結果等)
  //    一項都沒有減少 —— 這次只換了「連結怎麼組出來」這一件事。
  const addFriendUrl = buildLineAddFriendUrl(status?.lineBotBasicId);

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-5 py-12">
      <PageHeader
        backTo="/app/manage"
        helpMode
        title="LINE 串接設定"
        description={
          <>
            串接 LINE 官方帳號，之後訂單、請假等通知才能真正送出。※若不會設定，可聯繫我們的
            <OfficialLineAtLink /> 協助設定，將酌收設定費 $3000。
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>目前連線狀態</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5 text-sm">
          {isLoading ? (
            <LoadingSkeleton variant="lines" rows={2} />
          ) : status?.isConnected ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusTag tone="success">已連線</StatusTag>
                <span className="min-w-0 break-words text-foreground">
                  {status.displayName}
                  {status.lineBotBasicId ? `(@${status.lineBotBasicId})` : ""}
                </span>
              </div>
              {addFriendUrl ? (
                // 網址很長,320px 下必須能折行 ⇒ 不並排、標籤自成一行(比照 skill 二之六地址那條)。
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="text-muted-foreground">加好友連結：</span>
                  <a
                    href={addFriendUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 break-all text-brand hover:underline"
                  >
                    {addFriendUrl}
                  </a>
                  <Button
                    type="button"
                    variant="text"
                    size="card"
                    onClick={() => handleCopyAddFriendUrl(addFriendUrl)}
                  >
                    {copyLabel}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <StatusTag tone="neutral" className="self-start">
              尚未串接
            </StatusTag>
          )}
          {status?.lastTestedAt ? (
            <p className="text-xs tabular-nums text-muted-foreground">
              最後測試時間：
              {new Date(status.lastTestedAt).toLocaleString("zh-TW", { hour12: false })}
              {status.lastTestResult ? `・${status.lastTestResult}` : ""}
            </p>
          ) : null}

          {status?.isConnected ? (
            <CardAlertDialog>
              <CardAlertDialogTrigger asChild>
                {/* 🔴 可逆動作 ⇒ 不標紅(② 次要)。 */}
                <Button
                  type="button"
                  variant="neutral"
                  size="card"
                  className="self-start"
                  disabled={disconnecting}
                >
                  解除串接
                </Button>
              </CardAlertDialogTrigger>
              <CardAlertDialogContent>
                <CardAlertDialogHeader>
                  <CardAlertDialogTitle>確定要解除 LINE 串接嗎？</CardAlertDialogTitle>
                  <CardAlertDialogDescription>
                    解除後不會刪除通知設定/文案範本/發送記錄/已綁定的 LINE
                    帳號，重新填入正確憑證就能立刻恢復運作。
                  </CardAlertDialogDescription>
                </CardAlertDialogHeader>
                <CardAlertDialogFooter>
                  <CardAlertDialogCancel>再想想</CardAlertDialogCancel>
                  <CardAlertDialogAction onClick={handleDisconnect}>確定解除</CardAlertDialogAction>
                </CardAlertDialogFooter>
              </CardAlertDialogContent>
            </CardAlertDialog>
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
            建立一個 Messaging API 頻道，在「Basic settings」找到 Channel ID/Channel
            Secret，在「Messaging API」分頁點擊「Issue」核發一組 Channel Access Token。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <FormField label="Channel ID" htmlFor="line-channel-id" required>
              <FieldInput
                id="line-channel-id"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
              />
            </FormField>

            <FormField label="Channel Secret" htmlFor="line-channel-secret" required>
              <div className="flex gap-2">
                <FieldInput
                  id="line-channel-secret"
                  type={showSecret ? "text" : "password"}
                  className="min-w-0 flex-1"
                  value={channelSecret}
                  onChange={(e) => setChannelSecret(e.target.value)}
                  placeholder={status?.isConnected ? "(已設定，重新輸入以更換)" : undefined}
                />
                <RevealToggle
                  shown={showSecret}
                  label={showSecret ? "隱藏 Channel Secret" : "顯示 Channel Secret"}
                  onToggle={() => setShowSecret((v) => !v)}
                />
              </div>
            </FormField>

            <FormField label="Channel Access Token" htmlFor="line-channel-token" required>
              <div className="flex gap-2">
                <FieldInput
                  id="line-channel-token"
                  type={showToken ? "text" : "password"}
                  className="min-w-0 flex-1"
                  value={channelAccessToken}
                  onChange={(e) => setChannelAccessToken(e.target.value)}
                  placeholder={
                    status?.channelAccessTokenMasked
                      ? `(目前：${status.channelAccessTokenMasked}，重新輸入以更換)`
                      : undefined
                  }
                />
                <RevealToggle
                  shown={showToken}
                  label={showToken ? "隱藏 Channel Access Token" : "顯示 Channel Access Token"}
                  onToggle={() => setShowToken((v) => !v)}
                />
              </div>
            </FormField>

            {testResult ? (
              testResult.success ? (
                <p className="text-[13px] font-semibold text-success-strong">
                  {testResult.message}
                </p>
              ) : (
                // 🟡 常駐 `!`:「為什麼不能用」絕對不能收起來(skill 二)。
                <AlertNote tone="danger">{testResult.message}</AlertNote>
              )
            ) : null}

            {/* 這一頁唯一的 ① 主要按鈕(skill 二之三)。 */}
            <Button
              type="submit"
              variant="primary"
              size="touch"
              className="self-start"
              disabled={saving}
            >
              {saving ? "處理中⋯" : "儲存並測試連線"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* 客戶端第 2 批(C2-A05):LINE 登入設定卡。放在官方帳號串接卡片下面(兩者都在 LINE Developers 設定)。
          這一頁本身已經只有商家管理員進得來(RequireMerchantAdmin)。 */}
      <LineLoginSettingsCard merchantId={merchantId} />
    </main>
  );
}

export default function LineSettingsPage() {
  return (
    <RequireMerchantAdmin featureName="LINE 串接設定">
      <LineSettingsPageInner />
    </RequireMerchantAdmin>
  );
}
