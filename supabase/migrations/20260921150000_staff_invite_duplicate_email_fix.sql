-- 對應規格書 .project/specs/服務人員管理優化與硬刪除.md 第一節(需求 3,優先處理):
-- 重複邀請同一個信箱會失敗的 bug 修正。
--
-- 已在正式環境(wjtbmmnakcriuaqoknsq)用真實測試資料重現過一次規格書 §1.1 描述的情境
-- (邀請 A、A 完成登入設定密碼、移除 A、新建 B、用同一信箱邀請 B),重現結果與規格書診斷完全一致:
--   ERROR: 23505: duplicate key value violates unique constraint "merchant_staff_merchant_user_unique"
--   DETAIL: Key (merchant_id, user_id)=(...) already exists.
-- 根本原因:merchant_staff_merchant_user_unique 這個 partial unique index 只排除
-- user_id is null 的情況,沒有排除 status='removed' 的舊紀錄,導致新人員綁定同一信箱時
-- 跟已移除的舊紀錄撞鍵。動手前已用 pg_get_functiondef/pg_indexes 查證正式環境目前的最新定義,
-- 跟這裡假設的現況一致,不是憑 migration 檔名猜測。
--
-- §1.2.1:調整 partial unique index 的條件,只在「同一人同時是這間商家兩筆在職(active)名錄」
-- 時才擋下,已移除的舊紀錄不再佔用這個 (merchant_id, user_id) 組合。
-- =========================================================================
drop index public.merchant_staff_merchant_user_unique;

create unique index merchant_staff_merchant_user_unique
  on public.merchant_staff (merchant_id, user_id)
  where user_id is not null and status = 'active';

comment on index public.merchant_staff_merchant_user_unique is '只在 user_id 有值且 status=active 時要求 (merchant_id, user_id) 唯一,避免同一人同時是這間商家兩筆在職的人員紀錄。2026-09-21 修正(對應規格書「服務人員管理優化與硬刪除」§1.2.1):原本沒有排除 status=removed 的舊紀錄,導致服務人員被移除後,同一登入信箱要重新綁定給另一位新的服務人員時,會跟已移除的舊紀錄撞鍵失敗(23505)。';

-- =========================================================================
-- §1.2.2:record_invited_staff_login 增加防呆檢查與清楚的中文錯誤訊息。
-- 簽章不變(create or replace 即可):record_invited_staff_login(uuid, uuid, text, text) returns void。
-- =========================================================================
create or replace function public.record_invited_staff_login(
  p_staff_id uuid,
  p_user_id uuid,
  p_invited_login_email text,
  p_login_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conflict_id uuid;
begin
  if p_login_status not in ('invited', 'active') then
    raise exception '不合法的登入狀態: %', p_login_status;
  end if;

  if p_user_id is null then
    raise exception 'p_user_id 不可為 null';
  end if;

  -- 規格書 §1.2.2 第 1 點:調整索引後依然應該被擋下的合理業務衝突——同一個 merchant_id 下,
  -- 已經有另一筆 status='active' 的紀錄,user_id 就是 p_user_id(代表這個帳號已經是本店
  -- 另一位在職服務人員的登入)。找到就丟出清楚的中文錯誤訊息,不要讓使用者看到生硬的資料庫錯誤。
  select id into v_conflict_id
  from public.merchant_staff
  where merchant_id = (select merchant_id from public.merchant_staff where id = p_staff_id)
    and user_id = p_user_id
    and status = 'active'
    and id <> p_staff_id;

  if v_conflict_id is not null then
    raise exception '這個 Email 目前已經是本店另一位在職服務人員的登入帳號,不能重複綁定。如果是同一個人,請先確認是否選錯了服務人員,或聯絡系統管理員協助處理。' using errcode = 'P0001';
  end if;

  -- 規格書 §1.2.2 第 2 點:防禦性最後一道網。萬一索引調整後又漏了某種情境,依然不會讓使用者
  -- 看到原始的 Postgres unique_violation 錯誤訊息,而是回傳清楚的中文說明。
  begin
    update public.merchant_staff
    set user_id = p_user_id,
        invited_login_email = p_invited_login_email,
        login_status = p_login_status,
        login_invited_at = now(),
        login_activated_at = case when p_login_status = 'active' then now() else login_activated_at end
    where id = p_staff_id;
  exception when unique_violation then
    raise exception '這個信箱可能曾經被移除的服務人員使用過,系統應該要能自動處理,如果看到這個訊息代表發生了非預期的資料衝突,請聯絡系統管理員。' using errcode = 'P0001';
  end;

  if not found then
    raise exception '找不到指定的服務人員紀錄: %', p_staff_id;
  end if;

  perform public.seed_default_staff_permissions(p_staff_id);
end;
$$;

comment on function public.record_invited_staff_login(uuid, uuid, text, text) is '對應規格書 3.11,2026-09-21 修正(「服務人員管理優化與硬刪除」§1.2.2):只給 service_role 呼叫,由 Edge Function invite-merchant-staff 寫入邀請結果,並緊接著呼叫 seed_default_staff_permissions 種入預設權限(判斷 1)。新增兩層防呆:①同一帳號已是本店另一位在職服務人員的登入時,回傳清楚的中文說明;②把實際的 UPDATE 包進 exception 區塊,萬一發生非預期的 unique_violation 也不會讓使用者看到原始資料庫錯誤。';

revoke all on function public.record_invited_staff_login(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_invited_staff_login(uuid, uuid, text, text) to service_role;
