// 對應規格書 4.6:個人資料自助編輯視窗。表單(姓名必填/暱稱/電話/簡介 + 頭像上傳),
// 送出呼叫 updateMyStaffProfile(3.16/5.5)。
//
// ⚠️ 2026-09-24:原本還有一個「對外聯絡 Email」欄位(merchant_staff.contact_email),已隨
//    migration 20260924040800_drop_person_contact_email.sql 一起移除——使用者裁決
//    「客服和服務人員應該也是一樣只需要一個 Email 即可」,那個唯一的 Email 就是登入用的信箱
//    (有自己一套 request_staff_login_email_change 流程,不從這個「編輯個人資料」表單改)。
//    這個前端改動**必須**跟那支 migration 同一次部署上線:migration 會 drop 舊的 7 引數
//    update_my_staff_profile,舊的呼叫端在那之後一按「儲存」就會整個失敗。
//    (界線:商家本身的 public.merchants.contact_email 一律保留,那是給消費者看的店家聯絡信箱,
//     跟「人」的 contact_email 無關。)
//
// 頭像上傳直接複用既有 src/modules/staff-agent/StaffAvatarUploader.tsx,不另外複製一份——
// 那個元件本來就只吃 currentAvatarUrl/onUpload 兩個 prop,完全不耦合「上傳到哪個路徑」這件事,
// 路徑差異(self/<staff_id>/ vs 管理員路徑)已經在 uploadMyStaffAvatar()(api.ts)裡處理好,
// 元件本身不需要重新複製一份只是路徑不同的版本(工程師實作時的判斷,已在回報中向主腦說明)。
//
// ui-v1-full 第二階段第 1 批(盤點 S1,使用者已裁決「4 欄 + 頭像歸小卡窗」):外殼改用
// ui-overlay-patterns 的小卡窗殼(CardDialog),欄位改用 FormField / FieldInput / FieldTextarea
// 單欄直排(小卡窗 400px 寬不再分兩欄),底部改成「取消 / 儲存」兩顆。電話格式說明收進 `?`
// (skill 二:欄位怎麼填屬於看過一次就懂的內容)。**只動外觀,不動行為**:驗證、送出、頭像上傳
// 即存檔的邏輯全部照舊。

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
  CardDialogTrigger,
  FieldInput,
  FieldTextarea,
  FormField,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { StaffAvatarUploader } from "@/modules/staff-agent/StaffAvatarUploader";
import type { MerchantStaff } from "@/modules/staff-agent/types";
import { isValidTaiwanMobilePhone, TW_MOBILE_PHONE_ERROR_MESSAGE } from "@/lib/validation";

import { updateMyStaffProfile, uploadMyStaffAvatar } from "./api";

interface EditMyStaffProfileDialogProps {
  merchantId: string;
  staff: MerchantStaff;
  trigger: React.ReactNode;
  onSaved: () => void;
}

const FORM_ID = "edit-my-staff-profile-form";

export function EditMyStaffProfileDialog({
  merchantId,
  staff,
  trigger,
  onSaved,
}: EditMyStaffProfileDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(staff.name);
  const [nickname, setNickname] = useState(staff.nickname ?? "");
  const [phone, setPhone] = useState(staff.phone ?? "");
  const [intro, setIntro] = useState(staff.intro ?? "");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(staff.avatar_url);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(staff.name);
      setNickname(staff.nickname ?? "");
      setPhone(staff.phone ?? "");
      setIntro(staff.intro ?? "");
      setAvatarUrl(staff.avatar_url);
    }
  }, [open, staff]);

  // merchant_staff.phone 資料庫層已改為 NOT NULL + 台灣手機號碼格式 CHECK 約束
  // (SPECS-INDEX #595/#596),這裡比照 StaffListPage.tsx §8.1 的驗證規則,不能讓服務人員
  // 自己把電話欄位清空或填成不合格式的值送出——否則會直接撞到資料庫約束,跳出不好懂的錯誤訊息。
  function getPhoneValidationError(): string | null {
    const trimmedPhone = phone.trim();
    if (!trimmedPhone) return "請填寫電話";
    if (!isValidTaiwanMobilePhone(trimmedPhone)) return TW_MOBILE_PHONE_ERROR_MESSAGE;
    return null;
  }

  async function handleAvatarUpload(file: File) {
    const url = await uploadMyStaffAvatar(merchantId, staff.id, file);
    setAvatarUrl(url);
    // 頭像跟其他欄位不同,上傳成功就直接存檔,避免關掉對話框後遺失剛上傳的圖片
    // (比照既有 StaffFormDialog 的既有做法)。但存檔前一樣要先過電話驗證,不然這裡會比
    // 主表單送出更早撞到資料庫約束。
    const phoneError = getPhoneValidationError();
    if (phoneError) {
      toast.error(phoneError, { description: "頭像已上傳,請先修正電話欄位再儲存其他資料" });
      return;
    }
    await updateMyStaffProfile({
      staffId: staff.id,
      name,
      nickname,
      phone: phone.trim(),
      avatarUrl: url,
      intro,
    });
    onSaved();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("請填寫姓名");
      return;
    }
    const phoneError = getPhoneValidationError();
    if (phoneError) {
      toast.error(phoneError);
      return;
    }
    setSaving(true);
    try {
      await updateMyStaffProfile({
        staffId: staff.id,
        name,
        nickname,
        phone: phone.trim(),
        avatarUrl,
        intro,
      });
      toast.success("個人資料已更新");
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error("更新失敗", { description: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <CardDialog open={open} onOpenChange={setOpen}>
      <CardDialogTrigger asChild>{trigger}</CardDialogTrigger>
      <CardDialogContent>
        <CardDialogHeader>
          <CardDialogTitle>編輯個人資料</CardDialogTitle>
          <CardDialogDescription>只能修改姓名/暱稱/電話/頭像/簡介這幾項。</CardDialogDescription>
        </CardDialogHeader>
        {/* 底部按鈕列在 <form> 外面(小卡窗的 Footer 是獨立區塊),儲存鈕用 form 屬性指回這張表單。 */}
        <form id={FORM_ID} onSubmit={handleSubmit} className="flex flex-col gap-4">
          <StaffAvatarUploader currentAvatarUrl={avatarUrl} onUpload={handleAvatarUpload} />

          <FormField label="姓名" htmlFor="my-staff-name" required>
            <FieldInput
              id="my-staff-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </FormField>
          <FormField label="暱稱(對客戶顯示)" htmlFor="my-staff-nickname">
            <FieldInput
              id="my-staff-nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
          </FormField>
          <FormField
            label="電話"
            htmlFor="my-staff-phone"
            required
            helpLabel="說明:電話要怎麼填"
            help="請輸入台灣手機號碼,09 開頭共 10 碼數字,例如 0912345678。"
          >
            <FieldInput
              id="my-staff-phone"
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
          </FormField>
          <FormField label="簡介" htmlFor="my-staff-intro">
            <FieldTextarea
              id="my-staff-intro"
              rows={3}
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
            />
          </FormField>
        </form>
        <CardDialogFooter>
          <CardDialogClose asChild>
            <Button type="button" variant="neutral" size="touch">
              取消
            </Button>
          </CardDialogClose>
          <Button type="submit" form={FORM_ID} variant="primary" size="touch" disabled={saving}>
            {saving ? "儲存中⋯" : "儲存"}
          </Button>
        </CardDialogFooter>
      </CardDialogContent>
    </CardDialog>
  );
}
