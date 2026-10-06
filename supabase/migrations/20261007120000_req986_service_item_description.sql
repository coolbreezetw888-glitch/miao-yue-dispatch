-- SPECS-INDEX #986 第 9 批(2026-10-07,使用者裁決 2「服務項目加描述欄位」)。
-- 規格:.project/specs/使用者裁決小項與第7批調整-第9批.md 3-3(需求 9-7)。
--
-- service_items 加一個選填的「項目描述」,最多 200 字(資料庫 CHECK 擋)。
--   ・不回填:既有資料全部 null(= 沒填)。
--   ・空字串一律存 null:前端送出前 trim,空白送 null(不加 trigger)。
--   ・寫入照舊走表層 RLS(service_items_insert / service_items_update → private.can_manage_service_items),
--     不放寬任何 policy。service_items 沒有欄位層級的 grant(本機 information_schema.column_privileges 查過,
--     authenticated 的 insert / update 都是表層授權),新欄位不用另外補 grant。
--   ・資料匯入、apply_industry_preset 等既有 insert 不帶這欄 ⇒ null,不受影響。

alter table public.service_items add column if not exists description text;

alter table public.service_items
  add constraint service_items_description_length_check
  check (description is null or char_length(description) <= 200);

comment on column public.service_items.description is 'SPECS-INDEX #986 第 9 批:服務項目描述(選填,最多 200 字;空白一律存 null)。只顯示在服務項目管理頁與建單「選擇項目」整頁的卡片上,不進訂單、報表。';
