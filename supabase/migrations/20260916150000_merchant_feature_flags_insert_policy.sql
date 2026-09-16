-- 品管打回修正(SPECS-INDEX 編號 123/127/142):merchant_feature_flags 補上 INSERT 政策。
--
-- 背景:`setFeatureFlag()`(src/modules/merchant/api.ts)原本只用 .update()。新商家的
-- merchant_feature_flags 一開始是 0 筆,UPDATE 影響 0 筆但不報錯,商家管理員在
-- /app/business-hours 關閉「嚴格工時衝突檢查」時看到成功提示,但實際上什麼都沒寫入。
--
-- 修法本身分兩部分:
-- ① 前端 setFeatureFlag() 改成 upsert(onConflict: merchant_id,feature_key)——見這次的程式碼改動。
-- ② 但 20260916064727_booking_functions(本機檔名 20260916140100_booking_functions.sql)當時
--    只補了 UPDATE 政策(見該檔案「1.4/規則 2.4」段落的說明,寫入權限比照 can_manage_business_hours),
--    沒有補 INSERT 政策——這在「表裡已經有這一列」的情境下沒問題,但新商家 0 筆資料時,
--    upsert 底層送出的是 INSERT ... ON CONFLICT DO UPDATE,PostgREST/Postgres 仍然需要
--    INSERT 政策才會放行 INSERT 分支,否則會被 RLS 擋下(這次一併補上,不然只改前端 upsert
--    對新商家還是會失敗,只是从「靜默 0 筆」變成「明確的 RLS 錯誤」,一樣達不到規格要求)。
--
-- 寫入權限沿用既有 UPDATE 政策同一套判斷:private.can_manage_business_hours(merchant_id)
-- (商家管理員永遠可以,或該商家目前有效且被開通 business_hours 這個 section_key 的客服)。
create policy merchant_feature_flags_insert on public.merchant_feature_flags
  for insert to authenticated
  with check (private.can_manage_business_hours(merchant_id));

comment on policy merchant_feature_flags_insert on public.merchant_feature_flags is
  '補上 INSERT 政策,讓 setFeatureFlag() 改成 upsert 後,新商家第一次設定任何功能開關(0 筆列的情況)也能寫入,不只能更新既有列。寫入權限比照既有 UPDATE 政策,同樣歸在 business_hours 這把鑰匙底下(SPECS-INDEX 編號 123/127/142 打回修正)。';
