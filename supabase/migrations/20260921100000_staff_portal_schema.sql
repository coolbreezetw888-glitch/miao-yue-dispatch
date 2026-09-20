-- 模組 14:服務人員端(資料層,第一支)。
-- 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\服務人員端.md 第一節 1.1/1.2。
--
-- 1.1 merchant_staff 擴充四個「登入身份」欄位,跟既有 status(是否仍是有效服務人員)欄位
-- 刻意脫鉤(判斷 5/規則 2.1)——status 繼續只代表「人員名錄有效性」,不因為登入邀請進度而
-- 改變;login_status 只代表「登入能力進度」,不因為 status 而自動改變。
-- ADD COLUMN ... DEFAULT 'not_invited' 讓所有既有服務人員資料(含真實商家「涼風工匠」/「美甲」
-- 的既有人員)自動回填,user_id 維持既有 NULL 值不變,對現有任何查詢/畫面零影響——目前沒有任何
-- 既有邏輯讀取這四個新欄位。

alter table public.merchant_staff
  add column login_status text not null default 'not_invited'
    check (login_status in ('not_invited', 'invited', 'active')),
  add column invited_login_email text,
  add column login_invited_at timestamptz,
  add column login_activated_at timestamptz;

comment on column public.merchant_staff.login_status is '對應規格書 1.1/規則 2.1:登入能力進度,跟 status(人員名錄有效性)完全脫鉤獨立記錄。not_invited(預設,尚未開通登入)/invited(邀請信已寄出或查無帳號剛送出邀請,尚未完成設定密碼)/active(已能登入)。只有 status=''active'' 且 login_status=''active'' 才視為「目前能登入且有效」的服務人員(規則 2.9)。';
comment on column public.merchant_staff.invited_login_email is '邀請當下輸入的登入 email,獨立存一份,不透過 auth.users 反查,設計理由完全比照 merchant_agents.invited_email(規格書 1.3)。';

-- =========================================================================
-- 1.2 merchant_staff_permissions(服務人員自助功能權限)。
-- 比照既有 merchant_agent_permissions 的設計語言,但主體改成 staff_id(逐位服務人員個別授權,
-- 不是商家層級統一開關),對應 ARCHITECTURE 第十一節明確要求。
-- 四個 section_key:staff_calendar_view / staff_availability_self_manage / staff_payroll_view /
-- staff_profile_edit。granted 預設 true(判斷 1:這四項功能只碰自己的資料,風險本質跟客服的
-- 商家層級敏感操作不同,預設全開通對第一次使用的師傅體驗較好,跟客服預設全關的既有慣例刻意不同)。
-- =========================================================================
create table public.merchant_staff_permissions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.merchant_staff(id) on delete cascade,
  section_key text not null,
  granted boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_id, section_key)
);

create index merchant_staff_permissions_staff_id_idx on public.merchant_staff_permissions (staff_id);

comment on table public.merchant_staff_permissions is '服務人員自助功能權限(對應規格書 1.2)。逐位服務人員個別授權(主體是 staff_id,不是商家層級統一開關),四個 section_key:staff_calendar_view/staff_availability_self_manage/staff_payroll_view/staff_profile_edit。granted 預設 true(判斷 1),跟 merchant_agent_permissions 預設 false 的既有慣例刻意不同——理由見規格書判斷 1:這四項功能只碰自己的資料,風險本質低,預設關閉會讓新受邀服務人員第一次登入看到一片空白,誤以為帳號壞了。';

create trigger merchant_staff_permissions_set_updated_at
  before update on public.merchant_staff_permissions
  for each row execute function public.set_updated_at();

alter table public.merchant_staff_permissions enable row level security;
