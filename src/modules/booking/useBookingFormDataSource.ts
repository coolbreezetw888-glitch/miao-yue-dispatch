// SPECS-INDEX #977 第 7 批(2026-10-07):建單 / 編輯表單(CalendarPage.tsx 的 BookingFormDialog)的「資料來源」層。
//
// 同一張表單有兩種使用者:
//   ・商家模式(預設):管理員 / 客服。**原封不動**呼叫原本那幾支 hook(服務人員清單、服務項目、分類、料錢、
//     料錢開關、營業時間、付款方式、稅金、getBooking),參數、query key 都跟改版前一樣 ⇒ 行為零改變。
//   ・服務人員模式:可以自己下單的服務人員。他讀不到商家的服務項目 / 付款方式 / 稅金 / 營業時間表
//     (RLS 只開給管理員 / 客服),所以改讀兩支 SECURITY DEFINER 的唯讀 RPC:
//       staff_get_booking_form_options(選項)、staff_get_booking_for_edit(編輯時的這張單)。
//     **不放寬任何 RLS**。商家模式那幾支 hook 在服務人員模式下傳 null 進去 ⇒ 查詢停用、不會發出請求。
//     #986 第 9 批:料錢(總開關 + 上架品項)也改由 staff_get_booking_form_options 回,編輯時的現有料錢由
//     staff_get_booking_for_edit 回(使用者裁決推翻第 7 批主腦決定 C「服務人員模式不顯示料錢」)。
// 表單本體只讀這裡回傳的資料,不用知道現在是哪一種模式(要藏哪些欄位另外看 actor.kind)。

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { getFeatureFlag } from "@/modules/merchant/api";
import { useMerchantStaffList } from "@/modules/staff-agent/context";
import {
  useMerchantServiceCategories,
  useMerchantServiceItems,
} from "@/modules/service-items/context";
import {
  fetchStaffBookingForEdit,
  fetchStaffBookingFormOptions,
  type StaffBookingForEdit,
  type StaffBookingFormOptions,
} from "@/modules/staff-portal/api";

import { getBooking, MATERIAL_COST_ENABLED_FEATURE_KEY } from "./api";
import {
  useMerchantBusinessHours,
  useMerchantMaterialCostItems,
  useMerchantPaymentMethods,
  useMerchantTaxSettings,
} from "./context";
import {
  DEFAULT_MERCHANT_TAX_SETTINGS,
  type AmountAdjustmentMode,
  type BookingDetail,
  type BookingStatus,
} from "./types";

/** 這張表單是誰在用。服務人員模式的 staffId 一定是登入者自己那一列(後端也會再驗一次)。 */
export type BookingFormActor =
  { kind: "merchant" } | { kind: "staff"; staffId: string; staffName: string };

export const MERCHANT_BOOKING_FORM_ACTOR: BookingFormActor = { kind: "merchant" };

export interface BookingFormStaffOption {
  id: string;
  name: string;
}

export interface BookingFormServiceItem {
  id: string;
  name: string;
  price: number;
  duration_minutes: number;
  category_id: string | null;
  /** #986 第 9 批:服務項目描述(只在「選擇項目」整頁顯示)。沒填 = null。 */
  description?: string | null;
}

export interface BookingFormDataSource {
  staffList: BookingFormStaffOption[] | undefined;
  serviceItems: BookingFormServiceItem[] | undefined;
  serviceCategories: { id: string; name: string }[] | undefined;
  materialCostItems: { id: string; name: string; amount: number }[] | undefined;
  materialCostEnabled: boolean | undefined;
  businessHours: { day_of_week: number; is_closed: boolean }[] | undefined;
  paymentMethods: { id: string; name: string }[] | undefined;
  merchantTaxSettings: { taxMode: AmountAdjustmentMode; taxValue: number } | undefined;
  editingDetail: BookingDetail | undefined;
  /** 服務人員模式、而且這張單的內部備註被設成「不讓服務人員看到」⇒ 表單不顯示內部備註欄(後端也會保留原值)。 */
  editingNotesHidden: boolean;
}

/** 建單功能擴充規格書 2.3:料錢成本功能開關(查無資料視為關閉)。服務人員模式不查(merchantId 傳 null)。 */
function useMaterialCostEnabled(merchantId: string | null) {
  return useQuery({
    queryKey: ["booking-module", "material-cost-enabled", merchantId],
    queryFn: async () => {
      const value = await getFeatureFlag(merchantId as string, MATERIAL_COST_ENABLED_FEATURE_KEY);
      return value ?? false;
    },
    enabled: Boolean(merchantId),
  });
}

/**
 * 把 staff_get_booking_for_edit 的回傳轉成表單原本讀的 BookingDetail 形狀(只填表單真的會讀的欄位)。
 * 協助人員只有姓名(後端不回 id),這裡給一個不會跟真的 staff id 撞到的佔位 id,只拿來唯讀顯示;
 * 服務人員模式送出時根本不帶協助人員(後端保留原值)。
 */
export function staffEditToBookingDetail(row: StaffBookingForEdit): BookingDetail {
  return {
    id: row.id,
    merchant_id: row.merchant_id,
    staff_id: row.staff_id,
    status: row.status as BookingStatus,
    start_at: row.start_at,
    end_at: row.end_at,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    customer_email: row.customer_email,
    customer_address: row.customer_address,
    customer_notes: row.customer_notes,
    notes: row.notes,
    // 服務人員模式不顯示也不送出這個旗標(後端保留現值),這裡照實帶,表單不會用它來決定要不要藏。
    hide_notes_from_staff: row.notes_hidden,
    custom_total_amount_enabled: row.custom_total_amount_enabled,
    custom_total_amount: row.custom_total_amount,
    discount_enabled: row.discount_enabled,
    discount_mode: row.discount_mode,
    discount_value: row.discount_value,
    tax_enabled: row.tax_enabled,
    tax_mode_snapshot: row.tax_mode_snapshot,
    tax_value_snapshot: row.tax_value_snapshot,
    payment_method_id: row.payment_method_id,
    payment_method_name_snapshot: row.payment_method_name_snapshot,
    custom_duration_enabled: row.custom_duration_enabled,
    custom_duration_minutes: row.custom_duration_minutes,
    member_id: row.member_id,
    member_name_snapshot: row.member_name_snapshot,
    points_planned: row.points_planned,
    points_planned_auto: row.points_planned_auto,
    points_planned_overridden: row.points_planned_overridden,
    points_redeemed: row.points_redeemed,
    points_redeem_amount_snapshot: row.points_redeem_amount_snapshot,
    serviceItems: row.service_items.map((i) => ({
      id: i.service_item_id,
      name: i.name,
      quantity: i.quantity,
      unitPriceSnapshot: i.unit_price_snapshot,
      lineTotal: i.quantity * i.unit_price_snapshot,
    })),
    assistants: row.assistant_names.map((name, index) => ({
      staffId: `assigned-by-merchant-${index}`,
      staffName: name,
    })),
    // #986 第 9 批:編輯時預帶這張單目前的料錢(已下架品項也帶,跟商家模式一樣原樣送回、後端不擋)。
    materialCosts: (row.material_costs ?? []).map((c) => ({
      materialCostItemId: c.material_cost_item_id,
      name: c.name,
      // 第 11 批 F #993:數量(舊版後端沒有這個鍵 ⇒ 1)。
      quantity: Number(c.quantity ?? 1),
      amountSnapshot: Number(c.amount_snapshot),
    })),
    createdByName: "",
    lastModifiedByName: null,
  } as unknown as BookingDetail;
}

export function useBookingFormDataSource(params: {
  actor: BookingFormActor;
  merchantId: string;
  open: boolean;
  editingBookingId: string | null;
}): BookingFormDataSource {
  const { actor, open, editingBookingId } = params;
  const isStaff = actor.kind === "staff";
  const staffId = actor.kind === "staff" ? actor.staffId : null;
  // 商家模式:跟改版前完全一樣的 merchantId;服務人員模式:null ⇒ 這幾支查詢停用。
  const merchantId = isStaff ? null : params.merchantId;

  const { data: staffList } = useMerchantStaffList(merchantId);
  const { data: serviceItems } = useMerchantServiceItems(merchantId);
  const { data: serviceCategories } = useMerchantServiceCategories(merchantId);
  const { data: materialCostItems } = useMerchantMaterialCostItems(merchantId);
  const { data: materialCostEnabled } = useMaterialCostEnabled(merchantId);
  const { data: businessHours } = useMerchantBusinessHours(merchantId);
  const { data: paymentMethods } = useMerchantPaymentMethods(merchantId);
  const { data: merchantTaxSettings } = useMerchantTaxSettings(merchantId);
  const { data: merchantEditingDetail } = useQuery({
    queryKey: ["booking-module", "edit-detail", editingBookingId],
    queryFn: () => getBooking(editingBookingId as string),
    enabled: !isStaff && open && Boolean(editingBookingId),
  });

  const { data: staffOptions } = useQuery<StaffBookingFormOptions>({
    queryKey: ["staff-portal-module", "booking-form-options", staffId],
    queryFn: () => fetchStaffBookingFormOptions(staffId as string),
    enabled: isStaff && open && Boolean(staffId),
  });
  const { data: staffEditing } = useQuery<StaffBookingForEdit>({
    queryKey: ["staff-portal-module", "booking-for-edit", editingBookingId],
    queryFn: () => fetchStaffBookingForEdit(editingBookingId as string),
    enabled: isStaff && open && Boolean(editingBookingId),
    // 每次打開編輯都要拿最新的(避免帶著別人剛改過的舊值送出)。
    staleTime: 0,
    gcTime: 0,
  });

  // 🔴 服務人員模式轉出來的物件一定要 useMemo:表單的「開啟時帶入」effect 依賴 editingDetail /
  //    merchantTaxSettings 的參考,每次 render 都給新物件會讓 effect 一直重跑、狀態一直被重設(無限迴圈)。
  const staffActorId = actor.kind === "staff" ? actor.staffId : null;
  const staffActorName = actor.kind === "staff" ? actor.staffName : null;
  const staffSide = useMemo(() => {
    if (!staffActorId) return null;
    return {
      staffList: [{ id: staffActorId, name: staffOptions?.staff_name ?? staffActorName ?? "" }],
      serviceItems: staffOptions?.service_items.map((i) => ({ ...i, price: Number(i.price) })),
      materialCostItems: staffOptions
        ? (staffOptions.material_cost_items ?? []).map((m) => ({ ...m, amount: Number(m.amount) }))
        : undefined,
      merchantTaxSettings: staffOptions
        ? staffOptions.tax_settings
          ? {
              taxMode: staffOptions.tax_settings.tax_mode as AmountAdjustmentMode,
              taxValue: Number(staffOptions.tax_settings.tax_value),
            }
          : { ...DEFAULT_MERCHANT_TAX_SETTINGS }
        : undefined,
    };
  }, [staffActorId, staffActorName, staffOptions]);
  const staffEditingDetail = useMemo(
    () => (staffEditing ? staffEditToBookingDetail(staffEditing) : undefined),
    [staffEditing],
  );

  if (actor.kind === "merchant" || !staffSide) {
    return {
      staffList: staffList as BookingFormStaffOption[] | undefined,
      serviceItems: serviceItems as BookingFormServiceItem[] | undefined,
      serviceCategories,
      materialCostItems: materialCostItems as
        { id: string; name: string; amount: number }[] | undefined,
      materialCostEnabled,
      businessHours,
      paymentMethods,
      merchantTaxSettings,
      editingDetail: merchantEditingDetail ?? undefined,
      editingNotesHidden: false,
    };
  }

  return {
    // 主要服務人員固定是自己(裁決 3):清單只有自己一個人。
    staffList: staffSide.staffList,
    serviceItems: staffSide.serviceItems,
    serviceCategories: staffOptions?.service_categories,
    // #986 第 9 批(使用者裁決推翻主腦決定 C):服務人員跟客服一樣看得到、改得了料錢。
    // 總開關、上架品項都由 staff_get_booking_form_options 回;還沒讀到 ⇒ undefined(跟商家模式一樣)。
    materialCostItems: staffSide.materialCostItems,
    materialCostEnabled: staffOptions ? staffOptions.material_cost_enabled === true : undefined,
    businessHours: staffOptions?.business_hours,
    paymentMethods: staffOptions?.payment_methods,
    merchantTaxSettings: staffSide.merchantTaxSettings,
    editingDetail: staffEditingDetail,
    editingNotesHidden: staffEditing?.notes_hidden === true,
  };
}
