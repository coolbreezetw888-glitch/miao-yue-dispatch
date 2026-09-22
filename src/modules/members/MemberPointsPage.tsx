// #617(.project/specs/會員與紅利.md §10.5「紅利點數獨立化」):紅利點數功能從會員詳情頁移出,
// 在「功能」選單新開一張獨立卡片(新路由 /app/member-points),集中管理跟點數相關的操作:
//   1. 各會員點數餘額總覽清單(搜尋姓名/電話,顯示目前餘額)。
//   2. 點擊個別會員可以看到完整點數異動歷史(複用既有 get_member_point_history)。
//   3. 「手動調整」入口(複用既有 adjust_member_points,維持「僅商家管理員」的既有權限邊界)。
//   4. 「登記兌換」入口(複用既有 redeem_member_points)。
//   5. 點數設定(消費點數比例/推薦獎勵/生日贈點)用連結導去既有的會員系統設定頁,不重複維護
//      一份 UI(避免會員系統設定頁跟這裡兩邊都要維護一份設定表單)。
//
// 支援 ?member=<id> query 參數直接帶入某位會員(會員詳情頁「查看完整點數紀錄」連結會這樣用)。
//
// RedeemPointsDialog/AdjustPointsDialog 這兩個 Dialog 元件是從 MemberDetailPage.tsx 搬過來的
// (該頁面的「點數」卡片這次簡化成摘要 + 連結,完整操作集中到這裡,避免兩邊重複維護)。

import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

import {
  adjustMemberPoints,
  redeemMemberPoints,
  useMember,
  useMemberPointHistory,
  useMerchantMemberSettings,
  useMerchantMembersList,
} from "./api";
import { RequireMemberPointsAccess } from "./RequireMemberPointsAccess";
import { MEMBER_POINT_TRANSACTION_TYPE_LABELS, type Member, type MemberSummary } from "./types";

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
            目前餘額 {member.points_balance} 點。這裡只登記點數異動紀錄,不會自動反映在任何訂單金額上。
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
            <Textarea id="redeem-note" className="mt-2" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
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
          <DialogDescription>目前餘額 {member.points_balance} 點,不能調整成負數。</DialogDescription>
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
            <Textarea id="adjust-note" className="mt-2" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
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

/** 點擊清單裡某位會員之後顯示的完整點數異動歷史 + 兌換/調整入口。 */
function MemberPointsDetail({ memberId }: { memberId: string }) {
  const queryClient = useQueryClient();
  const { data: merchantRole } = useCurrentMerchantRole();
  const isAdmin = merchantRole === "admin";

  const { data: member, isLoading } = useMember(memberId);
  const { data: pointHistory } = useMemberPointHistory(memberId);

  function refetch() {
    void queryClient.invalidateQueries({ queryKey: ["members-module", "member-detail", memberId] });
    void queryClient.invalidateQueries({ queryKey: ["members-module", "point-history", memberId] });
    void queryClient.invalidateQueries({ queryKey: ["members-module", "members-list"] });
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">載入中⋯</p>;
  }
  if (!member) {
    return <p className="text-sm text-muted-foreground">找不到這位會員(可能已被移除)。</p>;
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>{member.name}</CardTitle>
          <CardDescription>{member.phone ?? "未填寫電話"}</CardDescription>
        </div>
        <Link to={`/app/members/${member.id}`} className="text-sm text-brand hover:underline">
          查看會員基本資料 →
        </Link>
      </CardHeader>
      <CardContent className="space-y-4">
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
      </CardContent>
    </Card>
  );
}

function MemberPointsPageInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");

  const selectedMemberId = searchParams.get("member");
  const { data: settings } = useMerchantMemberSettings(merchantId);
  const { data: members, isLoading } = useMerchantMembersList(merchantId, search);
  const activeMembers: MemberSummary[] = (members ?? []).filter((m) => m.status === "active");

  function selectMember(memberId: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("member", memberId);
      return next;
    });
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">紅利點數管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          「{merchant!.name}」會員的點數餘額總覽、手動調整、登記兌換與異動歷史,一站式在這裡操作。
        </p>
      </div>

      {settings && settings.points_feature_enabled === false ? (
        <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-foreground">
          目前紅利點數功能已關閉,建單表單跟會員詳情頁不會顯示任何點數相關內容給客戶/服務人員看,
          但你仍然可以在這裡查看/調整既有點數資料。要重新開放,請到{" "}
          <Link to="/app/member-settings" className="text-brand hover:underline">
            會員系統設定
          </Link>
          。
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>點數設定</CardTitle>
          <CardDescription>啟用開關、消費點數比例、推薦獎勵、生日贈點</CardDescription>
        </CardHeader>
        <CardContent>
          <Link to="/app/member-settings" className="text-sm text-brand hover:underline">
            前往會員系統設定 →
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>會員點數餘額總覽</CardTitle>
          <CardDescription>搜尋姓名/電話,點擊某位會員查看完整異動歷史與兌換/調整入口</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            className="max-w-xs"
            placeholder="搜尋姓名/電話"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : activeMembers.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前沒有符合條件的會員。</p>
          ) : (
            <ul className="space-y-1.5">
              {activeMembers.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => selectMember(m.id)}
                    className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      selectedMemberId === m.id
                        ? "border-brand bg-brand-soft/40"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {m.name}
                      {m.phone ? `・${m.phone}` : ""}
                    </span>
                    <Badge variant="outline">{m.pointsBalance} 點</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {selectedMemberId ? <MemberPointsDetail memberId={selectedMemberId} /> : null}
    </main>
  );
}

export default function MemberPointsPage() {
  return (
    <RequireMemberPointsAccess>
      <MemberPointsPageInner />
    </RequireMemberPointsAccess>
  );
}
