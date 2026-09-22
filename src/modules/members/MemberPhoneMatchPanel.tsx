// 模組 10(會員與紅利)§10.2/§10.2.1(SPECS-INDEX #614)。取代舊版 §4.4 MemberPickerField 的獨立
// 「會員(選填)」欄位設計:電話不當唯一鍵,只當查詢索引。由模組 6 的建單表單(CalendarPage.tsx)
// 直接掛載在「客戶電話」欄位下方,客服輸入電話後,這裡列出這支電話底下這個商家既有的所有客戶
// (可能不只一筆,例如家庭成員共用電話),客服可以連結既有客戶,或選「+ 這支電話的新客戶」。
// 本模組擁有並匯出這個元件,模組 6 只負責掛載(模組獨立性原則)。
//
// SPECS-INDEX #635(取代 #614 原本的做法):選「+ 這支電話的新客戶」不再只是「維持訪客訂單、
// member_id 留空」——點下去直接開啟建立正式會員的小表單(電話已經有了,只需要確認/填姓名),
// 送出後同步建立正式會員並連結,不再有獨立的「順便建立正式會員」按鈕要客服多點一步。
//
// §10.4(SPECS-INDEX #616)黑名單警告:客服點選一位 is_blacklisted=true 的既有客戶「當下」立即跳
// 警告 toast,純警告不擋單——這裡是唯一需要判斷黑名單的地方,因為 get_members_by_phone 的查詢
// 結果本來就附帶 is_blacklisted/blacklist_reason。

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { createMemberQuick, useMembersByPhone } from "./api";
import type { MemberPhoneMatchCandidate } from "./types";

export interface SelectedMember {
  id: string;
  name: string;
}

function formatLastBookingDate(iso: string | null): string {
  if (!iso) return "尚無消費紀錄";
  const d = new Date(iso);
  return `最近消費 ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** §10.2.2(SPECS-INDEX #635):客服點選「+ 這支電話的新客戶」就直接開這個表單——電話已經有了,
 * 只需要確認/填姓名,送出後直接沿用既有 create_member 同步建立正式會員,成功後自動選中,帶入
 * 表單的 member_id。不再有「訂單先當訪客送出、之後再補一步升級成會員」這個中間狀態。 */
function QuickCreateMemberDialog({
  merchantId,
  defaultName,
  defaultPhone,
  open,
  onOpenChange,
  onCreated,
}: {
  merchantId: string;
  defaultName: string;
  defaultPhone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (member: SelectedMember) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [phone, setPhone] = useState(defaultPhone);
  const [birthday, setBirthday] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setPhone(defaultPhone);
      setBirthday("");
    }
  }, [open, defaultName, defaultPhone]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("請填寫會員姓名");
      return;
    }
    setSaving(true);
    try {
      const member = await createMemberQuick(
        merchantId,
        name.trim(),
        phone.trim() ? phone.trim() : null,
        birthday.trim() ? birthday.trim() : null,
      );
      toast.success("已建立正式會員並自動連結");
      onCreated({ id: member.id, name: member.name });
      onOpenChange(false);
    } catch (err) {
      toast.error("建立失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>建立正式會員</DialogTitle>
          <DialogDescription>
            電話已經帶入,確認或修改姓名後送出,會直接建立正式會員並連結到這筆訂單。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="quick-member-name">姓名 *</Label>
            <Input
              id="quick-member-name"
              className="mt-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="quick-member-phone">電話</Label>
            <Input
              id="quick-member-phone"
              className="mt-2"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="quick-member-birthday">生日</Label>
            <Input
              id="quick-member-birthday"
              type="date"
              className="mt-2"
              value={birthday}
              onChange={(e) => setBirthday(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving ? "建立中⋯" : "建立並連結"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MemberPhoneMatchPanel({
  merchantId,
  phone,
  customerName,
  selectedMember,
  onSelectMember,
}: {
  merchantId: string;
  phone: string;
  customerName: string;
  selectedMember: SelectedMember | null;
  onSelectMember: (member: SelectedMember | null) => void;
}) {
  const trimmedPhone = phone.trim();
  const [dismissedPhone, setDismissedPhone] = useState<string | null>(null);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);

  // 電話變更時重新開放這個面板(先前對「上一支電話」做的選擇不該沿用到新輸入的電話)。
  useEffect(() => {
    setDismissedPhone(null);
  }, [trimmedPhone]);

  const { data: candidates } = useMembersByPhone(
    !selectedMember ? merchantId : undefined,
    trimmedPhone,
  );

  function handleSelectCandidate(candidate: MemberPhoneMatchCandidate) {
    onSelectMember({ id: candidate.memberId, name: candidate.name });
    setDismissedPhone(trimmedPhone);
    if (candidate.isBlacklisted) {
      // §10.4(核心):選定黑名單客戶「當下」立即跳警告,純警告不擋單。
      toast.warning(
        `⚠️ 這位客戶已被列入黑名單${candidate.blacklistReason ? `,原因:${candidate.blacklistReason}` : ""}`,
        { description: "這只是提醒,不會阻擋建單,仍可以繼續完成流程。" },
      );
    }
  }

  if (selectedMember) {
    return (
      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
        <span className="text-foreground">
          <span className="text-muted-foreground">已連結會員:</span> {selectedMember.name}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onSelectMember(null)}>
          清除連結
        </Button>
      </div>
    );
  }

  if (!trimmedPhone || dismissedPhone === trimmedPhone) {
    return null;
  }

  const list = candidates ?? [];

  return (
    <div className="rounded-md border border-border p-2">
      <p className="mb-1.5 text-xs text-muted-foreground">
        {list.length > 0
          ? "這支電話有既有客戶紀錄,選擇要連結的客戶,或視為新客戶:"
          : "這支電話目前沒有既有客戶紀錄:"}
      </p>
      <ul className="space-y-1">
        {list.map((c) => (
          <li key={c.memberId}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => handleSelectCandidate(c)}
            >
              <span className="flex items-center gap-1.5">
                {c.name}
                {c.isBlacklisted ? <Badge variant="destructive">黑名單</Badge> : null}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatLastBookingDate(c.lastBookingDate)}
              </span>
            </button>
          </li>
        ))}
        <li className="px-2 py-1.5">
          <button
            type="button"
            className="text-sm text-brand hover:underline"
            onClick={() => setQuickCreateOpen(true)}
          >
            + 這支電話的新客戶
          </button>
        </li>
      </ul>

      <QuickCreateMemberDialog
        merchantId={merchantId}
        defaultName={customerName}
        defaultPhone={trimmedPhone}
        open={quickCreateOpen}
        onOpenChange={setQuickCreateOpen}
        onCreated={(member) => {
          onSelectMember(member);
          setDismissedPhone(trimmedPhone);
        }}
      />
    </div>
  );
}
