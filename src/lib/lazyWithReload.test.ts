// SPECS-INDEX #1054(網站拆檔):部署新版後舊分檔不存在 ⇒ 動態載入失敗時自動重新整理一次;
// 剛重整過(CHUNK_RELOAD_WINDOW_MS 內)又失敗就不再重整、照原本的錯誤往外丟。
// 這裡用假的 sessionStorage / reload / 時間驗證規則(含 QA 打回的「兩包一成一敗」無限重整情境)。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetChunkReloadStateForTest,
  CHUNK_RELOAD_FLAG_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  loadWithReloadOnce,
  type ChunkReloadEnvironment,
} from "./lazyWithReload";

function makeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      map.set(key, value);
    }),
  };
}

/** 讓 microtask 都跑完(檢查「不會結束的 promise」確實還沒結束)。 */
async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

const fail =
  (message = "chunk missing") =>
  () =>
    Promise.reject(new Error(message));
const ok =
  <T>(value: T) =>
  () =>
    Promise.resolve(value);

describe("loadWithReloadOnce", () => {
  let storage: ReturnType<typeof makeStorage>;
  let reload: ReturnType<typeof vi.fn>;
  let clock: number;
  let env: ChunkReloadEnvironment;

  /** 模擬整頁重新整理:模組層級狀態歸零,sessionStorage 保留,時間往前走一點。 */
  function simulatePageReload(elapsedMs = 500) {
    __resetChunkReloadStateForTest();
    clock += elapsedMs;
  }

  beforeEach(() => {
    __resetChunkReloadStateForTest();
    storage = makeStorage();
    reload = vi.fn();
    clock = 1_000_000;
    env = { getStorage: () => storage, reload, now: () => clock };
  });

  afterEach(() => {
    __resetChunkReloadStateForTest();
  });

  it("載入成功:回傳模組、不重新整理、不寫記號", async () => {
    await expect(loadWithReloadOnce(ok("ok"), env)).resolves.toBe("ok");
    expect(reload).not.toHaveBeenCalled();
    expect(storage.map.size).toBe(0);
  });

  it("第一次失敗:寫入時間記號、自動重新整理一次,promise 不結束(畫面停在骨架,不顯示錯誤)", async () => {
    let settled = false;
    loadWithReloadOnce(fail(), env).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.map.get(CHUNK_RELOAD_FLAG_KEY)).toBe(String(clock));
    expect(settled).toBe(false);
  });

  it("重新整理後仍失敗(記號還在有效期內):不再重新整理、照原本的錯誤往外丟", async () => {
    void loadWithReloadOnce(fail("x"), env);
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);

    simulatePageReload();
    const error = new Error("y");
    await expect(loadWithReloadOnce(() => Promise.reject(error), env)).rejects.toBe(error);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("QA 打回情境:同一網址要載兩包,A 包成功、B 包一直失敗 ⇒ 只重整一次,第二輪不可再重整", async () => {
    // 第一輪:A 成功、B 失敗 ⇒ 重整一次。
    await loadWithReloadOnce(ok("A"), env);
    void loadWithReloadOnce(fail("B"), env);
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);

    // 第二輪(重整後):A 先成功(不可以清掉記號),B 還是失敗 ⇒ 不再重整,錯誤往外丟。
    simulatePageReload();
    await expect(loadWithReloadOnce(ok("A"), env)).resolves.toBe("A");
    await expect(loadWithReloadOnce(fail("B"), env)).rejects.toThrow("B");
    expect(reload).toHaveBeenCalledTimes(1);

    // 再多跑幾輪(使用者手動重整、時間還在有效期內)也一樣不會自動重整。
    for (let round = 0; round < 5; round += 1) {
      simulatePageReload(1_000);
      await loadWithReloadOnce(ok("A"), env);
      await expect(loadWithReloadOnce(fail("B"), env)).rejects.toThrow("B");
    }
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("A 包成功、B 包失敗的順序反過來(B 先失敗、A 後成功)也一樣只重整一次", async () => {
    void loadWithReloadOnce(fail("B"), env);
    await loadWithReloadOnce(ok("A"), env);
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);

    simulatePageReload();
    await expect(loadWithReloadOnce(fail("B"), env)).rejects.toThrow("B");
    await loadWithReloadOnce(ok("A"), env);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("記號過期後(超過有效期)再遇到失敗:可以再自動重整一次,之後在有效期內又不再重整", async () => {
    void loadWithReloadOnce(fail(), env);
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);

    simulatePageReload(CHUNK_RELOAD_WINDOW_MS + 1);
    void loadWithReloadOnce(fail(), env);
    await flush();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(storage.map.get(CHUNK_RELOAD_FLAG_KEY)).toBe(String(clock));

    simulatePageReload();
    await expect(loadWithReloadOnce(fail(), env)).rejects.toThrow();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("記號內容不是數字:視為沒有記號,重整一次並改寫成時間戳", async () => {
    storage.map.set(CHUNK_RELOAD_FLAG_KEY, "garbage");
    void loadWithReloadOnce(fail(), env);
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.map.get(CHUNK_RELOAD_FLAG_KEY)).toBe(String(clock));
  });

  it("同一頁兩個載入同時失敗:只重新整理一次", async () => {
    void loadWithReloadOnce(fail("a"), env);
    void loadWithReloadOnce(fail("b"), env);
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("sessionStorage 不能用(丟例外):不自動重新整理(避免重整迴圈),照原本的錯誤往外丟", async () => {
    const error = new Error("chunk missing");
    const blocked: ChunkReloadEnvironment = {
      getStorage: () => {
        throw new Error("SecurityError");
      },
      reload,
      now: () => clock,
    };
    await expect(loadWithReloadOnce(() => Promise.reject(error), blocked)).rejects.toBe(error);
    expect(reload).not.toHaveBeenCalled();
  });

  it("sessionStorage 回傳 null:不自動重新整理,照原本的錯誤往外丟", async () => {
    const error = new Error("chunk missing");
    const none: ChunkReloadEnvironment = { getStorage: () => null, reload, now: () => clock };
    await expect(loadWithReloadOnce(() => Promise.reject(error), none)).rejects.toBe(error);
    expect(reload).not.toHaveBeenCalled();
  });

  it("寫入記號失敗(例如容量滿):不自動重新整理,照原本的錯誤往外丟", async () => {
    storage.setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const error = new Error("chunk missing");
    await expect(loadWithReloadOnce(() => Promise.reject(error), env)).rejects.toBe(error);
    expect(reload).not.toHaveBeenCalled();
  });

  it("sessionStorage 只存這一個記號", async () => {
    void loadWithReloadOnce(fail(), env);
    await flush();
    expect([...storage.map.keys()]).toEqual([CHUNK_RELOAD_FLAG_KEY]);
  });
});
