-- 資料正確性回歸測試(2026-09-24 深夜巡檢批次 B1 / B2 / B3)。
-- 對應 migration:
--   20260924020300_fix_rollback_bulk_operation_member_tier.sql
--   20260924020400_fix_update_booking_material_cost_snapshot.sql
--   20260924020500_fix_import_members_batch_member_tier.sql
--
-- 【為什麼需要這份測試】
-- ・B1:update_member 在 #615 被改成 7 個參數(第 7 個 p_tier_id 有 default null,而函式內部
--       是無條件 `tier_id = p_tier_id`),但 rollback_bulk_operation 還停在 6 個參數的呼叫法,
--       於是「復原會員匯入」會靜默把被復原會員的會員等級清成未分級,使用者完全不會被告知。
-- ・B2:update_booking 重寫料錢關聯表時直接讀 material_cost_items.amount 的「即時」金額,
--       破壞 booking_material_costs.amount_snapshot 的快照原則——商家調整品項價格之後,
--       任何一次編輯訂單(哪怕只是改客戶電話的錯字)都會把舊單的料錢成本改成新價格,
--       連帶改掉 net_of_material_cost 模式下的師傅抽成基準。
-- ・B3:跟 B1 同源、但影響更大的一支——import_members_batch 在 upsert_by_phone 模式下同樣
--       只傳 6 個參數,所以「每一次」匯入都會把電話對上的既有會員的等級清成未分級。
begin;

select plan(12);

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

insert into auth.users (id, email) values
  ('d4000000-0000-4000-8000-000000000001', 'pgtap-data01-admin@test.local');

insert into groups (id) values ('d4000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('d4000000-0000-4000-8000-000000000020', 'd4000000-0000-4000-8000-000000000010', '資料正確性測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('d4000000-0000-4000-8000-000000000020', 'd4000000-0000-4000-8000-000000000001');

-- =========================================================================
-- B1 fixture:一個會員等級 + 一位屬於該等級的會員。
-- =========================================================================
insert into merchant_member_tiers (id, merchant_id, name)
values ('d4000000-0000-4000-8000-000000000070', 'd4000000-0000-4000-8000-000000000020', 'VIP');

select pg_temp.test_set_auth('d4000000-0000-4000-8000-000000000001');

-- 這位會員的「目前」狀態 = 匯入已經把姓名/備註蓋掉之後的樣子,等級是 VIP。
select id from create_member(
  'd4000000-0000-4000-8000-000000000020',
  '匯入時被蓋掉的新姓名',
  '0955000002',
  null, null, '匯入時被蓋掉的新備註',
  null,
  'd4000000-0000-4000-8000-000000000070'
) \gset data01_member_

select pg_temp.test_clear_auth();

-- 模擬「一次 upsert_by_phone 會員匯入把這位既有會員改過」的批次紀錄。
-- 刻意手工建立而不是真的跑 import_members_batch,原因有二:
--   ① 這裡要驗的是 rollback_bulk_operation 這一條路徑本身,fixture 越單純越好定位問題;
--   ② pre_operation_snapshot 的結構(只有 name/phone/email/birthday/notes 五個欄位,
--      沒有 tier_id)是 20260920170100 寫死的,手工照抄同樣的結構才能真實重現當時的情境。
-- created_at 必須等於這位會員目前的 updated_at,否則 rollback 會判定「匯入後又被編輯過」而跳過。
insert into merchant_bulk_operations (
  id, merchant_id, operation_type, write_mode, status,
  total_rows, success_rows, created_by_user_id, created_at, pre_operation_snapshot
)
select
  'd4000000-0000-4000-8000-000000000080',
  'd4000000-0000-4000-8000-000000000020',
  'member_import', 'upsert_by_phone', 'completed',
  1, 1, 'd4000000-0000-4000-8000-000000000001', m.updated_at,
  jsonb_build_object('members', jsonb_build_object(
    m.id::text,
    jsonb_build_object(
      'name', '匯入前的原本姓名',
      'phone', '0955000001',
      'email', null,
      'birthday', null,
      'notes', '原本的備註'
    )
  ))
from members m
where m.id = :'data01_member_id'::uuid;

insert into merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
values ('d4000000-0000-4000-8000-000000000080', 'members', :'data01_member_id'::uuid, 'updated');

-- =========================================================================
-- ①~③ B1:復原之後,基本資料被還原,而且會員等級「沒有」被清空。
-- =========================================================================
select pg_temp.test_set_auth('d4000000-0000-4000-8000-000000000001');

select is(
  (select (public.rollback_bulk_operation('d4000000-0000-4000-8000-000000000080') ->> 'restored_count')::int),
  1,
  'B1:復原成功處理了 1 筆會員(沒有被判定成「匯入後被編輯過」而跳過)'
);

select is(
  (select tier_id from members where id = :'data01_member_id'::uuid),
  'd4000000-0000-4000-8000-000000000070'::uuid,
  'B1 核心:復原會員匯入之後,會員等級仍然是 VIP,沒有被靜默清成未分級'
);

select is(
  (select name from members where id = :'data01_member_id'::uuid),
  '匯入前的原本姓名',
  'B1:復原確實有把姓名還原成匯入前的快照值(證明真的跑到那段 update_member,不是空轉)'
);

-- =========================================================================
-- ④~⑥ B3:upsert_by_phone 匯入「不能」清掉電話對上的既有會員的會員等級。
--     這一段仍然在商家管理員的登入狀態下執行(import_members_batch 只有商家管理員能呼叫)。
-- =========================================================================
select id from create_member(
  'd4000000-0000-4000-8000-000000000020',
  '匯入前就存在的熟客',
  '0955000003',
  null, null, '原本的備註',
  null,
  'd4000000-0000-4000-8000-000000000070'
) \gset data01_vip_

-- 一份只有姓名+電話的 CSV(匯入格式本來就沒有「會員等級」欄位),電話跟上面這位熟客對得上。
select public.import_members_batch(
  'd4000000-0000-4000-8000-000000000020',
  'upsert_by_phone',
  jsonb_build_array(jsonb_build_object(
    'row_number', 1,
    'name', '匯入後的新姓名',
    'phone', '0955000003'
  ))
) as op_id \gset data01_import_

select is(
  (select success_rows from merchant_bulk_operations where id = :'data01_import_op_id'::uuid),
  1,
  'B3:upsert_by_phone 匯入成功更新了 1 筆既有會員(不是整列失敗被吞進 error_report)'
);

select is(
  (select name from members where id = :'data01_vip_id'::uuid),
  '匯入後的新姓名',
  'B3:匯入確實有更新到這位既有會員(證明真的走到 update_member,不是空轉)'
);

select is(
  (select tier_id from members where id = :'data01_vip_id'::uuid),
  'd4000000-0000-4000-8000-000000000070'::uuid,
  'B3 核心:upsert_by_phone 匯入之後,既有會員的 VIP 等級仍然保留,沒有被靜默清成未分級'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- B2 fixture:可以用料錢成本的商家 + 一筆已建立的預約。
-- =========================================================================
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('d4000000-0000-4000-8000-000000000020', 2, false, '00:00', '23:59');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('d4000000-0000-4000-8000-000000000030', 'd4000000-0000-4000-8000-000000000020', '染髮', 2000, 'primary', 60);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('d4000000-0000-4000-8000-000000000040', 'd4000000-0000-4000-8000-000000000020', '設計師', '0901000501', true);

insert into payment_methods (id, merchant_id, name)
values ('d4000000-0000-4000-8000-000000000060', 'd4000000-0000-4000-8000-000000000020', '現場付款');

insert into merchant_feature_flags (merchant_id, feature_key, enabled)
values ('d4000000-0000-4000-8000-000000000020', 'material_cost_enabled', true);

insert into material_cost_items (id, merchant_id, name, amount) values
  ('d4000000-0000-4000-8000-000000000091', 'd4000000-0000-4000-8000-000000000020', '染劑', 300),
  ('d4000000-0000-4000-8000-000000000092', 'd4000000-0000-4000-8000-000000000020', '護髮素', 800);

select pg_temp.test_set_auth('d4000000-0000-4000-8000-000000000001');

-- 9/1 建單,只選「染劑」,當時是 300 元。
select id from create_booking(
  'd4000000-0000-4000-8000-000000000020', 'd4000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id','d4000000-0000-4000-8000-000000000030','quantity',1,'unit_price',2000)),
  '2026-09-22 10:00:00+08', '客戶甲', '0988000501',
  p_material_cost_item_ids => array['d4000000-0000-4000-8000-000000000091']::uuid[],
  p_payment_method_id => 'd4000000-0000-4000-8000-000000000060'
) \gset data01_booking_

-- ⑦ 建單當下的快照就是當時的金額(create_booking 的行為不變)。
select is(
  (select amount_snapshot from booking_material_costs
    where booking_id = :'data01_booking_id'::uuid
      and material_cost_item_id = 'd4000000-0000-4000-8000-000000000091'),
  300::numeric(10,2),
  'B2:建單當下「染劑」的快照金額是 300(create_booking 行為不變)'
);

select pg_temp.test_clear_auth();

-- 9/5 商家把「染劑」調漲成 500(品項設定變更,跟已建立的舊單無關)。
update material_cost_items set amount = 500 where id = 'd4000000-0000-4000-8000-000000000091';

select pg_temp.test_set_auth('d4000000-0000-4000-8000-000000000001');

-- 9/6 客服只是進去改個客戶電話的錯字就存檔(料錢品項完全沒變)。
select update_booking(
  :'data01_booking_id'::uuid, 'd4000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id','d4000000-0000-4000-8000-000000000030','quantity',1,'unit_price',2000)),
  '2026-09-22 10:00:00+08', '客戶甲', '0988000599',
  p_material_cost_item_ids => array['d4000000-0000-4000-8000-000000000091']::uuid[],
  p_payment_method_id => 'd4000000-0000-4000-8000-000000000060'
);

-- ⑧ 核心:舊品項的快照必須維持 300,不能變成品項現在的 500。
select is(
  (select amount_snapshot from booking_material_costs
    where booking_id = :'data01_booking_id'::uuid
      and material_cost_item_id = 'd4000000-0000-4000-8000-000000000091'),
  300::numeric(10,2),
  'B2 核心:品項漲價後再編輯訂單,舊品項的 amount_snapshot 仍然是原始快照 300'
);

-- ⑨ 對照:編輯確實有生效(證明上面不是因為 update_booking 根本沒跑到)。
select is(
  (select customer_phone from bookings where id = :'data01_booking_id'::uuid),
  '0988000599',
  'B2:這次編輯確實生效了(客戶電話已更新),所以 ⑤ 不是因為 update_booking 沒跑'
);

-- 再編輯一次,這次「新增」一個之前沒有的品項「護髮素」(目前 800)。
select update_booking(
  :'data01_booking_id'::uuid, 'd4000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id','d4000000-0000-4000-8000-000000000030','quantity',1,'unit_price',2000)),
  '2026-09-22 10:00:00+08', '客戶甲', '0988000599',
  p_material_cost_item_ids => array[
    'd4000000-0000-4000-8000-000000000091',
    'd4000000-0000-4000-8000-000000000092'
  ]::uuid[],
  p_payment_method_id => 'd4000000-0000-4000-8000-000000000060'
);

-- ⑩ 舊品項依然維持原始快照。
select is(
  (select amount_snapshot from booking_material_costs
    where booking_id = :'data01_booking_id'::uuid
      and material_cost_item_id = 'd4000000-0000-4000-8000-000000000091'),
  300::numeric(10,2),
  'B2:加了新品項之後,原有品項的快照依然是 300'
);

-- ⑪ 新加入的品項要用「現在」的金額當快照(這才是新品項的正確快照時點)。
select is(
  (select amount_snapshot from booking_material_costs
    where booking_id = :'data01_booking_id'::uuid
      and material_cost_item_id = 'd4000000-0000-4000-8000-000000000092'),
  800::numeric(10,2),
  'B2:這次新加入的「護髮素」用的是品項目前的金額 800'
);

-- ⑫ 總筆數正確(整批刪除重寫沒有漏寫或重複)。
select is(
  (select count(*) from booking_material_costs where booking_id = :'data01_booking_id'::uuid)::int,
  2,
  'B2:重寫後料錢關聯表剛好兩筆,沒有漏寫也沒有重複'
);

select pg_temp.test_clear_auth();

select * from finish();
rollback;
