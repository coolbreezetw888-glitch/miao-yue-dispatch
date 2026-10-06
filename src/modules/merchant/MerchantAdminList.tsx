// 對應規格書(商家與集團管理)4.3:商家設定頁 — 管理員清單顯示。
// 2026-09-16 模組 3(人員與權限管理)4.1 改動:補上「新增管理員」表單 + 每筆管理員旁的
// 「移除」按鈕,呼叫規格書 3.3 新增的 invite_merchant_admin/remove_merchant_admin RPC
// (規則 2.3/2.4)。這兩支 RPC 操作的是模組 1 自己的 merchant_admins 表,這裡直接
// `supabase.rpc(...)` 呼叫,不 import 模組 3 的 api.ts——維持模組獨立性(模組 3 依賴模組 1,
// 不建立反向依賴)。
// 錯誤訊息顯示沿用模組 2 已建立的 getErrorMessage() 共用工具(見模組 2 SKILL 記錄的踩坑:
// Supabase 的 error 不是真正的 Error 實例),不重新發明一套。
//
// 2026-09-17 修正 SPECS-INDEX #85 回歸 bug:這個元件是被 MerchantSettingsPage.tsx 的外層
// <form onSubmit={handleSubmit}>(店名/地址/主題色/公告等設定表單)包在裡面渲染的,HTML 不允許
// 巢狀 <form>,原本這裡自己又包一層 <form onSubmit={handleAdd}> 會被瀏覽器忽略,實際效果是
// email 輸入框跟「新增」按鈕變成屬於外層那個 <form>——點「新增」觸發的其實是外層表單的原生送出
// (整頁重新載入),handleAdd 完全沒被呼叫。改成不用 <form> 包,「新增」按鈕改用
// type="button" + onClick 直接呼叫 handleAdd 本體,不依賴表單送出事件;email 輸入框額外補上
// Enter 鍵手動觸發,保留原本按 Enter 送出的操作習慣。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 每一位管理員改 ListCard(二之五);右側只放「一顆主要動作 + 一個 ⋯」——這一列唯一的動作
//     是「移除」,而且它是**不可逆**的(沒有「恢復」,要重新邀請一次),所以留在卡片上並用
//     ③ 危險(白底紅字淡紅框)。🔴 不做實心紅(二之三)。
//     📌 這是全批第二個標紅的地方:第 1 / 2 批「可逆動作不標紅」的裁決講的是下架 / 停用 /
//        解除綁定那一類有路回頭的動作,移除管理員沒有那條路。
//   - 加入日期改成屬性標籤 AttributeTag(二之四:靜態分類、方角灰底安靜)。
//   - 「新增管理員(Email)」改 FormField + FieldInput;沒有管理員時改 EmptyState,
//     依 EmptyState 的例外條款不另外放按鈕 —— 下一步(新增管理員的欄位)就在空狀態正下方、
//     一眼看得到,改在 description 用一句話指路。
//   - 載入中改灰色骨架;載入失敗改 ErrorState(什麼壞了 / 可能原因 / 下一步 + 資料沒有遺失)。
//
// ⚠️ 這個元件被 MerchantSettingsPage 的外層 <form> 包在裡面(見上面 2026-09-17 那段),
//    所以這裡**依然不能自己包 <form>** —— FormField 只是一個 div + Label,沒有這個問題;
//    「新增」按鈕維持 type="button" + onClick,不依賴表單送出事件。
//
// **只動外觀,不動行為**:邀請 / 移除的 RPC 呼叫、Enter 鍵送出、錯誤訊息來源、顯示 fallback
// (adminDisplay.ts)全部照舊。

import { useState } from "react";
import { toast } from "sonner";

import {
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
  EmptyState,
  ErrorState,
  FieldInput,
  FormField,
  ListCard,
  LoadingSkeleton,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

// 2026-09-24:管理員名單的顯示 fallback 規則抽到 ./adminDisplay.ts 共用——這份清單在商家端
// (這個檔案)跟超級管理員端(platform-admin/MerchantDetailPage.tsx)各自渲染一份 markup,
// fallback 規則若各自複製會漂移,所以集中維護、兩邊都 import 同一份(見該檔案開頭的說明)。
import { adminDisplayName, adminJobTitle, adminPhone } from "./adminDisplay";
import { useMerchantAdmins } from "./context";

async function inviteMerchantAdmin(merchantId: string, userEmail: string): Promise<void> {
  const { error } = await supabase.rpc("invite_merchant_admin", {
    p_merchant_id: merchantId,
    p_user_email: userEmail.trim(),
  });
  if (error) throw error;
}

async function removeMerchantAdmin(merchantId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc("remove_merchant_admin", {
    p_merchant_id: merchantId,
    p_user_id: userId,
  });
  if (error) throw error;
}

export function MerchantAdminList({ merchantId }: { merchantId: string | null | undefined }) {
  const { data: admins, isLoading, error, refetch } = useMerchantAdmins(merchantId);
  const [newAdminEmail, setNewAdminEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);

  async function handleAdd() {
    if (!merchantId || !newAdminEmail.trim() || adding) return;
    setAdding(true);
    try {
      await inviteMerchantAdmin(merchantId, newAdminEmail);
      setNewAdminEmail("");
      await refetch();
      toast.success("已新增管理員");
    } catch (err) {
      toast.error("新增失敗", { description: getErrorMessage(err) });
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(userId: string) {
    if (!merchantId) return;
    setRemovingUserId(userId);
    try {
      await removeMerchantAdmin(merchantId, userId);
      await refetch();
      toast.success("已移除管理員");
    } catch (err) {
      // 規則 2.4 的防呆訊息(移除後這間店會沒有任何人能登入管理)會透過 getErrorMessage(err) 顯示。
      toast.error("移除失敗", { description: getErrorMessage(err) });
    } finally {
      setRemovingUserId(null);
    }
  }

  if (isLoading) {
    // skill 二之八:載入中用灰色骨架,不要用文字。
    return <LoadingSkeleton variant="cards" rows={2} />;
  }

  if (error) {
    // skill 二之八:出錯要講三件事 +「你的資料沒有遺失」(那句由 ErrorState 固定加上)。
    return (
      <ErrorState
        title="讀不到管理員名單"
        reason={`可能是網路斷了，或是這間店的權限剛剛被調整過(原始訊息：${error.message})`}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2.5">
        {(admins ?? []).map((admin) => (
          <li key={admin.id}>
            {/* 對應規格書「首頁外殼與主題色優化」三 + QA #183 打回:email 長度不固定(真實帳號
                可能 25 字元以上),窄螢幕下不能跟右側日期/按鈕擠在同一個 nowrap 列,否則會把
                整個 <li> 撐寬到超出卡片,連帶讓整個頁面 body 出現橫向捲軸。這裡改成手機寬度垂直
                堆疊(min-w-0 讓資訊區真的能縮小換行,不撐開容器)、sm 以上維持原本橫向排列,
                不是用整列橫向捲動處理(這是一般清單列,不是刻意設計成可橫向捲動的區塊)。

                2026-09-24:這一列從「只有一個 email」擴充成「暱稱 / 職位 / 手機 / Email」。
                使用者原話:「目前我這邊看到的只有 Email(新增管理員也是 Email),新增用 Email 沒
                問題,但名單要顯示暱稱 / 手機 / Email,這樣才好判斷是誰。」
                那個 Email 就是登入 Email(auth.users)——同日使用者又裁決一個人只有一個 Email
                (「登入和聯絡信箱應該要是一致的」),所以這裡不會有第二個 Email 欄位。
                資訊多了之後手機版更容易溢出,所以每一行都各自 break-words / break-all
                (email 跟手機沒有空白可以斷行,要用 break-all),沿用 StaffListPage.tsx /
                AgentListPage.tsx 剛修過的同一組模式。 */}
            {/* 2026-09-24:這一列從「只有一個 email」擴充成「暱稱 / 職位 / 手機 / Email」。
                使用者原話:「目前我這邊看到的只有 Email(新增管理員也是 Email),新增用 Email 沒
                問題,但名單要顯示暱稱 / 手機 / Email,這樣才好判斷是誰。」
                那個 Email 就是登入 Email(auth.users)——同日使用者又裁決一個人只有一個 Email
                (「登入和聯絡信箱應該要是一致的」),所以這裡不會有第二個 Email 欄位。
                資訊多了之後手機版更容易溢出,所以每一行都各自 break-words / break-all
                (email 跟手機沒有空白可以斷行,要用 break-all)。ListCard 的 title / meta 本身
                已經是 break-words,email 與手機那兩行額外再加 break-all。 */}
            <ListCard
              title={
                <>
                  {/* null 的 fallback 一律走 ./adminDisplay.ts,不在畫面裡自己寫 ?? 或 || 判斷。 */}
                  {adminDisplayName(admin)}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {adminJobTitle(admin)}
                  </span>
                </>
              }
              tags={
                <AttributeTag className="tabular-nums">
                  {new Date(admin.created_at).toLocaleDateString("zh-TW")} 加入
                </AttributeTag>
              }
              meta={
                <>
                  <span className="block break-all">手機：{adminPhone(admin)}</span>
                  {/* 2026-09-24 使用者裁決:一位管理員只有**一個** Email,就是登入 Email
                      (原話:「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」)。
                      原本這裡下面還有一行「聯絡信箱」(merchant_admins.contact_email),連同那個
                      欄位跟 adminContactEmailToShow() 判斷式一起移除了,不要加回來。 */}
                  <span className="block break-all">Email:{admin.email}</span>
                </>
              }
              primaryAction={
                <CardAlertDialog>
                  <CardAlertDialogTrigger asChild>
                    {/* 🔴 ③ 危險(白底紅字淡紅框):移除管理員沒有「恢復」,要重新邀請一次。
                        不做實心紅(skill 二之三)。 */}
                    <Button
                      type="button"
                      variant="danger"
                      size="card"
                      disabled={removingUserId === admin.user_id}
                    >
                      移除
                    </Button>
                  </CardAlertDialogTrigger>
                  <CardAlertDialogContent>
                    <CardAlertDialogHeader>
                      <CardAlertDialogTitle>確定要移除這位管理員嗎？</CardAlertDialogTitle>
                      {/* 2026-09-24:確認訊息一併帶上暱稱——名單現在顯示暱稱,確認視窗只講 email
                          會讓人要自己對照是哪一位,移除是不可逆的操作,要讓對象一眼確認。 */}
                      <CardAlertDialogDescription>
                        {adminDisplayName(admin)}({admin.email})將無法再登入管理這間店。如果這是
                        最後一位管理員(且集團也沒有設定集團管理者)，系統會擋下這個操作並提示。
                      </CardAlertDialogDescription>
                    </CardAlertDialogHeader>
                    <CardAlertDialogFooter>
                      <CardAlertDialogCancel>取消</CardAlertDialogCancel>
                      <CardAlertDialogAction
                        tone="danger"
                        onClick={() => handleRemove(admin.user_id)}
                      >
                        確定移除
                      </CardAlertDialogAction>
                    </CardAlertDialogFooter>
                  </CardAlertDialogContent>
                </CardAlertDialog>
              }
            />
          </li>
        ))}
      </ul>
      {(admins ?? []).length === 0 ? (
        // EmptyState 的例外條款:下一步(下面那個 Email 欄位)就在空狀態正下方、一眼看得到,
        // 所以不硬做一顆「聚焦上方欄位」的按鈕,改在 description 用一句話指路。
        <EmptyState
          title="目前沒有管理員紀錄"
          description="用下面的「新增管理員(Email)」把人加進來，對方就能登入管理這間店。"
        />
      ) : null}

      {/* ⚠️ 這裡刻意**不包 <form>**:這個元件被外層的商家設定表單包著,巢狀 <form> 會被瀏覽器
          忽略,「新增」會變成觸發外層表單的原生送出(整頁重新載入)——見檔頭 2026-09-17 那段。 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
        <FormField
          label="新增管理員(Email)"
          htmlFor="new-merchant-admin-email"
          className="min-w-0 flex-1"
          help="對方必須先自己註冊過秒約帳號，你才加得進來。加進來的人跟你一樣是商家管理員，看得到也改得動這間店的所有設定。"
          helpLabel="說明：新增管理員要注意什麼"
        >
          <FieldInput
            id="new-merchant-admin-email"
            type="email"
            value={newAdminEmail}
            onChange={(e) => setNewAdminEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleAdd();
              }
            }}
            placeholder="對方需已註冊過秒約帳號"
          />
        </FormField>
        {/* ② 次要:這一頁的 ① 主要按鈕是最下方的「儲存變更」(skill 二之三)。 */}
        <Button
          type="button"
          variant="neutral"
          size="touch"
          className="shrink-0"
          onClick={() => void handleAdd()}
          disabled={adding || !newAdminEmail.trim()}
        >
          {adding ? "新增中⋯" : "新增"}
        </Button>
      </div>
    </div>
  );
}
