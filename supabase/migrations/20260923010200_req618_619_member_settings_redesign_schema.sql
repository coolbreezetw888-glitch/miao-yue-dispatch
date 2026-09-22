-- SPECS-INDEX #618/#619(規格書 .project/specs/會員與紅利.md §10.6/§10.7)。
-- 會員系統設定頁重新設計:
--   1. 移除「建立會員時電話必填」開關(phone_required_to_create)。
--   2. 移除「核發獎勵要求電話已驗證」開關(require_verified_phone_for_rewards),改用新的
--      reward_condition_mode(五選一)取代,跟既有「電話已驗證」條件並存,新增「LINE 已綁定」條件。
--   3.「基本政策」改名「會員政策」,新增啟用開關(policy_enabled)+ 政策內容欄位(policy_content)。
--
-- ⚠️ 根因記錄(對應 #618 決策文字要求,供之後任何類似「後端有設定值、前端沒讀」的問題排查參考):
-- 商家端人工驗收回報「關閉『建立會員時電話必填』開關後,新增會員頁面仍顯示必填」。engineer 這次
-- 逐一檢查這個系統目前所有讀取 phone_required_to_create 的前端程式碼,結果如下:
--   - src/modules/members/MembersListPage.tsx 的 NewMemberDialog:有正確讀取
--     settings?.phone_required_to_create 並依此決定星號/必填檢查,沒有寫死。
--   - src/modules/members/MemberPickerField.tsx 的 QuickCreateMemberDialog(建單表單快速建立會員
--     入口):完全沒有讀取這個設定值,姓名以外的欄位一律不要求必填(跟回報的「仍顯示必填」現象方向
--     相反,不完全吻合)。
--   - src/modules/data-tools/ImportWizardPage.tsx(模組 12 批次匯入預覽):有正確讀取。
-- 沒有在這份程式碼庫裡找到「完全寫死必填、忽略設定值」的那個確切位置,無法百分之百重現回報的
-- 現象——不排除是商家當時看到的其實是「建單表單」本身「客戶電話」欄位(bookings.customer_phone,
-- 訂單聯絡資訊,一律必填,跟會員的 phone_required_to_create 是兩個不同的欄位/兩件不同的事)被誤認
-- 成「會員電話必填」。**這個開關這次直接移除(不是修好它),上面的排查過程完整記錄下來,是為了
-- 避免之後其他模組出現類似「使用者回報某個設定開關沒作用」時,徒勞地在同一批檔案裡重複排查。**
--
-- 這次順便判斷:10.2 節(SPECS-INDEX #614)已經把電話定位成「查詢索引,不是必填的唯一鍵」,
-- phone_required_to_create 這個欄位在新設計下沒有任何邏輯還需要它,直接 drop column(而不是保留
-- 但不使用),避免留下死欄位。

alter table public.merchant_member_settings
  drop column phone_required_to_create,
  drop column require_verified_phone_for_rewards;

alter table public.merchant_member_settings
  add column reward_condition_mode text not null default 'none'
    check (reward_condition_mode in ('none', 'phone_verified', 'line_bound', 'either', 'both')),
  add column policy_enabled boolean not null default false,
  add column policy_content text;

comment on column public.merchant_member_settings.reward_condition_mode is '模組 10 §10.7(SPECS-INDEX #619):核發紅利/推薦獎勵/生日贈點前的資格判斷條件,取代原本的 require_verified_phone_for_rewards 單一 boolean 開關。none=不設條件(符合既有其他規則就核發);phone_verified=只看電話已驗證;line_bound=只看 LINE 已綁定;either=電話已驗證或 LINE 已綁定其中一項即可;both=兩者都要符合。跟既有 members.phone_verified 並存,line_bound 讀取既有 members.line_bound(模組 11 LINE通知已建立)。';
comment on column public.merchant_member_settings.policy_enabled is '模組 10 §10.6(SPECS-INDEX #618):是否啟用「會員政策」(原「基本政策」改名),啟用後 policy_content 才會顯示給客戶端(模組 13 之後串接)/預覽效果使用。';
comment on column public.merchant_member_settings.policy_content is '模組 10 §10.6:會員政策內容,純文字,前端用可自動依內容調整高度的文字區域顯示/編輯,不需要富文本編輯器。';
