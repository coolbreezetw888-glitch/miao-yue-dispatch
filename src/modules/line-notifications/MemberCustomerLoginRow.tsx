// 客戶端第 2 批(C2-H03):會員詳細頁「LINE 綁定」區塊多一行「客戶端登入：已連結（最後登入 10月8日）/ 未連結」。
// 只讀,後台不能改。資料來自 get_member_customer_login_status(只回 linked / last_login_at / relink_blocked,不含 LINE userId)。
// 店家按「解除綁定」會連客戶端登入一起斷開(C2-H02),所以解除後要重抓這一行(見 MemberLineBindingSection)。
//
// 主腦複查追加(c2-contract 4-5 / 4-5b):店家解除過綁定後,被解除的那個 LINE 帳號不能自動接回這位會員
// (客人那邊看到的是 phone_taken)。relink_blocked = true 時這一行多一顆「允許重新接上」(確認窗),
// 只有有會員管理權限的人看得到(後端一樣會擋 42501)。

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  StatusTag,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

import {
  allowMemberCustomerRelink,
  canManageMembers,
  fetchMemberCustomerLoginStatus,
  formatLastLoginDate,
  memberCustomerLoginQueryKey,
} from "./memberCustomerLoginApi";

export function MemberCustomerLoginRow({ memberId }: { memberId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: memberCustomerLoginQueryKey(memberId),
    queryFn: () => fetchMemberCustomerLoginStatus(memberId),
  });
  const { data: role } = useCurrentMerchantRole();
  const { data: agentMembers } = useAgentPermission("members");
  const mayManage = canManageMembers(role, agentMembers);

  const [open, setOpen] = useState(false);
  // 確認窗每次打開都重新掛載(skill 三:關掉後很快再打開不會被上一個的退場遮罩擋住)。
  const [dialogSeq, setDialogSeq] = useState(0);
  const [allowing, setAllowing] = useState(false);

  async function handleAllow() {
    setAllowing(true);
    try {
      await allowMemberCustomerRelink(memberId);
      toast.success("已允許重新接上");
      await queryClient.invalidateQueries({ queryKey: memberCustomerLoginQueryKey(memberId) });
    } catch (err) {
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setAllowing(false);
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5"
      data-testid="member-customer-login-row"
    >
      <span className="text-[13px] font-semibold text-foreground">客戶端登入</span>
      {isLoading ? (
        <Skeleton className="h-5 w-16 rounded-full bg-muted" />
      ) : isError ? (
        <span className="text-xs text-muted-foreground">暫時讀不到</span>
      ) : data?.linked ? (
        <>
          <StatusTag tone="success">已連結</StatusTag>
          {data.lastLoginAt ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {`最後登入 ${formatLastLoginDate(data.lastLoginAt)}`}
            </span>
          ) : null}
        </>
      ) : (
        <StatusTag tone="neutral">未連結</StatusTag>
      )}

      {data?.relinkBlocked && mayManage ? (
        <CardAlertDialog
          open={open}
          onOpenChange={(next) => {
            if (!allowing) setOpen(next);
          }}
        >
          <Button
            type="button"
            variant="neutral"
            size="card"
            disabled={allowing}
            onClick={() => {
              setDialogSeq((n) => n + 1);
              setOpen(true);
            }}
            data-testid="member-customer-relink-button"
          >
            允許重新接上
          </Button>
          <CardAlertDialogContent key={dialogSeq}>
            <CardAlertDialogHeader>
              <CardAlertDialogTitle>允許重新接上嗎？</CardAlertDialogTitle>
              <CardAlertDialogDescription>
                {
                  "這位會員的 LINE 綁定先前被你解除過。允許後，那個 LINE 帳號可以再用這支電話接上這位會員。"
                }
              </CardAlertDialogDescription>
            </CardAlertDialogHeader>
            <CardAlertDialogFooter>
              <CardAlertDialogCancel>取消</CardAlertDialogCancel>
              <CardAlertDialogAction onClick={() => void handleAllow()}>允許</CardAlertDialogAction>
            </CardAlertDialogFooter>
          </CardAlertDialogContent>
        </CardAlertDialog>
      ) : null}
    </div>
  );
}
