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
          <p className="mt-1 text-sm text-muted-foreground">
            系統裡所有的集團與商家，可以篩選、可以啟用/停用任一間店
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
                    <Link
                      to={`/platform-admin/merchants/${m.id}`}
                      className="font-medium text-foreground hover:underline"
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
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={togglingId === m.id}
                      onClick={() => handleToggleStatus(m.id, m.status)}
                    >
                      {m.status === "active" ? "停用" : "啟用"}
                    </Button>
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
