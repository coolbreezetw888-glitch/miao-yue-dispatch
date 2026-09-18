-- 模組 6:訂單管理(第二批)— §4.3 自訂工時開關,資料層。
-- 對應規格書 §2.1 bookings 新增欄位表:custom_duration_enabled/custom_duration_minutes。
-- 這兩欄位都可以直接一次到位(custom_duration_enabled 是常數 default false,
-- custom_duration_minutes 允許 null),不需要比照 unit_price_snapshot 那種分兩步回填的安全遷移。

alter table public.bookings
  add column custom_duration_enabled boolean not null default false,
  add column custom_duration_minutes integer check (custom_duration_minutes > 0);

comment on column public.bookings.custom_duration_enabled is '§4.3/§2.2 裁決 Q3(方向一):整筆訂單層級的自訂工時開關。關閉時沿用 Σ(duration_minutes_snapshot × quantity) 計算 end_at;開啟後改用 custom_duration_minutes 直接計算 end_at,會真的影響這筆訂單在行事曆上實際佔用的時段、以及跟其他預約的衝突檢查邊界(含第五節單日例外第三層)。';
comment on column public.bookings.custom_duration_minutes is '§4.3:自訂總服務時長(分鐘),custom_duration_enabled=true 時必填且必須 > 0;關閉時應存為 null,避免留著舊值造成混淆(§4.3 邊界情況)。';
