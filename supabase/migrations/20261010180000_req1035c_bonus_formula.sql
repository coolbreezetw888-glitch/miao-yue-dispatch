-- SPECS-INDEX #1035 彈性計薪 C 批(自由公式)
-- 規格書:母版 .project/specs/彈性計薪.md 第三節 PC-F01~F03、PC-E01~E04,第四節 PX-03。
--
--   PC-E01  private.bonus_formula_compile(merchant, 文字)  白名單逐字掃描 + 遞迴下降解析 ⇒ AST jsonb
--           (輔助:bonus_formula_norm_char / bonus_formula_fail / bonus_formula_expect / bonus_formula_parse)
--   PC-E02  private.bonus_formula_eval(ast, vars)          只認 PC-E01 產生的節點,先整棵檢查形狀再計算
--           (輔助:bonus_formula_check_ast / bonus_formula_eval_node)
--           private.bonus_formula_vars(staff, 月)          公式用的欄位值(跟 bonus_compute_rules 同一個月份基準)
--   PC-E03  private.bonus_validate_rules / private.bonus_compute_rules 改版:多一種 kind = 'formula'
--           (只插 [req1035c begin/end] 標記段;其他四種規則的驗證與算法逐字保留)
--   PC-E04  public.preview_bonus_formula(merchant, 文字, staff, 月, 範例)
--
-- 🔴 公式安全(PX-03):全程不用動態 SQL。使用者打的字只會被「一個字一個字地比對白名單」,
--    變成 jsonb 語法樹;計算時遞迴走語法樹,只做 + - * / 比較 IF MIN MAX 與讀變數。
--    服務名稱只當成「查詢參數」拿去比對本店 service_items.name,不會被拼進任何 SQL。
-- 🔴 上限:原文 ≤ 300 字、記號 ≤ 150 個、括號 / 函式巢狀 ≤ 8 層、數量() / 業績() ≤ 10 次、
--    每個方案 ≤ 5 條公式;計算器另有節點數(≤ 300)、節點深度(≤ 200)、函式巢狀(≤ 8)保護(防竄改)。
-- 🔴 除以 0 ⇒ 那次除法 = 0 + 旗標 division_by_zero;任何中間值絕對值 > 1e12 ⇒ 整條 0 + 旗標 overflow;
--    結果四捨五入到元,< 0 ⇒ 0 + negative_clamped,> 1,000,000 ⇒ 1,000,000 + capped。報表不會因此失敗。
-- 🔴 private.* 一律 revoke all;public.preview_bonus_formula 先 revoke 再只 grant authenticated。
-- 🔴 沒有公式規則的方案:bonus_validate_rules / bonus_compute_rules 的輸出跟改版前逐鍵相同(pgTAP 鎖)。

-- =========================================================================
-- 單一字元正規化:全形 → 半形(括號、逗號、比較、運算、數字、英文字母、小數點、引號、空白)。
-- ≧ ≦ ≠ 是「一個字變兩個字」,由掃描器另外處理。
-- =========================================================================
create function private.bonus_formula_norm_char(p_c text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_c is null or p_c = '' then p_c
    when p_c = '（' then '('
    when p_c = '）' then ')'
    when p_c = '，' then ','
    when p_c = '＞' then '>'
    when p_c = '＜' then '<'
    when p_c = '＝' then '='
    when p_c = '＋' then '+'
    when p_c = '－' then '-'
    when p_c = '＊' then '*'
    when p_c = '×' then '*'
    when p_c = '／' then '/'
    when p_c = '÷' then '/'
    when p_c = '．' then '.'
    when p_c = '！' then '!'
    when p_c in ('“', '”', '＂') then '"'
    when p_c in (' ', '　', chr(9), chr(10), chr(13)) then ' '
    when ascii(p_c) between 65296 and 65305 then chr(ascii(p_c) - 65248)
    when ascii(p_c) between 65313 and 65338 then chr(ascii(p_c) - 65248)
    when ascii(p_c) between 65345 and 65370 then chr(ascii(p_c) - 65248)
    else p_c
  end;
$$;

revoke all on function private.bonus_formula_norm_char(text) from public, anon, authenticated;

-- 編譯錯誤:丟出專用錯誤碼 BFC01,hint = 第幾個字(沒有位置就空字串)。只有 bonus_formula_compile 會接住它。
create function private.bonus_formula_fail(p_message text, p_position integer)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'BFC01',
    message = p_message,
    hint = coalesce(p_position::text, '');
end;
$$;

revoke all on function private.bonus_formula_fail(text, integer) from public, anon, authenticated;

-- 期待下一個記號是 p_expect('rp' / 'end' / 'comma_or_rp'),不是就用白話說明哪裡不對。
create function private.bonus_formula_expect(p_tok jsonb, p_expect text)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_kind text := p_tok ->> 'k';
  v_pos integer := (p_tok ->> 'p')::integer;
begin
  if v_kind = p_expect or (p_expect = 'comma_or_rp' and v_kind in ('comma', 'rp')) then
    return;
  end if;
  if v_kind = 'end' then
    perform private.bonus_formula_fail(
      case when p_expect = 'comma_or_rp' then '少了右括號「)」，或參數之間少了逗號。' else '少了右括號「)」。' end,
      v_pos);
  elsif v_kind = 'rp' then
    perform private.bonus_formula_fail('這裡多了一個右括號「)」。', v_pos);
  elsif v_kind = 'comma' then
    perform private.bonus_formula_fail('逗號只能用在 IF、MIN、MAX 的括號裡，用來分開參數。', v_pos);
  else
    perform private.bonus_formula_fail('這裡少了運算符號（+、-、*、/ 或比較符號）。', v_pos);
  end if;
end;
$$;

revoke all on function private.bonus_formula_expect(jsonb, text) from public, anon, authenticated;

-- =========================================================================
-- 遞迴下降解析(優先順序:比較 < 加減 < 乘除 < 正負號 < 基本項)。
--   p_tokens:記號陣列(最後一個一定是 {k:'end'});p_pos:從第幾個記號開始(0 起算);
--   p_depth:目前括號 / 函式巢狀層數(> 8 ⇒ 編譯失敗);p_min_prec:這一層只吃優先順序 ≥ 它的運算。
--   回 {n: AST 節點, p: 下一個還沒用掉的記號位置}。
--   比較不能連續(1 < x < 10 ⇒ 錯誤,請用相乘或 IF);正負號連續出現時合併成一個 neg(不遞迴)。
-- =========================================================================
create function private.bonus_formula_parse(
  p_tokens jsonb,
  p_pos integer,
  p_depth integer,
  p_min_prec integer,
  p_merchant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_max_depth constant integer := 8;
  v_pos integer := p_pos;
  v_tok jsonb;
  v_neg boolean := false;
  v_node jsonb;
  v_sub jsonb;
  v_name text;
  v_fn_pos integer;
  v_args jsonb;
  v_argc integer;
  v_op text;
  v_prec integer;
  v_cmp_done boolean := false;
  v_service_name text;
  v_active_count integer;
  v_total_count integer;
  v_item_id uuid;
begin
  -- 正負號(連續的合併)
  loop
    v_tok := p_tokens -> v_pos;
    exit when not (v_tok ->> 'k' = 'op' and v_tok ->> 'v' in ('+', '-'));
    if v_tok ->> 'v' = '-' then
      v_neg := not v_neg;
    end if;
    v_pos := v_pos + 1;
  end loop;

  v_tok := p_tokens -> v_pos;
  case v_tok ->> 'k'
  when 'num' then
    v_node := jsonb_build_object('t', 'num', 'v', v_tok ->> 'v');
    v_pos := v_pos + 1;

  when 'lp' then
    if p_depth + 1 > c_max_depth then
      perform private.bonus_formula_fail('括號或函式包太多層了：最多 8 層。', (v_tok ->> 'p')::integer);
    end if;
    v_sub := private.bonus_formula_parse(p_tokens, v_pos + 1, p_depth + 1, 0, p_merchant_id);
    v_pos := (v_sub ->> 'p')::integer;
    perform private.bonus_formula_expect(p_tokens -> v_pos, 'rp');
    v_node := v_sub -> 'n';
    v_pos := v_pos + 1;

  when 'name' then
    v_name := v_tok ->> 'v';
    v_fn_pos := (v_tok ->> 'p')::integer;
    if (p_tokens -> (v_pos + 1)) ->> 'k' = 'lp' then
      if v_name in ('完成單數', '完成數量', '月薪', '請假天數') then
        perform private.bonus_formula_fail(
          '「' || v_name || '」是欄位，後面不能直接接括號；要相乘請寫「*」。',
          ((p_tokens -> (v_pos + 1)) ->> 'p')::integer);
      end if;
      if p_depth + 1 > c_max_depth then
        perform private.bonus_formula_fail('括號或函式包太多層了：最多 8 層。', v_fn_pos);
      end if;
      v_pos := v_pos + 2;

      if v_name in ('數量', '業績') then
        -- 指定服務(⚠️範圍 4):引號內必須完全等於本店某個服務項目名稱;存 id 不存名稱。
        v_tok := p_tokens -> v_pos;
        if v_tok ->> 'k' is distinct from 'str' then
          perform private.bonus_formula_fail(
            '「' || v_name || '」的括號裡要放服務名稱，例如 ' || v_name || '("冷氣清洗")。',
            (v_tok ->> 'p')::integer);
        end if;
        v_service_name := v_tok ->> 'v';
        if v_service_name = '' then
          perform private.bonus_formula_fail('服務名稱不能空白。', (v_tok ->> 'p')::integer);
        end if;
        select count(*) filter (where si.status = 'active'), count(*)
        into v_active_count, v_total_count
        from public.service_items si
        where si.merchant_id = p_merchant_id
          and si.name = v_service_name;
        if v_total_count = 0 then
          perform private.bonus_formula_fail(
            '找不到叫「' || left(v_service_name, 30) || '」的服務項目；名稱要跟「服務項目」裡的完全一樣。',
            (v_tok ->> 'p')::integer);
        end if;
        if v_active_count > 1 or (v_active_count = 0 and v_total_count > 1) then
          perform private.bonus_formula_fail(
            '有好幾個服務項目都叫「' || left(v_service_name, 30) || '」，請先把名稱改成不一樣再使用。',
            (v_tok ->> 'p')::integer);
        end if;
        select si.id into v_item_id
        from public.service_items si
        where si.merchant_id = p_merchant_id
          and si.name = v_service_name
          and (v_active_count = 0 or si.status = 'active')
        order by si.id
        limit 1;
        v_pos := v_pos + 1;
        perform private.bonus_formula_expect(p_tokens -> v_pos, 'rp');
        v_pos := v_pos + 1;
        v_node := jsonb_build_object(
          't', case when v_name = '數量' then 'item_units' else 'item_revenue' end,
          'id', v_item_id);
      else
        -- IF / MIN / MAX
        v_args := '[]'::jsonb;
        loop
          v_sub := private.bonus_formula_parse(p_tokens, v_pos, p_depth + 1, 0, p_merchant_id);
          v_args := v_args || jsonb_build_array(v_sub -> 'n');
          v_pos := (v_sub ->> 'p')::integer;
          v_tok := p_tokens -> v_pos;
          perform private.bonus_formula_expect(v_tok, 'comma_or_rp');
          v_pos := v_pos + 1;
          exit when v_tok ->> 'k' = 'rp';
        end loop;
        v_argc := jsonb_array_length(v_args);
        if v_name = 'IF' then
          if v_argc <> 3 then
            perform private.bonus_formula_fail('IF 要剛好 3 個參數：條件、成立時、不成立時。', v_fn_pos);
          end if;
          v_node := jsonb_build_object('t', 'if', 'c', v_args -> 0, 'a', v_args -> 1, 'b', v_args -> 2);
        else
          if v_argc < 2 or v_argc > 10 then
            perform private.bonus_formula_fail(v_name || ' 要 2～10 個參數，用逗號分開。', v_fn_pos);
          end if;
          v_node := jsonb_build_object('t', lower(v_name), 'args', v_args);
        end if;
      end if;
    else
      if v_name in ('IF', 'MIN', 'MAX') then
        perform private.bonus_formula_fail(v_name || ' 後面要接括號，例如 ' || v_name || '(…)。', v_fn_pos);
      end if;
      if v_name = '數量' then
        perform private.bonus_formula_fail('「數量」後面要接括號和服務名稱，例如 數量("冷氣清洗")。', v_fn_pos);
      end if;
      v_node := jsonb_build_object('t', 'var', 'n', case v_name
        when '完成單數' then 'orders'
        when '完成數量' then 'units'
        when '業績' then 'revenue'
        when '月薪' then 'salary'
        when '請假天數' then 'leave_days'
      end);
      if v_node ->> 'n' is null then
        perform private.bonus_formula_fail('不認識「' || left(v_name, 20) || '」。', v_fn_pos);
      end if;
      v_pos := v_pos + 1;
    end if;

  when 'str' then
    perform private.bonus_formula_fail('引號只能用在 數量("…")、業績("…") 的括號裡。', (v_tok ->> 'p')::integer);
  when 'end' then
    perform private.bonus_formula_fail('公式還沒寫完：後面少了數字或欄位。', (v_tok ->> 'p')::integer);
  when 'op' then
    perform private.bonus_formula_fail('「' || (v_tok ->> 'v') || '」前面少了數字或欄位。', (v_tok ->> 'p')::integer);
  else
    -- rp / comma
    if (p_tokens -> (v_pos - 1)) ->> 'k' = 'lp' and v_tok ->> 'k' = 'rp' then
      perform private.bonus_formula_fail('括號裡面是空的。', (v_tok ->> 'p')::integer);
    end if;
    perform private.bonus_formula_fail('這裡少了數字或欄位。', (v_tok ->> 'p')::integer);
  end case;

  if v_neg then
    v_node := jsonb_build_object('t', 'neg', 'x', v_node);
  end if;

  -- 二元運算(左結合;比較不能連續)
  loop
    v_tok := p_tokens -> v_pos;
    exit when v_tok ->> 'k' is distinct from 'op';
    v_op := v_tok ->> 'v';
    v_prec := case when v_op in ('+', '-') then 2 when v_op in ('*', '/') then 3 else 1 end;
    exit when v_prec < p_min_prec;
    if v_prec = 1 then
      if v_cmp_done then
        perform private.bonus_formula_fail(
          '一個式子裡只能比較一次；例如 1 < 完成單數 < 10 請寫成 (完成單數 > 1) * (完成單數 < 10)。',
          (v_tok ->> 'p')::integer);
      end if;
      v_cmp_done := true;
    end if;
    v_sub := private.bonus_formula_parse(p_tokens, v_pos + 1, p_depth, v_prec + 1, p_merchant_id);
    v_node := jsonb_build_object('t', 'bin', 'op', v_op, 'l', v_node, 'r', v_sub -> 'n');
    v_pos := (v_sub ->> 'p')::integer;
  end loop;

  return jsonb_build_object('n', v_node, 'p', v_pos);
end;
$$;

revoke all on function private.bonus_formula_parse(jsonb, integer, integer, integer, uuid) from public, anon, authenticated;

-- =========================================================================
-- 語法樹形狀檢查(防竄改):每個節點只能是下面幾種、欄位一個不多一個不少;
--   節點深度 ≤ 200、函式巢狀 ≤ 8。回節點總數。任何不符 ⇒ raise BFE02(代表資料被改過)。
-- =========================================================================
create function private.bonus_formula_check_ast(p_node jsonb, p_depth integer, p_fdepth integer)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_t text;
  v_keys text[];
  v_count integer := 1;
  v_arg jsonb;
  v_ok boolean := false;
  v_fdepth integer := p_fdepth;
begin
  if p_depth > 200 or p_node is null or jsonb_typeof(p_node) is distinct from 'object' then
    raise exception '獎金公式的資料不正確，請重新儲存這個獎金方案。' using errcode = 'BFE02';
  end if;

  select array_agg(k order by k) into v_keys from jsonb_object_keys(p_node) as t(k);
  v_t := case when jsonb_typeof(p_node -> 't') = 'string' then p_node ->> 't' end;

  if v_t = 'num' then
    v_ok := v_keys = array['t', 'v']
            and jsonb_typeof(p_node -> 'v') = 'string'
            and (p_node ->> 'v') ~ '^[0-9]{1,9}(\.[0-9]{1,4})?$';
  elsif v_t = 'var' then
    v_ok := v_keys = array['n', 't']
            and jsonb_typeof(p_node -> 'n') = 'string'
            and (p_node ->> 'n') in ('orders', 'units', 'revenue', 'salary', 'leave_days');
  elsif v_t in ('item_units', 'item_revenue') then
    v_fdepth := v_fdepth + 1;
    v_ok := v_keys = array['id', 't']
            and jsonb_typeof(p_node -> 'id') = 'string'
            and (p_node ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  elsif v_t = 'bin' then
    v_ok := v_keys = array['l', 'op', 'r', 't']
            and jsonb_typeof(p_node -> 'op') = 'string'
            and (p_node ->> 'op') in ('+', '-', '*', '/', '>', '>=', '<', '<=', '=', '<>');
    if v_ok then
      v_count := v_count
        + private.bonus_formula_check_ast(p_node -> 'l', p_depth + 1, v_fdepth)
        + private.bonus_formula_check_ast(p_node -> 'r', p_depth + 1, v_fdepth);
    end if;
  elsif v_t = 'neg' then
    v_ok := v_keys = array['t', 'x'];
    if v_ok then
      v_count := v_count + private.bonus_formula_check_ast(p_node -> 'x', p_depth + 1, v_fdepth);
    end if;
  elsif v_t = 'if' then
    v_fdepth := v_fdepth + 1;
    v_ok := v_keys = array['a', 'b', 'c', 't'] and v_fdepth <= 8;
    if v_ok then
      v_count := v_count
        + private.bonus_formula_check_ast(p_node -> 'c', p_depth + 1, v_fdepth)
        + private.bonus_formula_check_ast(p_node -> 'a', p_depth + 1, v_fdepth)
        + private.bonus_formula_check_ast(p_node -> 'b', p_depth + 1, v_fdepth);
    end if;
  elsif v_t in ('min', 'max') then
    v_fdepth := v_fdepth + 1;
    v_ok := v_keys = array['args', 't']
            and v_fdepth <= 8
            and jsonb_typeof(p_node -> 'args') = 'array'
            and jsonb_array_length(p_node -> 'args') between 2 and 10;
    if v_ok then
      for v_arg in select e from jsonb_array_elements(p_node -> 'args') as t(e)
      loop
        v_count := v_count + private.bonus_formula_check_ast(v_arg, p_depth + 1, v_fdepth);
      end loop;
    end if;
  end if;

  if not coalesce(v_ok, false) or v_fdepth > 8 or v_count > 300 then
    raise exception '獎金公式的資料不正確，請重新儲存這個獎金方案。' using errcode = 'BFE02';
  end if;

  return v_count;
end;
$$;

revoke all on function private.bonus_formula_check_ast(jsonb, integer, integer) from public, anon, authenticated;

-- =========================================================================
-- PC-E01 編譯器:原文 → {ok:true, ast, normalized_text} 或 {ok:false, message, position}
--   1. 全形符號正規化 → 長度檢查 → 逐字元掃描切記號(數字 / 名稱 / 字串 / 運算子 / 括號 / 逗號);
--      名稱只接受白名單,其他字元直接報錯(含位置,位置 = 原文第幾個字,1 起算)。
--   2. 遞迴下降解析(bonus_formula_parse)。
--   只接住自己丟的 BFC01;其他錯誤照常往外丟(不吞錯)。
-- =========================================================================
create function private.bonus_formula_compile(p_merchant_id uuid, p_text text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_max_len constant integer := 300;
  c_max_tokens constant integer := 150;
  c_max_item_calls constant integer := 10;
  -- 看不見的字元(控制字元、零寬字元、方向控制 U+202E 等、各種特殊空白):錯誤訊息不放原字元,改寫碼位。
  c_invisible constant text :=
    '^[[:cntrl:]\u00a0\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3164\ufeff\uffa0\ufff0-\ufffb]$';
  v_len integer;
  v_i integer := 1;
  v_raw text;
  v_c text;
  v_n text;
  v_start integer;
  v_buf text;
  v_int text;
  v_dec text;
  v_upper text;
  v_tokens jsonb[] := array[]::jsonb[];
  v_norm text := '';
  v_item_calls integer := 0;
  v_prev jsonb;
  v_parsed jsonb;
  v_ast jsonb;
  v_msg text;
  v_hint text;
begin
  if p_text is null
     or btrim(translate(p_text, '　' || chr(9) || chr(10) || chr(13), '    ')) = '' then
    return jsonb_build_object('ok', false, 'message', '請輸入公式。', 'position', null);
  end if;

  v_len := char_length(p_text);
  if v_len > c_max_len then
    return jsonb_build_object(
      'ok', false,
      'message', '公式最多 ' || c_max_len || ' 個字，目前 ' || v_len || ' 個字。',
      'position', null);
  end if;

  begin
    while v_i <= v_len loop
      v_raw := substr(p_text, v_i, 1);
      v_c := private.bonus_formula_norm_char(v_raw);
      v_n := private.bonus_formula_norm_char(substr(p_text, v_i + 1, 1));

      if v_c = ' ' then
        v_norm := v_norm || ' ';
        v_i := v_i + 1;
        continue;
      end if;

      -- 數字:整數最多 9 位、小數最多 4 位;不能加千分位逗號。
      if v_c ~ '^[0-9]$' then
        v_start := v_i;
        v_int := '';
        v_dec := null;
        while v_i <= v_len and private.bonus_formula_norm_char(substr(p_text, v_i, 1)) ~ '^[0-9]$' loop
          v_int := v_int || private.bonus_formula_norm_char(substr(p_text, v_i, 1));
          v_i := v_i + 1;
        end loop;
        if v_i <= v_len and private.bonus_formula_norm_char(substr(p_text, v_i, 1)) = '.' then
          v_dec := '';
          v_i := v_i + 1;
          while v_i <= v_len and private.bonus_formula_norm_char(substr(p_text, v_i, 1)) ~ '^[0-9]$' loop
            v_dec := v_dec || private.bonus_formula_norm_char(substr(p_text, v_i, 1));
            v_i := v_i + 1;
          end loop;
          if v_dec = '' then
            perform private.bonus_formula_fail('小數點後面要接數字。', v_i - 1);
          end if;
        end if;
        v_int := coalesce(nullif(ltrim(v_int, '0'), ''), '0');
        if char_length(v_int) > 9 then
          perform private.bonus_formula_fail('數字太大了：整數最多 9 位數。', v_start);
        end if;
        if v_dec is not null and char_length(v_dec) > 4 then
          perform private.bonus_formula_fail('小數最多 4 位。', v_start);
        end if;
        if v_dec is null
           and v_i <= v_len
           and private.bonus_formula_norm_char(substr(p_text, v_i, 1)) = ','
           and private.bonus_formula_norm_char(substr(p_text, v_i + 1, 1)) ~ '^[0-9]$'
           and private.bonus_formula_norm_char(substr(p_text, v_i + 2, 1)) ~ '^[0-9]$'
           and private.bonus_formula_norm_char(substr(p_text, v_i + 3, 1)) ~ '^[0-9]$'
           and coalesce(private.bonus_formula_norm_char(substr(p_text, v_i + 4, 1)), '') !~ '^[0-9]$' then
          perform private.bonus_formula_fail(
            '數字不能加千分位逗號，例如 100,000 請寫成 100000（如果是函式的兩個參數，請在逗號後面加一個空白）。',
            v_i);
        end if;
        v_buf := v_int || coalesce('.' || v_dec, '');
        v_tokens := v_tokens || jsonb_build_object('k', 'num', 'v', v_buf, 'p', v_start);
        v_norm := v_norm || v_buf;
        continue;
      end if;

      -- 名稱:中文或英文字母連續一段,只接受白名單。
      if v_c ~ '^[A-Za-z一-鿿]$' then
        v_start := v_i;
        v_buf := '';
        while v_i <= v_len and private.bonus_formula_norm_char(substr(p_text, v_i, 1)) ~ '^[A-Za-z一-鿿]$' loop
          v_buf := v_buf || private.bonus_formula_norm_char(substr(p_text, v_i, 1));
          v_i := v_i + 1;
        end loop;
        v_upper := upper(v_buf);
        if v_upper in ('IF', 'MIN', 'MAX') then
          v_buf := v_upper;
        elsif v_buf in ('完成單數', '完成數量', '業績', '月薪', '請假天數', '數量') then
          null;
        elsif v_upper in ('AND', 'OR', 'NOT') then
          perform private.bonus_formula_fail(
            '不支援「' || v_buf || '」；要同時符合兩個條件請把條件相乘，例如 (完成單數 > 10) * (業績 > 50000)，或用 IF 一層包一層。',
            v_start);
        elsif cardinality(v_tokens) >= 2
              and v_tokens[cardinality(v_tokens)] ->> 'k' = 'lp'
              and v_tokens[cardinality(v_tokens) - 1] ->> 'v' in ('數量', '業績') then
          perform private.bonus_formula_fail(
            '服務名稱要用引號包起來，例如 數量("' || left(v_buf, 20) || '")。',
            v_start);
        else
          perform private.bonus_formula_fail(
            '不認識「' || left(v_buf, 20) || '」，可以用的欄位有：完成單數、完成數量、業績、月薪、請假天數。',
            v_start);
        end if;
        v_tokens := v_tokens || jsonb_build_object('k', 'name', 'v', v_buf, 'p', v_start);
        v_norm := v_norm || v_buf;
        continue;
      end if;

      -- 字串:只用在 數量("…") / 業績("…");內容照原文(不做全形轉換),只當成比對服務名稱的參數。
      if v_c = '"' then
        v_start := v_i;
        v_buf := '';
        v_i := v_i + 1;
        loop
          if v_i > v_len then
            perform private.bonus_formula_fail('引號沒有成對：服務名稱後面要再加一個「"」。', v_start);
          end if;
          v_raw := substr(p_text, v_i, 1);
          exit when v_raw in ('"', '“', '”', '＂');
          if v_raw in (chr(10), chr(13)) then
            perform private.bonus_formula_fail('引號沒有成對：服務名稱後面要再加一個「"」。', v_start);
          end if;
          if v_raw ~ c_invisible then
            perform private.bonus_formula_fail(
              '這裡有看不見的特殊字元（U+' || upper(lpad(to_hex(ascii(v_raw)), 4, '0')) || '），請刪掉後重打。',
              v_i);
          end if;
          v_buf := v_buf || v_raw;
          v_i := v_i + 1;
        end loop;
        v_i := v_i + 1;
        if char_length(v_buf) > 100 then
          perform private.bonus_formula_fail('服務名稱太長了（最多 100 個字）。', v_start);
        end if;
        v_tokens := v_tokens || jsonb_build_object('k', 'str', 'v', v_buf, 'p', v_start);
        v_norm := v_norm || '"' || v_buf || '"';
        continue;
      end if;

      -- 運算子
      v_buf := null;
      if v_c in ('+', '*', '/') then
        v_buf := v_c;
      elsif v_c = '-' then
        if v_n = '-' then
          perform private.bonus_formula_fail('不能連續寫兩個減號「--」；要減掉負數請寫成 5 - (-3)。', v_i);
        end if;
        v_buf := '-';
      elsif v_c = '>' then
        v_buf := case when v_n = '=' then '>=' else '>' end;
      elsif v_c = '<' then
        v_buf := case when v_n = '=' then '<=' when v_n = '>' then '<>' else '<' end;
      elsif v_c = '=' then
        if v_n = '=' then
          perform private.bonus_formula_fail('比較「等於」只要寫一個「=」。', v_i);
        end if;
        v_buf := '=';
      elsif v_c = '!' then
        if v_n is distinct from '=' then
          perform private.bonus_formula_fail('不能使用「!」；「不等於」請寫 <>。', v_i);
        end if;
        v_buf := '<>';
      elsif v_c = '≧' then
        v_buf := '>=';
      elsif v_c = '≦' then
        v_buf := '<=';
      elsif v_c = '≠' then
        v_buf := '<>';
      end if;
      if v_buf is not null then
        v_tokens := v_tokens || jsonb_build_object('k', 'op', 'v', v_buf, 'p', v_i);
        v_norm := v_norm || v_buf;
        v_i := v_i + case when char_length(v_buf) = 2 and v_c in ('>', '<', '!') then 2 else 1 end;
        continue;
      end if;

      if v_c = '(' then
        v_prev := v_tokens[cardinality(v_tokens)];
        if v_prev ->> 'k' = 'name' and v_prev ->> 'v' in ('數量', '業績') then
          v_item_calls := v_item_calls + 1;
        end if;
        v_tokens := v_tokens || jsonb_build_object('k', 'lp', 'p', v_i);
      elsif v_c = ')' then
        v_tokens := v_tokens || jsonb_build_object('k', 'rp', 'p', v_i);
      elsif v_c = ',' then
        v_tokens := v_tokens || jsonb_build_object('k', 'comma', 'p', v_i);
      elsif v_c = '%' then
        perform private.bonus_formula_fail('不支援百分號；5% 請寫成 0.05。', v_i);
      elsif v_c = '^' then
        perform private.bonus_formula_fail('不支援次方，請改用乘法。', v_i);
      elsif v_c = '.' then
        perform private.bonus_formula_fail('小數點前面要有數字，例如 0.5。', v_i);
      elsif v_raw ~ c_invisible then
        perform private.bonus_formula_fail(
          '這裡有看不見的特殊字元（U+' || upper(lpad(to_hex(ascii(v_raw)), 4, '0')) || '），請刪掉後重打。',
          v_i);
      else
        perform private.bonus_formula_fail('不能使用「' || v_raw || '」。', v_i);
      end if;
      v_norm := v_norm || v_c;
      v_i := v_i + 1;
    end loop;

    if cardinality(v_tokens) > c_max_tokens then
      perform private.bonus_formula_fail(
        '公式太長了：最多 ' || c_max_tokens || ' 個符號（數字、欄位、運算符號、括號各算一個），目前 '
          || cardinality(v_tokens) || ' 個。',
        null);
    end if;
    if v_item_calls > c_max_item_calls then
      perform private.bonus_formula_fail(
        '數量("…")、業績("…") 合計最多用 ' || c_max_item_calls || ' 次，目前 ' || v_item_calls || ' 次。',
        null);
    end if;

    v_tokens := v_tokens || jsonb_build_object('k', 'end', 'p', v_len);
    v_parsed := private.bonus_formula_parse(to_jsonb(v_tokens), 0, 0, 0, p_merchant_id);
    perform private.bonus_formula_expect(to_jsonb(v_tokens) -> (v_parsed ->> 'p')::integer, 'end');
    v_ast := v_parsed -> 'n';
  exception when sqlstate 'BFC01' then
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
    return jsonb_build_object(
      'ok', false,
      'message', case when v_hint ~ '^[0-9]+$' then '第 ' || v_hint || ' 個字附近：' || v_msg else v_msg end,
      'position', case when v_hint ~ '^[0-9]+$' then v_hint::integer end);
  end;

  -- 自己產生的語法樹也走一次形狀檢查(跟計算器同一關)。
  perform private.bonus_formula_check_ast(v_ast, 1, 0);

  return jsonb_build_object(
    'ok', true,
    'ast', v_ast,
    'normalized_text', btrim(regexp_replace(v_norm, ' {2,}', ' ', 'g')),
    'item_calls', v_item_calls);
end;
$$;

revoke all on function private.bonus_formula_compile(uuid, text) from public, anon, authenticated;

-- =========================================================================
-- PC-E02 計算器(單一節點,遞迴)。回 {v: 數值, z: 有沒有除以 0}。
--   只在 bonus_formula_eval 檢查過整棵樹的形狀之後呼叫。任何中間值絕對值 > 1e12 ⇒ raise BFE01。
--   IF 只算選到的那一邊(另一邊的除以 0 不算旗標)。乘除結果保留 10 位小數,避免位數無限長。
-- =========================================================================
create function private.bonus_formula_eval_node(p_node jsonb, p_vars jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_t text := p_node ->> 't';
  v_l jsonb;
  v_r jsonb;
  v_a numeric;
  v_b numeric;
  v_v numeric;
  v_z boolean := false;
  v_arg jsonb;
  v_first boolean := true;
begin
  if v_t = 'num' then
    v_v := (p_node ->> 'v')::numeric;
  elsif v_t = 'var' then
    v_v := coalesce((p_vars ->> (p_node ->> 'n'))::numeric, 0);
  elsif v_t = 'item_units' then
    v_v := coalesce((p_vars -> 'item_units' ->> (p_node ->> 'id'))::numeric, 0);
  elsif v_t = 'item_revenue' then
    v_v := coalesce((p_vars -> 'item_revenue' ->> (p_node ->> 'id'))::numeric, 0);
  elsif v_t = 'neg' then
    v_l := private.bonus_formula_eval_node(p_node -> 'x', p_vars);
    v_v := -((v_l ->> 'v')::numeric);
    v_z := (v_l ->> 'z')::boolean;
  elsif v_t = 'bin' then
    v_l := private.bonus_formula_eval_node(p_node -> 'l', p_vars);
    v_r := private.bonus_formula_eval_node(p_node -> 'r', p_vars);
    v_a := (v_l ->> 'v')::numeric;
    v_b := (v_r ->> 'v')::numeric;
    v_z := (v_l ->> 'z')::boolean or (v_r ->> 'z')::boolean;
    case p_node ->> 'op'
    when '+' then v_v := v_a + v_b;
    when '-' then v_v := v_a - v_b;
    when '*' then v_v := round(v_a * v_b, 10);
    when '/' then
      if v_b = 0 then
        v_v := 0;
        v_z := true;
      else
        v_v := round(v_a / v_b, 10);
      end if;
    when '>' then v_v := case when v_a > v_b then 1 else 0 end;
    when '>=' then v_v := case when v_a >= v_b then 1 else 0 end;
    when '<' then v_v := case when v_a < v_b then 1 else 0 end;
    when '<=' then v_v := case when v_a <= v_b then 1 else 0 end;
    when '=' then v_v := case when v_a = v_b then 1 else 0 end;
    when '<>' then v_v := case when v_a <> v_b then 1 else 0 end;
    else
      raise exception '獎金公式的資料不正確，請重新儲存這個獎金方案。' using errcode = 'BFE02';
    end case;
  elsif v_t = 'if' then
    v_l := private.bonus_formula_eval_node(p_node -> 'c', p_vars);
    if (v_l ->> 'v')::numeric <> 0 then
      v_r := private.bonus_formula_eval_node(p_node -> 'a', p_vars);
    else
      v_r := private.bonus_formula_eval_node(p_node -> 'b', p_vars);
    end if;
    v_v := (v_r ->> 'v')::numeric;
    v_z := (v_l ->> 'z')::boolean or (v_r ->> 'z')::boolean;
  elsif v_t in ('min', 'max') then
    for v_arg in select e from jsonb_array_elements(p_node -> 'args') as t(e)
    loop
      v_l := private.bonus_formula_eval_node(v_arg, p_vars);
      v_a := (v_l ->> 'v')::numeric;
      v_z := v_z or (v_l ->> 'z')::boolean;
      if v_first then
        v_v := v_a;
        v_first := false;
      elsif v_t = 'min' then
        v_v := least(v_v, v_a);
      else
        v_v := greatest(v_v, v_a);
      end if;
    end loop;
  else
    raise exception '獎金公式的資料不正確，請重新儲存這個獎金方案。' using errcode = 'BFE02';
  end if;

  if v_v is null then
    raise exception '獎金公式的資料不正確，請重新儲存這個獎金方案。' using errcode = 'BFE02';
  end if;
  if abs(v_v) > 1000000000000 then
    raise exception 'overflow' using errcode = 'BFE01';
  end if;

  return jsonb_build_object('v', v_v, 'z', v_z);
end;
$$;

revoke all on function private.bonus_formula_eval_node(jsonb, jsonb) from public, anon, authenticated;

-- =========================================================================
-- PC-E02 計算器入口:回 {value, flags[]}(PC-F03)。
--   先檢查整棵樹形狀(竄改 ⇒ raise BFE02);溢位 ⇒ 0 + overflow;除以 0 ⇒ division_by_zero;
--   四捨五入到元;< 0 ⇒ 0 + negative_clamped;> 1,000,000 ⇒ 1,000,000 + capped。
-- =========================================================================
create function private.bonus_formula_eval(p_ast jsonb, p_vars jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_result jsonb;
  v_value numeric;
  v_flags jsonb := '[]'::jsonb;
begin
  perform private.bonus_formula_check_ast(p_ast, 1, 0);

  begin
    v_result := private.bonus_formula_eval_node(p_ast, coalesce(p_vars, '{}'::jsonb));
  exception when sqlstate 'BFE01' then
    return jsonb_build_object('value', 0, 'flags', '["overflow"]'::jsonb);
  end;

  if (v_result ->> 'z')::boolean then
    v_flags := v_flags || '["division_by_zero"]'::jsonb;
  end if;

  v_value := round((v_result ->> 'v')::numeric, 0);
  if v_value < 0 then
    v_value := 0;
    v_flags := v_flags || '["negative_clamped"]'::jsonb;
  elsif v_value > 1000000 then
    v_value := 1000000;
    v_flags := v_flags || '["capped"]'::jsonb;
  end if;

  return jsonb_build_object('value', v_value, 'flags', v_flags);
end;
$$;

revoke all on function private.bonus_formula_eval(jsonb, jsonb) from public, anon, authenticated;

-- =========================================================================
-- 公式用的欄位值(某人某月)。
--   完成單 = 跟 private.bonus_compute_rules **同一個條件**(主要服務人員、completed、
--   coalesce(completed_at, start_at) 落在該月台北時間)—— 改一邊要同步另一邊(pgTAP 比對)。
--   orders = 完成單數;units = Σ 數量;revenue = Σ 業績基準(booking_item_revenue_basis);
--   salary = 該月月底當時的月薪;leave_days = 該月 confirmed 請假涵蓋的天數(重疊只算一次);
--   item_units / item_revenue = 每個服務項目 id 的數量 / 業績。
-- =========================================================================
create function private.bonus_formula_vars(p_staff_id uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_month_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_start timestamptz;
  v_end timestamptz;
  v_booking_ids uuid[];
  v_orders integer;
  v_units numeric;
  v_revenue numeric;
  v_item_units jsonb;
  v_item_revenue jsonb;
  v_salary numeric;
  v_leave_days integer;
begin
  v_start := v_month::timestamp at time zone 'Asia/Taipei';
  v_end := (v_month + interval '1 month')::timestamp at time zone 'Asia/Taipei';

  select coalesce(array_agg(b.id), array[]::uuid[])
  into v_booking_ids
  from public.bookings b
  where b.staff_id = p_staff_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_start
    and coalesce(b.completed_at, b.start_at) < v_end;

  v_orders := cardinality(v_booking_ids);

  with items as (
    select r.service_item_id as s, r.quantity as q, r.basis_amount as r
    from unnest(v_booking_ids) as u(booking_id)
    cross join lateral private.booking_item_revenue_basis(u.booking_id) as r
  ), per_item as (
    select s, sum(q) as q, sum(r) as r from items group by s
  )
  select coalesce((select sum(q) from items), 0),
         coalesce((select sum(r) from items), 0),
         coalesce((select jsonb_object_agg(s::text, q) from per_item), '{}'::jsonb),
         coalesce((select jsonb_object_agg(s::text, r) from per_item), '{}'::jsonb)
  into v_units, v_revenue, v_item_units, v_item_revenue;

  select s.monthly_base_salary into v_salary
  from private.get_staff_payroll_status_as_of(
    p_staff_id,
    ((v_month + interval '1 month')::timestamp at time zone 'Asia/Taipei') - interval '1 microsecond'
  ) s;

  select count(distinct d)::integer into v_leave_days
  from public.staff_leave_records slr
  cross join lateral generate_series(
    greatest(slr.start_date, v_month)::timestamp,
    least(slr.end_date, v_month_end)::timestamp,
    interval '1 day') as g(d)
  where slr.staff_id = p_staff_id
    and slr.status = 'confirmed'
    and slr.start_date <= v_month_end
    and slr.end_date >= v_month;

  return jsonb_build_object(
    'orders', v_orders,
    'units', v_units,
    'revenue', v_revenue,
    'salary', coalesce(v_salary, 0),
    'leave_days', coalesce(v_leave_days, 0),
    'item_units', v_item_units,
    'item_revenue', v_item_revenue
  );
end;
$$;

revoke all on function private.bonus_formula_vars(uuid, date) from public, anon, authenticated;

-- =========================================================================
-- PC-E03 規則驗證改版(以 A 批上線版本 e5fd02a8 為底,只插 [req1035c] 標記段):
--   kind = 'formula':只准 key / label / kind / text / ast;ast 一律忽略,伺服器用 text 重新編譯;
--   每個方案最多 5 條公式;編譯失敗 ⇒ 「第 N 條規則的公式有錯誤：…」。
--   其他四種規則:驗證與輸出逐字不變(text / ast 對它們仍是「不認得的欄位」)。
-- =========================================================================
create or replace function private.bonus_validate_rules(p_merchant_id uuid, p_rules jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_allowed_keys constant text[] := array[
    'key', 'label', 'kind', 'metric', 'service_item_ids', 'threshold', 'cap', 'amount', 'percent', 'retroactive'
  ];
  -- [req1035c begin]
  c_formula_keys constant text[] := array['key', 'label', 'kind', 'text', 'ast'];
  v_formula_count int := 0;
  v_text text;
  v_compiled jsonb;
  -- [req1035c end]
  v_count int;
  v_idx int := 0;
  v_rule jsonb;
  v_prefix text;
  v_bad_key text;
  v_key text;
  v_keys text[] := array[]::text[];
  v_label text;
  v_kind text;
  v_metric text;
  v_ids jsonb;
  v_id_texts text[];
  v_id_text text;
  v_service_ids uuid[];
  v_threshold numeric;
  v_cap numeric;
  v_amount numeric;
  v_percent numeric;
  v_retroactive boolean;
  v_foreign_count int;
  v_out jsonb := '[]'::jsonb;
begin
  if p_rules is null or jsonb_typeof(p_rules) <> 'array' then
    raise exception '獎金規則的格式不正確。' using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_rules);
  if v_count < 1 or v_count > 20 then
    raise exception '一個獎金方案至少要有 1 條規則，最多 20 條。' using errcode = '22023';
  end if;

  for v_rule in select e from jsonb_array_elements(p_rules) as t(e)
  loop
    v_idx := v_idx + 1;
    v_prefix := '第 ' || v_idx || ' 條規則';

    if jsonb_typeof(v_rule) <> 'object' then
      raise exception '%的格式不正確。', v_prefix using errcode = '22023';
    end if;

    select k into v_bad_key
    from jsonb_object_keys(v_rule) as t(k)
    -- [req1035c begin] 公式規則用自己的欄位白名單
    where k <> all (case when v_rule ->> 'kind' = 'formula' then c_formula_keys else c_allowed_keys end)
    -- [req1035c end]
    order by k
    limit 1;
    if v_bad_key is not null then
      raise exception '%有不認得的欄位「%」。', v_prefix, left(v_bad_key, 40) using errcode = '22023';
    end if;

    -- key:前端產生,1~40 字、只能小寫英數與減號,同一版內唯一(報表明細對應用)。
    if jsonb_typeof(v_rule -> 'key') is distinct from 'string' then
      raise exception '%缺少代號。', v_prefix using errcode = '22023';
    end if;
    v_key := v_rule ->> 'key';
    if char_length(v_key) < 1 or char_length(v_key) > 40 or v_key !~ '^[a-z0-9-]+$' then
      raise exception '%的代號格式不正確。', v_prefix using errcode = '22023';
    end if;
    if v_key = any (v_keys) then
      raise exception '%的代號跟其他規則重複。', v_prefix using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;

    -- label:1~30 字(前後空白去掉後)。
    if jsonb_typeof(v_rule -> 'label') is distinct from 'string' then
      raise exception '%的「名稱」要 1～30 個字。', v_prefix using errcode = '22023';
    end if;
    v_label := btrim(v_rule ->> 'label');
    if char_length(v_label) < 1 or char_length(v_label) > 30 then
      raise exception '%的「名稱」要 1～30 個字。', v_prefix using errcode = '22023';
    end if;

    -- [req1035c begin] 自訂公式(PC-E03)
    if jsonb_typeof(v_rule -> 'kind') = 'string' and v_rule ->> 'kind' = 'formula' then
      v_formula_count := v_formula_count + 1;
      if v_formula_count > 5 then
        raise exception '一個方案最多 5 條自訂公式規則。' using errcode = '22023';
      end if;
      if jsonb_typeof(v_rule -> 'text') is distinct from 'string' then
        raise exception '%的公式不能空白。', v_prefix using errcode = '22023';
      end if;
      v_text := v_rule ->> 'text';
      v_compiled := private.bonus_formula_compile(p_merchant_id, v_text);
      if not coalesce((v_compiled ->> 'ok')::boolean, false) then
        raise exception '%的公式有錯誤：%', v_prefix, v_compiled ->> 'message' using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'key', v_key,
        'label', v_label,
        'kind', 'formula',
        'text', btrim(v_text),
        'ast', v_compiled -> 'ast'
      ));
      continue;
    end if;
    -- [req1035c end]

    -- kind:A 批四種(C 批才會多 formula)。
    v_kind := case when jsonb_typeof(v_rule -> 'kind') = 'string' then v_rule ->> 'kind' end;
    if v_kind is null or v_kind not in ('per_order', 'per_unit', 'percent', 'lump_sum') then
      raise exception '%的「給什麼」不正確。', v_prefix using errcode = '22023';
    end if;

    -- metric:per_order=orders、per_unit=units、percent=revenue(固定,函式強制);lump_sum 三選一(必填)。
    v_metric := case when jsonb_typeof(v_rule -> 'metric') = 'string' then v_rule ->> 'metric' end;
    if v_rule ? 'metric' and jsonb_typeof(v_rule -> 'metric') <> 'null' and v_metric is null then
      raise exception '%的「用什麼量判斷達標」不正確。', v_prefix using errcode = '22023';
    end if;
    if v_kind = 'lump_sum' then
      if v_metric is null or v_metric not in ('orders', 'units', 'revenue') then
        raise exception '%的「用什麼量判斷達標」不正確。', v_prefix using errcode = '22023';
      end if;
    else
      if v_metric is not null
         and v_metric <> (case v_kind when 'per_order' then 'orders' when 'per_unit' then 'units' else 'revenue' end) then
        raise exception '%的「用什麼量判斷達標」跟「給什麼」對不上。', v_prefix using errcode = '22023';
      end if;
      v_metric := case v_kind when 'per_order' then 'orders' when 'per_unit' then 'units' else 'revenue' end;
    end if;

    -- service_item_ids:0~50 個,必須是本店服務項目(含已下架);重複的合併。
    v_ids := v_rule -> 'service_item_ids';
    v_service_ids := array[]::uuid[];
    if v_ids is not null and jsonb_typeof(v_ids) <> 'null' then
      if jsonb_typeof(v_ids) <> 'array' then
        raise exception '%的「只算這些服務」格式不正確。', v_prefix using errcode = '22023';
      end if;
      if jsonb_array_length(v_ids) > 50 then
        raise exception '%的「只算這些服務」最多選 50 項。', v_prefix using errcode = '22023';
      end if;
      if exists (select 1 from jsonb_array_elements(v_ids) as t(e) where jsonb_typeof(e) <> 'string') then
        raise exception '%的「只算這些服務」格式不正確。', v_prefix using errcode = '22023';
      end if;
      select coalesce(array_agg(distinct e), array[]::text[]) into v_id_texts
      from jsonb_array_elements_text(v_ids) as t(e);
      foreach v_id_text in array v_id_texts
      loop
        if v_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception '%的「只算這些服務」格式不正確。', v_prefix using errcode = '22023';
        end if;
        v_service_ids := v_service_ids || v_id_text::uuid;
      end loop;
      select count(*) into v_foreign_count
      from unnest(v_service_ids) as u(id)
      where not exists (
        select 1 from public.service_items si where si.id = u.id and si.merchant_id = p_merchant_id
      );
      if v_foreign_count > 0 then
        raise exception '%的「只算這些服務」裡有不屬於這間店的服務項目。', v_prefix using errcode = '22023';
      end if;
      select coalesce(array_agg(id order by id), array[]::uuid[]) into v_service_ids
      from unnest(v_service_ids) as u(id);
    end if;

    -- threshold:0 ~ 1 億,最多 2 位小數(必填)。
    if jsonb_typeof(v_rule -> 'threshold') is distinct from 'number' then
      raise exception '%的「超過多少後才開始算」要填 0～100,000,000 之間的數字。', v_prefix using errcode = '22023';
    end if;
    v_threshold := (v_rule ->> 'threshold')::numeric;
    if v_threshold < 0 or v_threshold > 100000000 or scale(v_threshold) > 2 then
      raise exception '%的「超過多少後才開始算」要填 0～100,000,000 之間的數字，最多 2 位小數。', v_prefix using errcode = '22023';
    end if;

    -- cap(⚠️範圍 2):null 或 > threshold,同樣不超過 1 億。
    v_cap := null;
    if v_rule ? 'cap' and jsonb_typeof(v_rule -> 'cap') <> 'null' then
      if jsonb_typeof(v_rule -> 'cap') <> 'number' then
        raise exception '%的「算到多少為止」要填數字。', v_prefix using errcode = '22023';
      end if;
      v_cap := (v_rule ->> 'cap')::numeric;
      if v_cap <= v_threshold then
        raise exception '%的「算到多少為止」要大於「超過多少後才開始算」。', v_prefix using errcode = '22023';
      end if;
      if v_cap > 100000000 or scale(v_cap) > 2 then
        raise exception '%的「算到多少為止」要填 100,000,000 以內的數字，最多 2 位小數。', v_prefix using errcode = '22023';
      end if;
    end if;

    -- amount / percent:依種類二選一,另一個必須不填(或 null)。
    v_amount := null;
    v_percent := null;
    if v_kind = 'percent' then
      if v_rule ? 'amount' and jsonb_typeof(v_rule -> 'amount') <> 'null' then
        raise exception '%是「業績百分比」，不用填「金額」。', v_prefix using errcode = '22023';
      end if;
      if jsonb_typeof(v_rule -> 'percent') is distinct from 'number' then
        raise exception '%的「百分比」要填 0～100 之間的數字。', v_prefix using errcode = '22023';
      end if;
      v_percent := (v_rule ->> 'percent')::numeric;
      if v_percent < 0 or v_percent > 100 or scale(v_percent) > 2 then
        raise exception '%的「百分比」要填 0～100 之間的數字，最多 2 位小數。', v_prefix using errcode = '22023';
      end if;
    else
      if v_rule ? 'percent' and jsonb_typeof(v_rule -> 'percent') <> 'null' then
        raise exception '%不是「業績百分比」，不用填「百分比」。', v_prefix using errcode = '22023';
      end if;
      if jsonb_typeof(v_rule -> 'amount') is distinct from 'number' then
        raise exception '%的「金額」要填 0～1,000,000 元之間的數字。', v_prefix using errcode = '22023';
      end if;
      v_amount := (v_rule ->> 'amount')::numeric;
      if v_amount < 0 or v_amount > 1000000 or scale(v_amount) > 2 then
        raise exception '%的「金額」要填 0～1,000,000 元之間的數字，最多 2 位小數。', v_prefix using errcode = '22023';
      end if;
    end if;

    -- retroactive(⚠️範圍 3):boolean,預設 false;「達標給一筆」不適用。
    v_retroactive := false;
    if v_rule ? 'retroactive' and jsonb_typeof(v_rule -> 'retroactive') <> 'null' then
      if jsonb_typeof(v_rule -> 'retroactive') <> 'boolean' then
        raise exception '%的「達標後整月都算」格式不正確。', v_prefix using errcode = '22023';
      end if;
      v_retroactive := (v_rule ->> 'retroactive')::boolean;
    end if;
    if v_kind = 'lump_sum' and v_retroactive then
      raise exception '%是「達標給一筆」，不能勾選「達標後整月都算」。', v_prefix using errcode = '22023';
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'key', v_key,
      'label', v_label,
      'kind', v_kind,
      'metric', v_metric,
      'service_item_ids', to_jsonb(v_service_ids),
      'threshold', v_threshold,
      'cap', v_cap,
      'amount', v_amount,
      'percent', v_percent,
      'retroactive', v_retroactive
    ));
  end loop;

  return v_out;
end;
$$;

-- create or replace 保留原本的 ACL;這裡再收一次,確保跟 A 批相同(只有 postgres)。
revoke all on function private.bonus_validate_rules(uuid, jsonb) from public, anon, authenticated;

-- =========================================================================
-- PC-E03 規則計算改版(以 A 批上線版本 624275fc 為底,只插 [req1035c] 標記段):
--   kind = 'formula' ⇒ bonus_formula_eval(ast, 該人該月的欄位值);結果加進合計,旗標併入 flags(不重複)。
--   公式規則的明細只有 key / label / kind / amount / flags(量的欄位為 null),**不含公式原文**。
--   沒有公式規則時:輸出跟改版前逐鍵相同。
-- =========================================================================
create or replace function private.bonus_compute_rules(p_staff_id uuid, p_month date, p_rules jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_start timestamptz;
  v_end timestamptz;
  v_booking_ids uuid[];
  v_items jsonb;
  v_rule jsonb;
  v_ids uuid[];
  v_kind text;
  v_metric text;
  v_threshold numeric;
  v_cap numeric;
  v_amount numeric;
  v_percent numeric;
  v_retro boolean;
  v_q numeric;
  v_hi numeric;
  v_counted numeric;
  v_range_start numeric;
  v_range_end numeric;
  v_achieved boolean;
  v_rule_amount numeric;
  v_total numeric := 0;
  v_results jsonb := '[]'::jsonb;
  v_flags jsonb := '[]'::jsonb;
  -- [req1035c begin]
  v_fvars jsonb;
  v_feval jsonb;
  v_flag text;
  -- [req1035c end]
begin
  v_start := v_month::timestamp at time zone 'Asia/Taipei';
  v_end := (v_month + interval '1 month')::timestamp at time zone 'Asia/Taipei';

  select coalesce(array_agg(b.id order by coalesce(b.completed_at, b.start_at), b.id), array[]::uuid[])
  into v_booking_ids
  from public.bookings b
  where b.staff_id = p_staff_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_start
    and coalesce(b.completed_at, b.start_at) < v_end;

  select coalesce(jsonb_agg(jsonb_build_object(
           'b', u.booking_id, 's', r.service_item_id, 'q', r.quantity, 'r', r.basis_amount)), '[]'::jsonb)
  into v_items
  from unnest(v_booking_ids) as u(booking_id)
  cross join lateral private.booking_item_revenue_basis(u.booking_id) as r;

  for v_rule in select e from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) as t(e)
  loop
    v_kind := v_rule ->> 'kind';

    -- [req1035c begin] 自訂公式(PC-E03)
    if v_kind = 'formula' then
      if v_fvars is null then
        v_fvars := private.bonus_formula_vars(p_staff_id, v_month);
      end if;
      v_feval := private.bonus_formula_eval(v_rule -> 'ast', v_fvars);
      v_rule_amount := coalesce((v_feval ->> 'value')::numeric, 0);
      v_total := v_total + v_rule_amount;
      for v_flag in select jsonb_array_elements_text(v_feval -> 'flags')
      loop
        if not (v_flags ? v_flag) then
          v_flags := v_flags || to_jsonb(v_flag);
        end if;
      end loop;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'key', v_rule ->> 'key',
        'label', v_rule ->> 'label',
        'kind', 'formula',
        'metric', null,
        'quantity', null,
        'counted_quantity', null,
        'range_start', null,
        'range_end', null,
        'achieved', null,
        'amount', v_rule_amount,
        'flags', coalesce(v_feval -> 'flags', '[]'::jsonb)
      ));
      continue;
    end if;
    -- [req1035c end]

    v_metric := v_rule ->> 'metric';
    v_threshold := coalesce((v_rule ->> 'threshold')::numeric, 0);
    v_cap := (v_rule ->> 'cap')::numeric;
    v_amount := coalesce((v_rule ->> 'amount')::numeric, 0);
    v_percent := coalesce((v_rule ->> 'percent')::numeric, 0);
    v_retro := coalesce((v_rule ->> 'retroactive')::boolean, false);
    select coalesce(array_agg(e::uuid), array[]::uuid[]) into v_ids
    from jsonb_array_elements_text(coalesce(v_rule -> 'service_item_ids', '[]'::jsonb)) as t(e);

    -- 量 Q
    if v_metric = 'orders' then
      if cardinality(v_ids) = 0 then
        v_q := cardinality(v_booking_ids);
      else
        select count(distinct x.b) into v_q
        from jsonb_to_recordset(v_items) as x(b uuid, s uuid, q int, r numeric)
        where x.s = any (v_ids);
      end if;
    elsif v_metric = 'units' then
      select coalesce(sum(x.q), 0) into v_q
      from jsonb_to_recordset(v_items) as x(b uuid, s uuid, q int, r numeric)
      where cardinality(v_ids) = 0 or x.s = any (v_ids);
    else
      select coalesce(sum(x.r), 0) into v_q
      from jsonb_to_recordset(v_items) as x(b uuid, s uuid, q int, r numeric)
      where cardinality(v_ids) = 0 or x.s = any (v_ids);
    end if;

    v_counted := 0;
    v_range_start := null;
    v_range_end := null;
    v_achieved := null;
    v_rule_amount := 0;

    if v_kind in ('per_order', 'per_unit') then
      -- 單 / 份是整數:第 k 個算不算 ⇔ k 落在 (T, C];T、C 可能有小數 ⇒ 用 floor 換成整數界線。
      v_hi := case when v_cap is null then v_q else least(v_q, floor(v_cap)) end;
      if v_retro then
        if v_q > v_threshold then
          v_counted := greatest(v_hi, 0);
          v_range_start := 1;
        end if;
      else
        v_counted := greatest(v_hi - floor(v_threshold), 0);
        v_range_start := floor(v_threshold) + 1;
      end if;
      if v_counted > 0 then
        v_range_end := v_range_start + v_counted - 1;
      else
        v_range_start := null;
      end if;
      v_rule_amount := v_counted * v_amount;
    elsif v_kind = 'percent' then
      v_hi := case when v_cap is null then v_q else least(v_q, v_cap) end;
      if v_retro then
        if v_q > v_threshold then
          v_counted := greatest(v_hi, 0);
        end if;
      else
        v_counted := greatest(v_hi - v_threshold, 0);
      end if;
      v_rule_amount := v_counted * v_percent / 100;
    elsif v_kind = 'lump_sum' then
      v_achieved := case when v_threshold = 0 then v_q > 0 else v_q >= v_threshold end;
      if v_cap is not null and v_q > v_cap then
        v_achieved := false;
      end if;
      v_counted := case when v_achieved then 1 else 0 end;
      v_rule_amount := case when v_achieved then v_amount else 0 end;
    end if;

    v_rule_amount := round(v_rule_amount, 0);
    v_total := v_total + v_rule_amount;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'key', v_rule ->> 'key',
      'label', v_rule ->> 'label',
      'kind', v_kind,
      'metric', v_metric,
      'quantity', v_q,
      'counted_quantity', v_counted,
      'range_start', v_range_start,
      'range_end', v_range_end,
      'achieved', v_achieved,
      'amount', v_rule_amount
    ));
  end loop;

  if v_total > 1000000 then
    v_total := 1000000;
    -- [req1035c begin] 公式規則可能已經帶了 capped,不重複加
    if not (v_flags ? 'capped') then
      v_flags := v_flags || '["capped"]'::jsonb;
    end if;
    -- [req1035c end]
  end if;

  return jsonb_build_object(
    'month', v_month,
    'amount', v_total,
    'rules', v_results,
    'flags', v_flags
  );
end;
$$;

revoke all on function private.bonus_compute_rules(uuid, date, jsonb) from public, anon, authenticated;

-- =========================================================================
-- PC-E04 preview_bonus_formula(p_merchant_id, p_text, p_staff_id null, p_month null, p_sample null)
--   權限:can_manage_commission_settings(該店)。先編譯:
--     失敗 ⇒ {ok:false, message, position, value:null, flags:[], vars_used:null}(不 raise,畫面即時檢查用)
--     成功且有 p_staff_id ⇒ 用那人那月的實際數字(服務人員要同店、月份限最近 24 個月含本月);
--     否則有 p_sample ⇒ 用店家填的範例(只收 orders / units / revenue / salary / leave_days,0～1,000,000,000);
--       範例沒有「指定服務」的數字 ⇒ 數量("…") / 業績("…") 以 0 計算並帶旗標 sample_items_zero;
--     兩個都沒有 ⇒ 只回「公式可以使用」(value = null)。
--   回 {ok, message, position, value, flags, vars_used, normalized_text}。
-- =========================================================================
create function public.preview_bonus_formula(
  p_merchant_id uuid,
  p_text text,
  p_staff_id uuid default null,
  p_month date default null,
  p_sample jsonb default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_sample_keys constant text[] := array['orders', 'units', 'revenue', 'salary', 'leave_days'];
  v_this_month date := private.bonus_this_month();
  v_month date;
  v_compiled jsonb;
  v_ast jsonb;
  v_staff_merchant_id uuid;
  v_vars jsonb;
  v_eval jsonb;
  v_flags jsonb;
  v_bad_key text;
  v_key text;
  v_value numeric;
  v_item_ids uuid[];
  v_items jsonb;
begin
  if p_merchant_id is null or not private.can_manage_commission_settings(p_merchant_id) then
    raise exception '沒有權限試算這間商家的獎金。' using errcode = '42501';
  end if;

  v_compiled := private.bonus_formula_compile(p_merchant_id, p_text);
  if not coalesce((v_compiled ->> 'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'message', v_compiled ->> 'message',
      'position', v_compiled -> 'position',
      'value', null,
      'flags', '[]'::jsonb,
      'vars_used', null,
      'normalized_text', null);
  end if;
  v_ast := v_compiled -> 'ast';

  select coalesce(array_agg(distinct (j #>> '{}')::uuid), array[]::uuid[]) into v_item_ids
  from jsonb_path_query(v_ast, 'lax $.**.id') as q(j);

  if p_staff_id is not null then
    select ms.merchant_id into v_staff_merchant_id
    from public.merchant_staff ms
    where ms.id = p_staff_id;
    if not found or v_staff_merchant_id is distinct from p_merchant_id then
      raise exception '找不到這位服務人員。' using errcode = 'P0002';
    end if;
    if p_month is null then
      raise exception '請選擇要試算的月份。' using errcode = '22023';
    end if;
    v_month := date_trunc('month', p_month)::date;
    if v_month > v_this_month or v_month < (v_this_month - interval '23 months')::date then
      raise exception '試算月份只能選最近 24 個月（含本月）。' using errcode = '22023';
    end if;
    v_vars := private.bonus_formula_vars(p_staff_id, v_month);
  elsif p_sample is not null then
    if jsonb_typeof(p_sample) <> 'object' then
      raise exception '範例數字的格式不正確。' using errcode = '22023';
    end if;
    select k into v_bad_key
    from jsonb_object_keys(p_sample) as t(k)
    where k <> all (c_sample_keys)
    order by k
    limit 1;
    if v_bad_key is not null then
      raise exception '範例數字有不認得的欄位「%」。', left(v_bad_key, 40) using errcode = '22023';
    end if;
    v_vars := jsonb_build_object('item_units', '{}'::jsonb, 'item_revenue', '{}'::jsonb);
    foreach v_key in array c_sample_keys
    loop
      v_value := 0;
      if p_sample ? v_key and jsonb_typeof(p_sample -> v_key) <> 'null' then
        if jsonb_typeof(p_sample -> v_key) <> 'number' then
          raise exception '範例數字要填 0～1,000,000,000 之間的數字。' using errcode = '22023';
        end if;
        v_value := (p_sample ->> v_key)::numeric;
        if v_value < 0 or v_value > 1000000000 or scale(v_value) > 4 then
          raise exception '範例數字要填 0～1,000,000,000 之間的數字，最多 4 位小數。' using errcode = '22023';
        end if;
      end if;
      v_vars := v_vars || jsonb_build_object(v_key, v_value);
    end loop;
  else
    return jsonb_build_object(
      'ok', true,
      'message', null,
      'position', null,
      'value', null,
      'flags', '[]'::jsonb,
      'vars_used', null,
      'normalized_text', v_compiled ->> 'normalized_text');
  end if;

  v_eval := private.bonus_formula_eval(v_ast, v_vars);
  v_flags := coalesce(v_eval -> 'flags', '[]'::jsonb);
  if p_staff_id is null and cardinality(v_item_ids) > 0 then
    v_flags := v_flags || '["sample_items_zero"]'::jsonb;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', si.id,
           'name', si.name,
           'units', coalesce((v_vars -> 'item_units' ->> si.id::text)::numeric, 0),
           'revenue', coalesce((v_vars -> 'item_revenue' ->> si.id::text)::numeric, 0)
         ) order by si.name, si.id), '[]'::jsonb)
  into v_items
  from public.service_items si
  where si.merchant_id = p_merchant_id
    and si.id = any (v_item_ids);

  return jsonb_build_object(
    'ok', true,
    'message', null,
    'position', null,
    'value', v_eval -> 'value',
    'flags', v_flags,
    'vars_used', jsonb_build_object(
      'orders', v_vars -> 'orders',
      'units', v_vars -> 'units',
      'revenue', v_vars -> 'revenue',
      'salary', v_vars -> 'salary',
      'leave_days', v_vars -> 'leave_days',
      'items', v_items),
    'normalized_text', v_compiled ->> 'normalized_text');
end;
$$;

revoke all on function public.preview_bonus_formula(uuid, text, uuid, date, jsonb) from public, anon, authenticated;
grant execute on function public.preview_bonus_formula(uuid, text, uuid, date, jsonb) to authenticated;
