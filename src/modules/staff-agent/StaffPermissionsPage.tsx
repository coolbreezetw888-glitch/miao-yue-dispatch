// 對應規格書(服務人員端)4.7 第 3 點:服務人員權限勾選畫面(新路由 /app/staff/:staffId/permissions)。
// 直接參考既有 AgentPermissionsPage.tsx 改寫,列出四個 section_key,逐項提供開關,並在
// 「可預約時段/休假自助調整」這一項旁附註「僅按件計酬服務人員可以使用」(規則 2.2)。

import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { fetchStaffPermissions, setStaffPermission } from "@/modules/staff-portal/api";
import { STAFF_PERMISSION_SECTIONS } from "@/modules/staff-portal/types";

import { fetchMerchantStaff } from "./api";
import { RequireMerchantAdmin } from "./RequireMerchantAdmin";

const permissionsQueryKey = (staffId: string) =>
  ["staff-agent-module", "staff-permissions", staffId] as const;

function StaffPermissionsInner() {
  const { staffId } = useParams<{ staffId: string }>();
  const { merchant } = useCurrentMerchant();
  const queryClient = useQueryClient();

  const { data: staffList } = useQuery({
    queryKey: ["staff-agent-module", "staff-admin-list", merchant?.id ?? ""],
    queryFn: () => fetchMerchantStaff(merchant!.id),
    enabled: Boolean(merchant?.id),
  });
  const staff = staffList?.find((s) => s.id === staffId);

  const { data: permissions, isLoading } = useQuery({
    queryKey: permissionsQueryKey(staffId ?? ""),
    queryFn: () => fetchStaffPermissions(staffId as string),
    enabled: Boolean(staffId),
  });

  const grantedMap = new Map((permissions ?? []).map((p) => [p.section_key, p.granted]));

  async function handleToggle(sectionKey: string, granted: boolean) {
    if (!staffId) return;
    try {
      await setStaffPermission(staffId, sectionKey, granted);
      await queryClient.invalidateQueries({ queryKey: permissionsQueryKey(staffId) });
    } catch (err) {
      toast.error("設定失敗", { description: getErrorMessage(err) });
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-5 py-12">
      <div>
        <Link to="/app/staff" className="text-sm text-muted-foreground hover:underline">
          ← 返回服務人員名單
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">
          {staff ? `${staff.name} 的權限設定` : "權限設定"}
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>自助功能區塊</CardTitle>
          <CardDescription>
            這四項只影響這位服務人員自己能不能看到/操作自己的資料,不涉及其他任何商家層級的敏感操作。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">載入中⋯</p>
          ) : (
            <ul className="space-y-2">
              {STAFF_PERMISSION_SECTIONS.map((section) => (
                <li
                  key={section.key}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">{section.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {section.description}
                      {section.key === "staff_availability_self_manage" &&
                      staff?.compensation_type === "monthly_salary" ? (
                        <span className="ml-1 text-warn">
                          (這位是月薪制服務人員,即使開啟也不會生效)
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <Switch
                    checked={grantedMap.get(section.key) ?? false}
                    onCheckedChange={(v) => handleToggle(section.key, v)}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export default function StaffPermissionsPage() {
  return (
    <RequireMerchantAdmin>
      <StaffPermissionsInner />
    </RequireMerchantAdmin>
  );
}
