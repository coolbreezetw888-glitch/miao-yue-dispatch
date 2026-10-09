// 客戶端第 4 批 4-A(C4-W01~W03):會員中心「我的錢包」(預覽圖 ⑩-3:只有紅利)。
//
// ・這批只有紅利點數;儲值金 #1038 還沒做(API 回 stored_value: null,版面先不出現)。
// ・只能看,客人不能自己折抵或儲值。
// ・點數類型用「客人看到的名稱」(memberCenterLogic.customerPointTypeLabel,推薦類吃 REFERRAL_UI_HIDDEN);
//   🔴 店家手打的點數說明(note)伺服器不回,這裡也沒有地方顯示。
// ・紅利沒開 / 兩項都沒有 ⇒ 回會員中心首頁(C4-W01)。

import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";

import { ErrorState, LoadingSkeleton } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { MemberCenterContext } from "./MemberCenterPage";
import { fetchMyWallet, memberCenterQueryKey } from "./memberCenterApi";
import {
  customerPointTypeLabel,
  formatPointDelta,
  isMemberGate,
  memberCenterPath,
  pointEntrySubtitle,
  type MemberWalletPage,
} from "./memberCenterLogic";

export function MemberWalletTab({ ctx }: { ctx: MemberCenterContext }) {
  const { slug } = ctx;
  const walletQuery = useInfiniteQuery({
    queryKey: [...memberCenterQueryKey(slug), "wallet"],
    queryFn: ({ pageParam }) => fetchMyWallet(slug, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (isMemberGate(last) ? null : (last.points?.nextCursor ?? null)),
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const pages = walletQuery.data?.pages ?? [];
  const gate = pages.find(isMemberGate) ?? null;
  const okPages = pages.filter((p): p is MemberWalletPage => !isMemberGate(p));
  const first = okPages[0] ?? null;

  const onSessionLost = ctx.onSessionLost;
  useEffect(() => {
    if (gate?.state === "not_linked") onSessionLost();
  }, [gate, onSessionLost]);

  if (walletQuery.isPending) {
    return (
      <div className="flex flex-col gap-3" data-testid="member-center-loading">
        <LoadingSkeleton variant="lines" rows={2} />
        <LoadingSkeleton variant="cards" rows={3} />
      </div>
    );
  }
  if (walletQuery.isError) {
    return (
      <div data-testid="member-center-error">
        <ErrorState
          honorific
          title="讀不到點數紀錄"
          reason="可能是網路不穩"
          onRetry={() => void walletQuery.refetch()}
          retryLabel="重新整理"
        />
      </div>
    );
  }
  if (gate) return null;
  // C4-W01:紅利沒開(也沒有儲值金)⇒ 不顯示錢包。
  if (!first || !first.points) return <Navigate to={memberCenterPath(slug)} replace />;

  const points = first.points;
  const history = okPages.flatMap((p) => p.points?.history ?? []);

  return (
    <div className="flex flex-col gap-3" data-testid="member-wallet">
      <section
        className="rounded-xl bg-brand p-4 text-brand-foreground shadow-sm"
        data-testid="member-wallet-points"
      >
        <p className="text-[13px] opacity-85">紅利點數</p>
        <p className="mt-0.5 text-[34px] font-extrabold leading-tight tabular-nums">
          <span data-testid="member-wallet-balance">{points.balance.toLocaleString("en-US")}</span>
          <span className="ml-1 text-base font-semibold">點</span>
        </p>
        <p className="mt-1 text-[13px] opacity-85">結帳時告訴店家要使用點數，就能折抵消費。</p>
      </section>

      <h2 className="px-0.5 pt-1 text-[15px] font-semibold text-foreground">點數明細</h2>
      {history.length === 0 ? (
        <div
          className="rounded-xl border border-dashed border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground"
          data-testid="member-wallet-empty"
        >
          目前還沒有點數紀錄
        </div>
      ) : (
        <ul
          className="divide-y divide-border rounded-xl border border-border bg-card shadow-sm"
          data-testid="member-wallet-history"
        >
          {history.map((h, i) => (
            <li
              key={`${h.createdAt}-${i}`}
              className="flex items-center justify-between gap-3 px-3.5 py-3"
              data-testid="member-wallet-entry"
            >
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-foreground">
                  {customerPointTypeLabel(h.type)}
                </p>
                <p className="mt-0.5 break-words text-[12.5px] text-muted-foreground">
                  {pointEntrySubtitle(h)}
                </p>
              </div>
              <span
                className={cn(
                  "shrink-0 text-[15px] font-semibold tabular-nums",
                  h.delta < 0 ? "text-muted-foreground" : "text-brand",
                )}
              >
                {formatPointDelta(h.delta)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {walletQuery.hasNextPage ? (
        <Button
          type="button"
          variant="neutral"
          size="touch"
          className="w-full"
          onClick={() => void walletQuery.fetchNextPage()}
          disabled={walletQuery.isFetchingNextPage}
          data-testid="member-wallet-more"
        >
          {walletQuery.isFetchingNextPage ? "載入中⋯" : "載入更多"}
        </Button>
      ) : null}
    </div>
  );
}
