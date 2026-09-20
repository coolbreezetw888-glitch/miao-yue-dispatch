-- 模組 11(LINE 通知)回填 migration
-- 對應模組 7/9 已經記錄過的既有教訓(見「開發流程紀錄.md」/PROGRESS.md 2026-09-19 條目):
-- seed_default_line_event_settings(3.20)只疊加在 create_group_and_merchant/create_merchant_in_group
-- 這兩支「建立新商家」的函式裡,對「這次上線前就已經存在的商家」(涼風工匠、美甲)完全沒有
-- 補做——如果不回填,等之後 4.1~4.2 的前端頁面做出來,這兩間真實商家會發現自己的 LINE 通知設定
-- 頁面永遠是空的(merchant_line_event_settings 一筆都沒有),要點兩下才會發現要去哪裡種資料。
-- 這裡對「所有目前已存在、但還沒有任何 merchant_line_event_settings 記錄」的商家補種一次,
-- seed_default_line_event_settings 本身冪等(on conflict do nothing),不會重複造成資料異常。
do $$
declare
  v_merchant record;
begin
  for v_merchant in
    select m.id
    from public.merchants m
    where not exists (
      select 1 from public.merchant_line_event_settings s where s.merchant_id = m.id
    )
  loop
    perform public.seed_default_line_event_settings(v_merchant.id);
  end loop;
end;
$$;
