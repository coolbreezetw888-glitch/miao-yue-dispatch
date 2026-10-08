// 客戶端第 4 批 4-B(#1041,C4-K04):會員詳細頁「LINE 綁定」卡裡的「聯絡人」區塊。
// 接在 C2-H03「客戶端登入」那一行下面(那一行保留當摘要 +「允許重新接上」),列出這位會員的每個 LINE 聯絡人。
//
// ・每位聯絡人:LINE 顯示名、主要 / 第二聯絡人、聯絡人電話、加入方式與時間、最後登入時間。
// ・有會員管理權限的人才有操作(後端一樣會擋 42501):
//     第二聯絡人「設為主要聯絡人」「移除」;主要聯絡人「移除」(還有其他聯絡人 ⇒ 同一個視窗先選新的主要聯絡人,
//     主腦整理「主要聯絡人聯絡不到時，店家後台可代為指定」)。
//   待處理申請「同意 / 拒絕」(⚠️範圍 第 4 點)。
// ・移除 = 封鎖(之後要再加入要按「允許重新接上」),可以回頭 ⇒ 不標紅(ui-overlay-patterns 二之三)。
// 🔴 LINE 顯示名、電話一律純文字;不顯示 LINE userId(後端也不回)。

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check } from "lucide-react";

import {
  AlertNote,
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
import { cn } from "@/lib/utils";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useAgentPermission, useCurrentMerchantRole } from "@/modules/staff-agent/context";

import {
  canManageMembers,
  formatLastLoginDate,
  memberCustomerLoginQueryKey,
} from "./memberCustomerLoginApi";
import {
  adminContactActionMessage,
  fetchAdminMemberContacts,
  joinedViaLabel,
  memberContactsAdminQueryKey,
  merchantRemoveMemberContact,
  merchantResolveContactRequest,
  merchantSetPrimaryContact,
  type AdminMemberContact,
} from "./memberContactsAdminApi";

type Confirm =
  | { kind: "primary"; contact: AdminMemberContact }
  | { kind: "remove"; contact: AdminMemberContact };

export function MemberContactsCard({ memberId }: { memberId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: memberContactsAdminQueryKey(memberId),
    queryFn: () => fetchAdminMemberContacts(memberId),
  });
  const { data: role } = useCurrentMerchantRole();
  const { data: agentMembers } = useAgentPermission("members");
  const mayManage = canManageMembers(role, agentMembers);

  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [dialogSeq, setDialogSeq] = useState(0);
  const [newPrimaryId, setNewPrimaryId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  async function refetch() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: memberContactsAdminQueryKey(memberId) }),
      queryClient.invalidateQueries({ queryKey: memberCustomerLoginQueryKey(memberId) }),
      queryClient.invalidateQueries({
        queryKey: ["line-notifications-module", "member-binding-status", memberId],
      }),
    ]);
  }

  function openConfirm(next: Confirm) {
    setDialogError(null);
    setNewPrimaryId(null);
    setDialogSeq((n) => n + 1);
    setConfirm(next);
  }

  const contacts = data?.contacts ?? [];
  const others = confirm ? contacts.filter((c) => c.id !== confirm.contact.id) : [];
  const needNewPrimary =
    confirm?.kind === "remove" && confirm.contact.isPrimary && others.length > 0;

  async function runConfirm() {
    if (!confirm || busy) return;
    if (needNewPrimary && !newPrimaryId) return;
    setBusy(true);
    setDialogError(null);
    try {
      const state =
        confirm.kind === "primary"
          ? await merchantSetPrimaryContact(confirm.contact.id)
          : await merchantRemoveMemberContact(
              confirm.contact.id,
              needNewPrimary ? newPrimaryId : null,
            );
      const message = adminContactActionMessage(state);
      if (message) {
        setDialogError(message);
        await refetch();
        return;
      }
      toast.success(confirm.kind === "primary" ? "已設為主要聯絡人" : "已移除這位聯絡人");
      setConfirm(null);
      await refetch();
    } catch (err) {
      setDialogError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleResolve(requestId: string, approve: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const state = await merchantResolveContactRequest(requestId, approve);
      const message = adminContactActionMessage(state);
      if (message) toast.error("沒有處理成功", { description: message });
      else toast.success(approve ? "已同意，對方已加入成為聯絡人" : "已拒絕這筆申請");
      await refetch();
    } catch (err) {
      toast.error("沒有處理成功", { description: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="member-contacts-card">
      <span className="text-[13px] font-semibold text-foreground">聯絡人</span>
      {isLoading ? (
        <Skeleton className="h-10 w-full rounded-md bg-muted" />
      ) : isError ? (
        <span className="text-xs text-muted-foreground">暫時讀不到聯絡人</span>
      ) : contacts.length === 0 && (data?.requests.length ?? 0) === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="member-contacts-card-empty">
          {"還沒有聯絡人。客人用 LINE 登入預約頁、填這位會員的電話後會出現在這裡。"}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {contacts.map((c) => (
            <li
              key={c.id}
              className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5"
              data-testid="member-contacts-card-row"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="break-words text-sm font-semibold text-foreground">
                  {c.lineDisplayName}
                </span>
                {c.isPrimary ? (
                  <StatusTag tone="success">主要聯絡人</StatusTag>
                ) : (
                  <StatusTag tone="neutral">第二聯絡人</StatusTag>
                )}
              </div>
              <p className="text-xs leading-relaxed tabular-nums text-muted-foreground">
                {[
                  c.contactPhone ? `聯絡人電話 ${c.contactPhone}` : null,
                  `${joinedViaLabel(c.joinedVia)}${c.joinedAt ? ` ${formatLastLoginDate(c.joinedAt)}` : ""}`,
                  c.lastLoginAt ? `最後登入 ${formatLastLoginDate(c.lastLoginAt)}` : null,
                ]
                  .filter(Boolean)
                  .join("・")}
              </p>
              {mayManage ? (
                <div className="flex flex-wrap gap-2">
                  {!c.isPrimary ? (
                    <Button
                      type="button"
                      variant="neutral"
                      size="card"
                      disabled={busy}
                      onClick={() => openConfirm({ kind: "primary", contact: c })}
                      data-testid="member-contacts-card-set-primary"
                    >
                      設為主要聯絡人
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="neutral"
                    size="card"
                    disabled={busy}
                    onClick={() => openConfirm({ kind: "remove", contact: c })}
                    data-testid="member-contacts-card-remove"
                  >
                    移除
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {data && data.requests.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="member-contacts-card-requests">
          <span className="text-xs font-semibold text-foreground">待處理的加入申請</span>
          {data.requests.map((r) => (
            <div
              key={r.id}
              className="flex flex-col gap-2 rounded-md border border-warn/50 bg-warn-soft px-3 py-2.5"
              data-testid="member-contacts-card-request"
            >
              <p className="text-sm text-foreground">
                <span className="break-words font-semibold">{r.lineDisplayName}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {[
                    r.phone ? ` 填的電話 ${r.phone}` : null,
                    r.createdAt ? ` ${formatLastLoginDate(r.createdAt)}申請` : null,
                  ]
                    .filter(Boolean)
                    .join("・")}
                </span>
              </p>
              {mayManage ? (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="neutral"
                    size="card"
                    disabled={busy}
                    onClick={() => void handleResolve(r.id, false)}
                    data-testid="member-contacts-card-reject"
                  >
                    拒絕
                  </Button>
                  <Button
                    type="button"
                    variant="neutral"
                    size="card"
                    disabled={busy}
                    onClick={() => void handleResolve(r.id, true)}
                    data-testid="member-contacts-card-approve"
                  >
                    同意
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <CardAlertDialog
        key={dialogSeq}
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <CardAlertDialogContent
          data-testid="member-contacts-card-dialog"
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <CardAlertDialogHeader>
            <CardAlertDialogTitle>
              {confirm?.kind === "primary" ? "設為主要聯絡人嗎？" : "移除這位聯絡人嗎？"}
            </CardAlertDialogTitle>
            <CardAlertDialogDescription>
              {confirm?.kind === "primary"
                ? `設定後只有 ${confirm.contact.lineDisplayName} 可以在會員中心修改會員資料、管理聯絡人。`
                : confirm
                  ? `移除後 ${confirm.contact.lineDisplayName} 不能再用 LINE 查看這位會員的預約；之後要再加入，請按「允許重新接上」。`
                  : ""}
            </CardAlertDialogDescription>
          </CardAlertDialogHeader>
          {needNewPrimary ? (
            <div className="flex flex-col gap-1.5" data-testid="member-contacts-card-new-primary">
              <p className="text-[13px] font-semibold text-foreground">請選新的主要聯絡人</p>
              <div role="radiogroup" aria-label="新的主要聯絡人" className="flex flex-col gap-1.5">
                {others.map((o) => {
                  const selected = newPrimaryId === o.id;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => {
                        setDialogError(null);
                        setNewPrimaryId(o.id);
                      }}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm",
                        selected ? "border-brand bg-brand-soft" : "border-border bg-background",
                      )}
                    >
                      <span className="break-words">{o.lineDisplayName}</span>
                      {selected ? (
                        <Check className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {needNewPrimary && !newPrimaryId ? (
            <AlertNote data-testid="member-contacts-card-need-primary">
              請先選一位新的主要聯絡人，才能移除。
            </AlertNote>
          ) : null}
          {dialogError ? (
            <AlertNote tone="danger" data-testid="member-contacts-card-dialog-error">
              {dialogError}
            </AlertNote>
          ) : null}
          <CardAlertDialogFooter>
            <CardAlertDialogCancel disabled={busy}>取消</CardAlertDialogCancel>
            {/* 主腦 10/9(QA 低-3):「移除」會連帶封鎖對方 ⇒ 危險樣式;「設為主要」維持主要。 */}
            <CardAlertDialogAction
              tone={confirm?.kind === "remove" ? "danger" : "primary"}
              disabled={busy || (needNewPrimary && !newPrimaryId)}
              onClick={(e) => {
                e.preventDefault();
                void runConfirm();
              }}
              data-testid="member-contacts-card-confirm"
            >
              {confirm?.kind === "primary" ? "設為主要" : "移除"}
            </CardAlertDialogAction>
          </CardAlertDialogFooter>
        </CardAlertDialogContent>
      </CardAlertDialog>
    </div>
  );
}
