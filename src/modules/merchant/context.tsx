// 模組 1:商家與集團管理 — 第五節「對外介面」的實作
// 其他模組要讀「目前操作中的商家」「我能管理哪些商家」「某個功能開關的值」「某商家的管理員名單」，
// 一律 import 這個檔案匯出的 hooks，不要自己 import supabase client 直接查 merchants/groups 等表。

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { fetchAccessibleMerchants, fetchMerchantAdminUsers, getFeatureFlag } from "./api";
import { CURRENT_MERCHANT_STORAGE_KEY } from "./constants";
import type { MerchantAdminUser, MerchantWithGroup } from "./types";

const ACCESSIBLE_MERCHANTS_QUERY_KEY = ["merchant-module", "accessible-merchants"] as const;

function readStoredMerchantId(): string | null {
  try {
    return window.localStorage.getItem(CURRENT_MERCHANT_STORAGE_KEY);
  } catch {
    // 無痕視窗或瀏覽器封鎖 localStorage 時，退回記憶體狀態，不擋住畫面。
    return null;
  }
}

function writeStoredMerchantId(id: string | null): void {
  try {
    if (id) {
      window.localStorage.setItem(CURRENT_MERCHANT_STORAGE_KEY, id);
    } else {
      window.localStorage.removeItem(CURRENT_MERCHANT_STORAGE_KEY);
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
}

const CurrentMerchantContext = createContext<CurrentMerchantContextValue | null>(null);

export function CurrentMerchantProvider({ children }: { children: ReactNode }) {
  const [currentMerchantId, setCurrentMerchantIdState] = useState<string | null>(() =>
    readStoredMerchantId(),
  );

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ACCESSIBLE_MERCHANTS_QUERY_KEY,
    queryFn: fetchAccessibleMerchants,
  });

  const merchants = data ?? [];
  const merchantIdsKey = merchants.map((m) => m.id).join(",");

  useEffect(() => {
    if (isLoading) return;
    const stillValid = merchants.some((m) => m.id === currentMerchantId);
    if (stillValid) return;

    // 目前記住的商家已經不在可存取清單裡(例如被移除管理員權限、或是第一次登入還沒選過)，
    // 退回清單第一間；清單是空的話就清成 null，交給 4.6 AppShell 判斷要不要導去 Onboarding。
    const fallback = merchants[0]?.id ?? null;
    setCurrentMerchantIdState(fallback);
    writeStoredMerchantId(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, merchantIdsKey]);

  function setCurrentMerchantId(id: string) {
    setCurrentMerchantIdState(id);
    writeStoredMerchantId(id);
  }

  const currentMerchant = merchants.find((m) => m.id === currentMerchantId) ?? null;

  const value: CurrentMerchantContextValue = {
    merchants,
    isLoading,
    error: error as Error | null,
    currentMerchantId,
    currentMerchant,
    setCurrentMerchantId,
    refetch: () => void refetch(),
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
  return () => queryClient.invalidateQueries({ queryKey: ACCESSIBLE_MERCHANTS_QUERY_KEY });
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
