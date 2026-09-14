import { createFileRoute } from "@tanstack/react-router";

import { LegalPage } from "@/components/LegalPage";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "服務條款｜秒約 Miao Yue" },
      { name: "description", content: "秒約派工預約系統的服務條款（暫定版本）。" },
      { property: "og:title", content: "服務條款｜秒約 Miao Yue" },
      { property: "og:description", content: "秒約派工預約系統的服務條款。" },
    ],
  }),
  component: () => (
    <LegalPage title="服務條款">
      <p>本頁為暫定內容，正式條款將於產品上線前公布。</p>
      <p>使用秒約服務即表示您同意依約定方式使用本系統，並對帳號內容負保管責任。</p>
      <p>如對條款有任何疑問，歡迎來信 hello@miaoyue.app。</p>
    </LegalPage>
  ),
});
