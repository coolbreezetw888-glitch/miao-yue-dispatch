-- 第 11 批 D(#991,2026-10-07):拿掉「電話驗證狀態」人工標記。
--
-- 使用者裁決:客戶要登入的前提就是收到簡訊、輸入驗證碼,未來不需要客服人工標記電話已驗證。
-- 規格書 §十(.project/specs/改掛會員與預設文案全形-第11批.md):
--   ① drop 唯一的寫入路徑 public.set_member_phone_verified(uuid, boolean);
--   ② 「核發獎勵資格條件」收掉靠這個欄位的 phone_verified / either / both 三個選項
--      ⇒ CHECK 收緊成 none / line_bound(不收的話商家一選「只看電話已驗證」,所有會員都拿不到點數);
--   ③ members.phone_verified / phone_verified_at 兩欄**保留**(4 支紅利核心函式仍以參數傳入,值恆為 false),
--      加退場註解;模組 13 簡訊登入上線時改用 identity_verified_at 表達,屆時一併 drop。
--   ④ **不 update 任何一列**。private.member_meets_reward_condition 本體不改(md5 維持 0d988cdd…),只補註解。
--
-- 📌 不需要 revoke / grant(沒有新增函式)。

-- ---------------------------------------------------------------------------
-- 1. 動手前斷言:不符就整支失敗(不自己改商家的規則設定)
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad_modes int;
  v_callers int;
begin
  select count(*) into v_bad_modes
  from public.merchant_member_settings
  where reward_condition_mode <> all (array['none', 'line_bound']);
  if v_bad_modes <> 0 then
    raise exception '有 % 間商家的核發資格條件仍用到電話驗證，請先回報主腦。', v_bad_modes;
  end if;

  select count(*) into v_callers
  from pg_proc
  where prosrc ilike '%set_member_phone_verified%'
    and proname <> 'set_member_phone_verified';
  if v_callers <> 0 then
    raise exception '還有 % 支函式在呼叫 set_member_phone_verified，請先回報主腦。', v_callers;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. drop 寫入路徑(完整簽章,不用 if exists:簽章對不上要讓它失敗)
-- ---------------------------------------------------------------------------
drop function public.set_member_phone_verified(uuid, boolean);

-- ---------------------------------------------------------------------------
-- 3. 核發獎勵資格條件只剩 none / line_bound
-- ---------------------------------------------------------------------------
alter table public.merchant_member_settings
  drop constraint merchant_member_settings_reward_condition_mode_check,
  add constraint merchant_member_settings_reward_condition_mode_check
    check (reward_condition_mode in ('none', 'line_bound'));

-- ---------------------------------------------------------------------------
-- 4. 欄位退場註解
-- ---------------------------------------------------------------------------
comment on column public.members.phone_verified is
  '已退場(第 11 批 D,2026-10-07):原本是客服人工標記，使用者裁決拿掉。沒有任何寫入路徑，恆為 false。🔴 不可再新增寫入路徑或畫面。保留欄位只因 4 支紅利核心函式仍以參數傳入(值恆為 false，結果不受影響)；模組 13 簡訊登入上線時改用 identity_verified_at 表達，屆時一併 drop。';

comment on column public.members.phone_verified_at is
  '已退場(第 11 批 D,2026-10-07):原本是客服人工標記電話已驗證的時間，使用者裁決拿掉。沒有任何寫入路徑，恆為 null。🔴 不可再新增寫入路徑或畫面。模組 13 簡訊登入上線時改用 identity_verified_at 表達，屆時與 phone_verified 一併 drop。';

-- ---------------------------------------------------------------------------
-- 5. 函式註解補一句(本體不改)
-- ---------------------------------------------------------------------------
comment on function private.member_meets_reward_condition(text, boolean, boolean) is
  '模組 10 §10.7(SPECS-INDEX #619):依 merchant_member_settings.reward_condition_mode 判斷某位會員是否符合核發資格。none=不設條件;phone_verified=只看電話已驗證;line_bound=只看 LINE 已綁定;either=任一即可;both=兩者皆要。只給 compute_member_loyalty_points/grant_pending_birthday_bonuses 內部呼叫,不對外暴露。第 11 批 D(2026-10-07)起 phone_verified / either / both 三個分支不會被走到(CHECK 只剩 none / line_bound;members.phone_verified 已退場、恆為 false)。';
