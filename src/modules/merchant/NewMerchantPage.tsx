// 對應規格書 4.4:新增分店流程頁面。
// 同集團底下已有至少一間商家的使用者，可以從這裡開新分店(規則 2.5:任一分店管理員都能開新分店)。
//
// ui-v1-full 第 3 批(2026-09-30):載入中改灰色骨架(skill 二之八)、「返回後台」改 ② 次要
//(這個畫面的 ① 主要按鈕是表單裡的「建立新分店」)。表單本身的改動在 MerchantIntakeForm.tsx。

import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { LoadingSkeleton } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { createMerchantInGroup } from "./api";
import { useCurrentMerchant, useRefetchAccessibleMerchants } from "./context";
import { MerchantIntakeForm, type MerchantIntakeFormValues } from "./MerchantIntakeForm";

export default function NewMerchantPage() {
  const navigate = useNavigate();
  const { merchant: currentMerchant, isLoading } = useCurrentMerchant();
  const refetchAccessibleMerchants = useRefetchAccessibleMerchants();

  async function handleSubmit(values: MerchantIntakeFormValues) {
    if (!currentMerchant) {
      throw new Error("目前沒有可以參考的集團,請先完成開店流程");
    }

    await createMerchantInGroup({
      groupId: currentMerchant.group_id,
      name: values.name,
      industryType: values.industryType,
      address: values.address,
      contactEmail: values.contactEmail,
      intro: values.intro,
    });

    await refetchAccessibleMerchants();
    toast.success("新分店建立成功！");
    navigate("/app", { replace: true });
  }

  if (isLoading) {
    // skill 二之八:載入中用灰色骨架,不要用「載入中⋯」四個字。
    return (
      <div className="min-h-screen bg-surface">
        <main className="mx-auto max-w-2xl px-5 py-16">
          <LoadingSkeleton variant="lines" rows={6} />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface font-sans antialiased">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-5">
          <Link to="/app" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
              秒
            </span>
            <span className="text-lg font-bold tracking-tight text-foreground">秒約</span>
          </Link>
          {/* ② 次要:這個畫面的主要動作是表單裡的「建立新分店」(skill 二之三)。 */}
          <Button asChild variant="neutral" size="card">
            <Link to="/app">返回後台</Link>
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-5 py-16">
        <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">新增分店</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            這間新分店會加進目前的集團,你會自動成為這間新分店的管理員。
          </p>
          <div className="mt-8">
            <MerchantIntakeForm
              submitLabel="建立新分店"
              submittingLabel="建立中⋯"
              onSubmit={handleSubmit}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
