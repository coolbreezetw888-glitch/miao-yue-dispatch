// SPECS-INDEX #1025 第三輪 ③:未儲存就離開的提醒 —— 文案與「這次點擊要不要攔」的純函式(useLeaveGuard 用)。

export const LEAVE_GUARD_COPY = {
  title: "確定放棄這次的變更？",
  body: "剛剛調整的開關還沒儲存，離開就會不見。",
  keepEditing: "繼續調整",
  discard: "放棄變更",
} as const;

/** 純函式:這次點擊要不要攔(給測試用)。回傳要前往的站內路徑,不用攔時回 null。 */
export function interceptedLeaveTarget(
  event: Pick<
    MouseEvent,
    "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
  >,
  anchor: Pick<HTMLAnchorElement, "href" | "target" | "hasAttribute"> | null,
  current: { origin: string; pathname: string; search: string; hash: string },
): string | null {
  if (!anchor || event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;
  let url: URL;
  try {
    url = new URL(anchor.href, `${current.origin}${current.pathname}`);
  } catch {
    return null;
  }
  if (url.origin !== current.origin) return null;
  const to = `${url.pathname}${url.search}${url.hash}`;
  if (to === `${current.pathname}${current.search}${current.hash}`) return null;
  return to;
}
