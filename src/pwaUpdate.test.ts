// SPECS-INDEX #1014(第 19 批):手機下拉重新整理 / App 切回前景時,也要主動檢查一次新版本。
// 規格:.project/specs/下拉刷新檢查新版本-第19批.md
//
// jsdom 沒有真正的 Service Worker,這裡用假的 navigator.serviceWorker / registration,
// 驗 src/pwaUpdate.ts 自己的邏輯:
//   ・checkForServiceWorkerUpdate:呼叫 registration.update()、30 秒節流、失敗安靜吞掉、永不 reject。
//   ・切回前景(visibilitychange → visible)會檢查一次;節流內不重複;切到背景不檢查。
//   ・重複呼叫 registerServiceWorkerAutoUpdate 不會重複掛監聽。
//   ・檢查後偵測到新版本 ⇒ 走原本的 updatefound 路徑通知訂閱者(isNewDetection: true),不自動套用。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetServiceWorkerUpdateStateForTest,
  checkForServiceWorkerUpdate,
  onServiceWorkerUpdateAvailable,
  registerServiceWorkerAutoUpdate,
  SERVICE_WORKER_UPDATE_CHECK_THROTTLE_MS,
} from "./pwaUpdate";

type Listener = () => void;

interface FakeRegistration {
  waiting: unknown;
  installing: FakeWorker | null;
  update: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, cb: Listener) => void;
  fire: (type: string) => void;
}

interface FakeWorker {
  state: string;
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, cb: Listener) => void;
  fire: (type: string) => void;
}

function makeEmitter() {
  const map = new Map<string, Listener[]>();
  return {
    addEventListener: (type: string, cb: Listener) => {
      map.set(type, [...(map.get(type) ?? []), cb]);
    },
    fire: (type: string) => {
      (map.get(type) ?? []).forEach((cb) => cb());
    },
  };
}

function makeWorker(): FakeWorker {
  return { state: "installing", postMessage: vi.fn(), ...makeEmitter() };
}

let registration: FakeRegistration;
let container: {
  controller: unknown;
  register: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};
let visibility: DocumentVisibilityState = "visible";
const hadServiceWorker = "serviceWorker" in navigator;

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** 註冊 + 觸發 load + 等 register() 的 promise 跑完。 */
async function registerAndLoad() {
  registerServiceWorkerAutoUpdate();
  window.dispatchEvent(new Event("load"));
  await vi.waitFor(() => expect(container.register).toHaveBeenCalled());
  await Promise.resolve();
  await Promise.resolve();
}

/** 讓排在 microtask 的 then/catch 都跑完。 */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  __resetServiceWorkerUpdateStateForTest();
  registration = {
    waiting: null,
    installing: null,
    update: vi.fn(() => Promise.resolve()),
    ...makeEmitter(),
  };
  container = {
    controller: {},
    register: vi.fn(() => Promise.resolve(registration)),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  __resetServiceWorkerUpdateStateForTest();
  if (!hadServiceWorker) {
    // jsdom 原本沒有 navigator.serviceWorker;還原成「不存在」。
    delete (navigator as unknown as Record<string, unknown>)["serviceWorker"];
  }
  delete (document as unknown as Record<string, unknown>)["visibilityState"];
});

describe("checkForServiceWorkerUpdate(#1014)", () => {
  it("還沒註冊好 service worker ⇒ 安靜略過,不報錯", async () => {
    await expect(checkForServiceWorkerUpdate()).resolves.toBe(false);
    expect(registration.update).not.toHaveBeenCalled();
  });

  it("註冊好之後 ⇒ 呼叫 registration.update()", async () => {
    await registerAndLoad();
    await expect(checkForServiceWorkerUpdate(100_000)).resolves.toBe(true);
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("30 秒節流:30 秒內第二次不送出,過了 30 秒才再送", async () => {
    await registerAndLoad();
    await checkForServiceWorkerUpdate(100_000);
    await expect(checkForServiceWorkerUpdate(100_000 + 5_000)).resolves.toBe(false);
    await expect(
      checkForServiceWorkerUpdate(100_000 + SERVICE_WORKER_UPDATE_CHECK_THROTTLE_MS - 1),
    ).resolves.toBe(false);
    expect(registration.update).toHaveBeenCalledTimes(1);
    await expect(
      checkForServiceWorkerUpdate(100_000 + SERVICE_WORKER_UPDATE_CHECK_THROTTLE_MS),
    ).resolves.toBe(true);
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it("上一次檢查還沒結束 ⇒ 不疊第二個(就算已經超過 30 秒)", async () => {
    await registerAndLoad();
    let finish: () => void = () => {};
    registration.update.mockImplementationOnce(
      () => new Promise<void>((r) => (finish = () => r())),
    );
    const first = checkForServiceWorkerUpdate(100_000);
    await expect(checkForServiceWorkerUpdate(100_000 + 60_000)).resolves.toBe(false);
    expect(registration.update).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await expect(checkForServiceWorkerUpdate(100_000 + 120_000)).resolves.toBe(true);
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it("🔴 檢查失敗(離線,update() reject)⇒ 安靜吞掉、不 reject;失敗也算一次節流", async () => {
    await registerAndLoad();
    registration.update.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    await expect(checkForServiceWorkerUpdate(100_000)).resolves.toBe(true);
    await expect(checkForServiceWorkerUpdate(100_000 + 1_000)).resolves.toBe(false);
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("🔴 update() 同步丟例外 ⇒ 也安靜吞掉、不 reject", async () => {
    await registerAndLoad();
    registration.update.mockImplementationOnce(() => {
      throw new Error("InvalidStateError");
    });
    await expect(checkForServiceWorkerUpdate(100_000)).resolves.toBe(true);
    // 進行中旗標有被清掉:過了節流可以再檢查。
    await expect(checkForServiceWorkerUpdate(200_000)).resolves.toBe(true);
  });

  it("檢查後偵測到新版本 ⇒ 照原本路徑通知訂閱者(isNewDetection: true),不自動送 SKIP_WAITING", async () => {
    await registerAndLoad();
    const listener = vi.fn();
    const unsubscribe = onServiceWorkerUpdateAvailable(listener);
    const worker = makeWorker();
    registration.update.mockImplementationOnce(() => {
      registration.installing = worker;
      registration.fire("updatefound");
      return Promise.resolve();
    });
    await checkForServiceWorkerUpdate(100_000);
    worker.state = "installed";
    worker.fire("statechange");
    expect(listener).toHaveBeenCalledWith({ isNewDetection: true });
    expect(worker.postMessage).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("切回前景時檢查新版本(#1014 主腦補上的決定)", () => {
  it("切回前景 ⇒ 檢查一次;節流內再切換不重複;切到背景不檢查", async () => {
    await registerAndLoad();
    setVisibility("hidden");
    await flush();
    expect(registration.update).not.toHaveBeenCalled();

    setVisibility("visible");
    await flush();
    expect(registration.update).toHaveBeenCalledTimes(1);

    // 馬上又切走再切回來(30 秒內)⇒ 不再打伺服器。
    setVisibility("hidden");
    setVisibility("visible");
    await flush();
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("過了 30 秒再切回前景 ⇒ 再檢查一次", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000_000);
    await registerAndLoad();
    setVisibility("visible");
    await flush();
    expect(registration.update).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + SERVICE_WORKER_UPDATE_CHECK_THROTTLE_MS + 1);
    setVisibility("hidden");
    setVisibility("visible");
    await flush();
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it("🔴 資安自檢:registerServiceWorkerAutoUpdate 被呼叫兩次 ⇒ 監聽不重複註冊(切回前景只檢查一次)", async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    registerServiceWorkerAutoUpdate();
    registerServiceWorkerAutoUpdate();
    window.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(container.register).toHaveBeenCalled());
    await flush();
    expect(container.register).toHaveBeenCalledTimes(1);
    expect(container.addEventListener).toHaveBeenCalledTimes(1); // controllerchange 只掛一次
    expect(addSpy.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);
    setVisibility("visible");
    await flush();
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("瀏覽器不支援 service worker ⇒ 什麼都不掛、不報錯", () => {
    delete (navigator as unknown as Record<string, unknown>)["serviceWorker"];
    const addSpy = vi.spyOn(document, "addEventListener");
    expect(() => registerServiceWorkerAutoUpdate()).not.toThrow();
    expect(addSpy.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(0);
  });
});
