// 「官方 LINE@」這幾個字:有網址就是連結(開新分頁),沒有就是純文字。
// 網址常數在 src/lib/officialContact.ts(SPECS-INDEX #974,目前刻意留空)。

import { OFFICIAL_LINE_AT_URL } from "@/lib/officialContact";

export function OfficialLineAtLink({ url = OFFICIAL_LINE_AT_URL }: { url?: string }) {
  if (!url) return <>官方 LINE@</>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold underline underline-offset-2"
    >
      官方 LINE@
    </a>
  );
}
