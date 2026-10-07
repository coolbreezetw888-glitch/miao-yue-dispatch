// 對應規格書(服務人員端)4.7 第 3 點:服務人員權限勾選畫面(新路由 /app/staff/:staffId/permissions)。
// 直接參考既有 AgentPermissionsPage.tsx 改寫,列出四個 section_key,逐項提供開關,並在
// 「可預約時段/休假自助調整」這一項旁附註「僅抽成制服務人員可以使用」(規則 2.2)。

import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { AlertNote, LoadingSkeleton } from "@/components/patterns";
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
          {/* 🔴 SPECS-INDEX #879 ①:原本寫「只影響這位服務人員自己能不能看到/操作自己的資料」是錯的 ——
              「行事曆檢視」開放的預約明細裡有**客戶**的姓名、電話、地址、備註,那不是「自己的資料」。
              舊寫法會讓管理員低估這個開關的份量,所以改成明講客戶個資會一起被看到。 */}
          <CardDescription>
            這四項決定這位服務人員登入服務人員端後能看到/操作哪些內容，不涉及商家層級的設定。
            其中「行事曆檢視」開放的不只是他自己的班表 ——
            預約明細裡會一併顯示客戶的姓名、電話、地址與備註，開啟前請先確認這位服務人員可以接觸客戶個資。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 🔴 SPECS-INDEX #877(使用者裁決 B):四筆權限紀錄是服務人員「第一次登入成功」那一刻才由
              seed_default_staff_permissions 建立,而且一律建成「開」;但下面的 Switch 是
              `grantedMap.get(key) ?? false`,查不到紀錄就顯示「關」。
              ⇒ 還沒完成登入的人,這頁顯示的「四項全關」是假的。
              依 ui-overlay-patterns 二之三「現在的狀態跟使用者以為的不一樣」⇒ 用常駐 `!`(AlertNote),
              **不可以**收進要點開的 `?`。
              📌 刻意不改 `?? false` —— 查不到紀錄就當沒權限是安全的方向,改成「沒紀錄當成開」會讓前端
                 在資料異常時往寬鬆的方向猜,方向錯誤(#877 備註)。 */}
          {staff && staff.login_status !== "active" ? (
            <AlertNote>
              這位服務人員還沒完成登入，
              <strong className="font-bold">四項權限會在他第一次登入時預設全部開啟</strong>
              ；現在顯示的關閉狀態不代表他登入後會是關的。等他完成登入後再回來這頁調整，才會是實際生效的設定。
            </AlertNote>
          ) : null}
          {isLoading ? (
            /* skill 二之八:載入中用灰色骨架,不用「載入中⋯」四個字。 */
            <LoadingSkeleton variant="lines" rows={4} />
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
                          (這位是月薪制服務人員，即使開啟也不會生效)
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
    <RequireMerchantAdmin featureName="服務人員權限設定">
      <StaffPermissionsInner />
    </RequireMerchantAdmin>
  );
}
