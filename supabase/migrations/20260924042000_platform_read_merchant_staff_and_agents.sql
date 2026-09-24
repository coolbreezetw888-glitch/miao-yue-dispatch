-- 規格書「超級管理員商家詳情強化」#694 / #695 / #696。
--
-- =========================================================================
-- 【為什麼需要這兩支函式】
--   超級管理員後台的商家詳情頁上,「服務人員」和「客服」這兩種人完全看不到。
--   實查的原因(規格書第 0.4 節,不是推測):
--     ・merchant_staff 的 SELECT 政策有 7 個 OR 分支,全部都是「你是不是這間店的人」;
--     ・merchant_agents 的 SELECT 政策只有 is_merchant_admin(...) 或 user_id = auth.uid();
--     ・兩條政策裡都沒有 private.is_platform_admin()。
--   ⇒ 平台管理員直接查這兩張表,拿到的是「靜默的 0 筆」而不是錯誤——畫面上會顯示
--     「目前沒有服務人員」,是最難察覺的一種失敗模式。
--
--   同一頁的「管理員名單」之所以顯示得出來,靠的也不是 RLS,而是 RPC
--   get_merchant_admin_users()。這次比照同一條路,再寫兩支唯讀函式。
--
-- 【為什麼不改成加一條 RLS 政策】(規格書第四節 (a),五個理由的摘要)
--   1. 名單要顯示 Email,而 Email 的單一真相在 auth.users,永遠不可能透過 RLS 開放給前端
--      join ⇒ 無論如何都需要 SECURITY DEFINER 函式,再加政策就是同一件事做兩遍。
--   2. merchant_staff 有 30 個欄位(13 個權限開關、line_user_id、換信箱流程的中間狀態…),
--      一條政策等於把整列全部、在全 app 任何地方都開給平台管理員;這裡只回傳 11 個白名單欄位。
--   3. RLS 會擴散到別的模組對這張表做的 embedded join,影響面遠超這次需求;RPC 只影響
--      呼叫它的那兩張卡片。
--   4. 在一條已經有 7 個 OR 分支的政策上疊第 8 個分支,維護成本太高。
--   5. 這是模組 2 的既定做法(get_merchant_admin_users / platform_get_merchant_admin_counts /
--      platform_get_user_email / platform_export_merchant_members_snapshot 共四次)。
--
-- 【⚠️ 權限判斷式與三值邏輯】(規格書第四節 (b))
--   merchant_staff.user_id / merchant_agents.user_id 都是 nullable。在 PostgreSQL 裡
--   `false or NULL` = NULL、`not NULL` = NULL、`if NULL then …` 不成立會被靜默跳過。
--   ⇒ 這兩支函式的權限判斷式**刻意完全不含任何可為 NULL 的欄位比較**,只有
--     `if not private.is_platform_admin()`,而該函式回傳的是 exists(...),永遠是 true/false。
--   ⚠️ 之後若有人要在這裡加「或這個人是自己」之類的條件,一定要寫成三段式:
--        or (x is not null and auth.uid() is not null and x = auth.uid())
--      不可以只寫 `or x = auth.uid()`。
--
-- 【⚠️ drop + create,不是 create or replace】(規格書第四節 (c))
--   ① migration 要能重跑,而 create or replace 無法變更 RETURNS TABLE 的形狀,會直接報錯;
--   ② create or replace 也不能變更輸入參數名稱;
--   ③ 精確簽章的 drop 保證不留下孤兒重載讓 PostgREST 解析到舊版本。
--   ⚠️ 代價:新建的函式會拿到 PostgreSQL 預設的 PUBLIC EXECUTE ⇒ 檔尾的 revoke/grant
--      (#696)不是選配,是必做。這正是 security_audit_01 測試裡「A2」記錄的真實事故
--      (recalculate_booking_commission 被 drop + create 重寫後繼承了預設 PUBLIC EXECUTE)。
--
-- 【⚠️ 這次完全沒有動 get_merchant_admin_users】——它同時被商家端 MerchantAdminList.tsx 和
--   平台端 MerchantDetailPage.tsx 使用,動它的簽章就會踩到上面兩條重載陷阱,而這次不需要動它。
--
-- 【唯讀保證】兩支函式都是 stable,沒有任何 insert / update / delete。
-- =========================================================================

-- -------------------------------------------------------------------------
-- #694:平台管理員讀取任一商家的服務人員名單(唯讀,白名單欄位)
-- -------------------------------------------------------------------------
drop function if exists public.platform_get_merchant_staff(uuid);

create function public.platform_get_merchant_staff(p_merchant_id uuid)
returns table(
  id uuid,
  merchant_id uuid,
  user_id uuid,
  name text,
  nickname text,
  phone text,
  compensation_type text,
  status text,
  login_status text,
  login_email text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  -- 權限檢查:只有平台管理員。刻意「不」比照 get_merchant_admin_users 疊加
  -- private.is_merchant_admin(...),理由見檔頭第四節 (a):商家端本來就可以靠既有 RLS
  -- 直接查表(useMerchantStaffList 就是直接查),不需要這支函式,多開一個商家也能走的
  -- 入口只是多一個要守的邊界。
  --
  -- ⚠️ 三值邏輯:這個判斷式裡刻意「沒有」任何可為 NULL 的欄位比較(見檔頭)。
  if not private.is_platform_admin() then
    raise exception '沒有權限執行此操作，僅限平台管理員使用' using errcode = '42501';
  end if;

  return query
    select
      ms.id,
      ms.merchant_id,
      ms.user_id,
      ms.name,
      ms.nickname,
      ms.phone,
      ms.compensation_type,
      ms.status,
      ms.login_status,
      -- Email 的單一真相:已註冊的人用 auth.users 的登入信箱;還沒註冊的人退回邀請時
      -- 輸入的信箱;兩個都沒有就是 null(前端負責顯示「尚未開通登入」,資料庫誠實回傳
      -- null,不在這裡 coalesce 成「未填」之類的字串)。
      coalesce(u.email::text, ms.invited_login_email) as login_email,
      ms.created_at
    from public.merchant_staff ms
    -- ⚠️⚠️ 一定是 LEFT JOIN,不能是 JOIN。ms.user_id 是 nullable(「還沒開通登入」的服務
    --      人員就是 NULL),用 inner join 的話這些人會整列「靜默消失」——不報錯、名單就是
    --      少了人,是最難發現的一種 bug。既有的 get_staff_login_email_status() 也是用
    --      left join,照它寫。module2_04 的 pgTAP 有專門的釘樁測試。
    left join auth.users u on u.id = ms.user_id
    where ms.merchant_id = p_merchant_id
    -- 在職的排前面、已移除的排後面,同組內依姓名。排序放在資料庫端,前端不再排一次。
    order by (case when ms.status = 'active' then 0 else 1 end), ms.name asc;
end;
$$;

comment on function public.platform_get_merchant_staff(uuid) is
  '規格書「超級管理員商家詳情強化」#694:平台管理員(private.is_platform_admin())唯讀檢視任一商家的服務人員名單。只回傳白名單欄位(不含 13 個權限開關、is_listed、line_user_id、頭像、換信箱流程中間狀態等 19 個欄位),因為平台維運只需要「辨識這是誰 + 怎麼聯絡 + 什麼身分/計酬/在職狀態」。⚠️ 非平台管理員一律 raise 42501,包含該商家自己的管理員——商家端本來就能靠既有 RLS 直接查 merchant_staff,不需要這支函式。⚠️ auth.users 用 LEFT JOIN:user_id 是 nullable(還沒開通登入的服務人員),inner join 會讓這些人整列靜默消失。⚠️ 已移除(status=''removed'')的人也會回傳,排在最後——軟刪除的人在平台維運上常常正是要查的對象。stable 唯讀,不寫入任何資料。';

-- -------------------------------------------------------------------------
-- #695:平台管理員讀取任一商家的客服名單(唯讀,白名單欄位)
-- -------------------------------------------------------------------------
drop function if exists public.platform_get_merchant_agents(uuid);

create function public.platform_get_merchant_agents(p_merchant_id uuid)
returns table(
  id uuid,
  merchant_id uuid,
  user_id uuid,
  name text,
  nickname text,
  phone text,
  job_title text,
  status text,
  login_email text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  -- 同 #694:權限判斷式只有 is_platform_admin(),不含任何可為 NULL 的欄位比較。
  if not private.is_platform_admin() then
    raise exception '沒有權限執行此操作，僅限平台管理員使用' using errcode = '42501';
  end if;

  return query
    select
      ma.id, ma.merchant_id, ma.user_id, ma.name, ma.nickname, ma.phone,
      ma.job_title,
      ma.status,
      -- 客服的 invited_email 是 NOT NULL,所以這裡 coalesce 的結果一定不是 null
      -- (跟服務人員不同,服務人員的 invited_login_email 可以是 null)。
      coalesce(u.email::text, ma.invited_email) as login_email,
      ma.created_at
    from public.merchant_agents ma
    -- ⚠️ 同 #694:一定是 LEFT JOIN。ma.user_id 是 nullable(「已邀請但還沒註冊」= NULL)。
    left join auth.users u on u.id = ma.user_id
    where ma.merchant_id = p_merchant_id
    -- 客服的 status 有三個值。在職(active)→ 已邀請(invited)→ 已移除(removed)。
    order by
      (case ma.status when 'active' then 0 when 'invited' then 1 else 2 end),
      ma.name asc;
end;
$$;

comment on function public.platform_get_merchant_agents(uuid) is
  '規格書「超級管理員商家詳情強化」#695:平台管理員(private.is_platform_admin())唯讀檢視任一商家的客服名單。⚠️ 客服沒有 compensation_type、也沒有 login_status 欄位(實查 information_schema.columns),不要為了跟服務人員對稱而硬湊——客服的「有沒有開通登入」就是看 status(invited 代表邀請信已寄出但還沒接受)。⚠️ 刻意不回傳逐項權限清單(merchant_agent_permissions),那是商家自己營運要看的細節。⚠️ auth.users 用 LEFT JOIN:user_id 是 nullable(已邀請但還沒註冊)。⚠️ 已移除(status=''removed'')的人也會回傳,排在最後。stable 唯讀,不寫入任何資料。';

-- -------------------------------------------------------------------------
-- #696:EXECUTE 權限收斂。
--
-- ⚠️ 這段不是選配。PostgreSQL 對**新建**的函式預設給 PUBLIC EXECUTE,而上面兩支函式用的
--    正是 drop + create,完全踩在 security_audit_01「A2」記錄的那個真實事故上
--    (recalculate_booking_commission 被 drop + create 重寫後繼承了預設 PUBLIC EXECUTE)。
--
-- 目標 ACL(比照既有 platform_* 函式):postgres=X | authenticated=X | service_role=X,
-- anon 與 PUBLIC 都沒有。module2_04 的 pgTAP 用 has_function_privilege 逐一釘住四種角色。
-- -------------------------------------------------------------------------
revoke all on function public.platform_get_merchant_staff(uuid) from public;
revoke all on function public.platform_get_merchant_agents(uuid) from public;
revoke all on function public.platform_get_merchant_staff(uuid) from anon;
revoke all on function public.platform_get_merchant_agents(uuid) from anon;
grant execute on function public.platform_get_merchant_staff(uuid) to authenticated;
grant execute on function public.platform_get_merchant_agents(uuid) to authenticated;
