-- 修正 20260919130100_payment_methods_v2_functions.sql 的一個實作疏失:
-- 該檔案重建 public.create_merchant_in_group 時,不小心從「20260915100100(最初版本)」的舊檔案
-- 抄了函式主體,漏看了後來 20260915110000_merchant_private_schema_hardening.sql 已經把內部的權限
-- 檢查從 public.is_group_member 改成 private.is_group_member(且 public.is_group_member 早就被
-- drop 掉了)。這支修正只補回這一行差異(呼叫 seed_default_payment_methods 的部分維持不動),
-- 其餘完全比照 hardening migration 之後的正確版本。
create or replace function public.create_merchant_in_group(
  p_group_id uuid,
  p_name text,
  p_industry_type text,
  p_address text default null,
  p_contact_email text default null,
  p_intro text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_merchant_id uuid;
  v_slug text;
begin
  if v_uid is null then
    raise exception '需要登入才能建立商家' using errcode = '28000';
  end if;

  if not private.is_group_member(p_group_id) then
    raise exception '沒有權限在此集團下新增分店' using errcode = '42501';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception '店名不可為空';
  end if;

  if p_industry_type not in ('on_site_dispatch', 'in_store_beauty') then
    raise exception '不支援的產業類型: %', p_industry_type;
  end if;

  v_slug := public.generate_booking_slug(p_name);

  insert into public.merchants (
    group_id, name, industry_type, address, contact_email, intro, booking_slug
  ) values (
    p_group_id, p_name, p_industry_type, p_address, p_contact_email, p_intro, v_slug
  )
  returning id into v_merchant_id;

  insert into public.merchant_admins (merchant_id, user_id)
  values (v_merchant_id, v_uid);

  perform public.apply_industry_preset(v_merchant_id);
  perform public.seed_default_payment_methods(v_merchant_id);

  return v_merchant_id;
end;
$$;

comment on function public.create_merchant_in_group(uuid, text, text, text, text, text) is '新增分店流程(4.4)呼叫的 RPC:檢查規則 2.5 權限後,原子性建立新分店+登記建立者為管理員+套用產業預設功能+種入模組 9 v2 預設付款方式,見規格書 3.3、支付方式.md §2。修正紀錄(2026-09-19):20260919130100 這支 migration 重建此函式時誤用了 hardening 之前的舊版本body(呼叫已經被 drop 掉的 public.is_group_member),本支修正改回呼叫 private.is_group_member。';
