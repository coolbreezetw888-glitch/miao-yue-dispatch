// 後台導覽外殼「首頁」分頁籤(路由 /app)。
//
// 2026-09-16 修正:這個分頁籤原本規劃叫「我的帳號」,使用者澄清之後,這裡實際定位是
// 「暫時佔位」——之後會被使用者另外提供的「主控台」設計取代(產品最後階段才會做),這次不用
// 預先做成帳號頁面的樣子,單純堪用即可。內容沿用舊版 AppShell(src/routes/app.tsx)首頁本體:
// 「Hi {email}」問候、目前操作中的商家卡片、商家切換器(從原本的頂端列搬過來)、「新增分店」
// 入口(僅 isAdmin)、登出按鈕——只是搬動顯示位置,判斷邏輯(isAdmin 判斷方式、登出流程)
// 完全不變。

import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { MerchantSwitcher } from "@/modules/merchant/MerchantSwitcher";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { INDUSTRY_TYPE_LABELS } from "@/modules/merchant/types";
import type { IndustryType } from "@/modules/merchant/types";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

import { useAppLayoutContext } from "./AppLayout";

export default function HomePage() {
  const { email, onSignOut } = useAppLayoutContext();
  const { merchant: currentMerchant } = useCurrentMerchant();
  // 對應規格書(人員與權限管理)4.5 的既有判斷方式:role 還沒判斷完成時(undefined)先當作
  // false,避免畫面短暫誤閃管理員專屬的「新增分店」入口。
  const { data: merchantRole } = useCurrentMerchantRole();
  const isAdmin = merchantRole === "admin";

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Hi {email}</h1>
        <MerchantSwitcher />
      </div>

      <div className="rounded-2xl border border-border bg-card p-8">
        {currentMerchant ? (
          <>
            <p className="text-sm text-muted-foreground">目前操作中的商家</p>
            <p className="mt-1 text-xl font-semibold text-foreground">{currentMerchant.name}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {INDUSTRY_TYPE_LABELS[currentMerchant.industry_type as IndustryType] ??
                currentMerchant.industry_type}
              {currentMerchant.status === "disabled" ? "・已停用" : ""}
            </p>
          </>
        ) : null}
        <p className="mt-6 text-base leading-relaxed text-muted-foreground">
          你的派工管理後台即將上線 — 下一個里程碑會加上人員、服務項目與訂單管理功能。
        </p>
      </div>

      {isAdmin ? (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
          <div>
            <p className="text-sm font-medium text-foreground">新增分店</p>
            <p className="mt-1 text-xs text-muted-foreground">在同一個集團底下再開一間新的分店</p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/app/new-merchant">新增分店</Link>
          </Button>
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onSignOut}>
          登出
        </Button>
      </div>
    </div>
  );
}
