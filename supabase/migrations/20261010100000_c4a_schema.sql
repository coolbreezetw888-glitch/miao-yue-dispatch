-- 客戶端第 4-A 批(模組 13)— migration 1:欄位、check、會員地址
-- 規格書:.project/specs/客戶端第4批-會員中心與自己取消.md(「零之零」優先;本批只做 4-A)
-- 介面文件:.project/notes/c4-contract.md
--
-- =========================================================================
-- 這支 migration 做的事
-- =========================================================================
--   C4-A01-1  merchant_booking_settings.customer_cancel_deadline_hours(0~168,預設 24)
--             + 加進「只有管理員能改」保護 trigger private.protect_merchant_booking_settings_online_columns
--   C4-A01-2  user_notifications.event_type 加 'customer_booking_cancelled'、'member_contact_request'(原 9 個值逐字保留)
--   C4-A01-3  members.address(≤ 200 字)
--   C4-A04    public.update_member 多一個 p_address text default null(null = 不改地址;'' = 清掉)
--             ⚠️ 換簽章要 drop + create ⇒ revoke / grant 整組重寫(權限衛生規則 1)。
--
-- 函式本體內不寫註解(套正式庫後 md5(prosrc) 指紋比對才穩定),說明寫在函式上方。
-- 用語:一律「服務人員」;錯誤訊息全形標點。

-- ═════════════════════════════════════════════════════════════════════════
-- C4-A01-1 客人自己取消的期限(服務開始前 N 小時以前可以取消;0 = 服務開始前都可以)
--   大多數店沒有 merchant_booking_settings 這一列 ⇒ 讀取一律 coalesce(..., 24)(鐵律 8),不補插。
-- ═════════════════════════════════════════════════════════════════════════
alter table public.merchant_booking_settings
  add column customer_cancel_deadline_hours integer not null default 24;
alter table public.merchant_booking_settings
  add constraint merchant_booking_settings_customer_cancel_deadline_hours_check
  check (customer_cancel_deadline_hours between 0 and 168);

-- 既有保護 trigger:只有管理員能改線上預約欄位。這次只多 customer_cancel_deadline_hours 一欄(其他逐字保留)。
create or replace function private.protect_merchant_booking_settings_online_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
       (tg_op = 'INSERT' and (new.min_lead_hours is distinct from 2
                              or new.travel_buffer_minutes is distinct from 0
                              or new.allow_guest_booking is distinct from true
                              or new.completion_message_member is not null
                              or new.completion_message_guest is not null
                              or new.customer_cancel_deadline_hours is distinct from 24))
    or (tg_op = 'UPDATE' and (new.min_lead_hours is distinct from old.min_lead_hours
                              or new.travel_buffer_minutes is distinct from old.travel_buffer_minutes
                              or new.allow_guest_booking is distinct from old.allow_guest_booking
                              or new.completion_message_member is distinct from old.completion_message_member
                              or new.completion_message_guest is distinct from old.completion_message_guest
                              or new.customer_cancel_deadline_hours is distinct from old.customer_cancel_deadline_hours))
     )
     and auth.role() <> 'service_role'
     and not private.is_merchant_admin(new.merchant_id)
  then
    raise exception '只有商家管理員可以修改線上預約設定' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function private.protect_merchant_booking_settings_online_columns() from public, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-A01-2 鈴鐺事件加 'customer_booking_cancelled'(4-A)、'member_contact_request'(4-B 才會寫)
--   原本 9 個值逐字保留(動手前已核對本機與正式庫現值相同)。
-- ═════════════════════════════════════════════════════════════════════════
alter table public.user_notifications
  drop constraint user_notifications_event_type_check;
alter table public.user_notifications
  add constraint user_notifications_event_type_check
  check (event_type = any (array[
    'booking_created'::text, 'booking_cancelled'::text, 'booking_updated'::text, 'booking_reminder_next_day'::text,
    'booking_confirmed'::text, 'booking_completed_cancelled'::text, 'booking_completed_reverted'::text,
    'member_line_login_linked'::text, 'customer_booking_created'::text,
    'customer_booking_cancelled'::text, 'member_contact_request'::text
  ]));

-- ═════════════════════════════════════════════════════════════════════════
-- C4-A01-3 會員地址(⚠️範圍 第 2 點)。只由會員自己(customer_update_profile)或後台(update_member)改。
--   匯入 / 匯出這批不加地址欄。
-- ═════════════════════════════════════════════════════════════════════════
alter table public.members add column address text null;
alter table public.members
  add constraint members_address_length_check check (address is null or char_length(address) <= 200);

-- ═════════════════════════════════════════════════════════════════════════
-- C4-A04 public.update_member 多 p_address(第 8 個參數,default null)
--   null(不帶)= 地址不變 —— 匯入 import_members_batch、復原 rollback_bulk_operation 都用 7 個參數呼叫,
--     若 null 代表「清掉」就會靜默清掉會員地址(權限衛生規則 4 的同一個坑),所以 null 一律不動。
--   '' / 只有空白 = 清掉(存 null);有字 = 去頭尾空白後存入;超過 200 字 ⇒ 22023 invalid_address。
--   其他邏輯(權限、電話格式、同店電話唯一、等級)逐字保留。
-- ═════════════════════════════════════════════════════════════════════════
drop function if exists public.update_member(uuid, text, text, text, date, text, uuid);

CREATE OR REPLACE FUNCTION public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid DEFAULT NULL::uuid, p_address text DEFAULT NULL::text)
 RETURNS members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_result public.members;
  -- SPECS-INDEX #931 新增的兩個區域變數。
  v_normalized_phone text;
  v_conflict_name text;
  v_address text;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception '請填寫會員姓名';
  end if;

  -- #618:電話必填政策已移除。

  -- SPECS-INDEX #827(2026-09-30 使用者裁決 Q5 = (A)):會員電話的格式檢查,規則與擺放順序的理由
  -- 跟 create_member 那一段完全相同(格式檢查一定要排在唯一性檢查前面)。
  -- ⚠️ 既有的髒電話依使用者裁決不主動清;但只要客服進來編輯這位會員,就會被要求先把電話改正確
  --    (跟 update_booking 對舊訂單的既有處理方式一致)。正式庫目前不合格 0 筆,所以實際上沒有人會遇到。
  if p_phone is not null and btrim(p_phone) <> '' and not private.is_valid_taiwan_phone(p_phone) then
    raise exception '會員電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)；不填也可以';
  end if;

  -- SPECS-INDEX #931(2026-09-30):改電話時不可以撞到同商家**另一位** active 會員。
  -- `m.id <> p_member_id` 這個排除條件缺一不可 —— 沒有它的話,客服只是進來改個姓名錯字、
  -- 電話原封不動,也會被自己那一列擋下來。
  v_normalized_phone := private.normalize_phone(p_phone);
  if v_normalized_phone is not null then
    select m.name into v_conflict_name
    from public.members m
    where m.merchant_id = v_merchant_id
      and m.id <> p_member_id
      and m.status = 'active'
      and private.normalize_phone(m.phone) = v_normalized_phone
    limit 1;

    if v_conflict_name is not null then
      raise exception '這支電話已經有會員：%。同一間商家底下，一支電話只能有一位會員 —— 如果是同一位客戶，請直接使用那一筆；如果真的是不同的人，請改填另一支電話', v_conflict_name;
    end if;
  end if;

  -- #615:會員分級,同 create_member 的驗證邏輯。
  if p_tier_id is not null then
    if not exists (
      select 1 from public.merchant_member_tiers
      where id = p_tier_id and merchant_id = v_merchant_id and status = 'active'
    ) then
      raise exception '找不到指定的會員等級，或不屬於這間商家/已下架';
    end if;
  end if;

  if p_address is not null then
    v_address := nullif(btrim(p_address), '');
    if char_length(coalesce(v_address, '')) > 200 then
      raise exception '地址最多 200 字。' using errcode = '22023', hint = 'invalid_address';
    end if;
  end if;

  update public.members set
    name = btrim(p_name),
    phone = nullif(btrim(coalesce(p_phone, '')), ''),
    email = nullif(btrim(coalesce(p_email, '')), ''),
    birthday = p_birthday,
    notes = p_notes,
    tier_id = p_tier_id,
    address = case when p_address is null then address else v_address end
  where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$function$;

comment on function public.update_member(uuid, text, text, text, date, text, uuid, text) is '模組 10 §3.4(SPECS-INDEX #615/#618 疊加):編輯會員基本資料。#618 移除電話必填檢查。#615 新增 p_tier_id(選填,重新指派會員等級,傳 null 代表清空成未分級)。不接受修改 referred_by_member_id(既有規則不變)。權限維持只檢查 can_manage_members。SPECS-INDEX #931(2026-09-30 使用者裁決):改電話時先比對同商家**其他** active 會員(m.id <> p_member_id 這個排除條件缺一不可,否則只改姓名錯字也會被自己那一列擋下),撞到就 raise「這支電話已經有會員:某某某」。已下架的同號紀錄不擋。⚠️ 關於 CSV 匯入(2026-10-01 品管實測後修正的說明):這支函式確實是 import_members_batch 在 upsert_by_phone 模式下的更新路徑,所以 #827 的電話格式檢查在那條路徑上是真的會生效;但 #931 的唯一性檢查在那條路徑上**實務上不會觸發** —— 匯入是先用電話找到那一位既有會員、再拿同一支電話去更新他本人,而唯一性檢查本來就排除自己(m.id <> p_member_id)。至於 insert_only 模式下的重複電話,完全不會走到這支函式(它在呼叫 create_member 之前就被短路成 skipped 了),那條路徑的指名訊息是 20260930040500 補的。【SPECS-INDEX #827,2026-09-30 使用者裁決 Q5 = (A)】同時補上會員電話的格式檢查(排在唯一性檢查前面,理由同 create_member)。既有的髒電話依使用者裁決不主動清,但客服一進來編輯就會被要求先改正確(跟 update_booking 對舊訂單的既有處理方式一致);正式庫目前不合格 0 筆,實際上沒有人會遇到。【客戶端第 4-A 批 C4-A04】新增第 8 個參數 p_address(default null):null(不帶)= 地址不變(匯入 import_members_batch、復原 rollback_bulk_operation 用 7 個參數呼叫,不會清掉地址);空字串 / 只有空白 = 清掉;超過 200 字 ⇒ 22023 invalid_address。';

revoke execute on function public.update_member(uuid, text, text, text, date, text, uuid, text) from public, anon;
grant execute on function public.update_member(uuid, text, text, text, date, text, uuid, text) to authenticated, service_role;
