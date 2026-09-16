-- 模組 2 RLS/規則回歸測試 ③(部分):private.is_merchant_admin / is_group_member / is_platform_admin
-- 這幾個內部函式的資料庫層存取邊界。
--
-- 範圍說明(重要,寫在這裡讓之後維護的人不會誤會這份測試涵蓋了全部):
-- 這三支函式「刻意」有 `grant execute ... to authenticated`(見
-- 20260915110000_merchant_private_schema_hardening.sql、20260915120000_platform_admin_core.sql)
-- ——RLS 政策本身是以 authenticated 角色執行,一定要能呼叫到才能運作,這是正常且必要的設計,
-- 不是漏洞。這份測試驗證的是「anon/public 這兩個沒有登入資格的角色不能呼叫」,以及函式確實
-- 放在 private schema 底下(不是不小心留在 public)。
--
-- 至於「不會出現在 PostgREST 的 API 曝光範圍」這件事,決定因素是 supabase/config.toml 的
-- `api.schemas = ["public", "graphql_public"]`(private 不在清單裡)——這是專案設定值,
-- 不是資料庫裡的權限或資料,pgTAP 在資料庫層面測不到它,所以用「檢查 config.toml 內容」
-- 的方式在 CI/開發流程裡人工核對,見 .claude/skills/automated-testing/SKILL.md 的補充說明。
-- 正式環境(wjtbmmnakcriuaqoknsq)這項設定在模組 1/2 開發時已經用 Supabase security advisor
-- 實測確認過(見 20260915110000 migration 的說明註解),之後若要調整 api.schemas 務必回頭
-- 重新核對這條假設是否還成立。
begin;

select plan(9);

select ok(
  not has_function_privilege('anon', 'private.is_merchant_admin(uuid)', 'execute'),
  'anon 角色不能執行 private.is_merchant_admin'
);
select ok(
  not has_function_privilege('public', 'private.is_merchant_admin(uuid)', 'execute'),
  'PUBLIC 虛擬角色也沒有 private.is_merchant_admin 的執行權(不會透過 PUBLIC 間接讓 anon 拿到權限)'
);
select ok(
  has_function_privilege('authenticated', 'private.is_merchant_admin(uuid)', 'execute'),
  'authenticated 角色可以執行 private.is_merchant_admin(RLS 政策運作所必需,刻意開放)'
);

select ok(
  not has_function_privilege('anon', 'private.is_group_member(uuid)', 'execute'),
  'anon 角色不能執行 private.is_group_member'
);
select ok(
  not has_function_privilege('public', 'private.is_group_member(uuid)', 'execute'),
  'PUBLIC 虛擬角色也沒有 private.is_group_member 的執行權'
);
select ok(
  has_function_privilege('authenticated', 'private.is_group_member(uuid)', 'execute'),
  'authenticated 角色可以執行 private.is_group_member'
);

select ok(
  not has_function_privilege('anon', 'private.is_platform_admin()', 'execute'),
  'anon 角色不能執行 private.is_platform_admin'
);
select ok(
  not has_function_privilege('public', 'private.is_platform_admin()', 'execute'),
  'PUBLIC 虛擬角色也沒有 private.is_platform_admin 的執行權'
);
select ok(
  has_function_privilege('authenticated', 'private.is_platform_admin()', 'execute'),
  'authenticated 角色可以執行 private.is_platform_admin'
);

select * from finish();

rollback;
