// 對應規格書(商家與集團管理)4.3:商家設定頁 — 管理員清單顯示。
// 2026-09-16 模組 3(人員與權限管理)4.1 改動:補上「新增管理員」表單 + 每筆管理員旁的
// 「移除」按鈕,呼叫規格書 3.3 新增的 invite_merchant_admin/remove_merchant_admin RPC
// (規則 2.3/2.4)。這兩支 RPC 操作的是模組 1 自己的 merchant_admins 表,這裡直接
// `supabase.rpc(...)` 呼叫,不 import 模組 3 的 api.ts——維持模組獨立性(模組 3 依賴模組 1,
// 不建立反向依賴)。
// 錯誤訊息顯示沿用模組 2 已建立的 getErrorMessage() 共用工具(見模組 2 SKILL 記錄的踩坑:
// Supabase 的 error 不是真正的 Error 實例),不重新發明一套。

import { useState, type FormEvent } from "react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

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

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!merchantId || !newAdminEmail.trim()) return;
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
    return <p className="text-sm text-muted-foreground">載入管理員名單中⋯</p>;
  }

  if (error) {
    return <p className="text-sm text-destructive">管理員名單載入失敗:{error.message}</p>;
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {(admins ?? []).map((admin) => (
          <li
            key={admin.id}
            className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
          >
            <span className="text-foreground">{admin.email}</span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {new Date(admin.created_at).toLocaleDateString("zh-TW")} 加入
              </span>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={removingUserId === admin.user_id}>
                    移除
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>確定要移除這位管理員嗎?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {admin.email} 將無法再登入管理這間店。如果這是最後一位管理員(且集團也沒有設定
                      集團管理者),系統會擋下這個操作並提示。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleRemove(admin.user_id)}>
                      確定移除
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </li>
        ))}
        {(admins ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">目前沒有管理員紀錄</p>
        ) : null}
      </ul>

      <form onSubmit={handleAdd} className="flex items-end gap-3">
        <div className="flex-1">
          <Label htmlFor="new-merchant-admin-email">新增管理員(Email)</Label>
          <Input
            id="new-merchant-admin-email"
            type="email"
            className="mt-2"
            value={newAdminEmail}
            onChange={(e) => setNewAdminEmail(e.target.value)}
            placeholder="對方需已註冊過秒約帳號"
          />
        </div>
        <Button type="submit" disabled={adding || !newAdminEmail.trim()}>
          {adding ? "新增中⋯" : "新增"}
        </Button>
      </form>
    </div>
  );
}
