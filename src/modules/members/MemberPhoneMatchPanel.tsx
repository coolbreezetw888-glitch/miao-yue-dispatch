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
//
// ui-v1-full 第 3 批(2026-09-30,盤點 #32「建立正式會員」小卡窗):套用 ui-overlay-patterns skill。
//   - 🔴 QuickCreateMemberDialog 改用小卡窗殼 CardDialog(三、兩種窗 → 小卡窗:3 欄短表單)。
//     這是 skill 三「兩層重疊」點名的那一個畫面 —— **全頁層(建單表單)上面再疊一個小卡窗**,
//     兩層遮罩會相加。CardDialog 用的遮罩是 foreground/40(不是 shadcn 預設的 bg-black/80),
//     疊兩層約 64%,所以不會整個畫面變全黑;寬度 / 圓角 / 白邊全部由殼決定,
//     頁面**不再自己寫 max-w-sm**(盤點報告指出「每個彈窗寬度各自手寫」就是大小不一的根因)。
//   - 三個欄位改 FormField + FieldInput / FieldDate,姓名必填用紅色 `*`;
//     「電話是選填」這種「怎麼填」的說明收進 `?`(二 + 二之七)。
//   - 「建立並連結」是這顆小卡窗唯一的 ① 主要按鈕,旁邊補一顆「取消」(原本只有一顆送出鈕,
//     手機上沒有明顯的退出點;小卡窗按鈕列手機左右各半、電腦靠右,由殼統一)。
//   - 候選客戶列表:每一列做成 44px 的可點列(一、核心原則的觸控目標),
//     黑名單標記由 Badge variant="destructive" 改成 StatusTag tone="danger"(二之四)。
//   - 「清除連結」是可逆動作 ⇒ 不標紅,用 ② 次要(第 1 / 2 批已定案的裁決)。
//
// **只動外觀,不動行為**:電話查詢時機、選中黑名單客戶當下跳警告 toast(純警告不擋單)、
// 建立會員的驗證(姓名必填、電話選填但填了要合格式)、建立後自動選中並收起面板全部照舊。
// e2e/members.spec.ts 依賴的「已連結會員:」文字與「清除連結」按鈕名稱維持不變。

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import {
  CardDialog,
  CardDialogClose,
  CardDialogContent,
  CardDialogDescription,
  CardDialogFooter,
  CardDialogHeader,
  CardDialogTitle,
  FieldDate,
  FieldInput,
  FormField,
  StatusTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { isValidTaiwanPhone, TW_PHONE_ERROR_MESSAGE } from "@/lib/validation";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import { createMemberQuick, useMembersByPhone } from "./api";
import type { MemberPhoneMatchCandidate } from "./types";

/** 小卡窗的按鈕列在 <form> 外面(位置由殼決定),所以送出鈕要用 form= 指回這個 id。 */
const QUICK_CREATE_FORM_ID = "quick-create-member-form";

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
    // SPECS-INDEX #822:會員電話是選填,留空放行;填了就套客戶電話規則(手機或市話,見 validation.ts)。
    if (phone.trim() && !isValidTaiwanPhone(phone)) {
      toast.error(TW_PHONE_ERROR_MESSAGE);
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
    <CardDialog open={open} onOpenChange={onOpenChange}>
      <CardDialogContent>
        <CardDialogHeader>
          <CardDialogTitle>建立正式會員</CardDialogTitle>
          <CardDialogDescription>
            電話已經帶入,確認或修改姓名後送出,會直接建立正式會員並連結到這筆訂單。
          </CardDialogDescription>
        </CardDialogHeader>
        <form onSubmit={handleSubmit} id={QUICK_CREATE_FORM_ID} className="flex flex-col gap-3.5">
          <FormField label="姓名" htmlFor="quick-member-name" required>
            <FieldInput
              id="quick-member-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>
          <FormField
            label="電話"
            htmlFor="quick-member-phone"
            help="電話是選填,留空也可以建立會員。要填的話手機或市話都可以(例如 0912345678 或 02-12345678)。"
            helpLabel="說明:會員電話要不要填、格式是什麼"
          >
            <FieldInput
              id="quick-member-phone"
              type="tel"
              inputMode="tel"
              className="tabular-nums"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </FormField>
          <FormField label="生日" htmlFor="quick-member-birthday">
            <FieldDate
              id="quick-member-birthday"
              value={birthday}
              onChange={(e) => setBirthday(e.target.value)}
            />
          </FormField>
        </form>
        {/* 按鈕列在 form 外面、用 form= 屬性送出:小卡窗的按鈕列位置由殼決定(手機左右各半、
            電腦靠右),不能塞在 form 裡自己排。 */}
        <CardDialogFooter>
          <CardDialogClose asChild>
            <Button type="button" variant="neutral" size="touch">
              取消
            </Button>
          </CardDialogClose>
          <Button
            type="submit"
            form={QUICK_CREATE_FORM_ID}
            variant="primary"
            size="touch"
            disabled={saving}
          >
            {saving ? "建立中⋯" : "建立並連結"}
          </Button>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
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
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
        <span className="min-w-0 break-words text-foreground">
          <span className="text-muted-foreground">已連結會員:</span> {selectedMember.name}
        </span>
        {/* 可逆動作(清掉之後可以再選一次)⇒ 不標紅,用 ② 次要。 */}
        <Button
          type="button"
          variant="neutral"
          size="card"
          className="shrink-0"
          onClick={() => onSelectMember(null)}
        >
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
    <div className="rounded-md border border-border bg-muted/20 p-2">
      <p className="mb-1.5 px-1 text-xs leading-relaxed text-muted-foreground">
        {list.length > 0
          ? "這支電話有既有客戶紀錄,選擇要連結的客戶,或視為新客戶:"
          : "這支電話目前沒有既有客戶紀錄:"}
      </p>
      <ul className="flex flex-col gap-1">
        {list.map((c) => (
          <li key={c.memberId}>
            {/* 每一列是 44px 的可點列(觸控目標,skill 一);兩側都是動態文字,都要能折行。 */}
            <button
              type="button"
              className="flex min-h-11 w-full cursor-pointer flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-md bg-background px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => handleSelectCandidate(c)}
            >
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="break-words">{c.name}</span>
                {c.isBlacklisted ? <StatusTag tone="danger">黑名單</StatusTag> : null}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatLastBookingDate(c.lastBookingDate)}
              </span>
            </button>
          </li>
        ))}
        <li>
          {/* ④ 純文字:很次要的動作,不搶版面(skill 二之三)。 */}
          <Button
            type="button"
            variant="text"
            size="card"
            className="w-full justify-start"
            onClick={() => setQuickCreateOpen(true)}
          >
            + 這支電話的新客戶
          </Button>
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
