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

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

import { adjustMemberPoints, redeemMemberPoints, useMemberPointHistory } from "./api";
import { MEMBER_POINT_TRANSACTION_TYPE_LABELS, type Member } from "./types";

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("zh-TW", { hour12: false });
}

function RedeemPointsDialog({ member, onSaved }: { member: Member; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const numericPoints = Number(points);
    if (!Number.isInteger(numericPoints) || numericPoints <= 0) {
      toast.error("兌換點數必須是大於 0 的整數");
      return;
    }
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          登記兌換
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>登記兌換點數</DialogTitle>
          <DialogDescription>
            目前餘額 {member.points_balance}{" "}
            點。這裡只登記點數異動紀錄,不會自動反映在任何訂單金額上。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="redeem-points">兌換點數 *</Label>
            <Input
              id="redeem-points"
              type="number"
              min={1}
              className="mt-2"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="redeem-note">用途說明 *</Label>
            <Textarea
              id="redeem-note"
              className="mt-2"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "處理中⋯" : "確認兌換"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 規則 2.6(核心):這個按鈕只有商家管理員看得到,依 merchantRole==='admin' 判斷,不是依
 * useAgentPermission——這個操作本來就不透過 section_key 開放。 */
function AdjustPointsDialog({ member, onSaved }: { member: Member; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const numericDelta = Number(delta);
    if (!Number.isInteger(numericDelta) || numericDelta === 0) {
      toast.error("調整點數必須是不為 0 的整數(正數增加、負數扣除)");
      return;
    }
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          手動調整
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>手動調整點數</DialogTitle>
          <DialogDescription>
            目前餘額 {member.points_balance} 點,不能調整成負數。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="adjust-delta">調整點數 *</Label>
            <Input
              id="adjust-delta"
              type="number"
              className="mt-2"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="正數增加、負數扣除"
            />
          </div>
          <div>
            <Label htmlFor="adjust-note">調整原因 *</Label>
            <Textarea
              id="adjust-note"
              className="mt-2"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "處理中⋯" : "確認調整"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 會員詳情頁「點數」卡片的內容:目前餘額 + 登記兌換/手動調整入口 + 完整異動歷史。
 * 放在 MemberDetailPage 的 <Card> 裡面使用,卡片外框由呼叫端負責(維持該頁既有的卡片樣式)。
 */
export function MemberPointsPanel({ member }: { member: Member }) {
  const queryClient = useQueryClient();
  const { data: merchantRole } = useCurrentMerchantRole();
  const isAdmin = merchantRole === "admin";
  const { data: pointHistory } = useMemberPointHistory(member.id);

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
    <div className="space-y-4">
      <p className="text-3xl font-bold text-foreground">{member.points_balance} 點</p>
      <div className="flex flex-wrap gap-2">
        <RedeemPointsDialog member={member} onSaved={refetch} />
        {isAdmin ? <AdjustPointsDialog member={member} onSaved={refetch} /> : null}
      </div>

      <div>
        <p className="mb-2 text-sm font-semibold text-foreground">異動歷史</p>
        {!pointHistory || pointHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">目前沒有任何點數異動紀錄。</p>
        ) : (
          <ul className="space-y-1.5">
            {pointHistory.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <p className="text-foreground">
                    {MEMBER_POINT_TRANSACTION_TYPE_LABELS[entry.transactionType]}
                    {entry.relatedMemberName ? `(${entry.relatedMemberName})` : ""}
                  </p>
                  {entry.note ? <p className="text-muted-foreground">{entry.note}</p> : null}
                  <p className="text-muted-foreground">{formatDateTime(entry.createdAt)}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={entry.pointsDelta > 0 ? "text-cta" : "text-destructive"}>
                    {entry.pointsDelta > 0 ? "+" : ""}
                    {entry.pointsDelta}
                  </p>
                  <p className="text-muted-foreground">餘額 {entry.balanceAfter}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
