-- SPECS-INDEX #987 第 10 批 10-7:資料庫函式錯誤訊息標點守門(防止半形標點長回來)
-- 規格書 .project/specs/資料庫錯誤訊息全形標點-第10批.md 第四節 10-7、第五節 5-1。
--
-- 🔴 為什麼要有這一支
--   第 10 批把 public / private 函式裡會顯示在畫面上的中文訊息,從半形 , : ; ! ? 改成全形。
--   之後新寫或重建函式時很容易又順手打成半形,沒有守門的話會一批一批慢慢長回來。
--
-- 📌 判斷規則(跟前端守門 src/lib/punctuationGuard.test.ts 一致,另外容許中間隔半形空白):
--   掃「目前生效」的函式本體(pg_proc.prosrc,public / private,排除 extension 自帶的函式),
--   先拿掉註解(-- 到行尾、/* … */),再找每一個單引號字串字面值,只要符合下列任一種就算違規:
--     ① 中文字(含 CJK 標點、全形字元)後面(可隔空白)接半形 , : ; ! ?
--     ② 半形 , : ; ! ? 後面(可隔空白)接中文字
--     ③ 半形 ) ] 後面接半形 , : ; ! ?,再接中文字
--   金額千分位(100,000)、時間(14:00)前後都是數字,不會被抓;半形括號、斜線本來就不在規則裡。
--   ⚠️ 不只看 raise:所有字串字面值都掃(比只看 raise 更嚴,format() 組字、變數暫存、回傳 jsonb 的文字都包含在內)。
--
-- 📌 放行清單(越短越好,每一條都寫理由;下方另有一條測試專抓「死掉的放行條目」):
--   目前是空的(第 11 批 #989 把原本三條預設文案 / 分類帳備註都改成全形後刪掉);結構保留,
--   真的有不該改的字串再加回來(每一條都要寫理由)。
begin;

select plan(9);

-- 一段原始碼裡,違規的字串字面值(原樣,含單引號)
create function pg_temp.req987_violations(p_src text) returns setof text language plpgsql immutable as $guard$
declare
  v_src text;
  v_lit text;
  -- 中文字:CJK 統一表意文字、CJK 標點(「」、。)、全形字元(，：（）)
  c_cjk constant text := '[　-〿㐀-鿿＀-￯]';
begin
  v_src := replace(p_src, E'\r\n', E'\n');
  v_src := regexp_replace(v_src, '/\*.*?\*/', '', 'g');
  v_src := regexp_replace(v_src, '--[^\n]*', '', 'g');
  for v_lit in
    select m[1] from regexp_matches(v_src, '(''(?:[^'']|'''')*'')', 'g') as m
  loop
    if v_lit ~ (c_cjk || '\s*[,:;!?]')
       or v_lit ~ ('[,:;!?]\s*' || c_cjk)
       or v_lit ~ ('[)\]][,:;!?]\s*' || c_cjk) then
      return next v_lit;
    end if;
  end loop;
end $guard$;

create function pg_temp.req987_all_hits() returns table(fn text, lit text) language sql stable as $$
  select n.nspname || '.' || p.proname, v.lit
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral pg_temp.req987_violations(p.prosrc) as v(lit)
  where n.nspname in ('public', 'private')
    and p.prokind in ('f', 'p')
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
$$;

-- 放行清單:函式名稱 + 字串裡的一小段原文(snippet 空字串 = 整支函式的字串都放行)
create function pg_temp.req987_allow() returns table(fn text, snippet text, reason text) language sql immutable as $$
  -- 第 11 批 #989:放行清單清空(回空集合),結構保留
  select null::text, null::text, null::text where false
$$;

-- ① 守門本體
select is(
  (select coalesce(array_agg(h.fn || ' ' || h.lit order by h.fn, h.lit), array[]::text[])
   from pg_temp.req987_all_hits() h
   where not exists (select 1 from pg_temp.req987_allow() a
                     where a.fn = h.fn and position(a.snippet in h.lit) > 0)),
  array[]::text[],
  '① public / private 函式裡的字串,中文旁邊不可以出現半形 , : ; ! ?(真的不該改的加進 req987_allow 並寫理由)'
);

-- ② 放行清單不可以有死項目
select is(
  (select coalesce(array_agg(a.fn || '「' || a.snippet || '」' order by a.fn), array[]::text[])
   from pg_temp.req987_allow() a
   where not exists (select 1 from pg_temp.req987_all_hits() h
                     where h.fn = a.fn and position(a.snippet in h.lit) > 0)),
  array[]::text[],
  '② 放行清單每一條都還對得到字串(對不到的代表已經改掉了,要從清單刪掉)'
);

-- ③~⑨ 偵測邏輯自我檢查(故障注入:確認守門真的會擋、也不會亂擋)
select is(
  (select count(*)::int from pg_temp.req987_violations($src$ raise exception '請稍後,再試一次'; $src$)),
  1, '③ 中文後面接半形逗號 ⇒ 抓到');
select is(
  (select count(*)::int from pg_temp.req987_violations($src$
     raise exception '找不到指定的商家: %', x;
     v_msg := format('原因:%s', r);
     return jsonb_build_object('message', '確定嗎?');
     raise exception '歡迎加入!';
     raise exception '(例如 0912345678);市話';
   $src$)),
  5, '④ 冒號(含後面隔空白)、format()、回傳 jsonb、驚嘆號、括號後的分號 ⇒ 全部抓到');
select is(
  (select count(*)::int from pg_temp.req987_violations($src$
     raise exception '找不到指定的商家：%', x;
     raise exception '單筆最多 100,000 點'; raise exception '開始時間(例如 14:00 或 14:30)';
     raise exception 'invalid input: %, %', a, b;
     raise exception '請輸入(例如 02-1234-5678#123)';
   $src$)),
  0, '⑤ 全形標點、千分位、時間、純英文、半形括號 ⇒ 不抓');
select is(
  (select count(*)::int from pg_temp.req987_violations($src$
     -- 註解裡的半形,不管:沒關係
     /* 區塊註解,也不管 */
     raise exception 'ok';
   $src$)),
  0, '⑥ 註解不掃');
select is(
  (select count(*)::int from pg_temp.req987_violations($src$ raise exception 'it''s 不行,喔'; $src$)),
  1, '⑦ 字串裡有跳脫的單引號('''')也切得對');
-- ⑧ 放行清單清空後,改用「在本交易內建一支故意寫半形的 public 函式」證明守門真的有掃 pg_proc
--    (不是掃了空集合);pgTAP 結束會 rollback,不留痕。
create function public.req987_probe() returns void language plpgsql as $probe$
begin
  raise exception '請稍後,再試';
end $probe$;
select ok(
  exists (select 1 from pg_temp.req987_all_hits() h where h.fn = 'public.req987_probe'),
  '⑧ 守門真的有掃到 public 函式(本交易內故意建的半形探針函式有被抓到 ⇒ 證明不是掃了空集合)');
select ok(
  (select count(distinct n.nspname || '.' || p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')) > 200,
  '⑨ 掃描範圍涵蓋 public / private 全部函式(> 200 支)');

select * from finish();
rollback;
