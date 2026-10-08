// 客戶端第 1 批(C1-A01~A10):公開預約頁 `/booking/<代碼>`。
// 規格:.project/specs/客戶端第1批-公開預約頁.md;畫面對照 .project/notes/客戶端預覽-2026-10-08.html 的 ①~⑤。
//
// ─── 這一頁的幾個重要決定 ───────────────────────────────────────────────────────────
// ・不需要登入、不套後台外殼;已經登入後台的人打開也一樣是客人版畫面,**不讀**目前操作中的商家
//   (useCurrentMerchant),所有資料都來自 get_public_booking_page(以網址代碼查)。
// ・主題色跟著「這間預約頁商家」走;離開這一頁時把顏色、分頁標題還原(同一個分頁回到後台時才不會顏色錯)。
// ・①~⑤ 都在同一個網址內切換(不另開子網址,避免客人把中間步驟分享出去)。步驟記在瀏覽器的
//   history state ⇒ 手機 / 瀏覽器的「上一頁」= 回到上一步,不是離開網站(C1-A09)。
//   重新整理:選的東西只放在記憶體(C1-A08:不存瀏覽器),所以一律回到 ①。做法是每次載入產生一個
//   sessionId 寫進 history state,state 裡的 sessionId 對不上(= 重新整理過)就當作 ①。
// ・時段一律由資料庫 get_public_available_slots 算,前端不判斷任何時段規則(C1-A07)。
// ・第 3 批(C3-D01~D07)起可以真的送出:會員(已用 LINE 登入並接上會員)與訪客(⑥-4,過 Turnstile)都走
//   Edge Function customer-booking-submit;成功後顯示 ⑦ 完成頁(結果只在記憶體,重新整理 / 上一頁回 ①)。
// ・客人與商家輸入的文字一律當純文字顯示(React 文字節點),不用 dangerouslySetInnerHTML(C1-F04)。

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Megaphone,
  Minus,
  Plus,
  Users,
} from "lucide-react";

import {
  AlertNote,
  ErrorState,
  FieldInput,
  FieldTextarea,
  FormField,
  HelpPanel,
  LoadingSkeleton,
  AttributeTag,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { applyThemeColorToDocument, resolveMerchantThemeColor } from "@/modules/merchant/theme";

import {
  fetchPublicAvailableSlots,
  fetchPublicBookingPage,
  PUBLIC_RATE_LIMITED_MESSAGE,
  PublicBookingError,
  rejectedSlotsMessage,
} from "./api";
import { BookingCompleteScreen } from "./BookingCompleteScreen";
import {
  BookingSubmitError,
  submitCustomerBooking,
  type GuestSubmitInput,
} from "./bookingSubmitApi";
import {
  newSubmissionId,
  SLOT_TAKEN_MESSAGE,
  submitFailureView,
  type SubmitFailureView,
  type SubmitRejectState,
  type SubmittedBooking,
} from "./bookingSubmitLogic";
import { ContactButtons, PublicShell, StepHeader, TitleOnlyHeader } from "./PublicBookingChrome";
import {
  CompleteProfileError,
  completeCustomerProfile,
  CustomerAuthError,
  customerSessionQueryKey,
  fetchCustomerSessionState,
  redirectToAuthorizeUrl,
  signOutCustomer,
  startLineJoin,
  startLineLogin,
} from "./customerAuthApi";
import {
  completeProfileErrorMessage,
  isAllowedAuthorizeUrl,
  isSessionInvalidHint,
  lineStartErrorMessage,
  peekPendingDraft,
  rememberLoginOrigin,
  rememberLoginSlug,
  takePendingDraft,
  type BookingDraft,
  type CustomerSessionState,
  type PendingDraft,
} from "./customerLoginLogic";
import {
  CustomerLoginBar,
  CustomerProfileScreen,
  JoinPendingScreen,
  GuestScreen,
  LineAvatar,
  LineLoginScreen,
  LinkedConfirmScreen,
  type ProfileSubmitOutcome,
} from "./CustomerLoginScreens";
import { memberCenterPath } from "./memberCenterLogic";
import { cancelMyJoinRequest } from "./memberContactsApi";
import {
  addDays,
  buildPublicServiceTabs,
  computeSelectionTotals,
  CUSTOMER_ADDRESS_MAX,
  CUSTOMER_NAME_MAX,
  CUSTOMER_NOTE_MAX,
  countChars,
  dayOfMonth,
  dayStateLabel,
  eligibleStaff,
  formatDateWithWeekday,
  formatDurationApprox,
  formatPublicPrice,
  formatSlotSummary,
  formatWeekHeading,
  formNextStepHint,
  step5Name,
  groupTimes,
  isNextWeekDisabled,
  merchantLogoText,
  PUBLIC_ITEM_QUANTITY_MAX,
  resolveContactLinks,
  selectionToItems,
  serviceStepBlockedReason,
  SLOT_DAYS_PER_PAGE,
  staffAvatarText,
  stepSelection,
  taipeiToday,
  toggleSelection,
  validateCustomerForm,
  weekdayLabel,
  type ContactLinks,
  type CustomerFormValues,
  type PublicSelection,
} from "./publicBookingLogic";
import { resolveTurnstileSiteKey } from "./turnstile";
import type { PublicBookingPageOk, PublicServiceItem, PublicSlotDay } from "./types";

const PAGE_QUERY_KEY = "public-booking";

// =========================================================================
// 路由進入點:讀資料、主題色、分頁標題、四種狀態
// =========================================================================

export default function PublicBookingPage() {
  const { slug: rawSlug = "" } = useParams();
  const slug = rawSlug.trim().toLowerCase();

  const pageQuery = useQuery({
    queryKey: [PAGE_QUERY_KEY, "page", slug],
    queryFn: () => fetchPublicBookingPage(slug),
    retry: (count, err) =>
      !(err instanceof PublicBookingError && err.kind === "rate_limited") && count < 1,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const page = pageQuery.data;
  const okPage = page?.status === "ok" ? page : null;

  // C1-A02:主題色跟著這間預約頁商家;離開時還原(回到後台時 AppLayout 會再套一次自己商家的顏色)。
  useEffect(() => {
    applyThemeColorToDocument(okPage ? resolveMerchantThemeColor(okPage.merchant) : null);
  }, [okPage?.merchant.theme_preset, okPage?.merchant.theme_custom_color]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => applyThemeColorToDocument(null), []);

  // C1-A02:瀏覽器分頁標題 = 店名;離開時還原。
  const previousTitle = useRef<string | null>(null);
  useEffect(() => {
    previousTitle.current = document.title;
    return () => {
      if (previousTitle.current !== null) document.title = previousTitle.current;
    };
  }, []);
  useEffect(() => {
    if (okPage) document.title = okPage.merchant.name;
    else if (page) document.title = "線上預約";
  }, [okPage?.merchant.name, page]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pageQuery.isPending) {
    return (
      <PublicShell header={<div className="h-[54px]" />}>
        <div className="flex flex-col gap-3" data-testid="public-booking-loading">
          <LoadingSkeleton variant="lines" rows={3} />
          <LoadingSkeleton variant="cards" rows={3} />
        </div>
      </PublicShell>
    );
  }

  if (pageQuery.isError || !page) {
    return (
      <PublicShell header={<div className="h-[54px]" />}>
        <LoadErrorState
          rateLimited={
            pageQuery.error instanceof PublicBookingError && pageQuery.error.kind === "rate_limited"
          }
          onRetry={() => void pageQuery.refetch()}
        />
      </PublicShell>
    );
  }

  if (page.status === "not_found") {
    return (
      <PublicShell header={<TitleOnlyHeader title="線上預約" />}>
        <NoticeCard
          testId="public-booking-not-found"
          title="找不到這個預約頁"
          body="請向店家確認連結是否正確。"
        />
      </PublicShell>
    );
  }

  if (page.status === "unavailable") {
    // C1-A01 ⚠️:停用的店不顯示店名、電話等任何資料(資料庫本來就只回 status)。
    return (
      <PublicShell header={<TitleOnlyHeader title="線上預約" />}>
        <NoticeCard
          testId="public-booking-unavailable"
          title="這間店目前暫停線上預約"
          body="如需預約，請直接聯絡店家。"
        />
      </PublicShell>
    );
  }

  return <BookingFlow key={slug} page={page} slug={slug} />;
}

function LoadErrorState({
  onRetry,
  rateLimited = false,
}: {
  onRetry: () => void;
  /** C3-G02:超過呼叫上限。 */
  rateLimited?: boolean;
}) {
  return (
    <div data-testid="public-booking-error">
      <ErrorState
        title={rateLimited ? PUBLIC_RATE_LIMITED_MESSAGE : "讀取失敗，請稍後再試"}
        reason={rateLimited ? "短時間內查詢次數太多，等幾分鐘再按重新整理" : "可能是網路不穩"}
        onRetry={onRetry}
        retryLabel="重新整理"
      />
    </div>
  );
}

function NoticeCard({ title, body, testId }: { title: string; body: string; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-5 py-10 text-center shadow-sm"
    >
      <p className="text-[17px] font-bold text-foreground">{title}</p>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

// =========================================================================
// 預約流程(① ~ ⑤,C2 加上 ⑥,C3 加上 ⑦ 完成頁)
// =========================================================================

// 0 = ① 店家首頁,1 = ② 選服務,2 = ③ 選服務人員,3 = ④ 選時間,4 = ⑤ 填資料,
// 5 = ⑥ 會員(依登入狀態顯示 ⑥-1 LINE 登入 / ⑥-2 填電話 / 確認送出),6 = ⑥-4 不登入預約(C2),
// 7 = ⑦ 完成頁(C3-D06;只有剛送出成功、結果還在記憶體時才有)。
type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
const LAST_FORM_STEP = 6;
const COMPLETE_STEP = 7;

interface FlowHistoryState {
  c1Session?: unknown;
  c1Step?: unknown;
}

function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface PickedSlot {
  signature: string;
  date: string;
  time: string;
}

/** C2-B04:登入回來的草稿 → 預約頁的初始狀態(只在第一次掛上時用一次)。 */
function draftToInitial(page: PublicBookingPageOk, pending: PendingDraft | null) {
  const draft = pending?.draft ?? null;
  if (!draft) return null;
  const known = new Set(page.service_items.map((i) => i.id));
  const selection = new Map<string, number>();
  for (const item of draft.items) {
    if (known.has(item.service_item_id)) selection.set(item.service_item_id, item.quantity);
  }
  const items = selectionToItems(selection);
  const staffId = draft.staff_id;
  return {
    selection,
    staffId,
    picked: { signature: JSON.stringify([items, staffId]), date: draft.date, time: draft.time },
    form: { name: draft.name, address: draft.address, note: draft.note },
  };
}

const SESSION_QUERY_KEY = customerSessionQueryKey;
const EMPTY_FORM: CustomerFormValues = { name: "", address: "", note: "" };

function BookingFlow({ page, slug }: { page: PublicBookingPageOk; slug: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [sessionId] = useState(newSessionId);

  const { merchant, booking_settings: settings } = page;
  const contacts = useMemo(() => resolveContactLinks(merchant), [merchant]);
  const isOnSite = settings.is_on_site;
  const lineLoginEnabled = settings.line_login_enabled;
  const allowGuest = settings.allow_guest_booking;
  const turnstileSiteKey = useMemo(() => resolveTurnstileSiteKey(), []);

  // C2-B04 / C2-E07:LINE 登入回來時帶著草稿(只在記憶體;重新整理就沒有 ⇒ 回到 ①)。
  const [initial] = useState(() => draftToInitial(page, peekPendingDraft(slug)));

  // ─── 選擇的內容(只放記憶體)───
  const [selection, setSelection] = useState<PublicSelection>(
    () => initial?.selection ?? new Map(),
  );
  const [serviceTab, setServiceTab] = useState<string | null>(null);
  const [chosenStaffId, setChosenStaffId] = useState<string | null>(initial?.staffId ?? null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [viewDate, setViewDate] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickedSlot | null>(initial?.picked ?? null);
  const [form, setForm] = useState<CustomerFormValues>(() => initial?.form ?? EMPTY_FORM);
  const [touched, setTouched] = useState<Record<keyof CustomerFormValues, boolean>>({
    name: false,
    address: false,
    note: false,
  });
  // ⑥ 的提示:剛接上會員 / 剛建立會員(已登入確認畫面上方)、在 LINE 按了取消(⑤ 上方)。
  const [linkNotice, setLinkNotice] = useState<"existing" | "created" | null>(null);
  const [returnNotice, setReturnNotice] = useState<"cancelled" | "failed" | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // ─── C3:送出預約 ───
  // ⑥-4 的電話與勾選放這裡(C3-D05:時段被約走回 ④ 再回來時要保留)。
  const [guestPhone, setGuestPhone] = useState("");
  const [guestAgree, setGuestAgree] = useState(false);
  // C3-A03 第 1 步:每次進入「確認送出」(⑥)產生一個;網路錯誤重按沿用同一個(不會變兩張單)。
  const [submissionId, setSubmissionId] = useState(newSubmissionId);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitFailureView | null>(null);
  const [slotTakenNotice, setSlotTakenNotice] = useState(false);
  const [completed, setCompleted] = useState<SubmittedBooking | null>(null);
  // 完成頁真的顯示過了沒(react-router 的換頁走 transition,可能比 setCompleted 晚一拍生效;
  // 用這個旗標區分「還沒切到完成頁」與「從完成頁按了上一頁」)。
  const [completeShown, setCompleteShown] = useState(false);
  // C3-B04:⑦-3「用 LINE 登入加入會員」按下去之後(跳 LINE 前)的狀態。
  // C4-B03:登入回來(沒有草稿)一律到會員中心 /me,由會員中心處理 ⑥-2「加入會員」與提示(不再回 ①)。
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const totals = useMemo(
    () => computeSelectionTotals(selection, page.service_items),
    [selection, page.service_items],
  );
  const serviceBlocked = serviceStepBlockedReason(totals);
  const staffOptions = useMemo(
    () => eligibleStaff(page.staff, selection, page.service_items),
    [page.staff, selection, page.service_items],
  );
  // 改了服務之後,原本指定的人如果不會做了 ⇒ 自動回到「不指定」。
  const staffId =
    chosenStaffId && staffOptions.some((s) => s.id === chosenStaffId) ? chosenStaffId : null;
  const items = useMemo(() => selectionToItems(selection), [selection]);
  // C1-A07 邊界:回上一步改了服務或服務人員 ⇒ 已選的時間清空、重新查詢。
  const signature = JSON.stringify([items, staffId]);
  const pickedSlot = picked && picked.signature === signature ? picked : null;
  const errors = validateCustomerForm(form, isOnSite);
  const formValid = Object.keys(errors).length === 0;

  // C2-C05:這間店的客人登入狀態(只有啟用 LINE 登入的店才查;沒登入不打網路)。
  const sessionQuery = useQuery({
    queryKey: SESSION_QUERY_KEY(slug),
    queryFn: () => fetchCustomerSessionState(slug),
    enabled: lineLoginEnabled,
    retry: 1,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const session: CustomerSessionState = sessionQuery.data ?? { state: "anonymous" };

  // ─── 步驟(來自 history state)───
  const historyState = (location.state ?? null) as FlowHistoryState | null;
  const requestedStep: Step =
    historyState?.c1Session === sessionId &&
    typeof historyState.c1Step === "number" &&
    historyState.c1Step >= 0 &&
    historyState.c1Step <= COMPLETE_STEP
      ? (historyState.c1Step as Step)
      : 0;
  // 用「上一頁 / 下一頁」跳回來時,前面的條件可能已經不成立(例:回 ② 把主要服務取消後又按瀏覽器的下一頁)
  // ⇒ 最多只顯示到條件還成立的那一步。
  // C3-D01:沒有 LINE 登入也不允許不登入的店,停在 ⑤(停用按鈕 + 聯絡店家)。
  const maxStep: Step =
    serviceBlocked !== null || page.service_items.length === 0
      ? 1
      : staffOptions.length === 0
        ? 2
        : pickedSlot === null
          ? 3
          : !formValid || (!lineLoginEnabled && !allowGuest)
            ? 4
            : LAST_FORM_STEP;
  let step: Step =
    completed !== null && requestedStep === COMPLETE_STEP
      ? COMPLETE_STEP
      : (Math.min(requestedStep, maxStep) as Step);
  if (step === 6 && !allowGuest) step = 5;
  // 沒有 LINE 登入的店沒有 ⑥-1(C3-D01:直接到 ⑥-4)。
  if (step === 5 && !lineLoginEnabled) step = allowGuest ? 6 : 4;

  // 進入「確認送出」(⑥)時換一個新的 submission_id;換步驟時清掉上一個畫面的失敗說明。
  const prevStepRef = useRef<Step>(step);
  useEffect(() => {
    const prev = prevStepRef.current;
    prevStepRef.current = step;
    if (prev === step) return;
    window.scrollTo(0, 0);
    setSubmitError(null);
    if (step >= 5 && step <= LAST_FORM_STEP && prev <= 4) setSubmissionId(newSubmissionId());
    if (step !== 3) setSlotTakenNotice(false);
  }, [step]);

  function goTo(next: Step, replace = false) {
    navigate(location.pathname, { state: { c1Session: sessionId, c1Step: next }, replace });
  }
  function goBack() {
    // 這一步一定是從上一步 push 進來的(同一個 session),所以直接退回上一筆歷史紀錄。
    if (requestedStep > 0) navigate(-1);
    else goTo(0);
  }

  /** 完成頁之後:選的內容全部清掉(下一張預約從頭開始)。 */
  function resetFlow() {
    setSelection(new Map());
    setServiceTab(null);
    setChosenStaffId(null);
    setWeekOffset(0);
    setViewDate(null);
    setPicked(null);
    setForm(EMPTY_FORM);
    setTouched({ name: false, address: false, note: false });
    setGuestPhone("");
    setGuestAgree(false);
    setLinkNotice(null);
    setSubmitError(null);
    setJoinError(null);
    setCompleted(null);
    setCompleteShown(false);
  }

  // C3-D06:完成頁按系統「上一頁」⇒ 回 ①,不能回到確認畫面再送一次。
  useEffect(() => {
    if (completed === null) return;
    if (requestedStep === COMPLETE_STEP) {
      if (!completeShown) setCompleteShown(true);
      return;
    }
    if (completeShown) {
      resetFlow();
      goTo(0, true);
    }
  }, [completed, requestedStep, completeShown]); // eslint-disable-line react-hooks/exhaustive-deps

  // C2-B04:登入回來 ⇒ 歷史紀錄排成「⑤ → ⑥」(系統上一頁回到 ⑤);在 LINE 按取消 ⇒ 停在 ⑤。
  // C4-B03(取代 C3-D07):沒有草稿而且登入成功 ⇒ 到會員中心首頁(登入回來頁本來就直接送到 /me,
  //   這裡只是保險:萬一標記被留在預約頁,一樣轉過去,不在 ① 停留)。
  const restoreHandled = useRef(false);
  useEffect(() => {
    if (restoreHandled.current) return;
    restoreHandled.current = true;
    const pending = peekPendingDraft(slug);
    if (!pending) return;
    if (!initial) {
      if (pending.outcome === "logged_in" && pending.draft === null && lineLoginEnabled) {
        // 標記留給會員中心拿(它要決定跳「已登入」還是「已加入」的提示)。
        navigate(memberCenterPath(slug), { replace: true });
        return;
      }
      takePendingDraft(slug);
      return;
    }
    takePendingDraft(slug);
    goTo(4, true);
    if (pending.outcome === "logged_in") goTo(5);
    else setReturnNotice(pending.outcome);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // C4-E05(⚠️範圍 第 3 點):已登入的會員,地址欄空白就帶入會員地址(只帶一次;客人改了不回寫會員資料)。
  const addressPrefilled = useRef(false);
  const memberAddress = session.state === "linked" ? session.memberAddress : null;
  useEffect(() => {
    if (addressPrefilled.current || !isOnSite || !memberAddress) return;
    addressPrefilled.current = true;
    setForm((f) => (f.address.trim() === "" ? { ...f, address: memberAddress } : f));
  }, [isOnSite, memberAddress]);

  function buildDraft(): BookingDraft | null {
    if (!pickedSlot) return null;
    return {
      items,
      staff_id: staffId,
      date: pickedSlot.date,
      time: pickedSlot.time,
      name: form.name.trim(),
      address: isOnSite ? form.address.trim() : "",
      note: form.note.trim(),
    };
  }

  async function handleLineLogin() {
    const draft = buildDraft();
    if (!draft || loginBusy) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      const url = await startLineLogin(slug, draft);
      // C2-F04:只跳 LINE 官方授權頁或本站的 callback,其他網址一律不跳。
      if (!isAllowedAuthorizeUrl(url, window.location.origin)) {
        setLoginError(lineStartErrorMessage(null));
        setLoginBusy(false);
        return;
      }
      rememberLoginSlug(slug);
      rememberLoginOrigin(null);
      redirectToAuthorizeUrl(url);
      // 不解除 busy:頁面即將離開,避免客人在跳轉前又按一次。
    } catch (err) {
      setLoginError(lineStartErrorMessage(err instanceof CustomerAuthError ? err.code : null));
      setLoginBusy(false);
    }
  }

  /** C3-B04:⑦-3「用 LINE 登入加入會員」(沒有草稿)。 */
  async function handleJoin() {
    if (joinBusy) return;
    setJoinBusy(true);
    setJoinError(null);
    try {
      const url = await startLineJoin(slug);
      if (!isAllowedAuthorizeUrl(url, window.location.origin)) {
        setJoinError(lineStartErrorMessage(null));
        setJoinBusy(false);
        return;
      }
      rememberLoginSlug(slug);
      rememberLoginOrigin(null);
      redirectToAuthorizeUrl(url);
    } catch (err) {
      setJoinError(lineStartErrorMessage(err instanceof CustomerAuthError ? err.code : null));
      setJoinBusy(false);
    }
  }

  async function handleLogout() {
    await signOutCustomer(slug);
    setLinkNotice(null);
    queryClient.setQueryData(SESSION_QUERY_KEY(slug), { state: "anonymous" });
  }

  /** C3-D05:伺服器說「沒有建立訂單」時,依 state 決定畫面。 */
  async function handleRejected(state: SubmitRejectState) {
    const view = submitFailureView(state, { lineLoginEnabled });
    if (state === "slot_taken") {
      // 回 ④ 重新選時間;服務、服務人員、姓名、地址、備註、電話、勾選都保留。
      setPicked(null);
      setSlotTakenNotice(true);
      await queryClient.invalidateQueries({ queryKey: [PAGE_QUERY_KEY, "slots", slug] });
      goTo(3, true);
      return;
    }
    if (state === "not_linked") {
      // 當作沒登入,回 ⑥-1(草稿還在記憶體)。
      await signOutCustomer(slug);
      queryClient.setQueryData(SESSION_QUERY_KEY(slug), { state: "anonymous" });
      setLoginError(view.message);
      if (step === 6) goTo(5, true);
      return;
    }
    setSubmitError(view);
  }

  /** 送出(會員:guest = null)。 */
  async function runSubmit(guest: GuestSubmitInput | null): Promise<void> {
    const draft = buildDraft();
    if (!draft || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = await submitCustomerBooking({ slug, submissionId, draft, guest });
      if (outcome.kind === "created") {
        // replace:系統上一頁不會回到確認畫面(C3-D06)。
        setCompleted(outcome.booking);
        goTo(COMPLETE_STEP, true);
      } else {
        await handleRejected(outcome.state);
      }
    } catch (err) {
      setSubmitError(
        submitFailureView(err instanceof BookingSubmitError ? err.code : "network", {
          lineLoginEnabled,
        }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleProfileSubmit(input: {
    phone: string;
    agree: boolean;
  }): Promise<ProfileSubmitOutcome> {
    try {
      const result = await completeCustomerProfile({
        slug,
        phone: input.phone,
        name: form.name.trim(),
        agreePolicy: input.agree,
      });
      if (result.kind === "phone_taken") return "phone_taken";
      if (result.kind === "join_pending") {
        // C4-H04:這支電話已經是別人的會員 ⇒ 已送出加入聯絡人申請,重抓登入狀態換到「申請已送出」畫面。
        await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY(slug) });
        return "join_pending";
      }
      setLinkNotice(result.existing ? "existing" : "created");
      // C3-D02:接上會員之後自動送出預約(第二段失敗時客人已經是會員,畫面依 C3-D05)。
      await runSubmit(null);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY(slug) });
      return "linked";
    } catch (err) {
      const hint = err instanceof CompleteProfileError ? err.hint : null;
      if (isSessionInvalidHint(hint)) {
        // 登入狀態不能用了(例:商家剛好換了 LINE 登入設定)⇒ 登出,回到 ⑥-1 重新登入。
        await signOutCustomer(slug);
        queryClient.setQueryData(SESSION_QUERY_KEY(slug), { state: "anonymous" });
        setLoginError(completeProfileErrorMessage(hint));
      }
      return { error: completeProfileErrorMessage(hint) };
    }
  }

  function handleHome() {
    resetFlow();
    goTo(0, true);
  }

  const loginBar =
    session.state === "linked" ? (
      <CustomerLoginBar memberName={session.memberName} onLogout={() => void handleLogout()} />
    ) : null;

  if (completed && (step === COMPLETE_STEP || !completeShown)) {
    return (
      <BookingCompleteScreen
        booking={completed}
        contacts={contacts}
        isOnSite={isOnSite}
        lineLoginEnabled={lineLoginEnabled}
        cancelDeadlineHours={settings.customer_cancel_deadline_hours}
        joinBusy={joinBusy}
        joinError={joinError}
        onJoin={() => void handleJoin()}
        onMemberCenter={() => {
          resetFlow();
          navigate(memberCenterPath(slug));
        }}
        onHome={handleHome}
      />
    );
  }

  if (step === 0 || completed !== null) {
    return (
      <HomeStep
        page={page}
        contacts={contacts}
        loginBar={loginBar}
        memberEntry={
          // C4-B01:只有啟用 LINE 登入的店才有會員中心入口。
          lineLoginEnabled ? (
            <MemberCenterEntry
              linkedName={session.state === "linked" ? session.memberName : null}
              onClick={() => navigate(memberCenterPath(slug))}
            />
          ) : null
        }
        onStart={() => goTo(1)}
      />
    );
  }

  if (step === 1) {
    return (
      <ServiceStep
        page={page}
        contacts={contacts}
        selection={selection}
        onSelectionChange={setSelection}
        activeTab={serviceTab}
        onTabChange={setServiceTab}
        totals={totals}
        blockedReason={serviceBlocked}
        onBack={goBack}
        onNext={() => goTo(2)}
      />
    );
  }

  if (step === 2) {
    return (
      <StaffStep
        staffOptions={staffOptions}
        selectedStaffId={staffId}
        onSelect={setChosenStaffId}
        onBack={goBack}
        onNext={() => goTo(3)}
      />
    );
  }

  if (step === 3) {
    return (
      <TimeStep
        slug={slug}
        items={items}
        staffId={staffId}
        signature={signature}
        isOnSite={isOnSite}
        contacts={contacts}
        notice={slotTakenNotice ? SLOT_TAKEN_MESSAGE : null}
        weekOffset={weekOffset}
        onWeekOffsetChange={(offset) => {
          setWeekOffset(offset);
          setViewDate(null);
        }}
        viewDate={viewDate}
        onViewDateChange={setViewDate}
        picked={pickedSlot}
        onPick={(date, time) => {
          setSlotTakenNotice(false);
          setPicked({ signature, date, time });
        }}
        onBack={goBack}
        onNext={() => goTo(4)}
      />
    );
  }

  const itemNames = [...selection]
    .map(([id, qty]) => {
      const item = page.service_items.find((i) => i.id === id);
      return item ? `${item.name} ×${qty}` : null;
    })
    .filter((s): s is string => s !== null)
    .join("、");
  const staffName = staffId
    ? (page.staff.find((s) => s.id === staffId)?.display_name ?? "不指定（由店家安排）")
    : "不指定（由店家安排）";
  const timeText = pickedSlot ? `${formatDateWithWeekday(pickedSlot.date)}${pickedSlot.time}` : "";
  const summaryAddress = isOnSite ? form.address.trim() : "";
  const fullSummary = (
    <BookingSummary
      timeText={timeText}
      staffName={staffName}
      customerName={form.name.trim()}
      itemNames={itemNames}
      address={summaryAddress}
      totalPrice={totals.totalPrice}
    />
  );

  if (step === 5) {
    if (session.state === "needs_profile") {
      return (
        <CustomerProfileScreen
          merchantName={merchant.name}
          lineDisplayName={session.lineDisplayName}
          linePictureUrl={session.linePictureUrl}
          policy={page.member_policy}
          contacts={contacts}
          allowGuest={allowGuest}
          submitting={submitting}
          submitError={submitError}
          joinRequest={session.joinRequest ?? null}
          onSubmit={handleProfileSubmit}
          onLogout={() => void handleLogout()}
          onGuest={() => goTo(6)}
        />
      );
    }
    if (session.state === "join_pending") {
      return (
        <JoinPendingScreen
          lineDisplayName={session.lineDisplayName}
          linePictureUrl={session.linePictureUrl}
          contacts={contacts}
          allowGuest={allowGuest}
          onUseOtherPhone={async () => {
            await cancelMyJoinRequest(slug);
            await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY(slug) });
          }}
          onGuest={() => goTo(6)}
          onLogout={() => void handleLogout()}
        />
      );
    }
    if (session.state === "linked") {
      return (
        <LinkedConfirmScreen
          merchantName={merchant.name}
          memberName={session.memberName}
          linkNotice={linkNotice}
          summary={fullSummary}
          contacts={contacts}
          submitting={submitting}
          submitError={submitError}
          onSubmit={() => void runSubmit(null)}
          onBack={goBack}
          onLogout={() => void handleLogout()}
        />
      );
    }
    return (
      <LineLoginScreen
        merchantName={merchant.name}
        logoUrl={merchant.logo_url}
        allowGuest={allowGuest}
        onBack={goBack}
        onLogin={() => void handleLineLogin()}
        onGuest={() => goTo(6)}
        busy={loginBusy || sessionQuery.isFetching}
        error={loginError}
      />
    );
  }

  if (step === 6) {
    return (
      <GuestScreen
        merchantName={merchant.name}
        policy={page.member_policy}
        contacts={contacts}
        summary={fullSummary}
        phone={guestPhone}
        onPhoneChange={setGuestPhone}
        agree={guestAgree}
        onAgreeChange={setGuestAgree}
        siteKey={turnstileSiteKey}
        lineLoginEnabled={lineLoginEnabled}
        submitting={submitting}
        submitError={submitError}
        onSubmit={({ phone, turnstileToken }) =>
          void runSubmit({ phone: phone.trim(), agreePolicy: guestAgree, turnstileToken })
        }
        onTurnstileError={() =>
          setSubmitError(submitFailureView("bot_check_error", { lineLoginEnabled }))
        }
        onLineLogin={() => goTo(5, true)}
        onBack={goBack}
      />
    );
  }

  // step === 4(⑤ 填資料)
  // C3-D01:有 LINE 登入 ⇒ ⑥-1(或已登入的確認畫面);沒有 LINE 登入但允許不登入 ⇒ 直接 ⑥-4;
  // 兩個都沒有 ⇒ 停用按鈕 + 常駐原因 + 聯絡按鈕。
  const canProceed = lineLoginEnabled || allowGuest;
  const nextStepHint = formNextStepHint({
    lineLoginEnabled,
    allowGuest,
    linked: session.state === "linked",
  });
  function handleConfirm() {
    setTouched({ name: true, address: true, note: true });
    setReturnNotice(null);
    setLoginError(null);
    if (!formValid || !canProceed) return;
    goTo(lineLoginEnabled ? 5 : 6);
  }

  return (
    <PublicShell
      header={
        <StepHeader
          stepNumber={4}
          title="填寫資料"
          onBack={goBack}
          lastStepName={step5Name(session.state === "linked")}
        />
      }
      footer={
        canProceed ? (
          <Button
            type="button"
            variant="primary"
            size="touch"
            className="w-full"
            onClick={handleConfirm}
            data-testid="public-booking-submit"
          >
            確定預約
          </Button>
        ) : (
          <>
            <AlertNote data-testid="public-booking-not-open">
              這家店目前不開放線上預約，請透過下方方式聯絡店家。
            </AlertNote>
            <Button
              type="button"
              variant="primary"
              size="touch"
              className="w-full"
              disabled
              data-testid="public-booking-submit"
            >
              確定預約
            </Button>
            <ContactButtons links={contacts} />
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {returnNotice === "cancelled" ? (
          <AlertNote data-testid="public-booking-line-cancelled">
            你取消了 LINE 登入。填好的資料都還在，可以再按「確定預約」。
          </AlertNote>
        ) : returnNotice === "failed" ? (
          <AlertNote data-testid="public-booking-line-failed">
            LINE 登入沒有成功，請再試一次。填好的資料都還在，可以再按「確定預約」。
          </AlertNote>
        ) : null}
        <BookingSummary
          timeText={timeText}
          staffName={staffName}
          customerName={null}
          itemNames={itemNames}
          address=""
          totalPrice={totals.totalPrice}
        />

        {/* 2026-10-09 使用者新增:姓名欄上方一行小字,先告訴客人下一步要做什麼(依店家設定與登入狀態)。 */}
        {nextStepHint ? (
          <p
            className="-mb-2 text-[12.5px] leading-relaxed text-muted-foreground"
            data-testid="public-booking-next-step-hint"
          >
            {nextStepHint}
          </p>
        ) : null}

        <FormField
          label="姓名"
          htmlFor="public-booking-name"
          required
          error={touched.name ? (errors.name ?? null) : null}
        >
          <FieldInput
            id="public-booking-name"
            autoComplete="name"
            maxLength={CUSTOMER_NAME_MAX + 20}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            aria-required="true"
          />
        </FormField>

        {isOnSite ? (
          <FormField
            label="服務地址"
            htmlFor="public-booking-address"
            required
            error={touched.address ? (errors.address ?? null) : null}
          >
            <FieldInput
              id="public-booking-address"
              autoComplete="street-address"
              maxLength={CUSTOMER_ADDRESS_MAX + 20}
              value={form.address}
              onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              onBlur={() => setTouched((t) => ({ ...t, address: true }))}
              aria-required="true"
            />
            <p className="text-[12.5px] text-muted-foreground">
              到府服務，請填服務人員要去的地址。
            </p>
          </FormField>
        ) : null}

        <FormField
          label="備註"
          htmlFor="public-booking-note"
          counter={{ value: countChars(form.note), max: CUSTOMER_NOTE_MAX }}
          error={
            touched.note || countChars(form.note) > CUSTOMER_NOTE_MAX ? (errors.note ?? null) : null
          }
        >
          <FieldTextarea
            id="public-booking-note"
            rows={3}
            placeholder="例如：大樓要換證、有沒有停車位"
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            onBlur={() => setTouched((t) => ({ ...t, note: true }))}
          />
        </FormField>
      </div>
    </PublicShell>
  );
}

function BookingSummary({
  timeText,
  staffName,
  customerName,
  itemNames,
  address,
  totalPrice,
}: {
  timeText: string;
  staffName: string;
  customerName: string | null;
  itemNames: string;
  /** C3-D03:確認送出畫面要列地址(到府店);空字串 = 不顯示。 */
  address: string;
  totalPrice: number;
}) {
  return (
    <section
      className="rounded-xl border border-border bg-card p-3.5 shadow-sm"
      data-testid="public-booking-summary"
    >
      <h2 className="mb-2 text-[15px] font-semibold text-foreground">預約內容</h2>
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[13.5px]">
        <dt className="text-muted-foreground">時間</dt>
        <dd className="tabular-nums text-foreground">{timeText}</dd>
        <dt className="text-muted-foreground">服務人員</dt>
        <dd className="break-words text-foreground">{staffName}</dd>
        {customerName ? (
          <>
            <dt className="text-muted-foreground">姓名</dt>
            <dd className="break-words text-foreground">{customerName}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">項目</dt>
        <dd className="break-words text-foreground">{itemNames}</dd>
        {address ? (
          <>
            <dt className="text-muted-foreground">地址</dt>
            <dd className="break-words text-foreground">{address}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">預估金額</dt>
        <dd className="font-semibold tabular-nums text-destructive/80">
          {formatPublicPrice(totalPrice)}
        </dd>
      </dl>
    </section>
  );
}

// =========================================================================
// ① 店家首頁
// =========================================================================

/**
 * C4-B01:① 右上「會員中心」入口。已登入且接上會員 ⇒ 頭像小圓 +「會員中心」;沒登入 ⇒「會員登入」⚠️。
 */
function MemberCenterEntry({
  linkedName,
  onClick,
}: {
  linkedName: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-full px-1.5 text-[13px] font-semibold text-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="public-booking-member-entry"
    >
      {linkedName !== null ? <LineAvatar name={linkedName} pictureUrl={null} size={24} /> : null}
      {linkedName !== null ? "會員中心" : "會員登入"}
    </button>
  );
}

/** ① 的頁首:置中店名 + 右邊會員中心入口(沒有入口就跟其他頁一樣只有標題)。 */
function HomeHeader({ title, right }: { title: string; right: ReactNode }) {
  if (!right) return <TitleOnlyHeader title={title} />;
  return (
    <div className="relative flex h-[54px] items-center justify-end px-2 sm:px-3">
      <h1 className="pointer-events-none absolute inset-x-[104px] truncate text-center text-base font-bold text-foreground">
        {title}
      </h1>
      {right}
    </div>
  );
}

function HomeStep({
  page,
  contacts,
  loginBar,
  memberEntry,
  onStart,
}: {
  page: PublicBookingPageOk;
  contacts: ContactLinks;
  /** C3-D07:已用 LINE 登入並接上會員 ⇒ 顯示登入列(跟確認送出畫面同一個元件)。 */
  loginBar: ReactNode;
  /** C4-B01:頁首右邊的會員中心入口(沒啟用 LINE 登入 = null)。 */
  memberEntry: ReactNode;
  onStart: () => void;
}) {
  const { merchant, booking_settings: settings } = page;
  const address = merchant.address?.trim() ?? "";
  const intro = merchant.intro?.trim() ?? "";
  const announcement = merchant.announcement?.trim() ?? "";
  const hasContacts = Boolean(contacts.lineUrl || contacts.telHref);

  return (
    <PublicShell
      header={<HomeHeader title={merchant.name} right={memberEntry} />}
      className="max-w-none px-0 py-0 sm:px-0"
      footer={
        <Button
          type="button"
          variant="primary"
          size="touch"
          className="w-full"
          onClick={onStart}
          data-testid="public-booking-start"
        >
          開始預約
        </Button>
      }
    >
      <section className="flex flex-col items-center gap-2 bg-brand-soft px-4 pt-[22px] pb-[18px] text-center">
        {/* 首頁的色帶整條寬(電腦上也是),裡面的內容才收在置中的內容欄。 */}
        {merchant.logo_url ? (
          <img
            src={merchant.logo_url}
            alt={`${merchant.name}的標誌`}
            className="h-[72px] w-[72px] rounded-[20px] bg-background object-cover shadow-sm"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-[72px] w-[72px] items-center justify-center rounded-[20px] bg-brand text-[22px] font-extrabold text-brand-foreground shadow-sm"
            data-testid="public-booking-logo-text"
          >
            {merchantLogoText(merchant.name)}
          </div>
        )}
        <p
          className="break-words text-xl font-bold text-foreground"
          data-testid="public-booking-shop-name"
        >
          {merchant.name}
        </p>
        <AttributeTag tone="strong">{settings.is_on_site ? "到府服務" : "到店服務"}</AttributeTag>
      </section>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-3 sm:px-4">
        {loginBar}
        {address || hasContacts ? (
          <div className="rounded-xl border border-border bg-card shadow-sm">
            {address ? (
              <div
                className="flex items-start gap-2.5 px-3.5 py-3 text-sm"
                data-testid="public-booking-address"
              >
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
                <span className="min-w-0 break-words text-foreground">{address}</span>
              </div>
            ) : null}
            {address && hasContacts ? <div className="mx-3.5 h-px bg-border" /> : null}
            {hasContacts ? <ContactButtons links={contacts} className="px-3.5 py-3" /> : null}
          </div>
        ) : null}

        {intro ? (
          <section
            className="rounded-xl border border-border bg-card p-3.5 shadow-sm"
            data-testid="public-booking-intro"
          >
            <h2 className="mb-1 text-sm font-semibold text-foreground">店家簡介</h2>
            <p className="whitespace-pre-line break-words text-[13px] leading-relaxed text-muted-foreground">
              {intro}
            </p>
          </section>
        ) : null}

        {announcement ? (
          <HelpPanel data-testid="public-booking-announcement">
            <div className="flex items-start gap-2">
              <Megaphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <strong>公告</strong>
                <p className="whitespace-pre-line break-words">{announcement}</p>
              </div>
            </div>
          </HelpPanel>
        ) : null}
      </div>
    </PublicShell>
  );
}

// =========================================================================
// ② 選服務
// =========================================================================

function ServiceStep({
  page,
  contacts,
  selection,
  onSelectionChange,
  activeTab,
  onTabChange,
  totals,
  blockedReason,
  onBack,
  onNext,
}: {
  page: PublicBookingPageOk;
  contacts: ContactLinks;
  selection: PublicSelection;
  onSelectionChange: (next: PublicSelection) => void;
  activeTab: string | null;
  onTabChange: (key: string) => void;
  totals: ReturnType<typeof computeSelectionTotals>;
  blockedReason: string | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const tabs = useMemo(
    () => buildPublicServiceTabs(page.service_items, page.categories),
    [page.service_items, page.categories],
  );
  const currentTab = tabs.find((t) => t.key === activeTab) ?? tabs[0] ?? null;

  if (tabs.length === 0) {
    // C1-A05 邊界:這間店沒有任何上架中的服務項目。
    return (
      <PublicShell header={<StepHeader stepNumber={1} title="選擇服務" onBack={onBack} />}>
        <div
          data-testid="public-booking-no-services"
          className="mt-4 flex flex-col items-center gap-4 rounded-xl border border-border bg-card px-5 py-8 text-center shadow-sm"
        >
          <p className="text-[15px] font-semibold text-foreground">
            店家還沒有開放線上預約的服務，請直接聯絡店家。
          </p>
          <ContactButtons links={contacts} className="w-full" />
        </div>
      </PublicShell>
    );
  }

  return (
    <PublicShell
      header={
        <StepHeader stepNumber={1} title="選擇服務" onBack={onBack}>
          <Tabs value={currentTab?.key ?? ""} onValueChange={onTabChange} className="px-2">
            <UnderlineTabsList variant="pages" aria-label="服務分類">
              {tabs.map((tab) => (
                <UnderlineTabsTrigger key={tab.key} value={tab.key}>
                  {tab.label}
                </UnderlineTabsTrigger>
              ))}
            </UnderlineTabsList>
          </Tabs>
        </StepHeader>
      }
      footer={
        <>
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <span data-testid="public-booking-selected-count">
              已選 <b className="tabular-nums">{totals.itemCount}</b> 項
              {totals.itemCount > 0 ? `（共 ${totals.unitCount} 份）` : ""}
            </span>
            <span className="text-muted-foreground">
              預估時長{" "}
              <b className="text-foreground" data-testid="public-booking-total-duration">
                {totals.totalMinutes > 0 ? formatDurationApprox(totals.totalMinutes) : "—"}
              </b>
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] text-muted-foreground">預估金額</span>
            <span
              className="text-lg font-semibold tabular-nums text-destructive/80"
              data-testid="public-booking-total-price"
            >
              {formatPublicPrice(totals.totalPrice)}
            </span>
          </div>
          {blockedReason ? (
            <AlertNote data-testid="public-booking-service-blocked">{blockedReason}</AlertNote>
          ) : null}
          <Button
            type="button"
            variant="primary"
            size="touch"
            className="w-full"
            disabled={blockedReason !== null}
            onClick={onNext}
            data-testid="public-booking-next"
          >
            下一步
          </Button>
        </>
      }
    >
      {currentTab ? (
        <ul className="flex flex-col gap-3" aria-label={`${currentTab.label}的服務項目`}>
          {currentTab.items.map((item) => (
            <ServiceItemCard
              key={item.id}
              item={item}
              quantity={selection.get(item.id) ?? null}
              onToggle={() => onSelectionChange(toggleSelection(selection, item.id))}
              onStep={(delta) => onSelectionChange(stepSelection(selection, item.id, delta))}
            />
          ))}
        </ul>
      ) : null}
    </PublicShell>
  );
}

function ServiceItemCard({
  item,
  quantity,
  onToggle,
  onStep,
}: {
  item: PublicServiceItem;
  quantity: number | null;
  onToggle: () => void;
  onStep: (delta: 1 | -1) => void;
}) {
  const checked = quantity !== null;
  const shown = quantity ?? 1;
  const duration = formatDurationApprox(item.duration_minutes);
  return (
    <li
      data-testid={`public-booking-item-${item.id}`}
      className={cn(
        "rounded-xl border bg-card shadow-sm transition-colors",
        checked ? "border-brand/50" : "border-border",
      )}
    >
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          onClick={onToggle}
          className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden="true"
            className={cn(
              "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2",
              checked ? "border-brand bg-brand text-brand-foreground" : "border-border",
            )}
          >
            {checked ? <Check className="h-4 w-4" strokeWidth={3} /> : null}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="break-words text-[15px] font-semibold text-foreground">
              {item.name}
            </span>
            {item.description?.trim() ? (
              <span className="whitespace-pre-line break-words text-[13px] text-muted-foreground">
                {item.description}
              </span>
            ) : null}
            <span className="text-[13px] tabular-nums text-muted-foreground">
              固定價格{" "}
              <span className="font-semibold text-destructive/80">
                {formatPublicPrice(item.price)}
              </span>
            </span>
            {duration ? <span className="text-[13px] text-brand">{duration}</span> : null}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1 self-center">
          <Button
            type="button"
            variant="neutral"
            size="cardIcon"
            disabled={!checked || shown <= 1}
            aria-label={`減少「${item.name}」的數量`}
            onClick={() => onStep(-1)}
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </Button>
          <span
            className="inline-flex h-9 w-11 items-center justify-center rounded-md border border-input bg-muted/40 text-[15px] tabular-nums"
            aria-label={`「${item.name}」的數量`}
            data-testid={`public-booking-qty-${item.id}`}
          >
            {shown}
          </span>
          <Button
            type="button"
            variant="neutral"
            size="cardIcon"
            disabled={checked && shown >= PUBLIC_ITEM_QUANTITY_MAX}
            aria-label={`增加「${item.name}」的數量`}
            onClick={() => onStep(1)}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </li>
  );
}

// =========================================================================
// ③ 選服務人員
// =========================================================================

function StaffStep({
  staffOptions,
  selectedStaffId,
  onSelect,
  onBack,
  onNext,
}: {
  staffOptions: PublicBookingPageOk["staff"];
  selectedStaffId: string | null;
  onSelect: (id: string | null) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const header = <StepHeader stepNumber={2} title="選擇服務人員" onBack={onBack} />;

  if (staffOptions.length === 0) {
    // C1-A06 邊界:一個符合條件的人都沒有 ⇒ 不顯示「不指定」。
    return (
      <PublicShell
        header={header}
        footer={
          <Button type="button" variant="neutral" size="touch" className="w-full" onClick={onBack}>
            上一步
          </Button>
        }
      >
        <div
          data-testid="public-booking-no-staff"
          className="mt-4 rounded-xl border border-border bg-card px-5 py-8 text-center text-[15px] font-semibold text-foreground shadow-sm"
        >
          目前沒有可以預約這些服務的服務人員，請聯絡店家或改選其他服務。
        </div>
      </PublicShell>
    );
  }

  return (
    <PublicShell
      header={header}
      footer={
        <Button
          type="button"
          variant="primary"
          size="touch"
          className="w-full"
          onClick={onNext}
          data-testid="public-booking-next"
        >
          下一步
        </Button>
      }
    >
      <div role="radiogroup" aria-label="服務人員" className="flex flex-col gap-3">
        <StaffCard
          testId="public-booking-staff-any"
          selected={selectedStaffId === null}
          onSelect={() => onSelect(null)}
          avatar={
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
              <Users className="h-[22px] w-[22px]" aria-hidden="true" />
            </span>
          }
          name="不指定（由店家安排）"
          description="可以選的時間最多，店家會安排有空的服務人員"
        />
        <p className="-mb-1 px-0.5 text-[13px] font-semibold text-muted-foreground">
          或指定一位服務人員
        </p>
        {staffOptions.map((s) => (
          <StaffCard
            key={s.id}
            testId={`public-booking-staff-${s.id}`}
            selected={selectedStaffId === s.id}
            onSelect={() => onSelect(s.id)}
            avatar={
              s.avatar_url ? (
                <img
                  src={s.avatar_url}
                  alt=""
                  className="h-11 w-11 shrink-0 rounded-full bg-muted object-cover"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted text-base font-bold text-foreground"
                >
                  {staffAvatarText(s.display_name)}
                </span>
              )
            }
            name={s.display_name}
            description={s.intro?.trim() ? s.intro : null}
          />
        ))}
      </div>
    </PublicShell>
  );
}

function StaffCard({
  selected,
  onSelect,
  avatar,
  name,
  description,
  testId,
}: {
  selected: boolean;
  onSelect: () => void;
  avatar: ReactNode;
  name: string;
  description: string | null;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-testid={testId}
      className={cn(
        "flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl border bg-card p-3.5 text-left shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-brand/50" : "border-border",
      )}
    >
      {avatar}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="break-words text-[15px] font-semibold text-foreground">{name}</span>
        {description ? (
          <span className="whitespace-pre-line break-words text-[13px] text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "relative h-[22px] w-[22px] shrink-0 rounded-full border-2",
          selected ? "border-brand" : "border-border",
        )}
      >
        {selected ? <span className="absolute inset-1 rounded-full bg-brand" /> : null}
      </span>
    </button>
  );
}

// =========================================================================
// ④ 選日期時間
// =========================================================================

function TimeStep({
  slug,
  items,
  staffId,
  signature,
  isOnSite,
  contacts,
  notice,
  weekOffset,
  onWeekOffsetChange,
  viewDate,
  onViewDateChange,
  picked,
  onPick,
  onBack,
  onNext,
}: {
  slug: string;
  items: ReturnType<typeof selectionToItems>;
  staffId: string | null;
  signature: string;
  isOnSite: boolean;
  contacts: ContactLinks;
  /** C3-D05:剛剛送出時這個時段被約走了 ⇒ 常駐提示,請客人重選。 */
  notice: string | null;
  weekOffset: number;
  onWeekOffsetChange: (offset: number) => void;
  viewDate: string | null;
  onViewDateChange: (date: string) => void;
  picked: PickedSlot | null;
  onPick: (date: string, time: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const today = useMemo(() => taipeiToday(), []);
  const from = addDays(today, weekOffset * SLOT_DAYS_PER_PAGE);

  const slotsQuery = useQuery({
    queryKey: [PAGE_QUERY_KEY, "slots", slug, signature, from],
    queryFn: () =>
      fetchPublicAvailableSlots({ slug, items, staffId, from, days: SLOT_DAYS_PER_PAGE }),
    retry: (count, err) =>
      !(
        err instanceof PublicBookingError &&
        (err.kind === "rejected" || err.kind === "rate_limited")
      ) && count < 1,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const days = slotsQuery.data?.days ?? null;
  const serverDuration = slotsQuery.data?.duration_minutes ?? null;

  // 「下一週」要不要停用(見 isNextWeekDisabled 的說明):記住「同一組選擇」有沒有看過範圍內的日子。
  const [inRangeSeenFor, setInRangeSeenFor] = useState<string | null>(null);
  useEffect(() => {
    if (days && days.some((d) => d.state !== "out_of_range")) setInRangeSeenFor(signature);
  }, [days, signature]);
  const everInRange = inRangeSeenFor === signature;
  const lastDay = days ? (days[days.length - 1] ?? null) : null;
  const nextDisabled = isNextWeekDisabled({
    weekOffset,
    lastDayState: lastDay?.state ?? null,
    everInRange,
  });

  // 目前在看哪一天:自己點過的那天(還在這一頁、而且能約)> 已選時間的那天 > 這一頁第一個能約的日子。
  const openDays = days?.filter((d) => d.state === "open" && d.times.length > 0) ?? [];
  const activeDay: PublicSlotDay | null =
    openDays.find((d) => d.date === viewDate) ??
    openDays.find((d) => d.date === picked?.date) ??
    openDays[0] ??
    null;
  // 已選的時間在最新一次查詢裡已經不能約了(例:剛好被別人約走)⇒ 當作沒選。
  const pickedStillValid =
    picked !== null &&
    (days === null ||
      !days.some((d) => d.date === picked.date) ||
      days.some((d) => d.date === picked.date && d.times.includes(picked.time)));
  const effectivePicked = pickedStillValid ? picked : null;

  const rejected =
    slotsQuery.error instanceof PublicBookingError && slotsQuery.error.kind === "rejected";
  const rateLimited =
    slotsQuery.error instanceof PublicBookingError && slotsQuery.error.kind === "rate_limited";

  return (
    <PublicShell
      header={<StepHeader stepNumber={3} title="選擇時間" onBack={onBack} />}
      footer={
        <>
          {!effectivePicked ? <AlertNote>請先選一個開始時間。</AlertNote> : null}
          <Button
            type="button"
            variant="primary"
            size="touch"
            className="w-full"
            disabled={!effectivePicked}
            onClick={onNext}
            data-testid="public-booking-next"
          >
            下一步
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {notice ? (
          <AlertNote tone="danger" data-testid="public-booking-slot-taken">
            {notice}
          </AlertNote>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <span
            className="text-[15px] font-semibold text-foreground"
            data-testid="public-booking-week-heading"
          >
            {formatWeekHeading(from)}
          </span>
          <span className="flex items-center gap-1">
            <Button
              type="button"
              variant="text"
              size="card"
              className="px-2"
              disabled={weekOffset === 0}
              onClick={() => onWeekOffsetChange(Math.max(0, weekOffset - 1))}
              data-testid="public-booking-prev-week"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              前一週
            </Button>
            <Button
              type="button"
              variant="text"
              size="card"
              className="px-2"
              disabled={nextDisabled || slotsQuery.isPending}
              onClick={() => onWeekOffsetChange(weekOffset + 1)}
              data-testid="public-booking-next-week"
            >
              下一週
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </span>
        </div>

        {slotsQuery.isPending ? (
          <div data-testid="public-booking-slots-loading" className="flex flex-col gap-3">
            <div className="grid grid-cols-7 gap-1.5">
              {Array.from({ length: SLOT_DAYS_PER_PAGE }, (_, i) => (
                <div key={i} className="h-[62px] animate-pulse rounded-xl bg-muted" />
              ))}
            </div>
            <LoadingSkeleton variant="lines" rows={3} />
          </div>
        ) : slotsQuery.isError || !days ? (
          rejected ? (
            <AlertNote tone="danger" data-testid="public-booking-slots-rejected">
              {rejectedSlotsMessage(
                slotsQuery.error instanceof PublicBookingError ? slotsQuery.error.hint : null,
              )}
            </AlertNote>
          ) : (
            <LoadErrorState rateLimited={rateLimited} onRetry={() => void slotsQuery.refetch()} />
          )
        ) : (
          <>
            <div className="grid grid-cols-7 gap-1.5" role="group" aria-label="選擇日期">
              {days.map((d) => {
                const clickable = d.state === "open" && d.times.length > 0;
                const active = activeDay?.date === d.date;
                const label = dayStateLabel(d.state, d.date === today);
                return (
                  <button
                    key={d.date}
                    type="button"
                    disabled={!clickable}
                    aria-pressed={active}
                    aria-label={`${formatDateWithWeekday(d.date)}${label ? `，${label}` : clickable ? "" : "，不開放預約"}`}
                    onClick={() => onViewDateChange(d.date)}
                    data-testid={`public-booking-day-${d.date}`}
                    data-state={d.state}
                    className={cn(
                      "flex min-h-[62px] min-w-0 flex-col items-center justify-center rounded-xl border py-1.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-brand bg-brand text-brand-foreground"
                        : clickable
                          ? "cursor-pointer border-border bg-card text-muted-foreground"
                          : "border-transparent bg-muted text-muted-foreground",
                    )}
                  >
                    <span>{weekdayLabel(d.date)}</span>
                    <b
                      className={cn(
                        "text-[17px] leading-tight tabular-nums",
                        active
                          ? "text-brand-foreground"
                          : clickable
                            ? "font-bold text-foreground"
                            : "font-medium text-muted-foreground",
                      )}
                    >
                      {dayOfMonth(d.date)}
                    </b>
                    <span className="h-4 truncate text-[11px] leading-4">{label}</span>
                  </button>
                );
              })}
            </div>

            {activeDay ? (
              <div
                className="rounded-xl border border-border bg-card p-3.5 shadow-sm"
                data-testid="public-booking-times"
              >
                {groupTimes(activeDay.times).map((group, index) => (
                  <div key={group.label} className={cn(index > 0 && "mt-3.5")}>
                    <p className="mb-2 text-[13px] font-semibold text-foreground">{group.label}</p>
                    <div className="grid grid-cols-4 gap-2">
                      {group.times.map((t) => {
                        const on =
                          effectivePicked?.date === activeDay.date && effectivePicked.time === t;
                        return (
                          <button
                            key={t}
                            type="button"
                            aria-pressed={on}
                            onClick={() => onPick(activeDay.date, t)}
                            data-testid={`public-booking-time-${t}`}
                            className={cn(
                              "h-10 min-w-0 cursor-pointer rounded-md border text-[15px] tabular-nums transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              on
                                ? "border-brand bg-brand font-semibold text-brand-foreground"
                                : "border-input bg-background text-foreground",
                            )}
                          >
                            {t}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                data-testid="public-booking-week-empty"
                className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-4 py-6 text-center shadow-sm"
              >
                <p className="text-sm text-foreground">
                  {nextDisabled
                    ? "目前沒有可以預約的時間，請聯絡店家。"
                    : "這一週沒有可以預約的時間，請按「下一週」看看。"}
                </p>
                {nextDisabled ? <ContactButtons links={contacts} className="w-full" /> : null}
              </div>
            )}

            {effectivePicked && serverDuration !== null ? (
              <HelpPanel data-testid="public-booking-slot-summary">
                <div className="flex items-start gap-2">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    {formatSlotSummary(effectivePicked.date, effectivePicked.time, serverDuration)}
                  </span>
                </div>
              </HelpPanel>
            ) : null}
          </>
        )}

        {isOnSite ? (
          <p
            className="px-0.5 text-[12.5px] leading-relaxed text-muted-foreground"
            data-testid="public-booking-onsite-note"
          >
            預約時間為預計抵達時間，可能因交通稍有誤差，可與店家確認。
          </p>
        ) : null}
      </div>
    </PublicShell>
  );
}
