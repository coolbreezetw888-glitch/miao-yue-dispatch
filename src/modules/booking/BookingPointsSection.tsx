// 紅利系統重構 批次 7(§4.6,#842 / #799):建單 / 編輯預約表單裡的「紅利點數」那一組。
//
// 位置(skill 二之九,v2.3 修正):金額那組之後、備註之前(數字依賴金額)。這支只負責「畫」,
// 所有判斷都在 bookingPointsLogic.ts(有單元測試);表單狀態留在 BookingFormDialog,因為送出時要用。
//
// 顯示條件看的是 preview_booking_points 回傳的 feature_enabled 與 member.resolution(§3.2),
// 🔴 **不用 useMerchantMemberSettings**(判斷 13:只有 orders 鑰匙的客服讀不到設定表,hook 會說「開著」)。
//
// 所有商家 / 會員輸入的文字(會員姓名、服務項目名、公式名、後端錯誤訊息)一律走 React 文字插值,
// 不用 dangerouslySetInnerHTML。

import { useState } from "react";

import {
  AlertNote,
  DetailRow,
  DetailSection,
  FieldInput,
  FormField,
  LoadingSkeleton,
  SwitchRow,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";

import {
  type BookingPointsBlockView,
  type BookingPointsPreview,
  type OriginalBookingPoints,
  type RedeemValidation,
  describeBreakdownItem,
  describeEditPointsChange,
  describeIneligibleReason,
  memberContactPointsNote,
  POINTS_OVERRIDE_MAX,
} from "./bookingPointsLogic";
import { formatAmount } from "./orderAmount";

export interface BookingPointsSectionProps {
  view: BookingPointsBlockView;
  preview: BookingPointsPreview | undefined;
  /** 預覽呼叫本身失敗(網路、權限)時的白話訊息。 */
  fetchErrorMessage: string | null;
  /** 表單上還沒選任何服務項目(預覽一定回「請至少選擇一個服務項目」,改成灰字提示)。 */
  noServiceItems: boolean;
  /** 金額欄位有填錯(這時不會去問預覽)。 */
  amountInvalid: boolean;
  /** 編輯模式才有:開表單時這張單原本的派點 / 折抵。 */
  original: OriginalBookingPoints | null;
  /** 本單有自訂總金額或折扣(以表單當下的值為準,不等預覽回來)。 */
  reviewRequired: boolean;

  overrideEnabled: boolean;
  onOverrideEnabledChange: (enabled: boolean) => void;
  overrideInput: string;
  onOverrideInputChange: (value: string) => void;
  overrideError: string | null;
  /** 「改用建議值」(第 6 題):關掉手動修改、送出時帶 p_points_override_reset。 */
  onUseSuggested: () => void;

  redeemEnabled: boolean;
  onRedeemEnabledChange: (enabled: boolean) => void;
  redeemInput: string;
  onRedeemInputChange: (value: string) => void;
  redeemValidation: RedeemValidation;
  /** 判斷 24:預覽對到的會員變了,折抵剛被重設。 */
  redeemResetNotice: boolean;
  /** v2.4 裁決 22 L1:編輯一張「會員已下架」的舊單(預覽對已下架會員回 none)。 */
  memberRemoved?: boolean;
}

function MutedLine({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] leading-relaxed text-muted-foreground">{children}</p>;
}

export function BookingPointsSection(props: BookingPointsSectionProps) {
  const { view, preview } = props;
  const [showBreakdown, setShowBreakdown] = useState(false);

  // 功能關閉 ⇒ 整塊不渲染(不是灰掉、不是顯示 0)。
  if (view === "hidden") return null;

  const memberTag =
    preview && preview.featureEnabled && preview.error === null
      ? preview.resolution === "new"
        ? "新客戶(送出後自動建立會員)"
        : (preview.resolution === "existing" || preview.resolution === "given") &&
            preview.memberName
          ? `會員：${preview.memberName}`
          : null
      : null;

  const label = (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span>紅利點數</span>
      {memberTag ? (
        <span className="text-[12px] font-normal normal-case tracking-normal text-muted-foreground">
          {memberTag}
        </span>
      ) : null}
    </span>
  );

  // 編輯模式:這張單原本有折抵,但這次畫面沒有提供折抵開關(會員已下架、功能預覽出錯…)⇒
  // 告訴客服「原本的折抵會維持」,不要讓人以為折抵不見了。
  const keptRedeemLine =
    props.original && props.original.redeemed > 0 ? (
      <MutedLine>
        這張單已使用紅利折抵 {props.original.redeemed} 點(−
        {formatAmount(props.original.redeemAmount)}
        )，這次不會變動。
      </MutedLine>
    ) : null;

  if (view === "loading") {
    return (
      <DetailSection label={label} className="gap-3">
        <LoadingSkeleton variant="lines" rows={2} />
      </DetailSection>
    );
  }

  if (view === "error") {
    const message =
      props.fetchErrorMessage ?? (preview && preview.featureEnabled && preview.error) ?? null;
    return (
      <DetailSection label={label} className="gap-3">
        {props.amountInvalid ? (
          <MutedLine>金額欄位修好之後，這裡會顯示這筆訂單的紅利點數。</MutedLine>
        ) : props.noServiceItems ? (
          <MutedLine>選好服務項目後，這裡會顯示這筆訂單的紅利點數。</MutedLine>
        ) : (
          // v2.4 裁決 8 ④:預覽出錯要講出來,不可以默默顯示成 0 點。
          <AlertNote>
            {`目前算不出這筆訂單的紅利點數：${message ?? "原因不明"}。送出時系統會再算一次。`}
          </AlertNote>
        )}
        {keptRedeemLine}
      </DetailSection>
    );
  }

  if (view === "phone_incomplete") {
    return (
      <DetailSection label={label} className="gap-3">
        <MutedLine>填好客戶電話後，這裡會顯示這筆訂單的紅利點數</MutedLine>
      </DetailSection>
    );
  }

  if (view === "member_contact") {
    // C4-K03:這支電話是某位會員的聯絡人電話 ⇒ 不會新建會員(送出會被擋),請客服選那位會員。
    const contactMember =
      preview && preview.featureEnabled && preview.error === null ? preview.memberName : null;
    return (
      <DetailSection label={label} className="gap-3">
        <AlertNote data-testid="booking-points-member-contact">
          {memberContactPointsNote(contactMember)}
        </AlertNote>
        {keptRedeemLine}
      </DetailSection>
    );
  }

  if (view === "no_member") {
    // v2.4 裁決 22 L1:已下架會員的舊單不是「沒有連結會員」—— 派點與折抵都維持原本的(送出時帶 null = 維持)。
    if (props.memberRemoved && props.original) {
      return (
        <DetailSection label={label} className="gap-3">
          <MutedLine>
            {`這位會員已下架，本單維持原本的派點 ${props.original.planned} 點與折抵`}
          </MutedLine>
        </DetailSection>
      );
    }
    return (
      <DetailSection label={label} className="gap-3">
        <MutedLine>這筆訂單沒有連結會員，不會派點</MutedLine>
        {keptRedeemLine}
      </DetailSection>
    );
  }

  // view = member / new_member:這裡 preview 一定是成功的那一型。
  if (!preview || !preview.featureEnabled || preview.error !== null) return null;

  const reason = preview.eligible
    ? null
    : describeIneligibleReason(
        preview.ineligibleReason,
        preview.resolution,
        preview.rewardConditionMode,
      );
  const editChange = props.original
    ? describeEditPointsChange(props.original, preview.autoPoints)
    : null;
  const redeem = preview.redeem;
  // v2.4 裁決 22 L4:可用 0 點時不顯示折抵開關,改一行灰字(跟 CalendarPage 的 pointsRedeemAvailable 同一個條件)。
  const redeemAvailable = view === "member" && redeem.enabled && redeem.availablePoints > 0;
  const redeemNoPoints = view === "member" && redeem.enabled && redeem.availablePoints <= 0;

  return (
    <DetailSection label={label} className="gap-3">
      {/* 1. 本單預定派點(系統建議值) */}
      <div className="flex flex-col gap-1.5 rounded-md border border-border px-3.5 py-3">
        {preview.rulesConfigured || !preview.eligible ? (
          <DetailRow label="系統建議派點" size="lg">
            <span className="tabular-nums">{preview.autoPoints} 點</span>
          </DetailRow>
        ) : (
          // §4.6 第 5 點 / #799:規則沒設好時絕不顯示「0 點」這種會誤導的文字。
          <DetailRow label="系統建議派點" size="sm">
            商家尚未設定派點規則
          </DetailRow>
        )}
        {reason ? <MutedLine>{reason}</MutedLine> : null}
        <p className="text-[12px] text-muted-foreground">訂單完成後才入帳</p>
        {preview.earnMode === "advanced" && preview.breakdown.length > 0 ? (
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              variant="text"
              size="sm"
              className="self-start px-0"
              aria-expanded={showBreakdown}
              onClick={() => setShowBreakdown((v) => !v)}
            >
              {showBreakdown ? "收起逐項明細" : "查看逐項明細"}
            </Button>
            {showBreakdown ? (
              <ul className="flex flex-col gap-0.5 text-[12px] leading-relaxed text-muted-foreground">
                {preview.breakdown.map((item, index) => (
                  <li key={index} className="break-words">
                    {describeBreakdownItem(item)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 3. 有自訂總金額 / 折扣 ⇒ 常駐 `!`(送出時另外跳確認小卡窗) */}
      {props.reviewRequired ? (
        <AlertNote>本單有自訂總金額/折扣，系統建議值僅供參考，請確認派點數</AlertNote>
      ) : null}

      {/* 編輯模式:重算後的提示(§2.4 裁決 11 / 第 6 題) */}
      {editChange ? (
        <div className="flex flex-col gap-2">
          <AlertNote>{editChange.text}</AlertNote>
          {editChange.kind === "override_kept" && props.overrideEnabled ? (
            <Button
              type="button"
              variant="neutral"
              size="card"
              className="self-start"
              onClick={props.onUseSuggested}
            >
              改用建議值
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* 2. 手動修改派點 */}
      <SwitchRow
        id="booking-points-override"
        title="手動修改派點"
        description={`不用系統建議值，直接設定這筆訂單要派幾點(0~${POINTS_OVERRIDE_MAX.toLocaleString()} 點)。`}
        checked={props.overrideEnabled}
        onCheckedChange={props.onOverrideEnabledChange}
      >
        {props.overrideEnabled ? (
          <FormField
            label="本單派點"
            htmlFor="booking-points-override-input"
            required
            error={props.overrideError}
          >
            <FieldInput
              id="booking-points-override-input"
              inputMode="numeric"
              className="tabular-nums"
              value={props.overrideInput}
              onChange={(e) => props.onOverrideInputChange(e.target.value)}
            />
          </FormField>
        ) : null}
      </SwitchRow>

      {/* 4. 使用點數折抵(只在 existing / given 且商家開放折抵時出現;新客戶餘額 0 不顯示) */}
      {redeemAvailable ? (
        <SwitchRow
          id="booking-points-redeem"
          title="使用點數折抵"
          description={`目前可用 ${redeem.availablePoints} 點；本單最多可折 ${redeem.maxPoints} 點(${formatAmount(
            redeem.maxAmount,
          )})`}
          checked={props.redeemEnabled}
          onCheckedChange={props.onRedeemEnabledChange}
        >
          {props.redeemEnabled ? (
            <div className="flex flex-col gap-1.5">
              <FormField
                label="折抵點數"
                htmlFor="booking-points-redeem-input"
                error={props.redeemValidation.error}
                helpLabel="說明：點數折抵怎麼換算"
                help={`目前 ${redeem.pointsUnit ?? "—"} 點 = ${redeem.amountUnit ?? "—"} 元，金額無條件捨去到整數元；本單最多可折應付金額的 ${redeem.maxRatioPercent ?? 0}%。點數在建單當下就會先從會員餘額扣下，訂單取消會退回。`}
              >
                <FieldInput
                  id="booking-points-redeem-input"
                  inputMode="numeric"
                  className="tabular-nums"
                  value={props.redeemInput}
                  onChange={(e) => props.onRedeemInputChange(e.target.value)}
                />
              </FormField>
              {props.redeemValidation.error === null && props.redeemValidation.points > 0 ? (
                <p className="text-[13px] font-semibold tabular-nums text-foreground">
                  折抵 {formatAmount(props.redeemValidation.amount)}
                </p>
              ) : null}
              {props.redeemValidation.hint ? (
                <p className="text-[12px] text-muted-foreground">{props.redeemValidation.hint}</p>
              ) : null}
            </div>
          ) : null}
        </SwitchRow>
      ) : redeemNoPoints ? (
        <MutedLine>這位會員目前沒有可用點數，無法使用點數折抵</MutedLine>
      ) : (
        keptRedeemLine
      )}

      {/* 判斷 24 */}
      {props.redeemResetNotice ? <AlertNote>客戶電話已變更，紅利折抵已重設</AlertNote> : null}
    </DetailSection>
  );
}
