// 後台導覽外殼「行事曆」分頁籤(路由 /app/calendar,新增)。
// 模組 5(行事曆與預約總覽)還沒開發,先放一個「即將推出」的佔位畫面,文案比照現有風格。
// 等模組 5 正式開發時,由那個模組的規格書接手這個路由的實際內容,這次只把分頁籤跟路由架好
// (見規格書「新外殼結構」一節)。

import { CalendarDays } from "lucide-react";

export default function CalendarPlaceholderPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-10">
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border bg-card px-6 py-16 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-soft text-brand">
          <CalendarDays className="h-7 w-7" />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">行事曆功能即將上線</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            這裡以後會是你的預約總覽 — 敬請期待。
          </p>
        </div>
      </div>
    </div>
  );
}
