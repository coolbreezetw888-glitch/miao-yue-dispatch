-- 客戶端第 3 批 — C3-G01 計數表 / private.rate_limit_hit / public.internal_rate_limit_hit
--                  C3-G02 第 1 批兩支公開函式每 IP 10 分鐘 120 次(用 set_config('request.headers', ...) 模擬 PostgREST)
begin;

select plan(20);

-- 呼叫 n 次,回傳「第一次被擋是第幾次」(0 = 都沒被擋)與 hint
create function pg_temp.hammer(p_fn text, p_headers text, p_n integer) returns text language plpgsql as $$
declare i integer;
begin
  perform set_config('request.headers', coalesce(p_headers, ''), true);
  for i in 1 .. p_n loop
    begin
      if p_fn = 'page' then
        perform public.get_public_booking_page('pgtap-c3-rl');
      else
        perform public.get_public_available_slots('pgtap-c3-rl',
          jsonb_build_array(jsonb_build_object('service_item_id', 'c3f00000-0000-4000-8000-000000000081', 'quantity', 1)),
          null, (now() at time zone 'Asia/Taipei')::date + 3, 1);
      end if;
    exception when others then
      declare v_hint text; v_msg text;
      begin
        get stacked diagnostics v_hint = pg_exception_hint, v_msg = message_text;
        perform set_config('request.headers', '', true);
        return i || ':' || sqlstate || ':' || coalesce(v_hint, '') || ':' || v_msg;
      end;
    end;
  end loop;
  perform set_config('request.headers', '', true);
  return '0';
end $$;

insert into groups (id) values ('c3f00000-0000-4000-8000-000000000091');
insert into merchants (id, group_id, name, industry_type, booking_slug) values
  ('c3f00000-0000-4000-8000-000000000021', 'c3f00000-0000-4000-8000-000000000091', 'C3頻率店', 'in_store_beauty', 'pgtap-c3-rl');
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'c3f00000-0000-4000-8000-000000000021'::uuid, d, false, '09:00', '12:00' from generate_series(0, 6) d;
insert into merchant_staff (id, merchant_id, name, phone, is_listed, status, no_time_slot_limit) values
  ('c3f00000-0000-4000-8000-000000000031', 'c3f00000-0000-4000-8000-000000000021', '頻率S1', '0900320031', true, 'active', true);
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('c3f00000-0000-4000-8000-000000000081', 'c3f00000-0000-4000-8000-000000000021', '頻率項目', 100, 'primary', 60);

-- G01
select is(private.rate_limit_hit('c3-test', 'k1', interval '10 minutes', 2), true, 'G01-1 第 1 次 true');
select is(private.rate_limit_hit('c3-test', 'k1', interval '10 minutes', 2), true, 'G01-2 第 2 次 true');
select is(private.rate_limit_hit('c3-test', 'k1', interval '10 minutes', 2), false, 'G01-3 第 3 次超過 ⇒ false');
select is(private.rate_limit_hit('c3-test', 'k2', interval '10 minutes', 2), true, 'G01-4 別的 key 各算各的');
select is(private.rate_limit_hit('c3-other', 'k1', interval '10 minutes', 2), true, 'G01-5 別的 bucket 各算各的');
select is((select key_hash from private.rate_limit_hits where bucket = 'c3-test' and hits = 3),
  encode(sha256(convert_to('k1', 'UTF8')), 'hex'), 'G01-6 key 只存 SHA-256,不存原文');
select is(public.internal_rate_limit_hit('c3-edge', 'ip:1.2.3.4', 600, 10), true, 'G01-7 internal_rate_limit_hit 包裝可用');
select throws_ok($$select public.internal_rate_limit_hit('c3-edge', 'x', 0, 10)$$, '22023', null, 'G01-8 時間窗不合理 ⇒ 22023');
select is((select relpersistence from pg_class where oid = 'private.rate_limit_hits'::regclass), 'u'::"char", 'G01-9 計數表是 unlogged');
select is((select schedule from cron.job where jobname = 'rate-limit-hits-prune-hourly'), '23 * * * *', 'G01-10 每小時清理排程存在');
update private.rate_limit_hits set window_start = now() - interval '2 days' where bucket = 'c3-other';
select ok(private.prune_rate_limit_hits() >= 1, 'G01-11 清理有刪到 1 天前的計數');
select ok(not exists (select 1 from private.rate_limit_hits where bucket = 'c3-other')
          and exists (select 1 from private.rate_limit_hits where bucket = 'c3-test'), 'G01-12 只刪 1 天前的,這個時間窗的還在');

-- G02
select is(pg_temp.hammer('page', '{"x-forwarded-for":"6.6.6.6, 10.0.0.1"}', 121),
  '121:P0001:rate_limited:操作太頻繁，請稍後再試', 'G02-1 預約頁:同一 IP 第 121 次被擋(rate_limited)');
select is(pg_temp.hammer('page', '{"x-forwarded-for":"6.6.6.6, 10.0.0.2"}', 5),
  '0', 'G02-2 只有 XFF 第一段相同(客人自己帶的)、最後一段不同 ⇒ 不同 IP,不受影響');
select is(pg_temp.hammer('page', '{"cf-connecting-ip":"10.0.0.1","x-forwarded-for":"10.0.0.9"}', 1),
  '1:P0001:rate_limited:操作太頻繁，請稍後再試', 'G02-3 優先用 cf-connecting-ip(同一個 IP 已經用完額度)');
select is(pg_temp.hammer('page', null, 130), '0', 'G02-4 拿不到 IP(沒有標頭)⇒ 不限制');
select is(pg_temp.hammer('slots', '{"x-forwarded-for":"10.0.0.3"}', 121),
  '121:P0001:rate_limited:操作太頻繁，請稍後再試', 'G02-5 時段查詢:同一 IP 第 121 次被擋');
select is(pg_temp.hammer('slots', '{"x-forwarded-for":"10.0.0.1"}', 3),
  '0', 'G02-6 兩支函式各算各的(10.0.0.1 在預約頁用完,時段查詢照常)');
select is((select array_agg(p.proname::text || ':' || p.provolatile::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('get_public_booking_page', 'get_public_available_slots')),
  array['get_public_available_slots:v', 'get_public_booking_page:v'], 'G02-7 兩支公開函式改成 volatile');
select is((select count(*)::int from private.rate_limit_hits
           where key_hash in (encode(sha256(convert_to('ip:6.6.6.6', 'UTF8')), 'hex'))),
  0, 'G02-8 沒有任何計數用到 XFF 第一段(客人可偽造的那段)');

select * from finish();
rollback;
