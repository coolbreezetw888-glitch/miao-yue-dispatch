// 模組 1:商家與集團管理 — 第五節「對外介面」的實作
// 其他模組要讀「目前操作中的商家」「我能管理哪些商家」「某個功能開關的值」「某商家的管理員名單」，
// 一律 import 這個檔案匯出的 hooks，不要自己 import supabase client 直接查 merchants/groups 等表。
//
// 2026-09-15 主腦複查修正(SPECS-INDEX 編號 26/27,打回重做後的修正):
// 在同一個瀏覽器分頁「登出帳號 A → 註冊全新帳號 B」時，B 會誤看到 A 選定的商家(B 在
// merchant_admins 表裡確認是 0 筆，不是後端資料外洩，純粹是前端快取沒有依帳號區分)。根本原因有兩層，
// 這次一併修正：
//   1. localStorage 的「目前操作中商家 id」原本是一個全域 key，不分帳號、登出時也沒有清除——見
//      constants.ts 的 getCurrentMerchantStorageKey，改成依登入使用者 id 分開存。
//   2. 這張商家清單的 react-query 快取 key 原本也是全域的(不含使用者 id)——如果帳號 A 尚未結束的
//      請求，在畫面已經切換到帳號 B 之後才回應，會把 A 的資料寫進這個全域共用的快取 key，讓 B 讀到
//      A 的商家清單。這是比 localStorage 更根本的一層，這次一併把查詢 key 也依使用者 id 分開，
//      這樣不同帳號的請求天生寫入不同的快取位置，不會互相污染。
//   3. 不管前兩點有沒有做全，這裡保留「使用快取的 merchant id 之前，一定要先確認它真的出現在目前
//      這個使用者實際查得到的商家清單裡才能採用，否則退回清單第一間或 null」這條最後防線
//      (下面 useEffect 的 stillValid 檢查)——這是之後任何模組要讀取「使用者上次操作狀態」的本機
//      快取時都應該遵守的通用模式：快取值必須先驗證對「目前登入的這個使用者」仍然有效，不能拿到就直接用。
//   4. 使用者登出時(見 src/routes/app.tsx 的 handleSignOut)額外呼叫這裡新增的
//      clearCurrentMerchantSelection(),把「目前這個使用者」的本機選擇也清掉，屬於保險做法。

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { fetchAccessibleMerchants, fetchMerchantAdminUsers, getFeatureFlag } from "./api";
import { getCurrentMerchantStorageKey } from "./constants";
import type { MerchantAdminUser, MerchantWithGroup } from "./types";

/** 只用來做 invalidateQueries 的前綴——react-query 對陣列型 queryKey 預設用「前綴比對」，
 * 用這個前綴可以一次讓所有使用者的快取都失效，不用知道確切的使用者 id。 */
const ACCESSIBLE_MERCHANTS_QUERY_KEY_PREFIX = ["merchant-module", "accessible-merchants"] as const;

function readStoredMerchantId(userId: string | null): string | null {
  if (!userId) return null;
  try {
    return window.localStorage.getItem(getCurrentMerchantStorageKey(userId));
  } catch {
    // 無痕視窗或瀏覽器封鎖 localStorage 時，退回記憶體狀態，不擋住畫面。
    return null;
  }
}

function writeStoredMerchantId(userId: string | null, id: string | null): void {
  if (!userId) return;
  try {
    const key = getCurrentMerchantStorageKey(userId);
    if (id) {
      window.localStorage.setItem(key, id);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

interface CurrentMerchantContextValue {
  merchants: MerchantWithGroup[];
  isLoading: boolean;
  error: Error | null;
  currentMerchantId: string | null;
  currentMerchant: MerchantWithGroup | null;
  setCurrentMerchantId: (id: string) => void;
  refetch: () => void;
  clearCurrentMerchantSelection: () => void;
}

const CurrentMerchantContext = createContext<CurrentMerchantContextValue | null>(null);

export function CurrentMerchantProvider({ children }: { children: ReactNode }) {
  // undefined = 還不知道(auth 狀態尚未確認過，這段期間不做任何清除/校正判斷，避免誤判成訪客)。
  // null = 確定沒有登入。字串 = 目前登入的使用者 id。
  const [userId, setUserId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!active) return;
      setUserId(data.user?.id ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setUserId(session?.user.id ?? null);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const [currentMerchantId, setCurrentMerchantIdState] = useState<string | null>(null);

  // 使用者身份確定之後(含「換成了不同的使用者」)，重新從這個使用者自己專屬的 localStorage key
  // 讀取上次選定的商家 id——不同帳號的 key 天生不會互相讀到，見上面 readStoredMerchantId。
  useEffect(() => {
    setCurrentMerchantIdState(readStoredMerchantId(userId ?? null));
  }, [userId]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [...ACCESSIBLE_MERCHANTS_QUERY_KEY_PREFIX, userId ?? null] as const,
    queryFn: fetchAccessibleMerchants,
    enabled: Boolean(userId),
  });

  const merchants = userId ? (data ?? []) : [];
  const merchantIdsKey = merchants.map((m) => m.id).join(",");
  // userId 還沒確認時視為載入中；確定沒有登入(null)時視為「載入完成、0 筆」，不是還在等。
  const isLoadingResolved = userId === undefined ? true : Boolean(userId) && isLoading;

  useEffect(() => {
    if (!userId) return; // 還沒登入/登入狀態未確認時不校正，避免把還沒讀出來的值誤清掉。
    if (isLoading) return;
    const stillValid = merchants.some((m) => m.id === currentMerchantId);
    if (stillValid) return;

    // 目前記住的商家已經不在「這個使用者」實際可存取的清單裡(換了帳號、被移除管理員權限、或是
    // 第一次登入還沒選過)，退回清單第一間；清單是空的話就清成 null，交給 4.6 AppShell 判斷要不要
    // 導去 Onboarding。這裡是最後一道防線：不管 localStorage/react-query 的快取 key 有沒有依帳號
    // 分開，都會用「目前真正登入的使用者能看到的清單」重新校正一次，不盲目相信快取值。
    const fallback = merchants[0]?.id ?? null;
    setCurrentMerchantIdState(fallback);
    writeStoredMerchantId(userId, fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, isLoading, merchantIdsKey]);

  function setCurrentMerchantId(id: string) {
    setCurrentMerchantIdState(id);
    writeStoredMerchantId(userId ?? null, id);
  }

  /** 登出時呼叫(見 src/routes/app.tsx handleSignOut):清掉「目前這個使用者」的本機商家選擇。
   * 主要防線是 localStorage key 已經依使用者 id 分開存，這裡是保險，避免同一使用者下次登入時
   * 還留著舊的選擇(例如那間商家後來被停用或移除管理員)。 */
  function clearCurrentMerchantSelection() {
    writeStoredMerchantId(userId ?? null, null);
    setCurrentMerchantIdState(null);
  }

  const currentMerchant = merchants.find((m) => m.id === currentMerchantId) ?? null;

  const value: CurrentMerchantContextValue = {
    merchants,
    isLoading: isLoadingResolved,
    error: error as Error | null,
    currentMerchantId,
    currentMerchant,
    setCurrentMerchantId,
    refetch: () => void refetch(),
    clearCurrentMerchantSelection,
  };

  return (
    <CurrentMerchantContext.Provider value={value}>{children}</CurrentMerchantContext.Provider>
  );
}

function useCurrentMerchantContext(): CurrentMerchantContextValue {
  const ctx = useContext(CurrentMerchantContext);
  if (!ctx) {
    throw new Error(
      "useCurrentMerchant / useGroupMerchants 系列 hook 必須包在 <CurrentMerchantProvider> 底下使用(見 src/routes/app.tsx)",
    );
  }
  return ctx;
}

/** 5.1 對外介面:回傳目前操作中商家的基本資料與載入狀態。 */
export function useCurrentMerchant(): {
  merchant: MerchantWithGroup | null;
  isLoading: boolean;
  error: Error | null;
} {
  const { currentMerchant, isLoading, error } = useCurrentMerchantContext();
  return { merchant: currentMerchant, isLoading, error };
}

/** 5.2 對外介面:回傳目前使用者能存取的所有商家清單。 */
export function useGroupMerchants(): {
  merchants: MerchantWithGroup[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { merchants, isLoading, error, refetch } = useCurrentMerchantContext();
  return { merchants, isLoading, error, refetch };
}

/** 4.5 分店切換器專用:除了清單本身，還要拿到目前選的 id 跟切換函式。 */
export function useMerchantSwitcherState() {
  const { merchants, currentMerchantId, setCurrentMerchantId, isLoading } =
    useCurrentMerchantContext();
  return { merchants, currentMerchantId, setCurrentMerchantId, isLoading };
}

/** 讓 4.6 AppShell 在建立/刪除商家等操作後，強制重新拉一次可存取商家清單。 */
export function useRefetchAccessibleMerchants() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: ACCESSIBLE_MERCHANTS_QUERY_KEY_PREFIX });
}

/** 登出時呼叫,清掉「目前這個使用者」的本機商家選擇快取(見 src/routes/app.tsx handleSignOut,
 * 對應 2026-09-15 主腦複查修正)。 */
export function useClearCurrentMerchantSelection() {
  const { clearCurrentMerchantSelection } = useCurrentMerchantContext();
  return clearCurrentMerchantSelection;
}

/** 5.3 對外介面:讀取目前操作中商家的某個功能開關值。找不到列或尚未選定商家時回傳 null。 */
export function useFeatureFlag(featureKey: string): UseQueryResult<boolean | null> {
  const { merchant } = useCurrentMerchant();
  return useQuery({
    queryKey: ["merchant-module", "feature-flag", merchant?.id, featureKey],
    queryFn: () => getFeatureFlag(merchant!.id, featureKey),
    enabled: Boolean(merchant?.id),
  });
}

/** 5.4 對外介面:回傳某商家目前的管理員名單(含 email),供模組 3 直接複用查詢邏輯。 */
export function useMerchantAdmins(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantAdminUser[]> {
  return useQuery({
    queryKey: ["merchant-module", "merchant-admins", merchantId],
    queryFn: () => fetchMerchantAdminUsers(merchantId as string),
    enabled: Boolean(merchantId),
  });
}
