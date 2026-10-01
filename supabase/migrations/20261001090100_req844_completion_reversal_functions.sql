-- #844 已完成訂單可取消/還原 —— 批次 2:反轉引擎 + 連帶影響預覽 + 還原/取消兩個入口
-- 規格:.project/specs/已完成訂單取消與還原.md v1.2 §三、§四 4.1~4.4、§六、§七、§九 批次 2、§十 第 2 段;
--       檔尾「主腦紀錄」:五參數 log_booking_status_change 沒有 default,本檔一律明確傳第 5 個參數。
-- 疊在紅利重構 8 批(20261001020000 ~ 20261001080000)與 #844 批次 1(20261001090000)之上。
--
-- 【本檔新增(沒有修改任何既有函式)】
--   private.reverse_booking_completion(uuid, text, text, boolean)   反轉引擎(兩個入口共用)
--   public.get_completed_booking_reversal_preview(uuid)              連帶影響清單資料來源(只讀不鎖)
--   public.revert_completed_booking(uuid, text)                      還原完成(completed → accepted)
--   public.cancel_completed_booking(uuid, text, boolean)             取消已完成訂單(completed → cancelled)
--
-- 【只呼叫、不修改的既有函式】動工前指紋(2026-10-01,md5(replace(prosrc, E'\r\n', E'\n')) / 長度):
--   正式庫 wjtbmmnakcriuaqoknsq(唯讀 SELECT)= 本機 db reset 後:
--     private.is_merchant_admin(uuid)              559b386d80e4efc245f160c2e8668426 / 356
--     private.current_actor_display_name(uuid)     c969d0a7833bae57365d0e8259ed532d / 567
--     public.complete_booking(uuid)                4cfb14875fbb5ffc365373b046907520 / 1088(重新完成走它)
--     public.compute_booking_commission(uuid)      cc8e2a2b366c5a83b1fb65c8261e6062 / 2074
--   正式庫還沒有、只存在本機(紅利批次 3/4、#844 批次 1,已通過 QA 未上線):
--     private.refund_booking_redeem(uuid)                          668218be2bd4aabb858697d101bd7a68 / 2068
--     private.reverse_booking_earned_points(uuid, integer)         02d4e75d179449af64bdcd0465e91c8a / 8859
--       ↳ 2026-10-01 #844 批次 4 改了它的 shortfall_hint(依會員 / 推薦人分句,紅利批次 4 檔案直接改,
--         兩者都還沒上線),之後的指紋是 9577d051f0b49d261faa28dac76dc458 / 10414;本檔呼叫方式與回傳鍵不變。
--     private.log_booking_status_change(uuid,uuid,text,text,text)  24b351a7f846f9997db5a22cfcd3dc3a / 577
--   ⇒ 本檔必須跟紅利 8 批 + #844 批次 1 同一次或之後上線。
--
-- 【鎖的順序】一律「訂單列 → 會員列(依 id 由小到大)」:引擎第一步 for update 鎖訂單列;
--   refund_booking_redeem / reverse_booking_earned_points 對同一訂單再 for update 是同交易重入,
--   會員列由它們各自依 id 排序鎖 —— 跟 cancel_booking / update_booking / compute_member_loyalty_points 一致。

-- =========================================================================
-- 1. §4.1 private.reverse_booking_completion(反轉引擎)
-- =========================================================================
create function private.reverse_booking_completion(
  p_booking_id uuid,
  p_target_status text,
  p_reason text,
  p_notify_requested boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  -- 去頭尾空白:除了半形空白,也去掉 tab、換行與全形空白(U+3000)——只按 btrim() 預設只去半形空白,
  -- 「全形空白」或「只有換行」的原因會被當成有填(pgTAP D17 實測抓到)。
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n\u3000');
  v_merchant_id uuid;
  v_status text;
  v_source text;
  v_original_completed_at timestamptz;
  v_commission_snapshot jsonb;
  v_commission_amount numeric(10, 2) := 0;
  v_frozen integer := 0;
  v_points jsonb;
  v_is_cross_month boolean;
  v_report_month text;
  v_action text;
  v_booking public.bookings;
begin
  -- 1. 參數檢查(不涉及訂單內容,先擋不會洩漏任何資訊)。
  if p_target_status is null or p_target_status not in ('accepted', 'cancelled') then
    raise exception '不支援的目標狀態(只能還原為「已確認」或取消)' using errcode = '22023';
  end if;

  if v_reason = '' then
    raise exception '請填寫還原/取消的原因' using errcode = '22023';
  end if;

  if char_length(v_reason) > 500 then
    raise exception '原因最多 500 個字,目前是 % 個字,請精簡後再送出', char_length(v_reason) using errcode = '22023';
  end if;

  -- 2. 鎖訂單列(§3.11:鎖住之後才看狀態,兩個人同時按,第二個人一定看到最新狀態)。
  select b.merchant_id, b.status, b.source, b.completed_at
  into v_merchant_id, v_status, v_source, v_original_completed_at
  from public.bookings b
  where b.id = p_booking_id
  for update;

  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;

  -- 3. 先擋權限、再回報狀態:客服不會從錯誤訊息得知這張單目前的狀態(§4.1 第 3 步)。
  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '還原或取消已完成的訂單,只有商家管理員可以操作' using errcode = '42501';
  end if;

  -- 4. 狀態複檢(冪等:同一張單重複按,第二次在這裡被擋下,不會重複刪快照或重複收點)。
  if v_status <> 'completed' then
    raise exception '這筆訂單的狀態已經改變,請重新整理後再試' using errcode = 'P0001';
  end if;

  -- 5. 匯入的歷史訂單只能取消、不能還原(§3.13)。
  if p_target_status = 'accepted' and v_source = 'import' then
    raise exception '匯入的歷史訂單不能還原,只能取消。如果匯錯了,請取消後重新匯入' using errcode = 'P0001';
  end if;

  -- 不變量 status='completed' ⇔ completed_at 有值(§3.10;正式庫 0 筆例外)。萬一真的遇到就擋下,
  -- 不要寫出一筆 original_completed_at 為空的稽核(稽核表該欄 not null,會變成看不懂的系統錯誤)。
  if v_original_completed_at is null then
    raise exception '這筆已完成訂單缺少完成時間,資料異常,請聯絡系統管理員' using errcode = 'P0001';
  end if;

  v_action := case p_target_status when 'accepted' then 'revert_to_accepted' else 'cancel_completed' end;

  -- 6. 抽成快照組成 jsonb(先讀、還不刪,§3.4 第 1 點)。月薪制/沒有快照 → null / 0。
  select to_jsonb(r) || jsonb_build_object('items', coalesce((
           select jsonb_agg(to_jsonb(i) order by i.created_at, i.id)
           from public.booking_commission_item_records i
           where i.commission_record_id = r.id), '[]'::jsonb)),
         r.commission_amount
  into v_commission_snapshot, v_commission_amount
  from public.booking_commission_records r
  where r.booking_id = p_booking_id;

  v_commission_amount := coalesce(v_commission_amount, 0);

  -- 7. 折抵退回(只有取消路徑)。🔴 順序不可調換(§4.1 第 7 步,pgTAP module17_01 有故障注入):
  --    先把狀態改成 cancelled(completed_at 先留著)→ 再退回。退回函式看「訂單現在是不是 cancelled」
  --    決定分類帳備註,狀態沒先改會寫成「訂單編輯變更了會員或折抵點數…」。
  if p_target_status = 'cancelled' then
    update public.bookings
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_reason = v_reason
    where id = p_booking_id;

    v_frozen := private.refund_booking_redeem(p_booking_id);
  else
    v_frozen := 0;  -- 還原路徑:單子還活著,折抵凍結維持(§3.6)
  end if;

  -- 8. 收回入帳(兩個入口都做;不傳 p_points_due,讓紅利函式自己從分類帳算)。
  --    🔴 此時 completed_at 一定還在(§4.1 第 8 步,pgTAP 有故障注入):收回函式用它找「本單完成之後
  --    才折抵的訂單」組差額提示;先清成 null 會變成 -infinity,提示會列出該會員所有折抵單。
  --    會員已下架、紅利功能關閉都照樣收回(前提 E、Q9(a)):本檔刻意不加任何判斷。
  v_points := private.reverse_booking_earned_points(p_booking_id);

  -- 9. 刪抽成快照(明細 on delete cascade)。放在紅利呼叫之後只是讓可能 raise 的步驟先跑;
  --    任何一步 raise 都整筆回滾(邊界 17)。
  delete from public.booking_commission_records where booking_id = p_booking_id;

  -- 10. 跨月與報表月份一律用台北時區(§3.8)。
  v_is_cross_month := date_trunc('month', v_original_completed_at at time zone 'Asia/Taipei')
                      < date_trunc('month', now() at time zone 'Asia/Taipei');
  v_report_month := to_char(v_original_completed_at at time zone 'Asia/Taipei', 'YYYY-MM');

  -- 11. 改最終狀態並清 completed_at(還原路徑在這一步才改狀態;取消路徑狀態已是 cancelled)。
  update public.bookings
  set status = p_target_status,
      completed_at = null,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_booking;

  -- 12. 操作紀錄:五參數版(沒有 default,一定要明確傳 note)。note 只放原因,不放點數或餘額
  --     ——有訂單鑰匙的客服看得到操作紀錄(§3.2)。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, 'completed', p_target_status, v_reason);

  -- 13. 稽核表(收回函式 8 個鍵逐一寫入同名欄位)。
  insert into public.booking_completion_reversals (
    booking_id, merchant_id, action, reason, actor_user_id, actor_name_snapshot,
    original_completed_at, report_month, is_cross_month,
    commission_record_snapshot, commission_amount_reversed,
    points_due, points_recovered, points_shortfall,
    referral_due, referral_recovered, referral_shortfall,
    referrer_member_id, shortfall_hint,
    frozen_points_refunded, notified
  ) values (
    p_booking_id, v_merchant_id, v_action, v_reason, auth.uid(),
    private.current_actor_display_name(v_merchant_id),
    v_original_completed_at, v_report_month, v_is_cross_month,
    v_commission_snapshot, v_commission_amount,
    coalesce((v_points ->> 'points_due')::int, 0),
    coalesce((v_points ->> 'points_recovered')::int, 0),
    coalesce((v_points ->> 'points_shortfall')::int, 0),
    coalesce((v_points ->> 'referral_due')::int, 0),
    coalesce((v_points ->> 'referral_recovered')::int, 0),
    coalesce((v_points ->> 'referral_shortfall')::int, 0),
    (v_points ->> 'referrer_member_id')::uuid,
    v_points ->> 'shortfall_hint',
    v_frozen,
    case when p_target_status = 'cancelled' then coalesce(p_notify_requested, false) else false end
  );

  -- 14. 回傳(含推薦人餘額的提示 ⇒ 只有管理員拿得到,權限已在第 3 步擋)。
  return jsonb_build_object(
    'booking', to_jsonb(v_booking),
    'action', v_action,
    'commission_amount_reversed', v_commission_amount,
    'report_month', v_report_month,
    'is_cross_month', v_is_cross_month,
    'points', jsonb_build_object(
      'points_due', coalesce((v_points ->> 'points_due')::int, 0),
      'points_recovered', coalesce((v_points ->> 'points_recovered')::int, 0),
      'points_shortfall', coalesce((v_points ->> 'points_shortfall')::int, 0),
      'referral_due', coalesce((v_points ->> 'referral_due')::int, 0),
      'referral_recovered', coalesce((v_points ->> 'referral_recovered')::int, 0),
      'referral_shortfall', coalesce((v_points ->> 'referral_shortfall')::int, 0),
      'referrer_member_id', v_points -> 'referrer_member_id',
      'shortfall_hint', v_points -> 'shortfall_hint',
      'frozen_points_refunded', v_frozen
    )
  );
end;
$function$;

comment on function private.reverse_booking_completion(uuid, text, text, boolean) is '#844 §4.1 反轉引擎(還原完成 / 取消已完成訂單共用)。步驟順序刻意且有 pgTAP 故障注入守著:參數檢查(原因必填、去頭尾空白、上限 500 字)→ for update 鎖訂單 → is_merchant_admin(42501,先擋權限再回報狀態)→ status 必須 completed(否則「狀態已經改變」,冪等)→ 匯入單不能還原 → 讀抽成快照成 jsonb → 【取消路徑】先改 cancelled(保留 completed_at)再 refund_booking_redeem → reverse_booking_earned_points(completed_at 仍在)→ 刪抽成快照(明細 cascade)→ 台北時區算 report_month / is_cross_month → 改最終狀態並清 completed_at → 五參數 log_booking_status_change(note 只放原因)→ 寫 booking_completion_reversals。不發任何通知(p_notify_requested 只寫稽核 notified)。只由 revert_completed_booking / cancel_completed_booking 呼叫。';

revoke execute on function private.reverse_booking_completion(uuid, text, text, boolean) from public, anon, authenticated;

-- =========================================================================
-- 2. §4.3 public.revert_completed_booking(還原完成)
-- =========================================================================
create function public.revert_completed_booking(p_booking_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
  -- 真正的管理員檢查在引擎裡(先擋權限再回報狀態)。還原一律不發通知(§3.7)。
  return private.reverse_booking_completion(p_booking_id, 'accepted', p_reason, false);
end;
$function$;

comment on function public.revert_completed_booking(uuid, text) is '#844 §4.3:還原完成(completed → accepted)。薄包裝,呼叫 private.reverse_booking_completion。只有商家管理員可以(引擎內 is_merchant_admin,42501);原因必填;匯入單擋下;不退折抵、不發通知。回傳 jsonb(booking、action、commission_amount_reversed、report_month、is_cross_month、points{…})。';

revoke execute on function public.revert_completed_booking(uuid, text) from public, anon;
grant execute on function public.revert_completed_booking(uuid, text) to authenticated, service_role;

-- =========================================================================
-- 3. §4.4 public.cancel_completed_booking(取消已完成訂單)
-- =========================================================================
create function public.cancel_completed_booking(
  p_booking_id uuid,
  p_reason text,
  p_notify_requested boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
  -- p_notify_requested 只用來寫稽核表 notified(管理員的選擇);資料庫不發任何通知,
  -- 通知由前端在成功後依開關非同步發送(§4.4、§4.5)。
  return private.reverse_booking_completion(p_booking_id, 'cancelled', p_reason, coalesce(p_notify_requested, false));
end;
$function$;

comment on function public.cancel_completed_booking(uuid, text, boolean) is '#844 §4.4:取消已完成訂單(completed → cancelled)。薄包裝,呼叫 private.reverse_booking_completion。只有商家管理員可以;原因必填(同時寫進 cancelled_reason);匯入單允許;先退回折抵凍結再收回入帳;抽成快照刪除並備份。p_notify_requested 只寫稽核 notified,資料庫不發通知。';

revoke execute on function public.cancel_completed_booking(uuid, text, boolean) from public, anon;
grant execute on function public.cancel_completed_booking(uuid, text, boolean) to authenticated, service_role;

-- =========================================================================
-- 4. §4.2 public.get_completed_booking_reversal_preview(連帶影響清單)
-- =========================================================================
-- 只讀不鎖、不呼叫收回/退回函式(那兩支會寫入)。點數算法逐字比照 reverse_booking_earned_points:
-- 依會員分組、having sum > 0;收回順序「本單入帳(依會員 id)→ 推薦獎勵(依推薦人 id)」,
-- 同一人兩者都有時先扣入帳、再用扣完的餘額扣推薦;取消路徑在這之前先把折抵凍結退回給被扣的人。
-- 畫面一律寫「預計」,真正扣多少以執行結果為準(兩者只會因併發而不同)。
create function public.get_completed_booking_reversal_preview(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_b public.bookings;
  v_staff record;
  v_commission record;
  v_member jsonb := null;
  v_months_ago integer;
  v_is_cross_month boolean;
  v_blocked jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_points jsonb := null;
  v_members jsonb := '[]'::jsonb;
  v_referral jsonb := null;
  v_frozen_total integer := 0;
  v_due_total integer := 0;
  -- 模擬餘額:bal_r = 還原路徑、bal_c = 取消路徑(先加回折抵凍結)
  v_bal_r jsonb := '{}'::jsonb;
  v_bal_c jsonb := '{}'::jsonb;
  v_row record;
  v_r integer;
  v_c integer;
  v_ref_first uuid := null;
  v_ref_name text;
  v_ref_balance integer;
  v_ref_due integer := 0;
  v_ref_short_r integer := 0;
  v_ref_short_c integer := 0;
begin
  select * into v_b from public.bookings b where b.id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;

  -- 先擋權限再回報狀態(跟引擎一致)。回傳含會員/推薦人姓名與餘額 ⇒ 只給商家管理員(§3.2)。
  if not private.is_merchant_admin(v_b.merchant_id) then
    raise exception '還原或取消已完成的訂單,只有商家管理員可以操作' using errcode = '42501';
  end if;

  if v_b.status <> 'completed' then
    raise exception '這筆訂單的狀態已經改變,請重新整理後再試' using errcode = 'P0001';
  end if;

  if v_b.source = 'import' then
    v_blocked := v_blocked || jsonb_build_array(jsonb_build_object(
      'code', 'import_cannot_revert',
      'message', '匯入的歷史訂單不能還原,只能取消。如果匯錯了,請取消後重新匯入。'));
  end if;

  -- 服務人員
  select ms.id, ms.name, ms.status, ms.compensation_type
  into v_staff
  from public.merchant_staff ms
  where ms.id = v_b.staff_id;

  -- 抽成快照
  select r.commission_amount, r.recalculated_at, r.computed_at
  into v_commission
  from public.booking_commission_records r
  where r.booking_id = p_booking_id;

  if v_staff.id is not null and v_staff.status = 'removed' then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'staff_removed',
      'message', format('服務人員「%s」已經移除。還原後這張單無法編輯或改時間,只能重新完成或取消。', v_staff.name)));
  end if;

  if v_staff.id is not null and v_staff.compensation_type = 'monthly_salary' and v_commission.commission_amount is not null then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'staff_now_monthly',
      'message', format('服務人員「%s」目前已改成月薪制。這次會收回原本的抽成,之後重新完成也不會再產生抽成。', v_staff.name)));
  end if;

  if v_commission.recalculated_at is not null then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'commission_recalculated',
      'message', '這張單的抽成曾經人工重算過。收回後原本重算的結果不會保留,重新完成時會依當時的設定重新計算。'));
  end if;

  -- 跨月(台北時區;§3.8)
  v_is_cross_month := date_trunc('month', v_b.completed_at at time zone 'Asia/Taipei')
                      < date_trunc('month', now() at time zone 'Asia/Taipei');
  v_months_ago := greatest(0,
      (extract(year from now() at time zone 'Asia/Taipei')::int * 12 + extract(month from now() at time zone 'Asia/Taipei')::int)
    - (extract(year from v_b.completed_at at time zone 'Asia/Taipei')::int * 12 + extract(month from v_b.completed_at at time zone 'Asia/Taipei')::int));

  -- 訂單目前連結的會員
  if v_b.member_id is not null then
    select jsonb_build_object('id', m.id, 'name', m.name, 'status', m.status, 'balance', m.points_balance)
    into v_member
    from public.members m
    where m.id = v_b.member_id;
  end if;

  -- 點數:本單從來沒有任何點數交易 → null
  if exists (select 1 from public.member_point_transactions t where t.booking_id = p_booking_id) then
    -- 起始餘額:所有可能被動到的人(入帳會員、推薦人、折抵被扣的人)
    for v_row in
      select m.id, m.points_balance
      from public.members m
      where m.id in (select t.member_id from public.member_point_transactions t where t.booking_id = p_booking_id)
    loop
      v_bal_r := v_bal_r || jsonb_build_object(v_row.id::text, v_row.points_balance);
      v_bal_c := v_bal_c || jsonb_build_object(v_row.id::text, v_row.points_balance);
    end loop;

    -- 目前有效凍結(只有取消路徑會退)
    for v_row in
      select t.member_id, (-sum(t.points_delta))::int as frozen
      from public.member_point_transactions t
      where t.booking_id = p_booking_id
        and t.transaction_type in ('redeem_booking', 'redeem_booking_refund')
      group by t.member_id
      having -sum(t.points_delta) > 0
      order by t.member_id
    loop
      v_frozen_total := v_frozen_total + v_row.frozen;
      v_bal_c := v_bal_c || jsonb_build_object(v_row.member_id::text,
                   coalesce((v_bal_c ->> v_row.member_id::text)::int, 0) + v_row.frozen);
    end loop;

    -- 本單入帳(依會員 id,比照收回函式)
    for v_row in
      select t.member_id, sum(t.points_delta)::int as net, m.name, m.status, m.points_balance,
             coalesce((
               select (-sum(f.points_delta))::int
               from public.member_point_transactions f
               where f.booking_id = p_booking_id and f.member_id = t.member_id
                 and f.transaction_type in ('redeem_booking', 'redeem_booking_refund')
             ), 0) as frozen
      from public.member_point_transactions t
      join public.members m on m.id = t.member_id
      where t.booking_id = p_booking_id
        and t.transaction_type in ('earn_booking', 'earn_booking_reversal')
      group by t.member_id, m.name, m.status, m.points_balance
      having sum(t.points_delta) > 0
      order by t.member_id
    loop
      v_r := (v_bal_r ->> v_row.member_id::text)::int;
      v_c := (v_bal_c ->> v_row.member_id::text)::int;
      v_due_total := v_due_total + v_row.net;

      v_members := v_members || jsonb_build_array(jsonb_build_object(
        'member_id', v_row.member_id,
        'name', v_row.name,
        'status', v_row.status,
        'balance', v_row.points_balance,
        'due_expected', v_row.net,
        'frozen_refund_expected', greatest(v_row.frozen, 0),
        'shortfall_if_revert', greatest(v_row.net - v_r, 0),
        'shortfall_if_cancel', greatest(v_row.net - v_c, 0)
      ));

      v_bal_r := v_bal_r || jsonb_build_object(v_row.member_id::text, v_r - least(v_row.net, v_r));
      v_bal_c := v_bal_c || jsonb_build_object(v_row.member_id::text, v_c - least(v_row.net, v_c));
    end loop;

    -- 推薦獎勵(依推薦人 id,用扣完入帳後的模擬餘額)
    for v_row in
      select t.member_id, sum(t.points_delta)::int as net
      from public.member_point_transactions t
      where t.booking_id = p_booking_id
        and t.transaction_type in ('referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal')
      group by t.member_id
      having sum(t.points_delta) > 0
      order by t.member_id
    loop
      v_r := coalesce((v_bal_r ->> v_row.member_id::text)::int, 0);
      v_c := coalesce((v_bal_c ->> v_row.member_id::text)::int, 0);

      if v_ref_first is null then
        v_ref_first := v_row.member_id;
        select m.name, m.points_balance into v_ref_name, v_ref_balance from public.members m where m.id = v_row.member_id;
      end if;

      v_ref_due := v_ref_due + v_row.net;
      v_ref_short_r := v_ref_short_r + greatest(v_row.net - v_r, 0);
      v_ref_short_c := v_ref_short_c + greatest(v_row.net - v_c, 0);

      v_bal_r := v_bal_r || jsonb_build_object(v_row.member_id::text, v_r - least(v_row.net, v_r));
      v_bal_c := v_bal_c || jsonb_build_object(v_row.member_id::text, v_c - least(v_row.net, v_c));
    end loop;

    if v_ref_first is not null then
      v_referral := jsonb_build_object(
        'referrer_member_id', v_ref_first,
        'referrer_name', v_ref_name,
        'referrer_balance', v_ref_balance,
        'due_expected', v_ref_due,
        -- 規格的單一欄位;推薦人跟本單會員是不同人時(實務上一定如此)兩條路徑相同。
        'shortfall_expected', v_ref_short_r,
        -- 精確版:推薦人恰好也是本單入帳會員或折抵被扣的人時(極罕見,邊界 19),兩條路徑可能不同。
        'shortfall_if_revert', v_ref_short_r,
        'shortfall_if_cancel', v_ref_short_c
      );
    end if;

    v_points := jsonb_build_object(
      'members', v_members,
      'points_due_expected', v_due_total,
      'frozen_points', v_frozen_total,
      'referral', v_referral
    );
  end if;

  return jsonb_build_object(
    'booking_id', v_b.id,
    'status', v_b.status,
    'source', v_b.source,
    'can_revert', v_b.source <> 'import',
    'can_cancel', true,
    'blocked_reasons', v_blocked,
    'staff', case when v_staff.id is null then null else jsonb_build_object(
      'id', v_staff.id, 'name', v_staff.name, 'status', v_staff.status,
      'compensation_type_now', v_staff.compensation_type) end,
    'commission', jsonb_build_object(
      'exists', v_commission.commission_amount is not null,
      'amount', coalesce(v_commission.commission_amount, 0),
      'recalculated', v_commission.recalculated_at is not null,
      'computed_at', v_commission.computed_at),
    'completed_at', v_b.completed_at,
    'report_month', to_char(v_b.completed_at at time zone 'Asia/Taipei', 'YYYY-MM'),
    'is_cross_month', v_is_cross_month,
    'months_ago', v_months_ago,
    'revenue_amount', v_b.final_amount_snapshot,
    'member', v_member,
    'points', v_points,
    'warnings', v_warnings
  );
end;
$function$;

comment on function public.get_completed_booking_reversal_preview(uuid) is '#844 §4.2:還原/取消已完成訂單前的「這次會連帶影響」清單資料來源。只有商家管理員可以(42501,先擋權限再回報狀態);訂單不是 completed → raise。只讀不鎖、不呼叫會寫入的紅利函式;點數算法逐字比照 reverse_booking_earned_points(取消路徑先模擬退回折抵)。回傳 can_revert/can_cancel/blocked_reasons、staff、commission、completed_at、report_month、is_cross_month、months_ago(台北時區)、revenue_amount、member、points{members[], points_due_expected, frozen_points, referral}、warnings。含會員/推薦人姓名與餘額,只給管理員。';

revoke execute on function public.get_completed_booking_reversal_preview(uuid) from public, anon;
grant execute on function public.get_completed_booking_reversal_preview(uuid) to authenticated, service_role;
