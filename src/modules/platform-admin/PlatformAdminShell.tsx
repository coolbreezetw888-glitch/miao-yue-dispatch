// 對應規格書 4.2:超級管理員後台外殼與導覽。
// 純功能性的簡單頂部導覽(集團與商家 / 產業預設功能組合),沿用既有的 src/components/ui/ 元件庫，
// 不另外設計一套視覺系統——這是內部維運工具，不是賣給商家的產品功能，UI 打磨留到最後。

import { Link, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/platform-admin", label: "集團與商家" },
  { to: "/platform-admin/industry-presets", label: "產業預設功能組合" },
];

export function PlatformAdminShell({ children }: { children: ReactNode }) {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-surface font-sans antialiased">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-5">
          <div className="flex items-center gap-6">
            <span className="text-lg font-bold tracking-tight text-foreground">
              秒約・超級管理員後台
            </span>
            <nav className="flex items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const active =
                  item.to === "/platform-admin"
                    ? location.pathname === "/platform-admin"
                    : location.pathname.startsWith(item.to);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <Link to="/app" className="text-sm text-muted-foreground hover:text-foreground">
            返回一般後台
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-10">{children}</main>
    </div>
  );
}
