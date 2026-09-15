// 對應規格書 4.1:Onboarding(開店引導流程)頁面。
// 使用者登入後如果不屬於任何 merchant_admins 紀錄，AppShell(4.6)會導來這裡。

import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { AuthShell } from "@/components/AuthShell";
import { createGroupAndMerchant } from "./api";
import { useRefetchAccessibleMerchants } from "./context";
import { MerchantIntakeForm, type MerchantIntakeFormValues } from "./MerchantIntakeForm";

export default function OnboardingPage() {
  const navigate = useNavigate();
  const refetchAccessibleMerchants = useRefetchAccessibleMerchants();

  async function handleSubmit(values: MerchantIntakeFormValues) {
    await createGroupAndMerchant({
      name: values.name,
      industryType: values.industryType,
      address: values.address,
      contactEmail: values.contactEmail,
      intro: values.intro,
    });

    await refetchAccessibleMerchants();
    toast.success("開店成功！");
    navigate("/app", { replace: true });
  }

  return (
    <AuthShell title="開始使用秒約" subtitle="填寫第一間店的基本資料,馬上開始使用派工預約系統。">
      <MerchantIntakeForm
        submitLabel="建立第一間店"
        submittingLabel="建立中⋯"
        onSubmit={handleSubmit}
      />
    </AuthShell>
  );
}
