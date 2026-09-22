// 對應模組 10(會員與紅利)規格書 §4.2:會員詳情頁(新路由 /app/members/:id)。
// 基本資料 + 電話驗證 + 點數摘要 + 相關訂單 + 推薦名單。
//
// #617(.project/specs/會員與紅利.md §10.5「紅利點數獨立化」):點數區塊這次不再是完整的
// 兌換/手動調整/異動歷史操作面板——那些操作搬到新的獨立頁面 MemberPointsPage.tsx
// (/app/member-points),這裡只保留精簡摘要(目前餘額 + 「查看完整點數紀錄」連結導到獨立頁面
// 並帶入這位會員),避免兩邊各維護一份幾乎一樣的點數操作 UI。points_feature_enabled 關閉時
// 整個「點數」卡片不顯示。

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
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
import { MemberLineBindingSection } from "@/modules/line-notifications/MemberLineBindingSection";

import {
  setMemberPhoneVerified,
  updateMember,
  useMember,
  useMemberReferrals,
  useMemberRelatedBookings,
  useMerchantMemberSettings,
} from "./api";
import { RequireMembersAccess } from "./RequireMembersAccess";
import { MEMBER_STATUS_LABELS, type Member } from "./types";

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("zh-TW", { hour12: false });
}

// ---------------------------------------------------------------------------
// 編輯基本資料 Dialog。推薦人只能唯讀顯示,不可編輯(判斷:推薦關係只在建立當下決定)。
// ---------------------------------------------------------------------------
function EditMemberDialog({ member, onSaved }: { member: Member; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(member.name);
  const [phone, setPhone] = useState(member.phone ?? "");
  const [email, setEmail] = useState(member.email ?? "");
  const [birthday, setBirthday] = useState(member.birthday ?? "");
  const [notes, setNotes] = useState(member.notes ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(member.name);
      setPhone(member.phone ?? "");
      setEmail(member.email ?? "");
      setBirthday(member.birthday ?? "");
      setNotes(member.notes ?? "");
    }
  }, [open, member]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("請填寫會員姓名");
      return;
    }
    setSaving(true);
    try {
      await updateMember(member.id, {
        name: name.trim(),
        phone: phone.trim() ? phone.trim() : null,
        email: email.trim() ? email.trim() : null,
        birthday: birthday.trim() ? birthday.trim() : null,
        notes: notes.trim() ? notes.trim() : null,
      });
      toast.success("已更新會員資料");
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          編輯
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>編輯會員資料</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="edit-member-name">姓名 *</Label>
            <Input id="edit-member-name" className="mt-2" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="edit-member-phone">電話</Label>
            <Input id="edit-member-phone" className="mt-2" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="edit-member-email">Email</Label>
            <Input
              id="edit-member-email"
              type="email"
              className="mt-2"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-member-birthday">生日</Label>
            <Input
              id="edit-member-birthday"
              type="date"
              className="mt-2"
              value={birthday}
              onChange={(e) => setBirthday(e.target.value)}
            />
          </div>
          <div>
            <Label>推薦人</Label>
            <p className="mt-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
              推薦人只能在建立會員時設定,之後無法變更。
            </p>
          </div>
          <div>
            <Label htmlFor="edit-member-notes">備註</Label>
            <Textarea
              id="edit-member-notes"
              className="mt-2"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "儲存中⋯" : "儲存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MemberDetailInner() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { merchant } = useCurrentMerchant();
  const { data: memberSettings } = useMerchantMemberSettings(merchant?.id ?? null);
  const pointsFeatureEnabled = memberSettings?.points_feature_enabled !== false;

  const { data: member, isLoading } = useMember(id);
  const { data: relatedBookings } = useMemberRelatedBookings(id);
  const { data: referrals } = useMemberReferrals(id);

  const [verifying, setVerifying] = useState(false);
  const [copyLabel, setCopyLabel] = useState("複製");

  function refetchAll() {
    void queryClient.invalidateQueries({ queryKey: ["members-module", "member-detail", id] });
    void queryClient.invalidateQueries({ queryKey: ["members-module", "related-bookings", id] });
    void queryClient.invalidateQueries({ queryKey: ["members-module", "referrals", id] });
    void queryClient.invalidateQueries({ queryKey: ["members-module", "members-list"] });
  }

  async function handleToggleVerified() {
    if (!member) return;
    setVerifying(true);
    try {
      await setMemberPhoneVerified(member.id, !member.phone_verified);
      toast.success(member.phone_verified ? "已取消驗證標記" : "已標記為已驗證");
      refetchAll();
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setVerifying(false);
    }
  }

  async function handleCopyReferralCode() {
    if (!member) return;
    try {
      await navigator.clipboard.writeText(member.referral_code);
      setCopyLabel("已複製");
      setTimeout(() => setCopyLabel("複製"), 1500);
    } catch {
      toast.error("複製失敗,請手動抄寫推薦碼");
    }
  }

  if (isLoading) {
    return <p className="p-10 text-center text-sm text-muted-foreground">載入中⋯</p>;
  }

  if (!member) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 px-5 py-12 text-center">
        <p className="text-sm text-muted-foreground">找不到這位會員(可能已被移除或不屬於這間商家)。</p>
        <Link to="/app/members" className="text-sm text-brand hover:underline">
          ← 返回會員管理
        </Link>
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/members" className="text-sm text-muted-foreground hover:underline">
          ← 返回會員管理
        </Link>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{member.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant={member.status === "active" ? "default" : "secondary"}>
              {MEMBER_STATUS_LABELS[member.status as "active" | "removed"]}
            </Badge>
          </div>
        </div>
        <EditMemberDialog member={member} onSaved={refetchAll} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>基本資料</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">電話</span>
            <span className="text-foreground">{member.phone ?? "未填寫"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Email</span>
            <span className="text-foreground">{member.email ?? "未填寫"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">生日</span>
            <span className="text-foreground">{member.birthday ?? "未填寫"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">推薦碼</span>
            <span className="flex items-center gap-2 text-foreground">
              <code className="rounded bg-muted px-1.5 py-0.5">{member.referral_code}</code>
              <Button type="button" variant="ghost" size="sm" onClick={handleCopyReferralCode}>
                {copyLabel}
              </Button>
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-muted-foreground">電話驗證狀態</span>
              <p className="text-xs text-muted-foreground">此為人工標記,非簡訊驗證</p>
            </div>
            <div className="flex items-center gap-2">
              {member.phone_verified ? (
                <Badge variant="default">已驗證</Badge>
              ) : (
                <Badge variant="secondary">未驗證</Badge>
              )}
              <Button type="button" variant="outline" size="sm" disabled={verifying} onClick={handleToggleVerified}>
                {member.phone_verified ? "取消驗證標記" : "標記為已驗證"}
              </Button>
            </div>
          </div>
          {member.notes ? (
            <div>
              <span className="text-muted-foreground">備註</span>
              <p className="mt-1 whitespace-pre-wrap text-foreground">{member.notes}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* 模組 11(LINE 通知)§4.7:會員詳情頁疊加「LINE 綁定」區塊,歸在既有 members 權限底下
          (第〇節判斷 3/5),不是本模組新增的權限項目。 */}
      <Card>
        <CardHeader>
          <CardTitle>LINE 綁定</CardTitle>
        </CardHeader>
        <CardContent>
          <MemberLineBindingSection memberId={member.id} />
        </CardContent>
      </Card>

      {/* #617:點數區塊這次只保留精簡摘要,完整的兌換/手動調整/異動歷史操作搬到獨立頁面
          MemberPointsPage.tsx(/app/member-points)。points_feature_enabled 關閉時整張卡片不顯示,
          既有的點數餘額資料不受影響,只是隱藏。 */}
      {pointsFeatureEnabled ? (
        <Card>
          <CardHeader>
            <CardTitle>點數</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-3xl font-bold text-foreground">{member.points_balance} 點</p>
            <Link
              to={`/app/member-points?member=${member.id}`}
              className="text-sm text-brand hover:underline"
            >
              查看完整點數紀錄 →
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>相關訂單</CardTitle>
        </CardHeader>
        <CardContent>
          {!relatedBookings || relatedBookings.length === 0 ? (
            <p className="text-sm text-muted-foreground">這位會員目前沒有連結任何訂單。</p>
          ) : (
            <ul className="space-y-1.5">
              {relatedBookings.map((booking) => (
                <li
                  key={booking.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <p className="text-foreground">{formatDateTime(booking.startAt)}</p>
                    <p className="text-muted-foreground">{booking.serviceItemNames.join("、") || "—"}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-foreground">${Number(booking.finalAmountSnapshot).toFixed(0)}</p>
                    <p className="text-muted-foreground">
                      {booking.earnedPoints !== null ? `已核發 ${booking.earnedPoints} 點` : "未核發點數"}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>推薦名單</CardTitle>
        </CardHeader>
        <CardContent>
          {!referrals || referrals.length === 0 ? (
            <p className="text-sm text-muted-foreground">這位會員目前還沒有推薦過任何人。</p>
          ) : (
            <ul className="space-y-1.5">
              {referrals.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs"
                >
                  <button
                    type="button"
                    className="text-left text-foreground hover:underline"
                    onClick={() => navigate(`/app/members/${r.id}`)}
                  >
                    {r.name}
                  </button>
                  <div className="flex items-center gap-2">
                    <Badge variant={r.status === "active" ? "default" : "secondary"}>
                      {MEMBER_STATUS_LABELS[r.status]}
                    </Badge>
                    <span className="text-muted-foreground">
                      {r.referralRewardedAt ? "已核發推薦獎勵" : "尚未核發推薦獎勵"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export default function MemberDetailPage() {
  return (
    <RequireMembersAccess>
      <MemberDetailInner />
    </RequireMembersAccess>
  );
}
