-- 模組 11:LINE 通知 — 3.1~3.3 憑證管理函式
-- 對應規則 2.1:三支函式一律只認 private.is_merchant_admin,不接受客服呼叫(即使被授權
-- line_notification 也一樣被擋下)。

-- =========================================================================
-- 3.1 set_merchant_line_credentials
-- =========================================================================
create or replace function public.set_merchant_line_credentials(
  p_merchant_id uuid,
  p_channel_id text,
  p_channel_secret text,
  p_channel_access_token text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '沒有權限設定這間商家的 LINE 串接憑證' using errcode = '42501';
  end if;

  if p_channel_id is null or length(trim(p_channel_id)) = 0 then
    raise exception 'Channel ID 不可為空';
  end if;
  if p_channel_secret is null or length(trim(p_channel_secret)) = 0 then
    raise exception 'Channel Secret 不可為空';
  end if;
  if p_channel_access_token is null or length(trim(p_channel_access_token)) = 0 then
    raise exception 'Channel Access Token 不可為空';
  end if;

  insert into public.merchant_line_configs (
    merchant_id, channel_id, channel_secret, channel_access_token, is_connected, updated_at
  ) values (
    p_merchant_id, trim(p_channel_id), trim(p_channel_secret), trim(p_channel_access_token), false, now()
  )
  on conflict (merchant_id) do update set
    channel_id = excluded.channel_id,
    channel_secret = excluded.channel_secret,
    channel_access_token = excluded.channel_access_token,
    -- 重新填寫憑證後 is_connected 重設為 false,必須重新測試連線才會再度變成 true,避免商家改了
    -- 一組錯誤的憑證卻誤以為狀態還是「已連線」。
    is_connected = false,
    updated_at = now();
end;
$$;

comment on function public.set_merchant_line_credentials(uuid, text, text, text) is '規則 2.1/3.1:商家管理員設定/更新 LINE 官方帳號憑證,寫入後 is_connected 重設為 false。';

revoke execute on function public.set_merchant_line_credentials(uuid, text, text, text) from public, anon;
grant execute on function public.set_merchant_line_credentials(uuid, text, text, text) to authenticated;

-- =========================================================================
-- 3.2 get_merchant_line_config_status
-- =========================================================================
create or replace function public.get_merchant_line_config_status(p_merchant_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_row public.merchant_line_configs;
begin
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的 LINE 串接狀態' using errcode = '42501';
  end if;

  select * into v_row from public.merchant_line_configs where merchant_id = p_merchant_id;

  if v_row.merchant_id is null then
    return jsonb_build_object(
      'is_connected', false,
      'channel_id', null,
      'channel_access_token_masked', null,
      'display_name', null,
      'line_bot_basic_id', null,
      'last_tested_at', null,
      'last_test_result', null
    );
  end if;

  return jsonb_build_object(
    'is_connected', v_row.is_connected,
    'channel_id', v_row.channel_id,
    'channel_access_token_masked', '••••' || right(v_row.channel_access_token, 4),
    'display_name', v_row.display_name,
    'line_bot_basic_id', v_row.line_bot_basic_id,
    'last_tested_at', v_row.last_tested_at,
    'last_test_result', v_row.last_test_result
  );
end;
$$;

comment on function public.get_merchant_line_config_status(uuid) is '規則 2.1/3.2:回傳遮蔽過的 LINE 串接狀態,查無資料回傳「尚未串接」的預設物件,不報錯。channel_secret/完整 channel_access_token 永遠不會被讀回前端。';

revoke execute on function public.get_merchant_line_config_status(uuid) from public, anon;
grant execute on function public.get_merchant_line_config_status(uuid) to authenticated;

-- =========================================================================
-- 3.3 disconnect_merchant_line
-- =========================================================================
create or replace function public.disconnect_merchant_line(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '沒有權限解除這間商家的 LINE 串接' using errcode = '42501';
  end if;

  delete from public.merchant_line_configs where merchant_id = p_merchant_id;
  -- 判斷 12:不刪除通知設定/文案範本/發送記錄/已綁定帳號,重新填入正確憑證就能立刻恢復運作。
end;
$$;

comment on function public.disconnect_merchant_line(uuid) is '規則 2.1/3.3/判斷 12:解除 LINE 串接(只清空憑證),不影響通知設定/發送記錄/已綁定帳號。';

revoke execute on function public.disconnect_merchant_line(uuid) from public, anon;
grant execute on function public.disconnect_merchant_line(uuid) to authenticated;
