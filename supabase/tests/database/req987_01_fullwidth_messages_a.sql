-- SPECS-INDEX #987 第 10 批 子批 10-a:權限 / 平台 / 商家 / LINE 綁定類錯誤訊息全形化 —— 逐字保留證明
-- migration 20261007130000_req987_a_fullwidth_messages_permission_platform.sql
-- 規格書 .project/specs/資料庫錯誤訊息全形標點-第10批.md 第一節 1-3、第五節 5-1。
--
--   每支重建的函式三條斷言:
--   ① 指紋:目前 prosrc(CRLF→LF)把「新訊息」逐一換回「舊訊息」後,md5 必須等於改前指紋。
--      對照表以外的任何差異(多一個空白、改一個運算子)都會讓指紋對不上 ⇒ 變紅。
--   ② 屬性:security definer / volatility / search_path(proconfig)/ ACL / comment 跟改前逐字相同。
--   ③ 觸發器:綁這支函式的觸發器清單(表.名稱:啟用狀態)跟改前相同(不是觸發器函式就是空陣列)。
--   對照表的每一組都是「含單引號的完整 SQL 字串字面值」,避免換到函式裡其他地方的同樣文字。
begin;

select plan(84);

create function pg_temp.req987_oid(p_sig text) returns oid language sql stable as $$
  select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = p_sig
$$;

-- p_pairs = array[新1, 舊1, 新2, 舊2, ...]
create function pg_temp.req987_swap_back(p_sig text, p_pairs text[]) returns text language plpgsql stable as $$
declare
  v_src text;
begin
  select replace(prosrc, E'\r\n', E'\n') into v_src from pg_proc where oid = pg_temp.req987_oid(p_sig);
  -- 客戶端第 4-B 批 C4-H11:unbind_line_account 的 member 分支多一段「清掉全部聯絡人」(有 [c4b] 標記),先拿掉再比對改前指紋。
  v_src := regexp_replace(v_src, E'    -- \\[c4b\\] C4-H11.*?and status = ''active'';\\n', '', 'g');
  -- 客戶端第 5-B 批 C5-P02:claim_birthday_line_pending 多一段「主要聯絡人關掉優惠通知 ⇒ 略過」(有 [c5b] 標記),先拿掉再比對改前指紋。
  v_src := regexp_replace(v_src, E'    -- \\[c5b\\] C5-P02.*?continue;\\n    end if;\\n\\n', '', 'g');
  -- SPECS-INDEX #1025 FG-2:resolve_line_notification_targets 多一段「平台沒開 LINE 通知 ⇒ 回空清單」([req1025 FG2] 標記),先拿掉再比對改前指紋。
  v_src := regexp_replace(v_src, E'  -- \\[req1025 FG2 begin\\].*?-- \\[req1025 FG2 end\\]\\n\\n', '', 'g');
  -- SPECS-INDEX #1053:claim_birthday_line_pending 的 token 改從 Vault 取([req1053] 標記),先換回原寫法再比對改前指紋。
  if p_sig = 'public.claim_birthday_line_pending(p_limit integer)' then
    v_src := replace(v_src, E'  v_r record;\n  v_token text;\n', E'  v_r record;\n');
    v_src := replace(v_src, E'      c.is_connected,\n', E'      c.is_connected,\n      c.channel_access_token,\n');
    v_src := regexp_replace(v_src, E'    -- \\[req1053\\][^\\n]*\\n    v_token := case when coalesce\\(v_r\\.is_connected, false\\)\\n                    then private\\.line_messaging_access_token\\(v_r\\.merchant_id\\) end;\\n', '', 'g');
    v_src := replace(v_src, 'coalesce(btrim(v_token), '''')', 'coalesce(btrim(v_r.channel_access_token), '''')');
    v_src := replace(v_src, '''channel_access_token'', v_token,', '''channel_access_token'', v_r.channel_access_token,');
  end if;
  for i in 1 .. coalesce(array_length(p_pairs, 1), 0) / 2 loop
    v_src := replace(v_src, p_pairs[2 * i - 1], p_pairs[2 * i]);
  end loop;
  return v_src;
end $$;

create function pg_temp.req987_attrs(p_sig text) returns text[] language sql stable as $$
  select array[p.prosecdef::text, p.provolatile::text, coalesce(p.proconfig::text, 'NULL'),
               coalesce(p.proacl::text, 'NULL'), coalesce(obj_description(p.oid, 'pg_proc'), 'NULL')]
  from pg_proc p where p.oid = pg_temp.req987_oid(p_sig)
$$;

create function pg_temp.req987_triggers(p_sig text) returns text[] language sql stable as $$
  select coalesce(array_agg(t.tgrelid::regclass::text || '.' || t.tgname::text || ':' || t.tgenabled::text
                            order by t.tgrelid::regclass::text, t.tgname), array[]::text[])
  from pg_trigger t where t.tgfoid = pg_temp.req987_oid(p_sig) and not t.tgisinternal
$$;

-- ----- private.issue_line_binding_code(p_merchant_id uuid, p_target_type text, p_target_id uuid, p_created_by_user_id uuid) -----
-- #1051(全面體檢加固)改過本支函式 ⇒ 指紋/ACL 更新為加固後的值(加固內容見 migration 20261010230000~230300)。
select is(
  md5(pg_temp.req987_swap_back($m$private.issue_line_binding_code(p_merchant_id uuid, p_target_type text, p_target_id uuid, p_created_by_user_id uuid)$m$, array[
    $m$'暫時無法產生新的綁定碼，請稍後再試'$m$, $m$'暫時無法產生新的綁定碼,請稍後再試'$m$
  ])),
  $m$411decc625bfa8511c851a79f76dd323$m$,
  $m$private.issue_line_binding_code(p_merchant_id uuid, p_target_type text, p_target_id uuid, p_created_by_user_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.issue_line_binding_code(p_merchant_id uuid, p_target_type text, p_target_id uuid, p_created_by_user_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres}$m$, $m$規則 2.7 共用邏輯:先讓同目標舊碼失效,再產生一組目前有效範圍內不重複的 6 碼數字。只給 3.4~3.7 呼叫。$m$],
  $m$private.issue_line_binding_code(p_merchant_id uuid, p_target_type text, p_target_id uuid, p_created_by_user_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.issue_line_binding_code(p_merchant_id uuid, p_target_type text, p_target_id uuid, p_created_by_user_id uuid)$m$),
  array[]::text[],
  $m$private.issue_line_binding_code(p_merchant_id uuid, p_target_type text, p_target_id uuid, p_created_by_user_id uuid) ③ 觸發器綁定不變$m$);

-- ----- private.protect_merchant_staff_line_binding_columns() -----
-- #1051(全面體檢加固)改過本支函式 ⇒ 指紋/ACL 更新為加固後的值(加固內容見 migration 20261010230000~230300)。
select is(
  md5(pg_temp.req987_swap_back($m$private.protect_merchant_staff_line_binding_columns()$m$, array[
    $m$'不能透過一般編輯直接變更 LINE 綁定狀態，請透過 LINE 綁定/解除綁定流程操作'$m$, $m$'不能透過一般編輯直接變更 LINE 綁定狀態,請透過 LINE 綁定/解除綁定流程操作'$m$
  ])),
  $m$7a48f226e54c416c44bdf2717a14656f$m$,
  $m$private.protect_merchant_staff_line_binding_columns() ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.protect_merchant_staff_line_binding_columns()$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres}$m$, $m$規則 2.9:擋下「不是透過 service role」對 merchant_staff.line_user_id/line_bound 的異動,不影響這兩個欄位以外的一般編輯(姓名/電話/上架狀態等維持商家管理員可直接修改)。唯一例外是 3.19 unbind_line_account 已完成權限檢查後,用 transaction-local 的 line_notifications.bypass_staff_binding_guard 旗標放行。$m$],
  $m$private.protect_merchant_staff_line_binding_columns() ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.protect_merchant_staff_line_binding_columns()$m$),
  array[$m$merchant_staff.merchant_staff_protect_line_binding_columns:O$m$]::text[],
  $m$private.protect_merchant_staff_line_binding_columns() ③ 觸發器綁定不變$m$);

-- ----- private.protect_merchants_group_id_column() -----
-- #1051(全面體檢加固)改過本支函式 ⇒ 指紋/ACL 更新為加固後的值(加固內容見 migration 20261010230000~230300)。
select is(
  md5(pg_temp.req987_swap_back($m$private.protect_merchants_group_id_column()$m$, array[
    $m$'商家的集團歸屬只能由平台管理員調整，商家管理員不能自行把店搬到其他集團'$m$, $m$'商家的集團歸屬只能由平台管理員調整,商家管理員不能自行把店搬到其他集團'$m$
  ])),
  $m$2ad0942a816ef46aee19435767057e82$m$,
  $m$private.protect_merchants_group_id_column() ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.protect_merchants_group_id_column()$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres}$m$, $m$2026-09-24 安全修補(A4):擋下非平台管理員對 merchants.group_id 的異動。merchants_update 政策只判斷 id、不限制欄位,商家管理員原本可以自己把店搬到別的集團,導致原集團管理者的 private.is_merchant_admin() 立刻失效、永久失去存取且無法自行修復。放行路徑:service_role,或 transaction-local 旗標 platform_admin.bypass_merchant_group_guard(預留給未來的「商家轉移集團」功能)。$m$],
  $m$private.protect_merchants_group_id_column() ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.protect_merchants_group_id_column()$m$),
  array[$m$merchants.merchants_protect_group_id_column:O$m$]::text[],
  $m$private.protect_merchants_group_id_column() ③ 觸發器綁定不變$m$);

-- ----- public.apply_industry_preset(p_merchant_id uuid) -----
-- 客戶端第 1 批 C1-F03(20261008160000):ACL 的 PUBLIC(=X)已收回,期望值同步更新(函式本體未改)。
-- SPECS-INDEX #1025 FG1-A06(20261010150000):本體改成寫 merchant_feature_grants、comment 同步改寫 ⇒ ① ② 期望值同步更新(只改這一支)。
select is(
  md5(pg_temp.req987_swap_back($m$public.apply_industry_preset(p_merchant_id uuid)$m$, array[
    $m$'找不到指定的商家：%'$m$, $m$'找不到指定的商家: %'$m$
  ])),
  $m$ffa7cc2b98f1f85ebf2ba9aaf56ec837$m$,
  $m$public.apply_industry_preset(p_merchant_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.apply_industry_preset(p_merchant_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,service_role=X/postgres}$m$, $m$依商家的 industry_type 讀取 industry_feature_presets,批次寫入 merchant_feature_grants(SPECS-INDEX #1025 FG1-A06 起改寫平台功能開關表，不再寫 merchant_feature_flags)。功能清單每一項都寫一列，值 = 該產業的預設，沒設產業預設就用 platform_features.default_enabled;on conflict do nothing。只在開店 / 開分店時呼叫一次(T2:之後改產業預設不影響已開好的商家;T3:商家切換產業也不重套)。$m$],
  $m$public.apply_industry_preset(p_merchant_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.apply_industry_preset(p_merchant_id uuid)$m$),
  array[]::text[],
  $m$public.apply_industry_preset(p_merchant_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.claim_birthday_line_pending(p_limit integer) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.claim_birthday_line_pending(p_limit integer)$m$, array[
    $m$'發送過程中斷，系統沒有收到發送結果；為避免重複發送，不會自動重試'$m$, $m$'發送過程中斷,系統沒有收到發送結果;為避免重複發送,不會自動重試'$m$,
    $m$'超過 7 天仍未發送(當時 LINE 發送排程可能尚未啟用)，為避免過期的生日祝福，不再補發'$m$, $m$'超過 7 天仍未發送(當時 LINE 發送排程可能尚未啟用),為避免過期的生日祝福,不再補發'$m$,
    $m$'商家已停用，不發送生日 LINE 訊息'$m$, $m$'商家已停用,不發送生日 LINE 訊息'$m$,
    $m$'會員已下架，不發送生日 LINE 訊息(生日點數已照常發放)'$m$, $m$'會員已下架,不發送生日 LINE 訊息(生日點數已照常發放)'$m$
  ])),
  $m$d8ddf7e75ef0de730ebbfe2fe9f2caea$m$,
  $m$public.claim_birthday_line_pending(p_limit integer) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.claim_birthday_line_pending(p_limit integer)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,service_role=X/postgres}$m$, $m$紅利系統重構 §3.7(#841)排程 B 專用(service_role):認領 line_status=pending 且尚未認領的生日發送紀錄(最多 p_limit 筆,夾在 1~500)。商家已停用 ⇒ skipped_merchant_disabled;會員已下架 ⇒ skipped_member_removed(v2.4 第 19 條 ②③)。會員未綁 LINE ⇒ 直接標 skipped_not_bound;商家 LINE 未連線 ⇒ 標 skipped_not_connected;兩者都不回傳。真的要發的列寫入 line_attempted_at(認領)後回傳 jsonb(grant_id/merchant_id/member_id/line_user_id/channel_access_token/message_template/member_name/points/merchant_name)。另外兩條保護:認領超過 30 分鐘沒回報 ⇒ failed(不自動重試,避免重複發);發點後超過 7 天沒發出 ⇒ failed(不發過期祝福)。🔴 回傳內容含 LINE channel access token,只能給 service_role。$m$],
  $m$public.claim_birthday_line_pending(p_limit integer) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.claim_birthday_line_pending(p_limit integer)$m$),
  array[]::text[],
  $m$public.claim_birthday_line_pending(p_limit integer) ③ 觸發器綁定不變$m$);

-- ----- public.create_group_and_merchant(p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text) -----
-- 客戶端第 2 批 C2-H01(20261008170100):開頭多一段「客人帳號不能建店」,這裡多一組對照把那一段換掉,其餘本體逐字不變。
select is(
  md5(pg_temp.req987_swap_back($m$public.create_group_and_merchant(p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text)$m$, array[
    $m$  -- [c2] C2-H01:客戶端 LINE 登入的客人帳號不能建店。
  if private.is_customer_account() then
    raise exception '客人帳號不能建立商家。' using errcode = '42501';
  end if;

$m$, $m$$m$,
    $m$'不支援的產業類型：%'$m$, $m$'不支援的產業類型: %'$m$
  ])),
  $m$395131714e9868c8031969a198616f8b$m$,
  $m$public.create_group_and_merchant(p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.create_group_and_merchant(p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$Onboarding(4.1)呼叫的 RPC:原子性建立集團+第一間商家+登記建立者為管理員+套用產業預設功能+種入模組 9 v2 預設付款方式+種入模組 7 預設假別+種入模組 8 預設薪資設定與假別扣款規則+種入模組 10 預設會員設定,見規格書 3.2、支付方式.md §2、排班與休假管理.md §3.9、薪資與帳務.md §3.12、會員與紅利.md §3.15。$m$],
  $m$public.create_group_and_merchant(p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.create_group_and_merchant(p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text)$m$),
  array[]::text[],
  $m$public.create_group_and_merchant(p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text) ③ 觸發器綁定不變$m$);

-- ----- public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text) -----
-- 客戶端第 2 批 C2-H01(20261008170100):開頭多一段「客人帳號不能建店」,這裡多一組對照把那一段換掉,其餘本體逐字不變。
select is(
  md5(pg_temp.req987_swap_back($m$public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text)$m$, array[
    $m$  -- [c2] C2-H01:客戶端 LINE 登入的客人帳號不能建店。
  if private.is_customer_account() then
    raise exception '客人帳號不能建立商家。' using errcode = '42501';
  end if;

$m$, $m$$m$,
    $m$'不支援的產業類型：%'$m$, $m$'不支援的產業類型: %'$m$
  ])),
  $m$059764bf68379fd6b8c3a6099fc70471$m$,
  $m$public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$新增分店流程(4.4)呼叫的 RPC:檢查規則 2.5 權限後,原子性建立新分店+登記建立者為管理員+套用產業預設功能+種入模組 9 v2 預設付款方式+種入模組 7 預設假別+種入模組 8 預設薪資設定與假別扣款規則+種入模組 10 預設會員設定,見規格書 3.3、支付方式.md §2、排班與休假管理.md §3.9、薪資與帳務.md §3.12、會員與紅利.md §3.15。$m$],
  $m$public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text)$m$),
  array[]::text[],
  $m$public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text) ③ 觸發器綁定不變$m$);

-- ----- public.generate_booking_slug(p_name text) -----
-- 客戶端第 1 批 C1-F03(20261008160000):ACL 的 PUBLIC(=X)已收回,期望值同步更新(函式本體未改)。
select is(
  md5(pg_temp.req987_swap_back($m$public.generate_booking_slug(p_name text)$m$, array[
    $m$'無法產生唯一的預約網址代碼，請稍後再試'$m$, $m$'無法產生唯一的預約網址代碼,請稍後再試'$m$
  ])),
  $m$6ef4e51ee50dfc02b376b4101aeeffcb$m$,
  $m$public.generate_booking_slug(p_name text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.generate_booking_slug(p_name text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,service_role=X/postgres}$m$, $m$依店名產生英數字+連字號的預約網址代碼,確保唯一且不與系統路徑衝突,見規則 2.7。$m$],
  $m$public.generate_booking_slug(p_name text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.generate_booking_slug(p_name text)$m$),
  array[]::text[],
  $m$public.generate_booking_slug(p_name text) ③ 觸發器綁定不變$m$);

-- ----- public.get_agent_login_email_status(p_agent_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.get_agent_login_email_status(p_agent_id uuid)$m$, array[
    $m$'沒有權限執行此操作，僅限該商家管理員使用'$m$, $m$'沒有權限執行此操作,僅限該商家管理員使用'$m$
  ])),
  $m$f6a721f8162636aac5da383b12b201d9$m$,
  $m$public.get_agent_login_email_status(p_agent_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.get_agent_login_email_status(p_agent_id uuid)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 2.4.3:設計理由完全比照 get_staff_login_email_status,同一次修正 email_change 欄位名稱的 bug。$m$],
  $m$public.get_agent_login_email_status(p_agent_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.get_agent_login_email_status(p_agent_id uuid)$m$),
  array[]::text[],
  $m$public.get_agent_login_email_status(p_agent_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.get_staff_login_email_status(p_staff_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.get_staff_login_email_status(p_staff_id uuid)$m$, array[
    $m$'沒有權限執行此操作，僅限該商家管理員使用'$m$, $m$'沒有權限執行此操作,僅限該商家管理員使用'$m$
  ])),
  $m$d1f31bcd22bc2d4aa3cd626363f29d0d$m$,
  $m$public.get_staff_login_email_status(p_staff_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.get_staff_login_email_status(p_staff_id uuid)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 2.4.3:管理員查詢某位服務人員目前實際的登入 email(即時查 auth.users,不是 invited_login_email 那份歷史快照)以及兩種待驗證狀態(規則 2.3.3)。授權給 authenticated(不是只給 service_role),因為這是管理員直接從瀏覽器發起的查詢,內部自己做 is_merchant_admin 檢查。2026-09-21 修正:auth.users 存放待驗證新信箱的欄位是 email_change,不是 new_email(new_email 只是 supabase-js User 物件回傳給前端時用的欄位名稱)——用 nullif(..., '') 是因為 GoTrue 沒有待驗證變更時這個欄位是空字串,不是 null。$m$],
  $m$public.get_staff_login_email_status(p_staff_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.get_staff_login_email_status(p_staff_id uuid)$m$),
  array[]::text[],
  $m$public.get_staff_login_email_status(p_staff_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.invite_merchant_admin(p_merchant_id uuid, p_user_email text) -----
-- 客戶端第 2 批 QA 修正(20261008170300):email 查詢多一個「排除客人帳號」條件,這裡多一組對照把它換掉,其餘本體逐字不變。
select is(
  md5(pg_temp.req987_swap_back($m$public.invite_merchant_admin(p_merchant_id uuid, p_user_email text)$m$, array[
    $m$
    -- [c2-qa] 客戶端 LINE 登入的客人帳號一律當作「找不到」(訊息跟真的找不到一樣,不透露是客人帳號)。
    and coalesce(raw_app_meta_data ->> 'account_type', '') <> 'customer'$m$, $m$$m$,
    $m$'沒有權限執行此操作，僅限該商家管理員使用'$m$, $m$'沒有權限執行此操作,僅限該商家管理員使用'$m$,
    $m$'找不到指定的商家：%'$m$, $m$'找不到指定的商家: %'$m$,
    $m$'找不到這個 email 對應的使用者，請確認對方已經註冊過秒約帳號'$m$, $m$'找不到這個 email 對應的使用者,請確認對方已經註冊過秒約帳號'$m$
  ])),
  $m$f318cfcce10dde03e5d203104fc39d90$m$,
  $m$public.invite_merchant_admin(p_merchant_id uuid, p_user_email text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.invite_merchant_admin(p_merchant_id uuid, p_user_email text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.3/規則 2.3:商家管理員邀請另一位管理員(只能邀請已註冊帳號),查無 email 或已是管理員回傳明確錯誤。$m$],
  $m$public.invite_merchant_admin(p_merchant_id uuid, p_user_email text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.invite_merchant_admin(p_merchant_id uuid, p_user_email text)$m$),
  array[]::text[],
  $m$public.invite_merchant_admin(p_merchant_id uuid, p_user_email text) ③ 觸發器綁定不變$m$);

-- ----- public.platform_add_merchant_admin(p_merchant_id uuid, p_user_email text) -----
-- 客戶端第 2 批 QA 修正(20261008170300):email 查詢多一個「排除客人帳號」條件,這裡多一組對照把它換掉,其餘本體逐字不變。
select is(
  md5(pg_temp.req987_swap_back($m$public.platform_add_merchant_admin(p_merchant_id uuid, p_user_email text)$m$, array[
    $m$
    -- [c2-qa] 客戶端 LINE 登入的客人帳號一律當作「找不到」(訊息跟真的找不到一樣,不透露是客人帳號)。
    and coalesce(raw_app_meta_data ->> 'account_type', '') <> 'customer'$m$, $m$$m$,
    $m$'找不到指定的商家：%'$m$, $m$'找不到指定的商家: %'$m$
  ])),
  $m$4f0329f160ee8845de62fd4801f7ea41$m$,
  $m$public.platform_add_merchant_admin(p_merchant_id uuid, p_user_email text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.platform_add_merchant_admin(p_merchant_id uuid, p_user_email text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.4:超級管理員代替商家新增管理員，呼叫者必須通過 is_platform_admin 檢查；查無此 email 對應帳號或已是管理員時回傳明確錯誤。$m$],
  $m$public.platform_add_merchant_admin(p_merchant_id uuid, p_user_email text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.platform_add_merchant_admin(p_merchant_id uuid, p_user_email text)$m$),
  array[]::text[],
  $m$public.platform_add_merchant_admin(p_merchant_id uuid, p_user_email text) ③ 觸發器綁定不變$m$);

-- (#1051:public.platform_purge_merchant_members_and_points 已移除,原本這裡的 3 條比對一併拿掉。)

-- ----- public.platform_remove_merchant_admin(p_merchant_id uuid, p_user_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.platform_remove_merchant_admin(p_merchant_id uuid, p_user_id uuid)$m$, array[
    $m$'找不到指定的商家：%'$m$, $m$'找不到指定的商家: %'$m$
  ])),
  $m$1d7b7a29fd87e416b8312686abb72be6$m$,
  $m$public.platform_remove_merchant_admin(p_merchant_id uuid, p_user_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.platform_remove_merchant_admin(p_merchant_id uuid, p_user_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.5/規則 2.4:超級管理員代替商家移除管理員，若移除後該商家會變成無人可管(且集團也沒有集團管理者)則擋下並提示。$m$],
  $m$public.platform_remove_merchant_admin(p_merchant_id uuid, p_user_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.platform_remove_merchant_admin(p_merchant_id uuid, p_user_id uuid)$m$),
  array[]::text[],
  $m$public.platform_remove_merchant_admin(p_merchant_id uuid, p_user_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.platform_set_group_admin(p_group_id uuid, p_user_email text) -----
-- 客戶端第 2 批 QA 修正(20261008170300):email 查詢多一個「排除客人帳號」條件,這裡多一組對照把它換掉,其餘本體逐字不變。
select is(
  md5(pg_temp.req987_swap_back($m$public.platform_set_group_admin(p_group_id uuid, p_user_email text)$m$, array[
    $m$
    -- [c2-qa] 客戶端 LINE 登入的客人帳號一律當作「找不到」(訊息跟真的找不到一樣,不透露是客人帳號)。
    and coalesce(raw_app_meta_data ->> 'account_type', '') <> 'customer'$m$, $m$$m$,
    $m$'找不到指定的集團：%'$m$, $m$'找不到指定的集團: %'$m$
  ])),
  $m$efd6992d544808187dff4579f0753d78$m$,
  $m$public.platform_set_group_admin(p_group_id uuid, p_user_email text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.platform_set_group_admin(p_group_id uuid, p_user_email text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.6/規則 2.5:超級管理員代替集團指定或清空集團管理者。清空時若會導致集團底下有商家無人可管則擋下；設定時查無 email 對應帳號要回傳明確錯誤。$m$],
  $m$public.platform_set_group_admin(p_group_id uuid, p_user_email text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.platform_set_group_admin(p_group_id uuid, p_user_email text)$m$),
  array[]::text[],
  $m$public.platform_set_group_admin(p_group_id uuid, p_user_email text) ③ 觸發器綁定不變$m$);

-- ----- public.prevent_disable_last_active_merchant() -----
-- #1051(全面體檢加固)改過本支函式 ⇒ 指紋/ACL 更新為加固後的值(加固內容見 migration 20261010230000~230300)。
select is(
  md5(pg_temp.req987_swap_back($m$public.prevent_disable_last_active_merchant()$m$, array[
    $m$'集團底下至少要保留一間啟用中商家，無法停用最後一間'$m$, $m$'集團底下至少要保留一間啟用中商家,無法停用最後一間'$m$
  ])),
  $m$ea47492b7b627c66004473974ceb83b5$m$,
  $m$public.prevent_disable_last_active_merchant() ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.prevent_disable_last_active_merchant()$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,service_role=X/postgres}$m$, $m$NULL$m$],
  $m$public.prevent_disable_last_active_merchant() ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.prevent_disable_last_active_merchant()$m$),
  array[$m$merchants.merchants_prevent_disable_last_active:O$m$]::text[],
  $m$public.prevent_disable_last_active_merchant() ③ 觸發器綁定不變$m$);

-- ----- public.remove_merchant_admin(p_merchant_id uuid, p_user_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.remove_merchant_admin(p_merchant_id uuid, p_user_id uuid)$m$, array[
    $m$'沒有權限執行此操作，僅限該商家管理員使用'$m$, $m$'沒有權限執行此操作,僅限該商家管理員使用'$m$,
    $m$'找不到指定的商家：%'$m$, $m$'找不到指定的商家: %'$m$,
    $m$'移除後這間店會沒有任何人能登入管理，請先新增其他管理員'$m$, $m$'移除後這間店會沒有任何人能登入管理,請先新增其他管理員'$m$
  ])),
  $m$650a039fd93bb7cb08683b181a71a503$m$,
  $m$public.remove_merchant_admin(p_merchant_id uuid, p_user_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.remove_merchant_admin(p_merchant_id uuid, p_user_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.3/規則 2.4:商家管理員移除另一位管理員,若移除後該商家會變成無人可管(且集團也沒有集團管理者)則擋下並提示。$m$],
  $m$public.remove_merchant_admin(p_merchant_id uuid, p_user_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.remove_merchant_admin(p_merchant_id uuid, p_user_id uuid)$m$),
  array[]::text[],
  $m$public.remove_merchant_admin(p_merchant_id uuid, p_user_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid)$m$, array[
    $m$'找不到這筆預約，或它不屬於這個商家'$m$, $m$'找不到這筆預約,或它不屬於這個商家'$m$
  ])),
  $m$61799fbc7c2c0296b113d58f3807d422$m$,
  $m$public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,service_role=X/postgres}$m$, $m$3.9:LINE 通知 / 推播共用的訂單文案變數組裝。#844 §4.8:points_earned = 本單、本單目前會員的有效入帳(入帳 − 收回)。SPECS-INDEX #972:必須同時帶 p_merchant_id,訂單不屬於該商家(或 p_merchant_id 為 null)一律丟錯 P0002,防止用別家訂單編號把別家訂單內容組進自己的通知;刻意不給 default。只給 service_role。$m$],
  $m$public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid)$m$),
  array[]::text[],
  $m$public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid)$m$, array[
    $m$'找不到這筆請假紀錄，或它不屬於這個商家'$m$, $m$'找不到這筆請假紀錄,或它不屬於這個商家'$m$
  ])),
  $m$9c717723e9793d6a4a11647015d0ef3c$m$,
  $m$public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,service_role=X/postgres}$m$, $m$SPECS-INDEX 385:staff_leave_created 事件的文案變數組裝。查無此請假紀錄回 {}(安靜路徑)。SPECS-INDEX #972:必須同時帶 p_merchant_id,請假紀錄的服務人員不屬於該商家(或 p_merchant_id 為 null)一律丟錯 P0002;刻意不給 default。只給 service_role。$m$],
  $m$public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid)$m$),
  array[]::text[],
  $m$public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid, p_staff_leave_record_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid, p_staff_leave_record_id uuid)$m$, array[
    $m$'找不到這筆預約，或它不屬於這個商家'$m$, $m$'找不到這筆預約,或它不屬於這個商家'$m$,
    $m$'找不到這筆請假紀錄，或它不屬於這個商家'$m$, $m$'找不到這筆請假紀錄,或它不屬於這個商家'$m$,
    -- 客戶端第 5 批 C5-K01:notify_member 那一段換成一行註解(其他段逐字不變),這裡換回去再比對改前指紋。
    $m$  -- 客戶端第 5 批 C5-K01:模組 11 的「通知會員」(notify_member)已拿掉,客人通知改走 customer_line_outbox。
$m$, $m$  if v_settings.notify_member and v_booking.id is not null then
    if v_booking.member_id is null then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'member', 'id', null, 'reason', 'no_target')
      );
    else
      select name, line_bound into v_member_name, v_member_bound
      from public.members where id = v_booking.member_id and merchant_id = p_merchant_id;

      if coalesce(v_member_bound, false) then
        v_targets := v_targets || jsonb_build_array(jsonb_build_object(
          'type', 'member', 'id', v_booking.member_id, 'name', v_member_name,
          'line_user_id', (select line_user_id from public.members where id = v_booking.member_id and merchant_id = p_merchant_id)
        ));
      else
        v_skipped := v_skipped || jsonb_build_array(
          jsonb_build_object('type', 'member', 'id', v_booking.member_id, 'reason', 'target_not_bound')
        );
      end if;
    end if;
  end if;
$m$
  ])),
  $m$9b66ca4aea0df7d482a76a5aef99e175$m$,
  $m$public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid, p_staff_leave_record_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid, p_staff_leave_record_id uuid)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,service_role=X/postgres}$m$, $m$3.10 邊界情況:preview_line_notification_targets(前端預覽)跟 line-notify-dispatch(實際發送判斷)共用的唯一一份判斷邏輯,避免兩邊分岔造成「彈窗說會通知,結果沒有通知」。⚠️ 函式內部完全沒有權限檢查,只能給 service_role(Edge Function)直接呼叫,前端一律走有 can_manage_bookings 檢查、且會濾掉 line_user_id 的 preview_line_notification_targets 包裝函式。2026-09-24 安全修補:原本漏掉 revoke authenticated,導致任何登入者都能帶任意 merchant_id 撈走該商家所有管理員/客服的 line_user_id。SPECS-INDEX #876:服務人員分支要求「行事曆檢視」是開的(private.staff_calendar_view_allows_notifications)。SPECS-INDEX #962:服務人員分支另要求在職(merchant_staff.status = active,與 resolve_push_recipients 同一道);不寄的服務人員列入跳過清單,原因依序為 staff_inactive(已離職/停用)、staff_calendar_view_off(未開放行事曆檢視)、target_not_bound(未綁 LINE)。SPECS-INDEX #972:有帶 p_booking_id / p_staff_leave_record_id 時,該訂單/請假紀錄必須屬於 p_merchant_id,否則丟錯 P0002(跨商家 IDOR 修補);服務人員/會員查詢一併加上 merchant_id = p_merchant_id。$m$],
  $m$public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid, p_staff_leave_record_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid, p_staff_leave_record_id uuid)$m$),
  array[]::text[],
  $m$public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid, p_staff_leave_record_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.unbind_line_account(p_target_type text, p_target_id uuid) -----
-- 客戶端第 2 批 C2-H02(20261008170100):member 分支多清 user_id + 一行註解;20261008170200 再多寫封鎖表。這裡的對照把它們換回去,其餘本體逐字不變。
select is(
  md5(pg_temp.req987_swap_back($m$public.unbind_line_account(p_target_type text, p_target_id uuid)$m$, array[
    $m$    --   ・[c2] C2-H02(使用者 Q3):同時清 user_id ⇒ 客戶端 LINE 登入一起斷開,客人下次登入要重新填電話。
$m$, $m$$m$,
    $m$    --   ・[c2-relink] 被解除的客戶帳號記進封鎖表 ⇒ 這個帳號之後填同一支電話不會自動接回(回 phone_taken);
    --     別的 LINE 帳號照常可以接上。店家用 allow_member_customer_relink 撤銷。
    insert into public.customer_member_link_blocks (member_id, user_id, merchant_id, created_by_user_id)
    select m.id, m.user_id, m.merchant_id, auth.uid()
    from public.members m
    where m.id = p_target_id and m.user_id is not null
    on conflict (member_id, user_id) do nothing;
$m$, $m$$m$,
    $m$        identity_verified_via = null,
        user_id = null
$m$, $m$        identity_verified_via = null
$m$,
    $m$'不支援的綁定目標類型：%'$m$, $m$'不支援的綁定目標類型: %'$m$
  ])),
  $m$aaa2ba2f98909d5eb5ac3b86db3d8fb2$m$,
  $m$public.unbind_line_account(p_target_type text, p_target_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.unbind_line_account(p_target_type text, p_target_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$規則 2.8 反向操作/3.19:解除 LINE 綁定。admin/agent 允許管理員或本人;staff 自 2026-09-24 使用者裁決「要讓服務人員自己綁定」起,同樣允許「管理員或本人」(本人一律用 auth.uid() 對照 merchant_staff.user_id 判斷,不信任前端傳來的 id;實際欄位異動透過 line_notifications.bypass_staff_binding_guard 這個 transaction-local 旗標合法放行規則 2.9 觸發器);member 檢查 can_manage_members。三個分支都用 (user_id is not null and auth.uid() is not null and user_id = auth.uid()) 的 null 安全寫法(2026-09-24 修掉的既有三值邏輯漏洞)。SPECS-INDEX #910(2026-09-30,使用者裁決 Q2 = (B) 附帶限制):member 分支額外把 identity_verified_at 與 identity_verified_via 清成 null(綁定狀態歸零,名單上變回「尚未驗證」——2026-10-01 修正用詞,原本寫的是舊標籤「已建立(未綁定)」;使用者已裁決狀態名稱裡不可以出現「綁定」二字,文案的唯一來源是 src/modules/members/memberIdentityStatus.ts),但 🔴 **identity_first_verified_at 一律不動**(第一次完成驗證的時間永久保留 —— 使用者原話「會員資料、紀錄、加入時間也不該清除,僅是綁定狀態變回未綁定」)。這支函式是 identity_verified_at 目前唯一的清除路徑;會員本人與他的訂單/點數/分類帳完全不動。$m$],
  $m$public.unbind_line_account(p_target_type text, p_target_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.unbind_line_account(p_target_type text, p_target_id uuid)$m$),
  array[]::text[],
  $m$public.unbind_line_account(p_target_type text, p_target_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean)$m$, array[
    $m$'找不到指定的客服紀錄：%'$m$, $m$'找不到指定的客服紀錄: %'$m$,
    $m$'沒有權限執行此操作，僅限該商家管理員使用'$m$, $m$'沒有權限執行此操作,僅限該商家管理員使用'$m$
  ])),
  $m$10b3c7634d2ac44621e0a7aac2c81367$m$,
  $m$public.set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.9:商家管理員逐項開關某位客服能看到/操作哪些後台功能區塊。$m$],
  $m$public.set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean)$m$),
  array[]::text[],
  $m$public.set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean) ③ 觸發器綁定不變$m$);

-- ----- public.set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean)$m$, array[
    $m$'找不到指定的服務人員紀錄：%'$m$, $m$'找不到指定的服務人員紀錄: %'$m$,
    $m$'沒有權限執行此操作，僅限該商家管理員使用'$m$, $m$'沒有權限執行此操作,僅限該商家管理員使用'$m$
  ])),
  $m$b1a13483a02bf55a48f3f3cc01f3738a$m$,
  $m$public.set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.4/規則 2.11:商家管理員逐項開關某位服務人員的自助功能區塊,不透過 merchant_agent_permissions 開放給客服。$m$],
  $m$public.set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean)$m$),
  array[]::text[],
  $m$public.set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean) ③ 觸發器綁定不變$m$);

-- ----- public.hard_delete_merchant_agent(p_agent_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.hard_delete_merchant_agent(p_agent_id uuid)$m$, array[
    $m$'沒有權限執行此操作，僅限該商家管理員使用'$m$, $m$'沒有權限執行此操作,僅限該商家管理員使用'$m$,
    $m$'只能對已經移除的客服執行真正刪除，請先移除這位客服(軟刪除)，確認不再需要之後再進行真正刪除。'$m$, $m$'只能對已經移除的客服執行真正刪除,請先移除這位客服(軟刪除),確認不再需要之後再進行真正刪除。'$m$
  ])),
  $m$7275320c204cc55f21f3f9dcb842b197$m$,
  $m$public.hard_delete_merchant_agent(p_agent_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.hard_delete_merchant_agent(p_agent_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$SPECS-INDEX #798(2026-09-25 使用者裁決「選 A+C」):客服的「真正刪除」(硬刪除),照抄 hard_delete_merchant_staff 的先例。只有 private.is_merchant_admin(該客服的 merchant_id) 可以呼叫(42501),而且只能對 status=removed 的客服操作(P0001,必須先軟移除)。指向 merchant_agents.id 的外鍵只有 merchant_agent_permissions.agent_id(on delete cascade,這位客服自己的權限開關設定),沒有任何歷史事實表指向 merchant_agents(bookings 沒有 agent_id),所以不需要比照服務人員那幾項「有歷史紀錄就擋下」的檢查。完全不動 auth.users;刪除後 (merchant_id, user_id) 的 partial unique index 釋放,同一個人可以被重新邀請。$m$],
  $m$public.hard_delete_merchant_agent(p_agent_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.hard_delete_merchant_agent(p_agent_id uuid)$m$),
  array[]::text[],
  $m$public.hard_delete_merchant_agent(p_agent_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.hard_delete_merchant_staff(p_staff_id uuid) -----
-- #1051(全面體檢加固)改過本支函式 ⇒ 指紋/ACL 更新為加固後的值(加固內容見 migration 20261010230000~230300)。
select is(
  md5(pg_temp.req987_swap_back($m$public.hard_delete_merchant_staff(p_staff_id uuid)$m$, array[
    $m$'沒有權限執行此操作，僅限該商家管理員使用'$m$, $m$'沒有權限執行此操作,僅限該商家管理員使用'$m$,
    $m$'只能對已經移除的服務人員執行真正刪除，請先移除這位服務人員(軟刪除)，確認不再需要之後再進行真正刪除。'$m$, $m$'只能對已經移除的服務人員執行真正刪除,請先移除這位服務人員(軟刪除),確認不再需要之後再進行真正刪除。'$m$,
    $m$'這位服務人員「%」有歷史紀錄牽連(訂單 %筆、助手身份訂單 %筆、請假紀錄 %筆、抽成紀錄 %筆)，為了保留歷史帳務與訂單資料，無法真正刪除，只能維持「已移除」狀態。'$m$, $m$'這位服務人員「%」有歷史紀錄牽連(訂單 %筆、助手身份訂單 %筆、請假紀錄 %筆、抽成紀錄 %筆),為了保留歷史帳務與訂單資料,無法真正刪除,只能維持「已移除」狀態。'$m$,
    $m$'這位服務人員過去有實際發生過的月薪紀錄(曾經是有薪資的月薪制員工)，為了保留歷史帳務報表的正確性，無法真正刪除，只能維持「已移除」狀態。'$m$, $m$'這位服務人員過去有實際發生過的月薪紀錄(曾經是有薪資的月薪制員工),為了保留歷史帳務報表的正確性,無法真正刪除,只能維持「已移除」狀態。'$m$
  ])),
  $m$6b42dc972e3fb77a50d504447b8cdd1c$m$,
  $m$public.hard_delete_merchant_staff(p_staff_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.hard_delete_merchant_staff(p_staff_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書「服務人員管理優化與硬刪除」§3.3 + 模組 8 §11.4:只能對 status=removed 的服務人員操作,且 bookings/booking_assistants/staff_leave_records/booking_commission_records 四張歷史事實表只要有任何一筆牽連就整個擋下(不做部分刪除/匿名化)。§11.4 新增第五項檢查:staff_payroll_status_history 裡如果存在任何一筆 monthly_base_salary > 0 的紀錄,同樣擋下(保留歷史帳務報表正確性)。通過所有檢查後執行 DELETE,讓既有的 on delete cascade 外鍵自動清掉純設定/歷史表的關聯資料。完全不動 auth.users,同一信箱之後可以被重新邀請使用。$m$],
  $m$public.hard_delete_merchant_staff(p_staff_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.hard_delete_merchant_staff(p_staff_id uuid)$m$),
  array[]::text[],
  $m$public.hard_delete_merchant_staff(p_staff_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.remove_merchant_agent(p_agent_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.remove_merchant_agent(p_agent_id uuid)$m$, array[
    $m$'找不到指定的客服紀錄：%'$m$, $m$'找不到指定的客服紀錄: %'$m$,
    $m$'沒有權限執行此操作，僅限該商家管理員使用'$m$, $m$'沒有權限執行此操作,僅限該商家管理員使用'$m$
  ])),
  $m$b761e892f33f4b4db894f6240bd07ebb$m$,
  $m$public.remove_merchant_agent(p_agent_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.remove_merchant_agent(p_agent_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.7/規則 2.8-2.9:商家管理員移除客服(軟刪除)。移除後 private.is_merchant_agent() 會因為 status 不再是 active 而回傳 false,見規則 2.9。$m$],
  $m$public.remove_merchant_agent(p_agent_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.remove_merchant_agent(p_agent_id uuid)$m$),
  array[]::text[],
  $m$public.remove_merchant_agent(p_agent_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.restore_merchant_agent(p_agent_id uuid) -----
-- #1051(全面體檢加固)改過本支函式 ⇒ 指紋/ACL 更新為加固後的值(加固內容見 migration 20261010230000~230300)。
select is(
  md5(pg_temp.req987_swap_back($m$public.restore_merchant_agent(p_agent_id uuid)$m$, array[
    $m$'沒有權限執行此操作，僅限該商家管理員使用'$m$, $m$'沒有權限執行此操作,僅限該商家管理員使用'$m$,
    $m$'只有已移除的客服才需要恢復，這位客服目前的狀態不是已移除'$m$, $m$'只有已移除的客服才需要恢復,這位客服目前的狀態不是已移除'$m$,
    $m$'這個邀請 Email(%)目前已經有另一筆使用中的客服紀錄，無法恢復這一筆；如果要改用這一筆，請先移除另一筆'$m$, $m$'這個邀請 Email(%)目前已經有另一筆使用中的客服紀錄,無法恢復這一筆;如果要改用這一筆,請先移除另一筆'$m$
  ])),
  $m$bc10ec6fb429b9ad2379b1faaf157875$m$,
  $m$public.restore_merchant_agent(p_agent_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.restore_merchant_agent(p_agent_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$2026-09-24 使用者裁決(「重新啟用…指的應該是移除後[恢復/真正刪除]按鈕的恢復對吧?如果是的話那就要增加恢復按鈕。」):把已移除(status=removed)的客服恢復回可用狀態,對應客服管理列表「已移除」分頁的「恢復」按鈕。只有 private.is_merchant_admin 可以呼叫(跟既有 remove_merchant_agent 同一個授權層級,否則被移除的客服自己就能把自己恢復)。⚠️ 恢復後的狀態不是無條件寫成 active:登入帳號還在且 activated_at 有值(確實啟用過)才是 active,其餘恢復成 invited——因為 status 的語意是 invited=邀請已寄出但還不能登入 / active=已能登入,把從沒接受邀請的人寫成 active 會讓 public.mark_agent_active_if_self()(條件是 status=invited)之後撈不到他,永久卡在錯誤狀態。一般情境(在職過、被誤移除)結果就是 active,跟原本的契約一致;回傳整列 merchant_agents,前端讀回傳值的 status 即可。activated_at / invited_at 刻意不重設(那是歷史事實,remove_merchant_agent 當初也沒清掉;要重新寄邀請信請走 record_invited_merchant_agent)。恢復會連帶復原這位客服原本的 merchant_agent_permissions 權限設定——那些列從頭到尾掛在同一個 agent_id 上、移除時沒被刪過,所以恢復不是給一張白紙。查證結果:merchant_agents 沒有任何 email 唯一約束,而 (merchant_id, user_id) where user_id is not null 的 partial unique index 不分狀態,所以正常情況不可能出現「同一個人兩筆在職紀錄」;只有舊列的 auth 帳號被刪除(user_id 被 on delete set null 清成 null)後商家又用同一個 email 邀新人才可能,函式對這個極端情況加了 invited_email 重複檢查並給白話訊息。$m$],
  $m$public.restore_merchant_agent(p_agent_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.restore_merchant_agent(p_agent_id uuid)$m$),
  array[]::text[],
  $m$public.restore_merchant_agent(p_agent_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.request_agent_login_email_change(p_agent_id uuid, p_new_email text) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.request_agent_login_email_change(p_agent_id uuid, p_new_email text)$m$, array[
    $m$'沒有權限執行此操作，僅限該商家管理員使用'$m$, $m$'沒有權限執行此操作,僅限該商家管理員使用'$m$,
    $m$'這位客服尚未開通登入，無法設定登入信箱建議'$m$, $m$'這位客服尚未開通登入,無法設定登入信箱建議'$m$
  ])),
  $m$d2f9bf0be420d9e0e0f6a6e73bd84b05$m$,
  $m$public.request_agent_login_email_change(p_agent_id uuid, p_new_email text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.request_agent_login_email_change(p_agent_id uuid, p_new_email text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 2.4.1:商家管理員建議客服的新登入信箱,設計理由完全比照 request_staff_login_email_change。merchant_agents 沒有給 authenticated 的 UPDATE RLS 政策,這裡的 UPDATE 是透過 SECURITY DEFINER 函式擁有者權限執行,不需要額外的欄位保護觸發器。$m$],
  $m$public.request_agent_login_email_change(p_agent_id uuid, p_new_email text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.request_agent_login_email_change(p_agent_id uuid, p_new_email text)$m$),
  array[]::text[],
  $m$public.request_agent_login_email_change(p_agent_id uuid, p_new_email text) ③ 觸發器綁定不變$m$);

-- ----- public.request_staff_login_email_change(p_staff_id uuid, p_new_email text) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.request_staff_login_email_change(p_staff_id uuid, p_new_email text)$m$, array[
    $m$'沒有權限執行此操作，僅限該商家管理員使用'$m$, $m$'沒有權限執行此操作,僅限該商家管理員使用'$m$,
    $m$'這位服務人員尚未開通登入，無法設定登入信箱建議'$m$, $m$'這位服務人員尚未開通登入,無法設定登入信箱建議'$m$
  ])),
  $m$07a93b254c1b87034392039f7c74097e$m$,
  $m$public.request_staff_login_email_change(p_staff_id uuid, p_new_email text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.request_staff_login_email_change(p_staff_id uuid, p_new_email text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 2.4.1:商家管理員建議服務人員的新登入信箱。只寫入 pending 欄位,不呼叫任何 Supabase Auth API、不寄出任何信件(規則 2.3.1)。$m$],
  $m$public.request_staff_login_email_change(p_staff_id uuid, p_new_email text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.request_staff_login_email_change(p_staff_id uuid, p_new_email text)$m$),
  array[]::text[],
  $m$public.request_staff_login_email_change(p_staff_id uuid, p_new_email text) ③ 觸發器綁定不變$m$);

select * from finish();
rollback;
