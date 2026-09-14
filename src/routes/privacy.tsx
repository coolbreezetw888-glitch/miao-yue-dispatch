import { createFileRoute } from "@tanstack/react-router";

import { LegalPage } from "@/components/LegalPage";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "隱私政策｜秒約 Miao Yue" },
      { name: "description", content: "秒約如何蒐集與保護您的資料（暫定版本）。" },
      { property: "og:title", content: "隱私政策｜秒約 Miao Yue" },
      { property: "og:description", content: "秒約如何蒐集與保護您的資料。" },
    ],
  }),
  component: () => (
    <LegalPage title="隱私政策">
      <p>本頁為暫定內容，正式政策將於產品上線前公布。</p>
      <p>我們僅蒐集提供服務所需的最少資料，並以加密方式傳輸與保存。</p>
      <p>您可隨時來信 hello@miaoyue.app 要求查詢或刪除您的資料。</p>
    </LegalPage>
  ),
});
