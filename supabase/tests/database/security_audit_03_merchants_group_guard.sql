-- 安全回歸測試(2026-09-24 深夜巡檢批次 A4)。
-- 對應 migration:20260924020200_merchants_group_id_guard.sql
--
-- 【為什麼需要這份測試】
-- merchants_update 政策的 using/with check 都只判斷這一列的「id」(is_merchant_admin(id)),
-- 跟 group_id 完全無關,而 RLS 的 UPDATE 政策又限制不了欄位。結果是店長可以自己把店
-- 搬到別的集團底下,原集團管理者(靠 groups.group_admin_user_id 繼承取得存取權)的
-- is_merchant_admin() 立刻失效,從此看不到也管不到這間店,而且沒有任何自救途徑。
-- 這份測試釘住:商家管理員改不動 group_id、平台管理員改得動、其他既有流程沒被誤擋。
begin;

select plan(9);

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

create function pg_temp.test_clear_auth()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;

-- =========================================================================
-- Fixture:兩個集團,A 集團底下兩間店(避免停用測試撞到
-- prevent_disable_last_active_merchant 那個「至少保留一間啟用中商家」的既有規則)。
--   01 = A 集團某間店的店長(攻擊者)
--   02 = 平台管理員
-- =========================================================================
insert into auth.users (id, email) values
  ('d3000000-0000-4000-8000-000000000001', 'pgtap-sec03-owner@test.local'),
  ('d3000000-0000-4000-8000-000000000002', 'pgtap-sec03-platform@test.local');

insert into platform_admins (user_id) values ('d3000000-0000-4000-8000-000000000002');

insert into groups (id) values
  ('d3000000-0000-4000-8000-000000000011'),
  ('d3000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('d3000000-0000-4000-8000-000000000021', 'd3000000-0000-4000-8000-000000000011', 'A 集團一號店', 'in_store_beauty'),
  ('d3000000-0000-4000-8000-000000000022', 'd3000000-0000-4000-8000-000000000011', 'A 集團二號店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('d3000000-0000-4000-8000-000000000021', 'd3000000-0000-4000-8000-000000000001'),
  ('d3000000-0000-4000-8000-000000000022', 'd3000000-0000-4000-8000-000000000001');

-- =========================================================================
-- ①~④ 負面 + 一般編輯回歸:店長改不動 group_id,但其他欄位照常可以改。
-- =========================================================================
select pg_temp.test_set_auth('d3000000-0000-4000-8000-000000000001');

select throws_ok(
  $$update merchants
      set group_id = 'd3000000-0000-4000-8000-000000000012'
    where id = 'd3000000-0000-4000-8000-000000000021'$$,
  '42501', '商家的集團歸屬只能由平台管理員調整,商家管理員不能自行把店搬到其他集團',
  'A4 核心:商家管理員不能自己把店搬到別的集團(這就是原本的漏洞)'
);

select is(
  (select group_id from merchants where id = 'd3000000-0000-4000-8000-000000000021'),
  'd3000000-0000-4000-8000-000000000011'::uuid,
  'A4:攻擊被擋下,商家的集團歸屬完全沒有被改動'
);

select lives_ok(
  $$update merchants
      set name = 'A 集團一號店(改名)', address = '台北市某路 1 號', intro = '測試簡介'
    where id = 'd3000000-0000-4000-8000-000000000021'$$,
  'A4 回歸:商家管理員的一般設定編輯(名稱/地址/簡介)完全不受影響'
);

select lives_ok(
  $$update merchants set status = 'disabled' where id = 'd3000000-0000-4000-8000-000000000022'$$,
  'A4 回歸:停用分店(只改 status)沒有被誤擋'
);

-- ⑤ 回歸:新增分店走的是 INSERT,BEFORE UPDATE 觸發器不該有任何影響。
select lives_ok(
  $$select public.create_merchant_in_group(
      'd3000000-0000-4000-8000-000000000011', 'A 集團三號店', 'in_store_beauty')$$,
  'A4 回歸:create_merchant_in_group(INSERT 路徑)完全不受 BEFORE UPDATE 觸發器影響'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑥⑦ 正面:平台管理員(超級管理員)可以調整集團歸屬——集團編制本來就是平台層級的事。
-- =========================================================================
select pg_temp.test_set_auth('d3000000-0000-4000-8000-000000000002');

select lives_ok(
  $$update merchants
      set group_id = 'd3000000-0000-4000-8000-000000000012'
    where id = 'd3000000-0000-4000-8000-000000000021'$$,
  'A4 正面:平台管理員可以變更商家的集團歸屬'
);

select is(
  (select group_id from merchants where id = 'd3000000-0000-4000-8000-000000000021'),
  'd3000000-0000-4000-8000-000000000012'::uuid,
  'A4 正面:平台管理員的變更真的生效,不是被靜默擋下'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑧ 繞道 1:service_role(後台維運 / 未來的 Edge Function)不受限制。
-- =========================================================================
select pg_temp.test_set_auth('d3000000-0000-4000-8000-000000000001', 'service_role');

select lives_ok(
  $$update merchants
      set group_id = 'd3000000-0000-4000-8000-000000000011'
    where id = 'd3000000-0000-4000-8000-000000000021'$$,
  'A4:service_role 仍然可以調整集團歸屬(第一道繞道)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑨ 觸發器本身存在。
-- =========================================================================
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.merchants'::regclass
      and tgname = 'merchants_protect_group_id_column'
      and not tgisinternal
  ),
  'A4:merchants_protect_group_id_column 觸發器確實存在'
);

select * from finish();
rollback;
