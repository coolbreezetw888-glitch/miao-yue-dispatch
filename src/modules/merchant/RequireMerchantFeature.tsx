// SPECS-INDEX #1025 功能開關 FG1-U04:路由守門 —— 這間店沒開通這個平台功能,就整個看不到(F3=A)。
// 規格書 .project/specs/功能開關.md(第 2 版)T10、FG1-U04。
//
//   true      ⇒ 顯示內容
//   false     ⇒ <Navigate replace> 導回(預設 /app/manage 功能頁),不跳任何「尚未開通」提示
//   undefined ⇒ 讀取中:只顯示骨架,不導、不顯示內容(避免閃一下)
//               讀取失敗:骨架 + 既有錯誤提示(可重試),不擅自顯示也不擅自導走(資料庫端本來就會擋)
//
// 🔴 這只是畫面上的藏起來,不是安全邊界 —— 擋住點在資料庫(T6)。

import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { ErrorState, GuardLoading } from "@/components/patterns";

import { useMerchantFeatures } from "./features";

export function RequireMerchantFeature({
  featureKey,
  redirectTo = "/app/manage",
  children,
}: {
  featureKey: string;
  redirectTo?: string;
  children: ReactNode;
}) {
  const { hasFeature, isError, refetch } = useMerchantFeatures();
  const status = hasFeature(featureKey);

  if (status === true) return <>{children}</>;
  if (status === false) return <Navigate to={redirectTo} replace />;

  if (isError) {
    return (
      <div data-testid="merchant-feature-guard-error">
        <div className="mx-auto w-full max-w-3xl px-5 pt-10">
          <ErrorState
            title="讀不到這個頁面的設定"
            reason="可能是網路不穩定，請稍後再試一次"
            onRetry={() => void refetch()}
          />
        </div>
        <GuardLoading />
      </div>
    );
  }

  return <GuardLoading />;
}
