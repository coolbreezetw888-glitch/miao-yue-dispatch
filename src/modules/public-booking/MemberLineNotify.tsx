// 客戶端第 5 批:會員中心的兩個 LINE 通知畫面。
//   ・C5-M01 / F 區:首頁「加入店家 LINE 好友」提示卡(預覽圖 ⑧)。
//   ・C5-M02:我的資料「LINE 通知」區塊(預覽圖 ⑪-1),放在「LINE 帳號 已綁定」那行下面。
// 規格:.project/specs/客戶端第5批-LINE通知與綁定.md;純邏輯在 lineNotifyLogic.ts。
//
// ・店家不能用 LINE 通知客人(沒接上官方帳號 / 預約通知全關)⇒ 兩個畫面都不出現(不承諾做不到的事)。
// ・開關切換立即儲存;儲存中該開關停用 + 轉圈;失敗退回原狀態 + toast「儲存失敗，請稍後再試」。
// ・「優惠通知」5-A 不顯示;5-B(#1047)行銷 / 生日禮照開關發送後顯示(PROMO_SWITCH_VISIBLE)。
// ・加好友按鈕是外部連結(新分頁、noopener);LINE 綠色 #06C755 是 LINE 品牌色,不是本系統主題色。

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { AlertNote, SwitchRow } from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { isMemberGate } from "./memberCenterLogic";
import { memberCenterQueryKey } from "./memberCenterApi";
import { fetchMyNotifyPrefs, notifyPrefsQueryKey, setMyNotifyPrefs } from "./lineNotifyApi";
import {
  ADD_FRIEND_AFTER_NOTE,
  ADD_FRIEND_CARD_BODY,
  addFriendCardTitle,
  BOOKING_SWITCH_DESCRIPTION,
  BOOKING_SWITCH_TITLE,
  LINE_NOTIFY_SECTION_TITLE,
  NOT_FRIEND_NOTE,
  PREFS_SAVE_FAILED_MESSAGE,
  PROMO_SWITCH_DESCRIPTION,
  PROMO_SWITCH_TITLE,
  PROMO_SWITCH_VISIBLE,
  readAddFriendDismissed,
  shouldShowAddFriendCard,
  shouldShowLineNotifySection,
  shouldShowNotFriendNote,
  writeAddFriendDismissed,
  type MemberLineNotify,
  type MemberNotifyPrefs,
} from "./lineNotifyLogic";
import { LineIcon } from "./PublicBookingChrome";

const LINE_GREEN_SMALL_BUTTON_CLASS =
  "flex-1 border border-transparent bg-[#06C755] font-semibold text-white hover:bg-[#06C755]/90";

// =========================================================================
// ⑧ 首頁提示卡
// =========================================================================

export function MemberAddFriendCard({
  slug,
  merchantName,
  lineNotify,
}: {
  slug: string;
  merchantName: string;
  lineNotify: MemberLineNotify;
}) {
  const [dismissed, setDismissed] = useState(() => readAddFriendDismissed(slug));
  const [opened, setOpened] = useState(false);
  if (!shouldShowAddFriendCard(lineNotify, dismissed) || !lineNotify.addFriendUrl) return null;

  return (
    <section
      className="rounded-xl border border-border bg-card p-3.5 shadow-sm"
      data-testid="member-home-add-friend"
    >
      <p className="break-words text-[15px] font-semibold text-foreground">
        {addFriendCardTitle(merchantName)}
      </p>
      <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
        {ADD_FRIEND_CARD_BODY}
      </p>
      {opened ? (
        <p
          className="mt-2 text-[13px] leading-relaxed text-foreground"
          data-testid="member-home-add-friend-after"
        >
          {ADD_FRIEND_AFTER_NOTE}
        </p>
      ) : null}
      <div className="mt-2.5 flex gap-2">
        <Button
          type="button"
          variant="text"
          size="card"
          className="flex-1"
          onClick={() => {
            writeAddFriendDismissed(slug);
            setDismissed(true);
          }}
          data-testid="member-home-add-friend-later"
        >
          稍後再說
        </Button>
        <Button asChild size="card" className={LINE_GREEN_SMALL_BUTTON_CLASS}>
          <a
            href={lineNotify.addFriendUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpened(true)}
            data-testid="member-home-add-friend-go"
          >
            <LineIcon className="!size-5" />
            加入好友
          </a>
        </Button>
      </div>
    </section>
  );
}

// =========================================================================
// ⑪-1 我的資料「LINE 通知」區塊
// =========================================================================

type PrefKey = "notifyBooking" | "notifyPromo";

export function MemberLineNotifySection({
  slug,
  onSessionLost,
}: {
  slug: string;
  onSessionLost: () => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: notifyPrefsQueryKey(slug),
    queryFn: () => fetchMyNotifyPrefs(slug),
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const result = query.data;
  const gate = result && isMemberGate(result) ? result : null;
  const loaded = result && !isMemberGate(result) ? result : null;

  // 畫面上的開關值(切換時先改,失敗再退回)。
  const [prefs, setPrefs] = useState<MemberNotifyPrefs | null>(null);
  const [saving, setSaving] = useState<PrefKey | null>(null);

  useEffect(() => {
    if (loaded) setPrefs(loaded);
  }, [loaded]);

  useEffect(() => {
    if (gate?.state === "not_linked") onSessionLost();
  }, [gate, onSessionLost]);

  // 讀不到 / 讀取中 / 店家不能用 ⇒ 整塊不顯示(不顯示錯誤:這塊是附加功能,不要讓整頁看起來壞掉)。
  if (!prefs || !shouldShowLineNotifySection(prefs)) return null;

  async function toggle(key: PrefKey, next: boolean) {
    if (!prefs || saving) return;
    const before = prefs;
    setPrefs({ ...prefs, [key]: next });
    setSaving(key);
    try {
      const res = await setMyNotifyPrefs(
        slug,
        key === "notifyBooking" ? { notifyBooking: next } : { notifyPromo: next },
      );
      if (isMemberGate(res)) {
        setPrefs(before);
        if (res.state === "not_linked") onSessionLost();
        else toast.error(PREFS_SAVE_FAILED_MESSAGE);
        return;
      }
      setPrefs(res);
      queryClient.setQueryData(notifyPrefsQueryKey(slug), res);
      // 首頁的加好友卡也看「預約通知」開關 ⇒ 讓首頁重抓。
      void queryClient.invalidateQueries({ queryKey: [...memberCenterQueryKey(slug), "home"] });
    } catch {
      setPrefs(before);
      toast.error(PREFS_SAVE_FAILED_MESSAGE);
    } finally {
      setSaving(null);
    }
  }

  const spinner = (
    <Loader2
      className="ml-1.5 inline h-3.5 w-3.5 animate-spin align-[-2px] text-muted-foreground"
      aria-hidden="true"
    />
  );

  return (
    <section className="flex flex-col gap-2" data-testid="member-line-notify">
      <h2 className="px-0.5 text-[13px] font-semibold text-foreground">
        {LINE_NOTIFY_SECTION_TITLE}
      </h2>
      {shouldShowNotFriendNote(prefs) ? (
        <AlertNote data-testid="member-line-notify-not-friend">
          <span>{NOT_FRIEND_NOTE}</span>
          {prefs.addFriendUrl ? (
            <a
              href={prefs.addFriendUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 font-semibold underline underline-offset-2"
              data-testid="member-line-notify-add-friend"
            >
              加入好友
            </a>
          ) : null}
        </AlertNote>
      ) : null}
      <div className="flex flex-col gap-2 rounded-xl bg-card">
        <SwitchRow
          id="member-notify-booking"
          title={
            <>
              {BOOKING_SWITCH_TITLE}
              {saving === "notifyBooking" ? spinner : null}
            </>
          }
          description={BOOKING_SWITCH_DESCRIPTION}
          checked={prefs.notifyBooking}
          disabled={saving === "notifyBooking"}
          onCheckedChange={(v) => void toggle("notifyBooking", v)}
          className="bg-card"
        />
        {PROMO_SWITCH_VISIBLE ? (
          <SwitchRow
            id="member-notify-promo"
            title={
              <>
                {PROMO_SWITCH_TITLE}
                {saving === "notifyPromo" ? spinner : null}
              </>
            }
            description={PROMO_SWITCH_DESCRIPTION}
            checked={prefs.notifyPromo}
            disabled={saving === "notifyPromo"}
            onCheckedChange={(v) => void toggle("notifyPromo", v)}
            className="bg-card"
          />
        ) : null}
      </div>
    </section>
  );
}
