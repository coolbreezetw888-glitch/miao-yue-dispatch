/**
 * 「填過資料」(dirty)判斷 —— ui-overlay-patterns skill 三之六(第 11 批 J,#995 J-13)。
 *
 * 用途:全頁層 / 小卡窗按 Esc 或點上方空白條時,有填過資料要先問「確定放棄這次輸入？」。
 * 判斷方式是「跟打開時的內容比對」(改了又改回原樣 = 沒填),不是「有沒有碰過」。
 *
 * 用法(頁面):
 *   const formDirty = useFormDirty(form);
 *   // 在「把初始值灌進表單」的同一個地方呼叫 markClean(新增 = 空白表單那一刻;編輯 = 資料載入後 setForm 那一刻)
 *   setForm(initial); formDirty.markClean(initial);
 *   <FullPageLayerContent dirty={formDirty.dirty} ...>
 *
 * 🔴 不用「開窗那一刻自動拍快照」:編輯表單的資料是開窗後才非同步灌進來的,自動拍會誤判成「已填過」。
 *    markClean 沒被呼叫前 dirty 一律 false。
 */

import * as React from "react";

/** 「空」的值:`""`(去頭尾空白後)、null、undefined 視為相同。 */
function isEmptyLike(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isEmptyLike(a) && isEmptyLike(b)) return true;
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    // 陣列照順序比。
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const item of a) if (!b.has(item)) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!sameValue(a[key], b[key])) return false;
    }
    return true;
  }
  return Object.is(a, b);
}

/**
 * 目前的表單內容跟基準(打開時灌進去的內容)比,有沒有不一樣。
 * 深比較;字串先去頭尾空白;`""` / null / undefined 視為相同;陣列照順序比;物件少一個 key 等於 undefined。
 */
export function isFormDirty(current: unknown, baseline: unknown): boolean {
  return !sameValue(current, baseline);
}

export interface FormDirtyState<T> {
  /** 跟 markClean 時的內容不同 ⇒ true。markClean 沒被呼叫前一律 false。 */
  dirty: boolean;
  /** 在把初始值灌進表單的同一個地方呼叫,傳入那個初始值。 */
  markClean: (value: T) => void;
}

/** 給頁面用:傳入目前的表單內容,拿回 dirty 與 markClean。 */
export function useFormDirty<T>(current: T): FormDirtyState<T> {
  const [baseline, setBaseline] = React.useState<{ value: T } | null>(null);
  const markClean = React.useCallback((value: T) => {
    setBaseline({ value });
  }, []);
  const dirty = baseline ? isFormDirty(current, baseline.value) : false;
  return { dirty, markClean };
}
