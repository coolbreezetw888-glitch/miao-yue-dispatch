// 客戶端第 2 批(C2-H01):後台拿到客人帳號時顯示的畫面(AppLayout、PlatformAdminGuard 共用)。
// 畫面已經把後台 client 登出了,這裡只負責說明 + 一顆去登入頁的按鈕。

import { Link } from "react-router-dom";

import { AlertNote } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { CUSTOMER_ACCOUNT_BLOCKED_MESSAGE } from "@/lib/customerAccountGuard";

export function CustomerAccountBlocked() {
  return (
    <div
      className="flex min-h-dvh items-center justify-center bg-surface px-4"
      data-testid="customer-account-blocked"
    >
      <div className="flex w-full max-w-sm flex-col gap-4">
        <AlertNote tone="danger">
          <p className="font-semibold">{CUSTOMER_ACCOUNT_BLOCKED_MESSAGE}</p>
          <p className="mt-1">已經幫你登出後台。如果你是店家，請用店家帳號重新登入。</p>
        </AlertNote>
        <Button asChild variant="primary" size="touch" className="w-full">
          <Link to="/signin" replace>
            前往登入頁
          </Link>
        </Button>
      </div>
    </div>
  );
}
