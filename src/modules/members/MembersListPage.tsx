// 對應模組 10(會員與紅利)規格書 §4.1:會員管理列表頁(新路由 /app/members)。
// 頁面載入時先呼叫 grant_pending_birthday_bonuses(規則 2.5),有核發時顯示提示條。
// 清單:搜尋(姓名/電話/推薦碼)+ 篩選(狀態)。「新增會員」開啟 Dialog 表單。

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";

import {
  createMember,
  deactivateMember,
  fetchMerchantMembersList,
  grantPendingBirthdayBonuses,
  reactivateMember,
  useMerchantMemberTiers,
} from "./api";
import { RequireMembersAccess } from "./RequireMembersAccess";
import { MEMBER_STATUS_LABELS, type MemberStatus, type MemberSummary } from "./types";

const UNASSIGNED_TIER_VALUE = "__unassigned__";

const membersListQueryKey = (merchantId: string, search: string) =>
  ["members-module", "members-list", merchantId, search] as const;

// ---------------------------------------------------------------------------
// 推薦人搜尋輸入框(簡易版本):輸入姓名/電話/推薦碼即時查詢既有會員,選中後帶出 memberId。
// ---------------------------------------------------------------------------
function ReferrerPicker({
  merchantId,
  value,
  onChange,
}: {
  merchantId: string;
  value: { id: string; name: string } | null;
  onChange: (member: { id: string; name: string } | null) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [open, setOpen] = useState(false);

  const { data: candidates } = useQuery({
    queryKey: ["members-module", "referrer-picker", merchantId, keyword],
    queryFn: () => fetchMerchantMembersList(merchantId, keyword),
    enabled: open && keyword.trim().length > 0,
  });

  if (value) {
    return (
      <div className="mt-2 flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
        <span>{value.name}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          清除
        </Button>
      </div>
    );
  }

  return (
    <div className="relative mt-2">
      <Input
        placeholder="輸入姓名/電話/推薦碼搜尋"
        value={keyword}
        onChange={(e) => {
          setKeyword(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && keyword.trim() && candidates && candidates.length > 0 ? (
        <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-background shadow-md">
          {candidates
            .filter((c) => c.status === "active")
            .map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    onChange({ id: c.id, name: c.name });
                    setOpen(false);
                    setKeyword("");
                  }}
                >
                  {c.name}
                  {c.phone ? ` ・ ${c.phone}` : ""}
                </button>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}

function NewMemberDialog({ merchantId, onSaved }: { merchantId: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const { data: tiers } = useMerchantMemberTiers(merchantId, true);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [birthday, setBirthday] = useState("");
  const [notes, setNotes] = useState("");
  const [referrer, setReferrer] = useState<{ id: string; name: string } | null>(null);
  const [tierId, setTierId] = useState(UNASSIGNED_TIER_VALUE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setPhone("");
      setEmail("");
      setBirthday("");
      setNotes("");
      setReferrer(null);
      setTierId(UNASSIGNED_TIER_VALUE);
    }
  }, [open]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("請填寫會員姓名");
      return;
    }
    setSaving(true);
    try {
      await createMember({
        merchantId,
        name: name.trim(),
        phone: phone.trim() ? phone.trim() : null,
        email: email.trim() ? email.trim() : null,
        birthday: birthday.trim() ? birthday.trim() : null,
        notes: notes.trim() ? notes.trim() : null,
        referredByMemberId: referrer?.id ?? null,
        tierId: tierId === UNASSIGNED_TIER_VALUE ? null : tierId,
      });
      toast.success("已建立會員");
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error("建立失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="cta">新增會員</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>新增會員</DialogTitle>
          <DialogDescription>會員由商家建立,不是消費者自己註冊。</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="member-name">姓名 *</Label>
            <Input
              id="member-name"
              className="mt-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {/* #614(SPECS-INDEX):電話這次只當查詢索引,不是必填的唯一鍵,不再依 merchant_member_
              settings 的任何開關判斷是否必填(該開關已於 #618 移除)。 */}
          <div>
            <Label htmlFor="member-phone">電話</Label>
            <Input
              id="member-phone"
              className="mt-2"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="member-email">Email</Label>
            <Input
              id="member-email"
              type="email"
              className="mt-2"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="member-birthday">生日</Label>
            <Input
              id="member-birthday"
              type="date"
              className="mt-2"
              value={birthday}
              onChange={(e) => setBirthday(e.target.value)}
            />
          </div>
          {/* #615(SPECS-INDEX):會員等級,選填。 */}
          <div>
            <Label>會員等級(選填)</Label>
            <Select value={tierId} onValueChange={setTierId}>
              <SelectTrigger className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED_TIER_VALUE}>未分級</SelectItem>
                {(tiers ?? []).map((tier) => (
                  <SelectItem key={tier.id} value={tier.id}>
                    {tier.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>推薦人(選填)</Label>
            <ReferrerPicker merchantId={merchantId} value={referrer} onChange={setReferrer} />
            <p className="mt-1 text-xs text-muted-foreground">
              推薦人只能在建立當下設定,之後無法變更。
            </p>
          </div>
          <div>
            <Label htmlFor="member-notes">備註</Label>
            <Textarea
              id="member-notes"
              className="mt-2"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "儲存中⋯" : "建立"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MembersListInner() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant!.id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<MemberStatus | "all">("active");
  // #615(SPECS-INDEX):會員等級篩選,"all" 顯示全部。
  const [tierFilter, setTierFilter] = useState<string>("all");
  // #643(SPECS-INDEX):黑名單篩選,比照上面會員等級篩選的既有模式(Select,"all" 顯示全部)。
  const [blacklistFilter, setBlacklistFilter] = useState<"all" | "blacklisted" | "not_blacklisted">(
    "all",
  );
  const [birthdayNotice, setBirthdayNotice] = useState<number | null>(null);

  const { data: members, isLoading } = useQuery({
    queryKey: membersListQueryKey(merchantId, search),
    queryFn: () => fetchMerchantMembersList(merchantId, search),
  });
  const { data: tiers } = useMerchantMemberTiers(merchantId, false);
  const tierNameById = new Map((tiers ?? []).map((t) => [t.id, t.name]));

  // 規則 2.5:頁面載入時被動檢查並核發生日獎勵,不是背景排程。
  useEffect(() => {
    grantPendingBirthdayBonuses(merchantId)
      .then((count) => {
        if (count > 0) {
          setBirthdayNotice(count);
          void queryClient.invalidateQueries({ queryKey: ["members-module", "members-list"] });
        }
      })
      .catch(() => {
        // 靜默失敗即可,不影響列表頁本身的顯示(這不是使用者主動觸發的操作)。
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId]);

  function refetch() {
    return queryClient.invalidateQueries({ queryKey: ["members-module", "members-list"] });
  }

  async function handleDeactivate(memberId: string) {
    try {
      await deactivateMember(memberId);
      await refetch();
      toast.success("已下架會員");
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    }
  }

  async function handleReactivate(memberId: string) {
    try {
      await reactivateMember(memberId);
      await refetch();
      toast.success("已重新上架會員");
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    }
  }

  const visibleMembers: MemberSummary[] = (members ?? []).filter((m) => {
    if (statusFilter !== "all" && m.status !== statusFilter) return false;
    if (blacklistFilter === "blacklisted" && !m.isBlacklisted) return false;
    if (blacklistFilter === "not_blacklisted" && m.isBlacklisted) return false;
    if (tierFilter === "all") return true;
    if (tierFilter === UNASSIGNED_TIER_VALUE) return m.tierId === null;
    return m.tierId === tierFilter;
  });

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/manage" className="text-sm text-muted-foreground hover:underline">
          ← 返回功能
        </Link>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">會員管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            「{merchant!.name}」的會員名錄與紅利點數
          </p>
        </div>
        <NewMemberDialog merchantId={merchantId} onSaved={refetch} />
      </div>

      {birthdayNotice ? (
        <div className="rounded-md border border-brand/40 bg-brand-soft/40 px-3 py-2 text-sm text-foreground">
          🎂 今天有 {birthdayNotice} 位會員收到生日獎勵
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-xs"
          placeholder="搜尋姓名/電話/推薦碼"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex gap-1">
          {(["active", "removed", "all"] as const).map((s) => (
            <Button
              key={s}
              type="button"
              variant={statusFilter === s ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter(s)}
            >
              {s === "all" ? "全部" : MEMBER_STATUS_LABELS[s]}
            </Button>
          ))}
        </div>
        {/* #615(SPECS-INDEX):會員等級篩選。 */}
        <Select value={tierFilter} onValueChange={setTierFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部等級</SelectItem>
            <SelectItem value={UNASSIGNED_TIER_VALUE}>未分級</SelectItem>
            {(tiers ?? []).map((tier) => (
              <SelectItem key={tier.id} value={tier.id}>
                {tier.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* #643(SPECS-INDEX):黑名單篩選,比照上面會員等級篩選的既有 Select 模式,方便商家查看
            自己之前標記過哪些黑名單客戶。 */}
        <Select
          value={blacklistFilter}
          onValueChange={(v) => setBlacklistFilter(v as "all" | "blacklisted" | "not_blacklisted")}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部會員</SelectItem>
            <SelectItem value="blacklisted">只看黑名單</SelectItem>
            <SelectItem value="not_blacklisted">不含黑名單</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>會員名單</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : visibleMembers.length === 0 ? (
            <p className="text-sm text-muted-foreground">目前沒有符合條件的會員。</p>
          ) : (
            <ul className="space-y-2">
              {visibleMembers.map((member) => (
                <li
                  key={member.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => navigate(`/app/members/${member.id}`)}
                  >
                    <p className="truncate text-sm font-medium text-foreground">{member.name}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {member.phone ? <span>{member.phone}</span> : null}
                      <span>推薦碼 {member.referralCode}</span>
                      <Badge variant="outline">{member.pointsBalance} 點</Badge>
                      {member.tierId && tierNameById.has(member.tierId) ? (
                        <Badge variant="outline">{tierNameById.get(member.tierId)}</Badge>
                      ) : null}
                      {member.isBlacklisted ? <Badge variant="destructive">黑名單</Badge> : null}
                      <Badge variant={member.status === "active" ? "default" : "secondary"}>
                        {MEMBER_STATUS_LABELS[member.status]}
                      </Badge>
                    </div>
                  </button>
                  <div className="shrink-0">
                    {member.status === "active" ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm">
                            下架
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>確定要下架這位會員嗎?</AlertDialogTitle>
                            <AlertDialogDescription>
                              這是軟刪除,資料不會不見,之後隨時可以重新上架恢復。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDeactivate(member.id)}>
                              確定下架
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleReactivate(member.id)}
                      >
                        恢復
                      </Button>
                    )}
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

export default function MembersListPage() {
  return (
    <RequireMembersAccess>
      <MembersListInner />
    </RequireMembersAccess>
  );
}
