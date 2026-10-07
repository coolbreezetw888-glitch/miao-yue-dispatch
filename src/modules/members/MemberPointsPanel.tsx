// SPECS-INDEX #830(2026-09-29 使用者巡檢回報第 6 項,裁決見 .project/notes/2026-09-29-使用者調整清單.md
// Q2):「紅利點數管理」頁原本那張「會員點數餘額總覽」卡片被使用者判定跟會員名單每列的點數 Badge
// 重複,決定移除。但那張卡片同時是那一頁唯一的會員選擇器——點了某位會員才會展開 MemberPointsDetail
// (異動歷史 + 手動調整 + 登記兌換)。直接刪掉會讓這三個功能失去唯一入口,所以裁決是整組搬到
// 「會員管理 > 點擊某位會員」的詳情頁(MemberDetailPage.tsx)。
//
// 這個檔案就是搬過來的那一組:RedeemPointsDialog / AdjustPointsDialog / 異動歷史清單,原本都寫在
// MemberPointsPage.tsx 裡(更早之前 #617 又是從 MemberDetailPage.tsx 搬過去的,現在等於搬回來),
// 邏輯與文字原樣保留,只把「自己抓 useMember」改成由詳情頁把已經載入的 member 傳進來,避免同一頁
// 對同一位會員打兩次查詢。
//
// 🔴 權限邊界必須跟搬家前完全一致(SPECS-INDEX #830 備註的硬性要求),逐項對照:
//   ・手動調整(AdjustPointsDialog):搬家前是 `merchantRole === 'admin'` 才渲染按鈕,不看任何
//     section_key 開關(規則 2.6)。這裡原封不動沿用同一個判斷。後端 adjust_member_points 這支 RPC
//     本身的管理員檢查沒動,前端只是體驗層。
//   ・登記兌換(RedeemPointsDialog)/異動歷史:搬家前住在 RequireMemberPointsAccess 底下,那個守衛
//     認的是 members 這把鑰匙;搬到 MemberDetailPage 之後住在 RequireMembersAccess 底下,認的**也是**
//     members 這把鑰匙(兩個守衛檔案的判斷邏輯逐字相同)。後端 redeem_member_points /
//     get_member_point_history 沒動。
//   ・規則設定(核發獎勵資格條件/點數設定)沒有搬,仍留在 MemberPointsPage.tsx 由 member_points
//     那把鑰匙管,這個檔案完全不碰。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 兩顆對話框(登記兌換 / 手動調整)各只有 2 個欄位 ⇒ **小卡窗** CardDialog
//     (skill 三「📐 分類原則」第 3 點),不再自己寫 max-w-sm;按鈕列補「取消」,
//     按鈕平均分寬(手機左右各半;電腦第 12 批 #1001 起也平均分寬,原本靠右)由殼統一。
//   - 欄位改 FormField + FieldInput / FieldTextarea,必填用紅色 `*`。
//   - 🔴 兩個點數輸入框從 `type="number"` 改成文字輸入 + tabular-nums(比照 skill 二之七
//     金額欄位不用 type=number 的同一個理由:type=number 在手機上滑動會誤改數字、在桌機滑鼠
//     滾輪經過也會改值)。驗證完全沒變(仍然是 Number.isInteger 那一套)。
//     ⚠️「調整點數」刻意**不給 inputMode="numeric"**:那個欄位要能輸入負數(正數增加、負數扣除),
//        而 iOS 的 numeric 鍵盤沒有負號,給了會讓商家打不出 -5。「兌換點數」永遠是正整數,
//        所以給 inputMode="numeric" 讓手機直接跳數字鍵盤。
//   - 「正數增加、負數扣除」「兌換只登記紀錄不影響訂單金額」這種「怎麼填 / 會發生什麼」的說明
//     收進 `?`(skill 二)。
//   - 異動歷史:一筆一張卡、數字 tabular-nums、增加用語意色 success(原本寫死 text-cta),
//     每列至少 44px、兩側都能折行;沒有紀錄改 EmptyState(二之八)。
//   - ⚠️ 餘額那一行的 `text-3xl` 是 e2e 的選擇器(e2e/members.spec.ts 用 `p.text-3xl` 取餘額),
//     這次刻意不動這個 class(#849 要統一處理 e2e 選擇器時再一起改)。
//
// **只動外觀,不動行為**:兌換 / 調整的驗證與 API 呼叫、手動調整只有商家管理員看得到
//(merchantRole === 'admin')、成功後 invalidate 哪些查詢、toast 文案全部照舊。

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  CardDialog,
  CardDialogClose,
  CardDialogContent,
  CardDialogDescription,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
  CardDialogTrigger,
  EmptyState,
  ErrorState,
  FieldInput,
  FieldTextarea,
  FormField,
  parseAmountInput,
  useFormDirty,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

import { adjustMemberPoints, redeemMemberPoints, useMemberPointHistory } from "./api";
import { memberPointTransactionTypeLabel, type MemberDetail } from "./types";

/** 小卡窗的按鈕列在 <form> 外面(位置由殼決定),送出鈕用 form= 指回來。 */
const REDEEM_FORM_ID = "redeem-points-form";
const ADJUST_FORM_ID = "adjust-points-form";

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("zh-TW", { hour12: false });
}

function RedeemPointsDialog({ member, onSaved }: { member: MemberDetail; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState("");
  const [pointsError, setPointsError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  // 第 11 批 J(#995):打開那一刻的內容當基準,改過 ⇒ Esc / 上方空白先問放棄。
  const formDirty = useFormDirty({ points, note });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // 🔴 2026-09-30(品管第二次打回,🟡 第 2 項):原本是 `Number(points)` + `Number.isInteger`。
    // `Number.isInteger` 確實擋掉了 Infinity 跟小數,但 `1e3` → 1000 點、`0x10` → 16 點仍然過關
    // ——商家打 `1e3` 是打錯字,系統卻當成他真的要兌換 1000 點。改走 parseAmountInput
    // (integerOnly,最小 1 點)。
    // 🔴 2026-09-30:noun: "點數" —— 不傳的話留空會顯示「請輸入金額」(這一格填的是點數)。
    const parsed = parseAmountInput(points, { integerOnly: true, min: 1, noun: "點數" });
    if (!parsed.ok) {
      setPointsError(parsed.error);
      return;
    }
    setPointsError(null);
    const numericPoints = parsed.value;
    if (!note.trim()) {
      toast.error("請說明這次兌換的用途");
      return;
    }
    setSaving(true);
    try {
      await redeemMemberPoints(member.id, numericPoints, note.trim());
      toast.success("已登記兌換");
      setOpen(false);
      setPoints("");
      setNote("");
      onSaved();
    } catch (err) {
      toast.error("兌換失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <CardDialog
      open={open}
      onOpenChange={(next) => {
        if (next) formDirty.markClean({ points, note });
        setOpen(next);
        // 關窗再打開時不要留著上一次的紅字。
        if (!next) setPointsError(null);
      }}
    >
      <CardDialogTrigger asChild>
        <Button type="button" variant="neutral" size="card">
          登記兌換
        </Button>
      </CardDialogTrigger>
      {/* 2 個欄位 ⇒ 小卡窗(skill 三「📐 分類原則」第 3 點)。 */}
      <CardDialogContent dirty={formDirty.dirty}>
        <CardDialogHeader>
          <CardDialogTitle>登記兌換點數</CardDialogTitle>
          <CardDialogDescription>
            目前餘額 <span className="font-semibold tabular-nums">{member.points_balance}</span>{" "}
            點。
          </CardDialogDescription>
        </CardDialogHeader>
        <form onSubmit={handleSubmit} id={REDEEM_FORM_ID} className="flex flex-col gap-3.5">
          <FormField
            label="兌換點數"
            htmlFor="redeem-points"
            required
            error={pointsError}
            help="這裡只登記點數的異動紀錄，不會自動反映在任何訂單金額上 —— 折抵多少錢要自己在那張訂單裡改。只能填大於 0 的整數。"
            helpLabel="說明：登記兌換會不會影響訂單金額"
          >
            {/* 🔴 2026-09-30:錯誤改成顯示在欄位下面(skill 二之七),不是只丟 toast;
                一改內容就消失。inputMode 維持 numeric(這一格不需要負號)。 */}
            <FieldInput
              id="redeem-points"
              type="text"
              inputMode="numeric"
              className="tabular-nums"
              value={points}
              onChange={(e) => {
                setPoints(e.target.value);
                if (pointsError) setPointsError(null);
              }}
            />
          </FormField>
          <FormField label="用途說明" htmlFor="redeem-note" required>
            <FieldTextarea
              id="redeem-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </FormField>
        </form>
        <CardDialogFooter>
          <CardDialogClose asChild>
            <Button type="button" variant="neutral" size="touch">
              取消
            </Button>
          </CardDialogClose>
          <Button
            type="submit"
            form={REDEEM_FORM_ID}
            variant="primary"
            size="touch"
            disabled={saving}
          >
            {saving ? "處理中⋯" : "確認兌換"}
          </Button>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
  );
}

/** 規則 2.6(核心):這個按鈕只有商家管理員看得到,依 merchantRole==='admin' 判斷,不是依
 * useAgentPermission——這個操作本來就不透過 section_key 開放。 */
function AdjustPointsDialog({ member, onSaved }: { member: MemberDetail; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState("");
  const [deltaError, setDeltaError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  // 第 11 批 J(#995):打開那一刻的內容當基準,改過 ⇒ Esc / 上方空白先問放棄。
  const formDirty = useFormDirty({ delta, note });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // 🔴 2026-09-30(品管第二次打回,🟡 第 2 項):原本是 `Number(delta)` + `Number.isInteger`,
    // Infinity 擋掉了,但 `1e3` → 1000 點、`0x10` → 16 點仍然過關。改走 parseAmountInput。
    // ⚠️ 這一格**可以是負數**(扣點),所以 min 要放到負無限 —— parseAmountInput 的 min 預設是 0
    //    (它本來是給金額用的),不覆寫的話 `-5` 會被當成「點數不能是負數」擋掉。
    //    「不為 0」這條是這一格特有的規則,parseAmountInput 沒有這個選項,留在下面自己判。
    // 🔴 2026-09-30:noun: "點數" —— 不傳的話留空會顯示「請輸入金額」(這一格填的是點數)。
    const parsed = parseAmountInput(delta, {
      integerOnly: true,
      min: Number.NEGATIVE_INFINITY,
      noun: "點數",
    });
    if (!parsed.ok) {
      setDeltaError(parsed.error);
      return;
    }
    if (parsed.value === 0) {
      setDeltaError("要填不為 0 的整數(正數增加、負數扣除)");
      return;
    }
    setDeltaError(null);
    const numericDelta = parsed.value;
    if (!note.trim()) {
      toast.error("請填寫調整原因");
      return;
    }
    setSaving(true);
    try {
      await adjustMemberPoints(member.id, numericDelta, note.trim());
      toast.success("已調整點數");
      setOpen(false);
      setDelta("");
      setNote("");
      onSaved();
    } catch (err) {
      toast.error("調整失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <CardDialog
      open={open}
      onOpenChange={(next) => {
        if (next) formDirty.markClean({ delta, note });
        setOpen(next);
        if (!next) setDeltaError(null);
      }}
    >
      <CardDialogTrigger asChild>
        <Button type="button" variant="neutral" size="card">
          手動調整
        </Button>
      </CardDialogTrigger>
      {/* 2 個欄位 ⇒ 小卡窗。 */}
      <CardDialogContent dirty={formDirty.dirty}>
        <CardDialogHeader>
          <CardDialogTitle>手動調整點數</CardDialogTitle>
          <CardDialogDescription>
            目前餘額 <span className="font-semibold tabular-nums">{member.points_balance}</span>{" "}
            點，不能調整成負數。
          </CardDialogDescription>
        </CardDialogHeader>
        <form onSubmit={handleSubmit} id={ADJUST_FORM_ID} className="flex flex-col gap-3.5">
          <FormField
            label="調整點數"
            htmlFor="adjust-delta"
            required
            error={deltaError}
            help="填正數是幫他加點(例：5)，填負數是扣點(例：-5)。只能填不為 0 的整數，而且扣完之後的餘額不能變成負數。"
            helpLabel="說明：調整點數怎麼填正負"
          >
            {/* ⚠️ 這一格要能輸入負號,所以刻意不給 inputMode="numeric"
                (iOS 的數字鍵盤沒有負號,給了商家就打不出 -5)。**2026-09-30 再次確認保留現狀**,
                不要為了「跟其他數字欄位一致」順手加上去。 */}
            <FieldInput
              id="adjust-delta"
              type="text"
              className="tabular-nums"
              value={delta}
              onChange={(e) => {
                setDelta(e.target.value);
                if (deltaError) setDeltaError(null);
              }}
              placeholder="正數增加、負數扣除"
            />
          </FormField>
          <FormField label="調整原因" htmlFor="adjust-note" required>
            <FieldTextarea
              id="adjust-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </FormField>
        </form>
        <CardDialogFooter>
          <CardDialogClose asChild>
            <Button type="button" variant="neutral" size="touch">
              取消
            </Button>
          </CardDialogClose>
          <Button
            type="submit"
            form={ADJUST_FORM_ID}
            variant="primary"
            size="touch"
            disabled={saving}
          >
            {saving ? "處理中⋯" : "確認調整"}
          </Button>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
  );
}

/**
 * 會員詳情頁「點數」卡片的內容:目前餘額 + 登記兌換/手動調整入口 + 完整異動歷史。
 * 放在 MemberDetailPage 的 <Card> 裡面使用,卡片外框由呼叫端負責(維持該頁既有的卡片樣式)。
 */
export function MemberPointsPanel({ member }: { member: MemberDetail }) {
  const queryClient = useQueryClient();
  const { data: merchantRole } = useCurrentMerchantRole();
  const isAdmin = merchantRole === "admin";
  // 🔴 2026-09-30(品管第二次打回,🟡 第 3 項):原本只取 data,查詢失敗時 pointHistory 是
  // undefined ⇒ 畫成「目前沒有任何點數異動紀錄」,商家以為這位會員的點數歷史不見了。
  // 一律要有 isError 分支,而且排在空狀態之前。
  const {
    data: pointHistory,
    isError: isHistoryError,
    refetch: refetchHistory,
  } = useMemberPointHistory(member.id);

  function refetch() {
    void queryClient.invalidateQueries({
      queryKey: ["members-module", "member-detail", member.id],
    });
    void queryClient.invalidateQueries({
      queryKey: ["members-module", "point-history", member.id],
    });
    void queryClient.invalidateQueries({ queryKey: ["members-module", "members-list"] });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ⚠️ `text-3xl` 是 e2e 的選擇器(e2e/members.spec.ts 的 `p.text-3xl`),不要改這個 class。 */}
      <p className="text-3xl font-bold tabular-nums text-foreground">{member.points_balance} 點</p>
      <div className="flex flex-wrap gap-2">
        <RedeemPointsDialog member={member} onSaved={refetch} />
        {isAdmin ? <AdjustPointsDialog member={member} onSaved={refetch} /> : null}
      </div>

      <div>
        {/* skill 二之六第 1 點:組小標 11px 大寫字距。 */}
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
          異動歷史
        </p>
        {isHistoryError ? (
          <ErrorState
            title="讀不到點數異動紀錄"
            reason="可能是網路斷了；現在先不顯示紀錄，避免你把空白當成「這位會員沒有任何點數異動」"
            onRetry={() => void refetchHistory()}
          />
        ) : !pointHistory || pointHistory.length === 0 ? (
          <EmptyState
            title="目前沒有任何點數異動紀錄"
            description="訂單完成核發點數、生日獎勵、推薦獎勵，以及上面的登記兌換 / 手動調整，都會逐筆記在這裡。"
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {pointHistory.map((entry) => (
              // 一筆一張卡(skill 一);兩側都可能是使用者自己填的文字,都要能折行。
              <li
                key={entry.id}
                className="flex min-h-11 items-start justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-words text-[13px] font-semibold text-foreground">
                    {memberPointTransactionTypeLabel(entry.transactionType)}
                    {entry.relatedMemberName ? `(${entry.relatedMemberName})` : ""}
                  </p>
                  {entry.note ? (
                    <p className="break-words leading-relaxed text-muted-foreground">
                      {entry.note}
                    </p>
                  ) : null}
                  <p className="tabular-nums text-muted-foreground">
                    {formatDateTime(entry.createdAt)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {/* 語意色 token,不寫死顏色。增加 = 綠系、扣除 = 紅系。 */}
                  <p
                    className={`text-sm font-bold tabular-nums ${
                      entry.pointsDelta > 0 ? "text-success-strong" : "text-destructive-strong"
                    }`}
                  >
                    {entry.pointsDelta > 0 ? "+" : ""}
                    {entry.pointsDelta}
                  </p>
                  <p className="tabular-nums text-muted-foreground">餘額 {entry.balanceAfter}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
