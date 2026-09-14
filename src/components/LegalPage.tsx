import { Link } from "react-router-dom";
import type { ReactNode } from "react";

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background font-sans antialiased">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-3xl items-center px-5">
          <Link to="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
              秒
            </span>
            <span className="text-lg font-bold tracking-tight text-foreground">秒約</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-16">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">{title}</h1>
        <div className="mt-8 space-y-5 text-base leading-relaxed text-muted-foreground">
          {children}
        </div>
        <Link to="/" className="mt-10 inline-block text-sm font-semibold text-primary hover:underline">
          ← 回首頁
        </Link>
      </main>
    </div>
  );
}
