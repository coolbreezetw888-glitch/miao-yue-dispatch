-- 2026-09-24 使用者裁決:新增「紅利點數管理」權限鑰匙,把點數**規則**跟點數**交易**分開授權。
--
-- =========================================================================
-- 【使用者裁決原文】
--   餘額總覽、手動調整、登記兌換、異動歷史 = **會員管理**(使用者確認這樣是正確的)
--   核發獎勵資格條件、點數設定(啟用開關/比例/推薦/生日) = **紅利點數管理**這個功能
--
-- 也就是同一頁(紅利點數管理頁)裡分成兩段權限:
--   ・「交易」那一段(看餘額、手動調整、登記兌換、看異動歷史)→ 沿用既有的 members 鑰匙
--   ・「規則」那一段(啟用開關、核發獎勵資格條件、消費點數比例、推薦獎勵、生日贈點)
--     → 新的 member_points 鑰匙
--
-- =========================================================================
-- 【我選了「欄位層級保護 trigger」而不是「專用 RPC」,理由】
--
-- 先說清楚查證結果:`upsertMerchantMemberSettings`(src/modules/members/api.ts:72)走的
-- **不是** RPC,是 PostgREST 的**整列 upsert**
--   supabase.from("merchant_member_settings").upsert({...}, { onConflict: "merchant_id" })
-- 所以權限現在完全由這張表的 RLS 政策決定(private.can_manage_member_settings)。
--
-- 這造成一個必須先看懂才能動手的陷阱(前端工程師也獨立查證並回報了同一件事):
--   ⚠️ **MemberSettingsPage.tsx(走 member_settings 鑰匙)在存「會員政策」時,也會把那五個
--      規則欄位原樣送一次** —— 整列 upsert 的必然結果,它送的是整個表單狀態,不是差異。
--   所以如果把鎖做成「payload 裡含有規則欄位就要求 member_points 權限」,只有
--   member_settings、沒有 member_points 的客服會連「會員政策」都存不了,而那是他本來就有
--   權限做的事。這就是「修了 A 卻壞了 B」。
--
-- 結論:判斷條件必須是「**值真的有變動**」,不是「payload 有沒有帶這個欄位」。
-- 而 Postgres 的 RLS `WITH CHECK` **看不到 OLD**(只能檢查新列的值),沒有任何寫法能表達
-- 「這個欄位有沒有被改動」——這正是 .claude/skills/supabase-permission-hygiene 規則 2
-- 警告的「RLS UPDATE policy 的欄位陷阱」。所以純政策做不到,必須有 trigger 比對 OLD/NEW。
--
-- 那為什麼不改走專用 RPC?
--   ・改 RPC 要同時改前端 api.ts + 兩個頁面的送出邏輯,而前端工程師這一批已經按「欄位名不變、
--     繼續走整列 upsert」的前提完成並交付了。這時候改成 RPC 等於把已完成的前端推翻重做。
--   ・這個 codebase 已經有**現成且被測試釘住**的同型模式:merchant_staff 上的
--     merchant_staff_protect_line_binding_columns(20260920160000)、
--     merchant_staff_protect_pending_login_email_columns(20260921170000)、
--     merchant_staff_protect_identity_columns(20260924020100 + 20260924030100)。
--     三支都是「整列 RLS 開放 + 敏感欄位用 BEFORE trigger 鎖住」。照既有模式做,維護的人
--     一眼就認得;新創一套 RPC 反而是這張表獨有的例外。
--   ・trigger 是資料庫層的保護,連直接打 PostgREST 都擋得住;RPC 只要 RLS 還開著就擋不住
--     繞過 RPC 直接寫表(這正是 20260924030100 那支 INSERT 面補強學到的教訓)。
--
-- 所以:**欄位層級保護 trigger**。並且對稱地做兩組——規則欄位要 member_points,
-- 會員政策欄位要 member_settings——否則只有 member_points 的客服反而能去改會員政策。
--
-- ⚠️ INSERT 面也要擋(比照 20260924030100 學到的教訓):merchant_member_settings 是 upsert,
--    商家第一次存設定時走的是 INSERT,如果只掛 BEFORE UPDATE,客服可以在「還沒有設定列」的
--    商家上直接 INSERT 一列把規則值一次填好。INSERT 時 old 是 NULL 不能用 is distinct from,
--    改成跟「schema 實際預設值」比對(欄位預設值已逐一查 schema 確認,見 §3)。
--
-- =========================================================================
-- 【任務 6 第 4 點:grant_pending_birthday_bonuses 維持 can_manage_members —— 已查證,結論正確】
-- 它檢查的是 private.can_manage_members,主腦要求「維持現狀不要改,但請確認這個判斷正確」。
-- 確認結果:正確,不要改。理由:
--   ・使用者裁決把「**核發獎勵資格條件**」歸給紅利點數管理——注意那是「資格**條件**」,
--     也就是 reward_condition_mode 這個**設定值**,不是「核發」這個動作。
--   ・grant_pending_birthday_bonuses 是核發**動作**本身,而且它的觸發點是「打開會員管理列表頁
--     就自動跑」(見該函式註解),屬於會員管理頁的行為,不是設定頁的行為。
--   ・它跟 redeem_member_points(登記兌換)同一類:對既有會員做點數交易,使用者明確把這一類
--     歸在「會員管理」。
--   ・它完全不讀寫那五個規則欄位(只讀 reward_condition_mode/birthday_bonus_points 當計算輸入,
--     一個字都不改)。
-- 結論:維持 can_manage_members,這支 migration 一行都不動它。
-- =========================================================================

-- =========================================================================
-- §1 private.can_manage_member_points(p_merchant_id uuid)。
--     寫法完全比照 private.can_manage_members / can_manage_member_settings
--     (20260920140100:8/34),只換 section_key。
--
-- 關於「新增權限區塊鍵值 member_points」:已查證 merchant_agent_permissions.section_key
-- **沒有**任何 CHECK 約束或白名單表(20260916100000:113-121,表註解明講「不做強制白名單,
-- section_key 初稿清單只是前端自動完成用」),所以資料庫這一側不需要 ALTER 任何約束——
-- 「新增一把鑰匙」在資料庫層就等於「新增一支 can_xxx 函式」。前端的
-- AGENT_PERMISSION_SECTIONS 由另一位工程師負責加上對應項目。
-- =========================================================================
create or replace function private.can_manage_member_points(p_merchant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    private.is_merchant_admin(p_merchant_id)
    or exists (
      select 1
      from public.merchant_agents ma
      join public.merchant_agent_permissions map on map.agent_id = ma.id
      where ma.merchant_id = p_merchant_id
        and ma.user_id = auth.uid()
        and ma.status = 'active'
        and map.section_key = 'member_points'
        and map.granted = true
    );
$$;

comment on function private.can_manage_member_points(uuid) is '2026-09-24 使用者裁決:是否能管理該商家的「紅利點數規則」——啟用開關(points_feature_enabled)、核發獎勵資格條件(reward_condition_mode)、消費點數比例(points_earn_rate)、推薦獎勵點數(referral_bonus_points)、生日贈點點數(birthday_bonus_points)這五個欄位。商家管理員永遠可以,或是該商家目前有效的客服且被開通新的 member_points section_key。使用者把紅利點數管理頁拆成兩段權限:「交易」那一段(餘額總覽、手動調整、登記兌換、異動歷史)仍然走 members 鑰匙,「規則」這一段走這把新鑰匙。寫法完全比照 private.can_manage_members / can_manage_member_settings,只換 section_key。只給 RLS 政策/欄位保護 trigger 內部呼叫,不對外暴露。';

revoke execute on function private.can_manage_member_points(uuid) from public, anon;
grant execute on function private.can_manage_member_points(uuid) to authenticated;

-- =========================================================================
-- §2 放寬 merchant_member_settings 的三條 RLS 政策:member_settings **或** member_points
--     任一把鑰匙都能通過「列層級」這一關,真正「可以改哪些欄位」交給 §3 的 trigger 判斷。
--
-- 為什麼三條都要放寬(含 SELECT):只有 member_points 鑰匙的客服必須能**讀**到這一列,
-- 否則紅利點數管理頁的「點數設定」卡片連目前值都顯示不出來,更不可能編輯。
--
-- 這是「RLS 負責列層級、trigger 負責欄位層級」的分工——跟 merchant_staff 那三支保護 trigger
-- 的既有架構完全一致(RLS 政策開放給 can_manage_staff,欄位保護另外用 trigger)。
-- =========================================================================
drop policy if exists merchant_member_settings_select on public.merchant_member_settings;
drop policy if exists merchant_member_settings_insert on public.merchant_member_settings;
drop policy if exists merchant_member_settings_update on public.merchant_member_settings;

create policy merchant_member_settings_select on public.merchant_member_settings
  for select to authenticated
  using (
    private.can_manage_member_settings(merchant_id)
    or private.can_manage_member_points(merchant_id)
  );

create policy merchant_member_settings_insert on public.merchant_member_settings
  for insert to authenticated
  with check (
    private.can_manage_member_settings(merchant_id)
    or private.can_manage_member_points(merchant_id)
  );

create policy merchant_member_settings_update on public.merchant_member_settings
  for update to authenticated
  using (
    private.can_manage_member_settings(merchant_id)
    or private.can_manage_member_points(merchant_id)
  )
  with check (
    private.can_manage_member_settings(merchant_id)
    or private.can_manage_member_points(merchant_id)
  );

-- =========================================================================
-- §3 欄位層級保護 trigger。
--
-- 兩組欄位、兩把鑰匙、對稱處理:
--   【規則組】points_feature_enabled / reward_condition_mode / points_earn_rate /
--             referral_bonus_points / birthday_bonus_points → private.can_manage_member_points
--   【會員政策組】policy_enabled / policy_content          → private.can_manage_member_settings
--
-- ⚠️ 判斷的是「**值真的有變動**」,不是「payload 有沒有帶這個欄位」——這是這支 trigger 最重要的
--    一件事。理由見檔頭:整列 upsert 會讓兩個頁面互相把對方的欄位原樣送一次,用「有沒有帶」
--    判斷會讓只有 member_settings 的客服存不了會員政策。
--
-- 【欄位預設值(已逐一查 schema 確認,不是憑印象;INSERT 分支要用)】
--   ・points_earn_rate        20260920140000:17  numeric(10,2) not null default 0
--   ・referral_bonus_points   20260920140000:18  integer not null default 0
--   ・birthday_bonus_points   20260920140000:19  integer not null default 0
--   ・points_feature_enabled  20260922160400:17  boolean not null default true
--   ・reward_condition_mode   20260923010200:31  text not null default 'none'
--   ・policy_enabled          20260923010200:32  boolean not null default false
--   ・policy_content          20260923010200:33  text(沒有 default)→ 預設 NULL
--
-- 【合法寫入路徑盤點(這一步做錯會把「建立新商家」整個弄壞,所以逐一查過)】
--  (1) public.seed_default_member_settings(uuid)(20260920140600:15)
--      —— `insert into public.merchant_member_settings (merchant_id) values (p_merchant_id)
--          on conflict (merchant_id) do nothing`,**只帶 merchant_id**,其餘七個欄位全部
--          套用 schema 預設值 → 下面兩個 v_touches_* 判斷式對它一律為 false → 不會被擋。
--          這條路徑由 create_group_and_merchant / create_merchant_in_group 在建立商家當下呼叫,
--          那個時間點呼叫者還不一定已經是 merchant_admins 的一員,所以「不會被擋」這件事必須
--          靠「只帶預設值」成立,不能靠權限成立。已確認成立。
--  (2) 前端 src/modules/members/api.ts:72 upsertMerchantMemberSettings
--      —— 兩個頁面共用。商家管理員一律通過(兩支 can_ 函式都含 is_merchant_admin)。
--         客服則依他手上的鑰匙決定能改哪一組,這正是這次要達成的效果。
--  (3) e2e/support/members-fixture.ts:164 的 upsert(帶 points_earn_rate 等規則欄位)
--      —— 以該測試商家的建立者(商家管理員)身份執行 → is_merchant_admin 為真 → 通過。
--         (e2e 不在 `supabase test db` 範圍內,且本次任務禁止改 e2e/,這裡只是盤點不受影響。)
--  (4) pgTAP fixture 裡以 postgres 身分直接 insert/update merchant_member_settings
--      —— 此時沒有設定 request.jwt.claims,auth.role() 回傳 NULL,`NULL <> 'service_role'`
--         結果是 NULL,整個 AND 條件鏈是 NULL,`if NULL then` 不成立 → 不會拋錯。
--         這跟 merchant_staff 那三支保護 trigger 上線後既有測試依然全綠是同一個原因
--         (20260924030100 §1 (5) 已經記過這個機制),不是這次新引入的行為。
-- =========================================================================
create or replace function private.protect_merchant_member_settings_rule_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  -- 這次異動有沒有真的改動到「紅利點數規則」那五個欄位。
  v_touches_points_rules boolean;
  -- 這次異動有沒有真的改動到「會員政策」那兩個欄位。
  v_touches_policy boolean;
  v_merchant_id uuid;
begin
  if tg_op = 'INSERT' then
    -- INSERT:old 是 NULL,不能寫 `is distinct from old.xxx`(對 NULL record 取欄位在 plpgsql
    -- 觸發器裡會直接 raise)。改成判斷「有沒有主動帶了非預設值」,預設值以 schema 實際宣告為準。
    v_touches_points_rules :=
      coalesce(new.points_feature_enabled, true) is distinct from true
      or coalesce(new.reward_condition_mode, 'none') is distinct from 'none'
      or coalesce(new.points_earn_rate, 0) is distinct from 0::numeric
      or coalesce(new.referral_bonus_points, 0) is distinct from 0
      or coalesce(new.birthday_bonus_points, 0) is distinct from 0;

    v_touches_policy :=
      coalesce(new.policy_enabled, false) is distinct from false
      or new.policy_content is not null;

    v_merchant_id := new.merchant_id;
  else
    -- UPDATE:比對「值有沒有真的被改動」。這是整支 trigger 的關鍵——用 is distinct from 而不是
    -- 「payload 有沒有帶這個欄位」,所以 MemberSettingsPage 存會員政策時把五個規則欄位原樣
    -- 送一次(值沒變)完全不會觸發規則組的檢查,反之亦然。
    v_touches_points_rules :=
      new.points_feature_enabled is distinct from old.points_feature_enabled
      or new.reward_condition_mode is distinct from old.reward_condition_mode
      or new.points_earn_rate is distinct from old.points_earn_rate
      or new.referral_bonus_points is distinct from old.referral_bonus_points
      or new.birthday_bonus_points is distinct from old.birthday_bonus_points;

    v_touches_policy :=
      new.policy_enabled is distinct from old.policy_enabled
      or new.policy_content is distinct from old.policy_content;

    -- 用 old.merchant_id(這一列目前歸屬的商家)。merchant_id 是主鍵,理論上不會被改,
    -- 這裡比照 20260924020100 的既有寫法多一層保險。
    v_merchant_id := old.merchant_id;
  end if;

  if v_touches_points_rules
     -- 放行路徑:service_role(後台維運 / Edge Function)。目前沒有任何 Edge Function 會寫
     -- 這張表,保留這道是為了跟既有三支保護 trigger 的結構一致,不留下「將來多一條路徑就爆掉」
     -- 的落差。
     and auth.role() <> 'service_role'
     and not private.can_manage_member_points(v_merchant_id)
  then
    raise exception '紅利點數的規則設定(啟用開關、核發獎勵資格條件、消費點數比例、推薦獎勵、生日贈點)需要「紅利點數管理」權限才能修改;「會員管理」權限可以做手動調整與登記兌換,但不能改這些規則'
      using errcode = '42501';
  end if;

  if v_touches_policy
     and auth.role() <> 'service_role'
     and not private.can_manage_member_settings(v_merchant_id)
  then
    raise exception '會員政策(啟用開關與政策內容)需要「會員系統設定」權限才能修改'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function private.protect_merchant_member_settings_rule_columns() is '2026-09-24 使用者裁決(紅利點數管理權限拆分)的欄位層級保護。merchant_member_settings 是整列 upsert(src/modules/members/api.ts:72 走 PostgREST 不是 RPC),而 RLS 的 UPDATE policy 是整列層級、WITH CHECK 看不到 OLD,所以沒辦法用政策表達「可以改哪些欄位」——這正是 supabase-permission-hygiene 規則 2 的欄位陷阱。改用 BEFORE INSERT OR UPDATE trigger,完全比照 merchant_staff 上既有的三支保護 trigger(line_binding / pending_login_email / identity_columns)的模式。兩組欄位對稱處理:紅利點數規則五欄(points_feature_enabled/reward_condition_mode/points_earn_rate/referral_bonus_points/birthday_bonus_points)要 private.can_manage_member_points;會員政策兩欄(policy_enabled/policy_content)要 private.can_manage_member_settings。⚠️ 判斷的是「值真的有變動」(is distinct from)而不是「payload 有沒有帶這個欄位」——因為兩個頁面共用同一個整列 upsert,MemberSettingsPage 存會員政策時會把五個規則欄位原樣送一次,用「有沒有帶」判斷會讓只有 member_settings 權限的客服連會員政策都存不了。INSERT 面同樣要擋(upsert 第一次會走 INSERT),因為 old 是 NULL 所以改成跟 schema 實際預設值比對。seed_default_member_settings 只帶 merchant_id、其餘全套預設值,所以建立新商家的路徑一定不會被擋(這件事靠「只帶預設值」成立,不靠權限成立)。';

create trigger merchant_member_settings_protect_rule_columns
  before insert or update on public.merchant_member_settings
  for each row execute function private.protect_merchant_member_settings_rule_columns();

-- =========================================================================
-- §4 順手把 §1 那五個欄位的「歸哪把鑰匙」寫進欄位註解,讓之後的人不必回頭讀 migration。
--     (points_feature_enabled 的註解已經在 20260924040300 §7 一併寫過,這裡不重複。)
-- =========================================================================
comment on column public.merchant_member_settings.reward_condition_mode is '模組 10 §10.7(SPECS-INDEX #619):核發紅利/推薦獎勵/生日贈點前的資格判斷條件,取代原本的 require_verified_phone_for_rewards 單一 boolean 開關。none=不設條件(符合既有其他規則就核發);phone_verified=只看電話已驗證;line_bound=只看 LINE 已綁定;either=電話已驗證或 LINE 已綁定其中一項即可;both=兩者都要符合。跟既有 members.phone_verified 並存,line_bound 讀取既有 members.line_bound(模組 11 LINE通知已建立)。【2026-09-24 權限】使用者裁決把「核發獎勵資格條件」歸給新的「紅利點數管理」(member_points)鑰匙,只有 private.can_manage_member_points 能修改這個欄位,由 merchant_member_settings_protect_rule_columns trigger 落實。';

comment on column public.merchant_member_settings.points_earn_rate is '每消費多少元累積 1 點,計算基準是 bookings.final_amount_snapshot(含稅,規則 2.1)。預設 0(尚未設定,不核發)。【2026-09-24 權限】屬於「紅利點數規則」,只有 private.can_manage_member_points(member_points 鑰匙)能修改。';

comment on column public.merchant_member_settings.referral_bonus_points is '成功推薦一位會員可得幾點,預設 0。【2026-09-24】「成功推薦」的判斷條件已改成「被推薦人的第一筆**已完成訂單**」(原本是第一筆 earn_booking 點數異動),見 20260924040300 §6:這樣紅利點數功能關閉期間完成的訂單也會把名額用掉,重新打開後不補發(使用者裁決)。【權限】屬於「紅利點數規則」,只有 private.can_manage_member_points(member_points 鑰匙)能修改。';

comment on column public.merchant_member_settings.birthday_bonus_points is '生日當月核發的點數(規則 2.5,以月為單位容錯,不是精確當天),預設 0。【2026-09-24】關閉紅利點數功能期間錯過的生日不補發,判斷方式是查 merchant_points_feature_history 該會員生日當天功能是否開著,見 20260924040300(使用者裁決)。【權限】屬於「紅利點數規則」,只有 private.can_manage_member_points(member_points 鑰匙)能修改。';

comment on column public.merchant_member_settings.policy_enabled is '模組 10 §10.6(SPECS-INDEX #618):是否啟用「會員政策」(原「基本政策」改名),啟用後 policy_content 才會顯示給客戶端/預覽效果使用。【2026-09-24 權限】屬於「會員系統設定」,只有 private.can_manage_member_settings(member_settings 鑰匙)能修改——跟上面五個「紅利點數規則」欄位是兩把不同的鑰匙,同一支 merchant_member_settings_protect_rule_columns trigger 對稱保護。';

comment on column public.merchant_member_settings.policy_content is '模組 10 §10.6:會員政策內容,純文字,前端用可自動依內容調整高度的文字區域顯示/編輯,不需要富文本編輯器。【2026-09-24 權限】屬於「會員系統設定」(member_settings 鑰匙),見 policy_enabled 的註解。';
