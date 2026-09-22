-- 模組 15:服務人員推播通知 — 第五節排程機制。啟用 pg_cron/pg_net,新增每日排程任務呼叫
-- push-notify-reminder-dispatch(規則 4.8)。
--
-- ⚠️ 安全原則(規則 4.8 第 4 點):共用密鑰本身不寫進這份 migration 檔案。密鑰已經在 2026-09-22
-- 由 engineer 用 `select vault.create_secret(...)` 手動在 SQL Editor 執行一次性設定
-- (name = 'push_reminder_cron_secret'),這裡的 cron.schedule 只透過
-- `(select decrypted_secret from vault.decrypted_secrets where name = 'push_reminder_cron_secret')`
-- 在執行當下讀取,檔案裡完全沒有出現真正的密鑰值。
--
-- 官方文件查證(2026-09-22,search_docs):pg_cron 官方安裝指南建議
-- `create extension pg_cron with schema pg_catalog;` + 授權 cron schema 給 postgres;
-- pg_net 官方範例建議 `with schema extensions`(避免污染 public schema)。

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create extension if not exists pg_net with schema extensions;

-- 每天 UTC 01:00(等於台北時間早上 9 點,對應規格書判斷 5 的預設值)觸發一次。
-- 這個排程任務只負責「觸發」,實際的查詢/發送邏輯都在 Edge Function 裡(第五節說明 2)。
select
  cron.schedule(
    'push-notify-reminder-daily',
    '0 1 * * *',
    $$
    select
      net.http_post(
        url := 'https://wjtbmmnakcriuaqoknsq.supabase.co/functions/v1/push-notify-reminder-dispatch',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_reminder_cron_secret')
        ),
        body := '{}'::jsonb
      ) as request_id;
    $$
  );
