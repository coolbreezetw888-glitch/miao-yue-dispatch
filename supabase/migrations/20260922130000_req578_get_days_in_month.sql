-- 模組 8(薪資與帳務)規格書 §十 10.1:新增共用函式 private.get_days_in_month,回傳指定年月的
-- 實際天數(28~31,含閏年 2 月正確判斷)。直接用 PostgreSQL 內建日期運算,不自己手刻閏年判斷。
-- 供 private.compute_staff_payroll(/-_by_range)取代原本讀取 merchant_payroll_settings.
-- pay_days_per_month 的地方——「月折算天數」這次改成系統依「這筆計算實際查詢的年月」自動算出,
-- 不再是商家手動填寫的固定數字(該欄位已於同批次 20260922130200 移除)。

create or replace function private.get_days_in_month(p_year integer, p_month integer)
returns integer
language sql
immutable
set search_path = 'public'
as $function$
  select extract(
    day from (date_trunc('month', make_date(p_year, p_month, 1)) + interval '1 month - 1 day')
  )::integer;
$function$;

comment on function private.get_days_in_month(integer, integer) is '模組 8 §十 10.1:回傳指定年月的實際天數(28/29/30/31,含閏年 2 月正確判斷)。取代原本商家手動
填寫的固定「月折算天數」(merchant_payroll_settings.pay_days_per_month,已移除)。只給模組 8 內部
函式呼叫,不對外暴露。';

revoke execute on function private.get_days_in_month(integer, integer) from public, anon;
grant execute on function private.get_days_in_month(integer, integer) to authenticated;
