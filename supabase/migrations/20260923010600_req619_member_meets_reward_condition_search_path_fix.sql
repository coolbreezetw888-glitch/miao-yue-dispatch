-- SPECS-INDEX #634:修補 #619(20260923010400_req619_reward_condition_mode_functions.sql)新增的
-- private.member_meets_reward_condition 漏寫 `set search_path = public`(Supabase security advisor
-- 掃出 function_search_path_mutable,WARN 等級)——本專案函式一律要設定 search_path,同一支 migration
-- 裡另外兩支函式(compute_member_loyalty_points/grant_pending_birthday_bonuses)都有補,只有這支共用判斷
-- 函式漏加。比照既有先例(20260917110200_booking_form_detail_fixes_search_path_fix.sql)獨立處理。
--
-- ⚠️ 動工前已查證:用 pg_get_functiondef 確認正式環境(wjtbmmnakcriuaqoknsq)目前這支函式的版本跟
-- 本機 migration 逐字一致,沒有漂移。
--
-- 內容邏輯完全不變,只補上 set search_path = public,簽章不變,直接 create or replace 即可。
create or replace function private.member_meets_reward_condition(
  p_mode text,
  p_phone_verified boolean,
  p_line_bound boolean
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case p_mode
    when 'none' then true
    when 'phone_verified' then coalesce(p_phone_verified, false)
    when 'line_bound' then coalesce(p_line_bound, false)
    when 'either' then coalesce(p_phone_verified, false) or coalesce(p_line_bound, false)
    when 'both' then coalesce(p_phone_verified, false) and coalesce(p_line_bound, false)
    else true
  end;
$$;

comment on function private.member_meets_reward_condition(text, boolean, boolean) is '模組 10 §10.7(SPECS-INDEX #619):依 merchant_member_settings.reward_condition_mode 判斷某位會員是否符合核發資格。none=不設條件;phone_verified=只看電話已驗證;line_bound=只看 LINE 已綁定;either=任一即可;both=兩者皆要。只給 compute_member_loyalty_points/grant_pending_birthday_bonuses 內部呼叫,不對外暴露。';

revoke execute on function private.member_meets_reward_condition(text, boolean, boolean) from public, anon;
grant execute on function private.member_meets_reward_condition(text, boolean, boolean) to authenticated;
