-- 第 11 批 E(#992,2026-10-07):客服權限「相依權限」一次存多把、失敗全退。
--
-- 規格書 §11.7(.project/specs/改掛會員與預設文案全形-第11批.md):
--   客服權限頁打開某個權限時,會跳小卡窗問「要不要一起開啟相依的權限」,按「一起開啟」要一次寫入
--   2~3 把。舊的 set_agent_permission 一次只能存一把,連呼叫 3 次時第 2 次失敗就會留下「開一半」。
--   ⇒ 新增 set_agent_permissions(p_agent_id, p_changes jsonb):一次呼叫 = 一個交易,全部成功或全部不動。
--
-- 授權與訊息逐字照抄 set_agent_permission(找不到客服 / 非該商家管理員 42501)。
-- 🔴 刻意**不**在後端檢查「相依必須成立」:那會讓規則上線前就存在的不一致資料(正式庫 4 位客服
--    「會員管理開、紅利點數關」)在商家改別的權限時被擋;相依是前端提示,後端照舊只管「是不是這家商家的管理員」。
-- 舊的 set_agent_permission 保留不動(已開著的舊分頁 / PWA 在更新前仍會呼叫它),下一批再 drop。

create or replace function public.set_agent_permissions(p_agent_id uuid, p_changes jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_merchant_id uuid;
  v_count int;
  v_change jsonb;
  v_keys text[] := array[]::text[];
  v_key text;
begin
  select merchant_id into v_merchant_id
  from public.merchant_agents
  where id = p_agent_id;

  if not found then
    raise exception '找不到指定的客服紀錄：%', p_agent_id;
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  -- 格式檢查(全部檢查完才開始寫,任何一筆不符就整批不寫)
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception '權限變更的格式不正確。' using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_changes);
  if v_count < 1 or v_count > 30 then
    raise exception '權限變更的格式不正確，一次要有 1 到 30 筆。' using errcode = '22023';
  end if;

  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    if jsonb_typeof(v_change) <> 'object'
       or jsonb_typeof(v_change -> 'section_key') is distinct from 'string'
       or jsonb_typeof(v_change -> 'granted') is distinct from 'boolean' then
      raise exception '權限變更的格式不正確。' using errcode = '22023';
    end if;

    v_key := v_change ->> 'section_key';
    if btrim(v_key) = '' then
      raise exception '權限變更的格式不正確。' using errcode = '22023';
    end if;

    if v_key = any (v_keys) then
      raise exception '同一個權限不能在一次變更裡出現兩次。' using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;
  end loop;

  -- 逐筆寫入(與舊函式同一句);函式內任何一筆失敗 ⇒ 整個交易回滾
  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    insert into public.merchant_agent_permissions (agent_id, section_key, granted)
    values (p_agent_id, v_change ->> 'section_key', (v_change ->> 'granted')::boolean)
    on conflict (agent_id, section_key)
    do update set granted = excluded.granted, updated_at = now();
  end loop;
end;
$$;

revoke execute on function public.set_agent_permissions(uuid, jsonb) from public, anon;
grant execute on function public.set_agent_permissions(uuid, jsonb) to authenticated, service_role;

comment on function public.set_agent_permissions(uuid, jsonb) is
  '第 11 批 E(#992,2026-10-07):商家管理員一次寫入某位客服的多把權限(p_changes = [{section_key, granted}],1~30 筆、同一個 section_key 不可重複),一個交易內全部成功或全部不動。授權與訊息照抄 set_agent_permission。刻意不在後端檢查相依(相依是前端提示)。舊的 set_agent_permission 保留,前端已全部改走這支,下一批 drop。';
