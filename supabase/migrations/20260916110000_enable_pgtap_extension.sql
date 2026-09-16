-- 基礎建設:啟用 pgTAP extension(資料庫層自動化測試用,對應 ARCHITECTURE.md 第八節第 5 條)
-- 正式專案 miaoyue(ref wjtbmmnakcriuaqoknsq)已經手動啟用過 pgtap(2026-09-16 用 list_extensions 確認過),
-- 這裡用 CREATE EXTENSION IF NOT EXISTS 補一份到版控的 migration 裡,是幂等操作(正式庫上再套用一次
-- 不會有任何副作用),目的是讓「本機 `supabase start` 建出來的全新測試用資料庫」也會自動啟用這個
-- extension,不用每次都手動下指令,見 .claude/skills/automated-testing/SKILL.md。
create extension if not exists pgtap with schema extensions;
