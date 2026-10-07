-- 第 11 批 D(#991,2026-10-07):拿掉「電話驗證狀態」人工標記。
-- 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §10.4 D-7、§10.6:
--   ① set_member_phone_verified 已 drop;
--   ② reward_condition_mode 的 CHECK 擋 phone_verified / either / both,放行 none / line_bound;
--   ③ members 仍然沒有任何 UPDATE 的 RLS policy(沒有被誤開新寫入路徑);
--   ④ 兩欄註解含「已退場」;member_meets_reward_condition 本體沒被動。
begin;

select plan(14);

-- ① 寫入函式已退場(任何簽章都不存在)
select hasnt_function('public', 'set_member_phone_verified', array['uuid', 'boolean'],
  '①:public.set_member_phone_verified(uuid, boolean) 不存在');
select is(
  (select count(*)::int from pg_proc where proname = 'set_member_phone_verified'),
  0,
  '①:任何 schema、任何簽章的 set_member_phone_verified 都不存在'
);
select is(
  (select count(*)::int from pg_proc where prosrc ilike '%set_member_phone_verified%'),
  0,
  '①:沒有任何函式本體還在呼叫 set_member_phone_verified'
);

-- ② CHECK 收緊(用一間測試商家的設定列;整支測試結束 rollback)
insert into groups (id) values ('b11d0000-0000-4000-8000-000000000010');
insert into merchants (id, group_id, name, industry_type) values
  ('b11d0000-0000-4000-8000-000000000020', 'b11d0000-0000-4000-8000-000000000010', 'B11D 測試商家', 'in_store_beauty');
insert into merchant_member_settings (merchant_id) values ('b11d0000-0000-4000-8000-000000000020')
on conflict (merchant_id) do nothing;

select throws_ok(
  $$update merchant_member_settings set reward_condition_mode = 'phone_verified'
    where merchant_id = 'b11d0000-0000-4000-8000-000000000020'$$,
  '23514', null, '②:phone_verified 被 CHECK 擋下');
select throws_ok(
  $$update merchant_member_settings set reward_condition_mode = 'either'
    where merchant_id = 'b11d0000-0000-4000-8000-000000000020'$$,
  '23514', null, '②:either 被 CHECK 擋下');
select throws_ok(
  $$update merchant_member_settings set reward_condition_mode = 'both'
    where merchant_id = 'b11d0000-0000-4000-8000-000000000020'$$,
  '23514', null, '②:both 被 CHECK 擋下');
select lives_ok(
  $$update merchant_member_settings set reward_condition_mode = 'line_bound'
    where merchant_id = 'b11d0000-0000-4000-8000-000000000020'$$,
  '②:line_bound 放行');
select lives_ok(
  $$update merchant_member_settings set reward_condition_mode = 'none'
    where merchant_id = 'b11d0000-0000-4000-8000-000000000020'$$,
  '②:none 放行');
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
   where conname = 'merchant_member_settings_reward_condition_mode_check'),
  'CHECK ((reward_condition_mode = ANY (ARRAY[''none''::text, ''line_bound''::text])))',
  '②:CHECK 定義恰好是 none / line_bound'
);

-- ③ members 沒有任何 UPDATE / ALL 的 RLS policy(寫入一律走 RPC,沒有被誤開新路徑)
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'members' and cmd in ('UPDATE', 'ALL')),
  0,
  '③:members 仍然沒有任何 UPDATE 的 RLS policy'
);

-- ④ 欄位保留 + 退場註解;判斷函式本體沒動
select has_column('public', 'members', 'phone_verified', '④:members.phone_verified 欄位保留');
select ok(
  col_description('public.members'::regclass,
    (select attnum from pg_attribute where attrelid = 'public.members'::regclass and attname = 'phone_verified'))
    like '%已退場%'
  and col_description('public.members'::regclass,
    (select attnum from pg_attribute where attrelid = 'public.members'::regclass and attname = 'phone_verified_at'))
    like '%已退場%',
  '④:phone_verified / phone_verified_at 兩欄註解都含「已退場」'
);
select is(
  (select md5(replace(prosrc, E'\r\n', E'\n')) from pg_proc
   where oid = 'private.member_meets_reward_condition(text, boolean, boolean)'::regprocedure),
  '0d988cddb7dbfb17e0b5dedd695c952f',
  '④:private.member_meets_reward_condition 本體沒被動(md5 不變)'
);
select ok(
  obj_description('private.member_meets_reward_condition(text, boolean, boolean)'::regprocedure, 'pg_proc')
    like '%第 11 批 D%',
  '④:member_meets_reward_condition 註解補上第 11 批 D 的說明'
);

select * from finish();
rollback;
