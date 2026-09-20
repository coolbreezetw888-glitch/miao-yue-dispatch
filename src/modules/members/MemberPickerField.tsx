// 模組 10(會員與紅利)§4.4/§5.1:建單表單疊加的會員選擇欄位。由模組 6 的建單表單掛載使用,
// 本模組擁有並匯出這個元件、模組 6 只負責掛載,不擁有其邏輯(呼應模組獨立性原則,判斷 15)。
//
// 功能:①搜尋既有會員(依姓名/電話),選中後把 member_id 帶入建單表單;②「找不到?建立新會員」
// 精簡版快速建立入口;③選填欄位,不選就是訪客訂單(member_id=null),對既有建單流程沒有強制性
// 影響。這個欄位歸在既有的 orders 權限底下(規則 2.10),不需要額外檢查 members 權限。

import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

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

import { createMemberQuick, fetchMerchantMembersList } from "./api";

export interface SelectedMember {
  id: string;
  name: string;
}

function QuickCreateMemberDialog({
  merchantId,
  open,
  onOpenChange,
  onCreated,
}: {
  merchantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (member: SelectedMember) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [birthday, setBirthday] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setPhone("");
      setBirthday("");
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
      const member = await createMemberQuick(
        merchantId,
        name.trim(),
        phone.trim() ? phone.trim() : null,
        birthday.trim() ? birthday.trim() : null,
      );
      toast.success("已建立會員並自動選中");
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
          <DialogTitle>快速建立會員</DialogTitle>
          <DialogDescription>建立後自動選中,套用到目前這筆訂單。</DialogDescription>
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
              {saving ? "建立中⋯" : "建立並選中"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MemberPickerField({
  merchantId,
  value,
  onChange,
}: {
  merchantId: string;
  value: SelectedMember | null;
  onChange: (member: SelectedMember | null) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [open, setOpen] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);

  const { data: candidates } = useQuery({
    queryKey: ["members-module", "member-picker", merchantId, keyword],
    queryFn: () => fetchMerchantMembersList(merchantId, keyword),
    enabled: open && keyword.trim().length > 0,
  });

  const activeCandidates = (candidates ?? []).filter((c) => c.status === "active");

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
        <span className="text-foreground">{value.name}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          清除
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        placeholder="輸入姓名/電話搜尋既有會員(選填)"
        value={keyword}
        onChange={(e) => {
          setKeyword(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && keyword.trim() ? (
        <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-background shadow-md">
          {activeCandidates.length > 0
            ? activeCandidates.map((c) => (
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
              ))
            : null}
          <li>
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-sm text-brand hover:bg-muted"
              onClick={() => {
                setQuickCreateOpen(true);
                setOpen(false);
              }}
            >
              找不到?建立新會員
            </button>
          </li>
        </ul>
      ) : null}

      <QuickCreateMemberDialog
        merchantId={merchantId}
        open={quickCreateOpen}
        onOpenChange={setQuickCreateOpen}
        onCreated={(member) => {
          onChange(member);
          setKeyword("");
        }}
      />
    </div>
  );
}
