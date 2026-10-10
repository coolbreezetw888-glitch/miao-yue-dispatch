-- SPECS-INDEX #1053(全面體檢 B-01):各店 LINE Messaging API 金鑰搬進 Vault — migration B
-- 規格書 .project/specs/LINE金鑰搬Vault.md
--
-- ⚠️ 上線順序:migration A → 部署全部相關 Edge Function(不再讀明文欄位)→ 才套這支 B。
--
-- 這支做的事:
--   1. 再核對一次:每一列都有 Vault id + 末 4 碼,且仍有明文的列 Vault 解密後與明文一致;不符就整支失敗(什麼都不改)。
--   2. 把明文欄位清成 null(讓舊值所在的資料列版本變成可回收的舊版本;drop column 本身不會清掉磁碟上的舊值)。
--   3. drop 明文欄位 channel_secret / channel_access_token。
--   4. 4 個新欄位改成 not null(之後每一列都必須有 Vault id 與末 4 碼)。
-- 擇一理由(規格 R6):同一支清 null 後直接 drop,不留到下一版 —— A 之後已經沒有任何函式或 Edge 讀寫明文欄位,
-- 保留欄位只會留下「之後有人不小心又寫回明文」的空間;而回退需求由 A 的核對 + Vault 保存原值涵蓋。

do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad
    from public.merchant_line_configs c
    left join vault.decrypted_secrets s on s.id = c.channel_secret_vault_id
    left join vault.decrypted_secrets t on t.id = c.channel_access_token_vault_id
   where nullif(s.decrypted_secret, '') is null
      or nullif(t.decrypted_secret, '') is null
      or c.channel_secret_last4 is null
      or c.channel_access_token_last4 is null
      or (nullif(btrim(c.channel_secret), '') is not null and s.decrypted_secret <> btrim(c.channel_secret))
      or (nullif(btrim(c.channel_access_token), '') is not null and t.decrypted_secret <> btrim(c.channel_access_token));
  if v_bad > 0 then
    raise exception '#1053 B 前置核對不符:% 列的 Vault 金鑰缺漏或與明文不一致,請先確認 migration A 已正確套用', v_bad;
  end if;
end;
$$;

-- 清 null 時不要動到 updated_at(那是「商家最後一次改設定」的時間)。
alter table public.merchant_line_configs disable trigger merchant_line_configs_set_updated_at;
update public.merchant_line_configs
   set channel_secret = null, channel_access_token = null
 where channel_secret is not null or channel_access_token is not null;
alter table public.merchant_line_configs enable trigger merchant_line_configs_set_updated_at;

alter table public.merchant_line_configs drop column channel_secret;
alter table public.merchant_line_configs drop column channel_access_token;

alter table public.merchant_line_configs alter column channel_secret_vault_id set not null;
alter table public.merchant_line_configs alter column channel_access_token_vault_id set not null;
alter table public.merchant_line_configs alter column channel_secret_last4 set not null;
alter table public.merchant_line_configs alter column channel_access_token_last4 set not null;

comment on table public.merchant_line_configs is 'LINE 官方帳號串接設定(對應規格書 1.1)。#1053:Channel Secret / Access Token 存在 Vault(line_messaging_channel_secret:<merchant_id> / line_messaging_access_token:<merchant_id>),表裡只放 Vault id 與末 4 碼;列被刪時觸發器一併刪 Vault。沒有任何 RLS 政策、anon / authenticated 沒有表權限;寫入只透過 set_merchant_line_credentials,Edge Function 讀金鑰只透過 internal_get_line_messaging_credentials(service_role)。';
