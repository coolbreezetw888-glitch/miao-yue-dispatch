-- 客戶端第 1 批(模組 13 客戶端)— migration 1:線上預約設定新欄位 + 收回兩支內部函式的公開執行權限
-- 規格書:.project/specs/客戶端第1批-公開預約頁.md(C1-C03、C1-F03)
--
-- =========================================================================
-- 1. C1-C03 新欄位
-- =========================================================================
--   merchant_booking_settings.min_lead_hours        smallint not null default 2,  0~72   (#978 / C1-B04)
--   merchant_booking_settings.travel_buffer_minutes smallint not null default 0,  0~240  (#1039 / C1-B08)
--   merchant_booking_settings.allow_guest_booking   boolean  not null default true       (第 3 批才生效)
--   merchants.line_friend_url                       text null,`https://` 開頭、≤ 300 字   (C1-A04 / C1-D02)
--   ・沒有 merchant_booking_settings 那一列的商家:所有讀取一律 coalesce 成預設值(2 / 0 / true),
--     這支 migration **不補插任何資料列**(本檔沒有任何資料寫入)。
--
-- =========================================================================
-- 2. 寫入權限(supabase-permission-hygiene 規則 2「UPDATE policy 欄位陷阱」)
-- =========================================================================
--   ・merchants:UPDATE 政策 = 商家管理員 / 超級管理員 ⇒ 新欄位 line_friend_url 同樣只有管理員能寫,
--     不需要另外處理(客服根本沒有 merchants 的 UPDATE 政策)。
--   ・merchant_booking_settings:既有 INSERT / UPDATE 政策 = can_manage_business_hours(管理員 **或**
--     有「營業時間」權限的客服)。規格 C1-D01 要求新三欄「只有管理員能改」⇒ **不改政策的對象範圍**
--     (客服仍可照舊寫 start_time_interval_minutes),另加一支 BEFORE INSERT / UPDATE 欄位保護 trigger:
--       - INSERT:新三欄不是預設值、而且寫的人不是這間店的管理員 ⇒ 42501
--       - UPDATE:新三欄任一欄有變動、而且寫的人不是這間店的管理員 ⇒ 42501
--     繞道比照 private.protect_merchants_group_id_column 的既有慣例:service_role、migration
--     (auth.role() 為 null)不擋。
--   ・錯誤訊息固定一句,不帶任何資料(ui-overlay-patterns:BEFORE trigger 在 RLS 之前執行,錯誤訊息
--     不能透露資料)。這支 trigger 只回答「你不是這間店的管理員」,不透露那一列現在的值。
--
-- =========================================================================
-- 3. C1-F03 收回 apply_industry_preset / generate_booking_slug 的 PUBLIC 執行權限
-- =========================================================================
--   20260915100300 只 revoke from anon, authenticated,漏了 PUBLIC(ACL 仍有 `=X/postgres`)。
--   兩支函式本體一個字都不改;唯二呼叫者 create_group_and_merchant / create_merchant_in_group 都是
--   SECURITY DEFINER(以擁有者 postgres 身分執行)⇒ 不受影響。
--
-- 用語:一律「服務人員」。

-- ─── 1. 新欄位 ─────────────────────────────────────────────────────────────
alter table public.merchant_booking_settings
  add column min_lead_hours smallint not null default 2;
alter table public.merchant_booking_settings
  add constraint merchant_booking_settings_min_lead_hours_check
  check (min_lead_hours between 0 and 72);

alter table public.merchant_booking_settings
  add column travel_buffer_minutes smallint not null default 0;
alter table public.merchant_booking_settings
  add constraint merchant_booking_settings_travel_buffer_minutes_check
  check (travel_buffer_minutes between 0 and 240);

alter table public.merchant_booking_settings
  add column allow_guest_booking boolean not null default true;

alter table public.merchants
  add column line_friend_url text null;
alter table public.merchants
  add constraint merchants_line_friend_url_format
  check (line_friend_url is null or (line_friend_url like 'https://%' and char_length(line_friend_url) <= 300));

comment on column public.merchant_booking_settings.min_lead_hours is
  '客戶端第 1 批 C1-B04:客人線上預約最少要提前幾小時(0~72,0 = 不限制)。查無資料列 = 2。只影響客戶端,後台建單不受影響。只有商家管理員能改(trigger private.protect_merchant_booking_settings_online_columns)。';
comment on column public.merchant_booking_settings.travel_buffer_minutes is
  '客戶端第 1 批 C1-B08(#1039):車程緩衝分鐘數(0~240)。只在到府產業(on_site_dispatch)生效,到店當 0。查無資料列 = 0。只影響客戶端可約時段,後台不擋也不提醒。只有商家管理員能改。';
comment on column public.merchant_booking_settings.allow_guest_booking is
  '客戶端第 1 批 C1-D01:允許不登入預約。查無資料列 = true。第 3 批送出預約時生效。只有商家管理員能改。';
comment on column public.merchants.line_friend_url is
  '客戶端第 1 批 C1-A04 / C1-D02:LINE 官方帳號加入好友網址,預約頁「LINE 聯絡店家」按鈕用。資料庫只擋明顯錯誤格式(https:// 開頭、≤ 300 字),網域限制在前端。';

-- ─── 2. 新欄位的寫入保護(只有管理員能改) ─────────────────────────────────────
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
                              or new.allow_guest_booking is distinct from true))
    or (tg_op = 'UPDATE' and (new.min_lead_hours is distinct from old.min_lead_hours
                              or new.travel_buffer_minutes is distinct from old.travel_buffer_minutes
                              or new.allow_guest_booking is distinct from old.allow_guest_booking))
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

create trigger merchant_booking_settings_protect_online_columns
  before insert or update on public.merchant_booking_settings
  for each row execute function private.protect_merchant_booking_settings_online_columns();

-- ─── 3. C1-F03 ─────────────────────────────────────────────────────────────
revoke execute on function public.apply_industry_preset(uuid) from public, anon, authenticated;
revoke execute on function public.generate_booking_slug(text) from public, anon, authenticated;
grant  execute on function public.apply_industry_preset(uuid) to service_role;
grant  execute on function public.generate_booking_slug(text) to service_role;
