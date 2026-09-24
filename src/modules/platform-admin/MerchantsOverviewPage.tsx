// 對應規格書 4.3:集團與商家總覽清單(`/platform-admin`)。
// 啟用/停用按鈕直接沿用模組 1 現成的 enableMerchant/disableMerchant，不重寫。

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { disableMerchant, enableMerchant } from "@/modules/merchant/api";
import { INDUSTRY_TYPE_LABELS } from "@/modules/merchant/types";
import type { IndustryType } from "@/modules/merchant/types";

import { platformFetchAllMerchants } from "./api";
import { getErrorMessage } from "./getErrorMessage";
import { PlatformAdminShell } from "./PlatformAdminShell";

const ALL_STATUS = "all";
const ALL_INDUSTRY = "all";
const ALL_MERCHANTS_QUERY_KEY = ["platform-admin", "all-merchants"] as const;

export default function MerchantsOverviewPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>(ALL_STATUS);
  const [industryFilter, setIndustryFilter] = useState<string>(ALL_INDUSTRY);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const {
    data: merchants,
    isLoading,
    error,
  } = useQuery({
    queryKey: ALL_MERCHANTS_QUERY_KEY,
    queryFn: platformFetchAllMerchants,
  });

  const filtered = useMemo(() => {
    return (merchants ?? []).filter((m) => {
      if (statusFilter !== ALL_STATUS && m.status !== statusFilter) return false;
      if (industryFilter !== ALL_INDUSTRY && m.industry_type !== industryFilter) return false;
      return true;
    });
  }, [merchants, statusFilter, industryFilter]);

  async function handleToggleStatus(merchantId: string, currentStatus: string) {
    setTogglingId(merchantId);
    try {
      if (currentStatus === "active") {
        await disableMerchant(merchantId);
        toast.success("已停用這間商家");
      } else {
        await enableMerchant(merchantId);
        toast.success("已啟用這間商家");
      }
      await queryClient.invalidateQueries({ queryKey: ALL_MERCHANTS_QUERY_KEY });
    } catch (err) {
      // 沿用 module 1 的 disableMerchant/enableMerchant,那邊丟出的也是 Supabase 的「形狀對
      // 但不是 Error 子類別」的一般物件(見 getErrorMessage.ts 開頭的說明),所以這裡同樣要用
      // getErrorMessage 而不是 instanceof Error 判斷,才能正確顯示資料庫回傳的訊息。
      toast.error("操作失敗", { description: getErrorMessage(err) });
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <PlatformAdminShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">集團與商家總覽</h1>
          {/* #693:這一頁最初只寫「可以篩選、可以啟用/停用」,加上商家名稱的連結樣式跟旁邊的
              純文字一模一樣(見 #692),使用者因此以為「總覽只有停用/啟用」,完全不知道可以
              點進詳情頁。視覺提示(#691/#692)加上這一句白話說明,兩層一起做,才不會下一輪
              又問同一件事。 */}
          <p className="mt-1 text-sm text-muted-foreground">
            系統裡所有的集團與商家,可以篩選、可以啟用/停用任一間店。點商家名稱或右側「查看詳情」,可以進到單一商家的詳情頁,查看並編輯基本資料、管理員、集團管理者,以及檢視服務人員與客服名單。
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="狀態" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUS}>全部狀態</SelectItem>
              <SelectItem value="active">啟用中</SelectItem>
              <SelectItem value="disabled">已停用</SelectItem>
            </SelectContent>
          </Select>

          <Select value={industryFilter} onValueChange={setIndustryFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="產業" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_INDUSTRY}>全部產業</SelectItem>
              <SelectItem value="on_site_dispatch">到府派工</SelectItem>
              <SelectItem value="in_store_beauty">美業到店</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">載入中⋯</p>
        ) : error ? (
          <p className="text-sm text-destructive">載入失敗:{(error as Error).message}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>商家名稱</TableHead>
                <TableHead>所屬集團</TableHead>
                <TableHead>產業</TableHead>
                <TableHead>狀態</TableHead>
                <TableHead>管理員人數</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    {/* #692:這個連結一直都在,但 `text-foreground` 就是普通正文的顏色,跟右邊
                        「所屬集團/產業」那幾欄長得一模一樣,而 `hover:underline` 在手機上根本
                        沒有 hover 可以觸發——所以使用者完全看不出商家名稱可以點。只換顏色
                        token 成 `text-brand`(全專案已有 25 處在用的品牌色),其餘不動:
                        不要改成 <Button>、不要加圖示、也不要改成常駐底線(既有慣例是
                        hover:underline,見 MemberDetailPage.tsx 的「查看完整點數紀錄 →」)。 */}
                    <Link
                      to={`/platform-admin/merchants/${m.id}`}
                      className="font-medium text-brand hover:underline"
                    >
                      {m.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{m.group?.name ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {INDUSTRY_TYPE_LABELS[m.industry_type as IndustryType] ?? m.industry_type}
                  </TableCell>
                  <TableCell>
                    <span
                      className={
                        m.status === "active"
                          ? "text-sm font-medium text-foreground"
                          : "text-sm font-medium text-muted-foreground"
                      }
                    >
                      {m.status === "active" ? "啟用中" : "已停用"}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{m.admin_count}</TableCell>
                  <TableCell className="text-right">
                    {/* #691:「操作」欄原本只有一顆停用/啟用按鈕,所以使用者看不出這一頁還能
                        下鑽。這裡補一個文字連結放在按鈕左邊,沿用 MemberDetailPage.tsx
                        L486-491 的既有慣例(`text-sm text-brand hover:underline` + 「→」),
                        不自創新的 class 組合。
                        ⚠️ 已停用的商家(status='disabled')這個連結照樣要顯示——停用只是客戶端
                           不能下單,平台方當然還要能進去看。所以這裡刻意沒有任何條件判斷。
                        ⚠️ 外層 TableCell 的 text-right 不動,只在裡面多包一層 flex 讓兩個元素
                           靠右並排。 */}
                    <div className="flex items-center justify-end gap-3">
                      <Link
                        to={`/platform-admin/merchants/${m.id}`}
                        className="text-sm text-brand hover:underline"
                      >
                        查看詳情 →
                      </Link>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={togglingId === m.id}
                        onClick={() => handleToggleStatus(m.id, m.status)}
                      >
                        {m.status === "active" ? "停用" : "啟用"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    沒有符合條件的商家
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        )}
      </div>
    </PlatformAdminShell>
  );
}
