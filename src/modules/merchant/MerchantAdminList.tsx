// 對應規格書 4.3:商家設定頁 — 唯讀管理員清單顯示。
// 刻意不提供新增/移除按鈕(見規格書「本模組明確不做的事」),那是模組 3 的範圍。

import { useMerchantAdmins } from "./context";

export function MerchantAdminList({ merchantId }: { merchantId: string | null | undefined }) {
  const { data: admins, isLoading, error } = useMerchantAdmins(merchantId);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">載入管理員名單中⋯</p>;
  }

  if (error) {
    return <p className="text-sm text-destructive">管理員名單載入失敗:{error.message}</p>;
  }

  if (!admins || admins.length === 0) {
    return <p className="text-sm text-muted-foreground">目前沒有管理員紀錄</p>;
  }

  return (
    <ul className="space-y-2">
      {admins.map((admin) => (
        <li
          key={admin.id}
          className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
        >
          <span className="text-foreground">{admin.email}</span>
          <span className="text-xs text-muted-foreground">
            {new Date(admin.created_at).toLocaleDateString("zh-TW")} 加入
          </span>
        </li>
      ))}
      <li className="text-xs text-muted-foreground">
        新增/移除管理員的功能將在「人員與權限管理」模組推出後開放。
      </li>
    </ul>
  );
}
