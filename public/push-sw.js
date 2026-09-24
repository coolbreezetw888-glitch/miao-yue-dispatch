// 模組 15(手機推播通知)§7.1:純 JavaScript 靜態檔案,不經過 Vite/TypeScript 編譯
// (跟 public/manifest.json 一樣)。這個檔案被 vite.config.ts 的 VitePWA({ workbox: { importScripts }})
// 設定插入 dist/sw.js 最上方(`importScripts('/push-sw.js')`),註冊在同一個 service worker
// 執行環境下——不改動模組 7(排班與休假管理)已經踩坑修好的自動更新偵測邏輯,兩者互不干擾。
//
// 做三件事:收到推播時顯示通知(push)、使用者點擊通知時開啟/聚焦對應頁面(notificationclick)、
// 以及測試推播的送達回報(§6.3)。不做雙向互動,不做深層連結(§4.7 第 2 點的範圍)。
//
// ⚠️ 2026-09-25「手機推播擴及三種角色」批次修掉一個既有的真實 bug(§〇.5 / §4.7):
//    原本這裡的預設目的地寫死成 '/app/my-calendar',而 src/App.tsx 裡**根本沒有這個路由**
//    (服務人員的行事曆實際掛在 /app/calendar)。也就是說一旦真的有人收到推播並點下去,
//    會直接落到「找不到頁面」。這個 bug 一直沒被發現,正是因為正式環境的訂閱表一筆資料都沒有。
//    現在 fallback 一律改成 '/app' —— 這個路由一定存在,而且 HomePage 本身會依角色自動導到
//    正確落點。**不要再把任何具體的功能頁路徑寫成 fallback。**
//
// ⚠️ 這個檔案的邏輯必須跟 src/modules/push-notifications/pushPayload.ts 保持一致(比照模組 11
//    判斷 11:前端/service worker 執行環境彼此不共用程式碼,各自寫一份小型函式)。

// §4.7 第 4 點:唯一允許的 fallback。
var PUSH_FALLBACK_URL = "/app";

self.addEventListener("push", function (event) {
  event.waitUntil(handlePushEvent(event));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event));
});

async function handlePushEvent(event) {
  var payload = { title: "秒約", body: "", url: PUSH_FALLBACK_URL, kind: null, ackUrl: null };
  try {
    if (event.data) {
      var parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        payload = {
          title: typeof parsed.title === "string" && parsed.title ? parsed.title : payload.title,
          body: typeof parsed.body === "string" ? parsed.body : payload.body,
          url: typeof parsed.url === "string" && parsed.url ? parsed.url : payload.url,
          kind: typeof parsed.kind === "string" && parsed.kind ? parsed.kind : null,
          ackUrl: typeof parsed.ack_url === "string" && parsed.ack_url ? parsed.ack_url : null,
        };
      }
    }
  } catch (err) {
    // 解析失敗時使用預設值,不讓整個 push 事件因此失敗(比照規則 4.3「安靜」精神延伸到這裡)。
  }

  // ⚠️ 顯示通知永遠排第一,而且絕對不能因為下面的回報/postMessage 失敗就不顯示(§6.3 第 2 點)。
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "/icons/icon-192.png",
    data: { url: payload.url, kind: payload.kind, ackUrl: payload.ackUrl },
  });

  // §6.3 第 2 點:測試推播的送達回報。失敗直接吞掉。
  if (payload.kind === "test" && payload.ackUrl) {
    try {
      await fetch(payload.ackUrl, { method: "POST", body: "{}" });
    } catch (err) {
      // 回報失敗不影響任何事(通知已經顯示出來了)。
    }
  }

  // §6.3 第 3 點:對所有開著的分頁廣播,讓畫面可以立刻反應,不用等輪詢。
  try {
    var clientList = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (var i = 0; i < clientList.length; i++) {
      clientList[i].postMessage({
        type: payload.kind === "test" ? "push-test-received" : "push-received",
      });
    }
  } catch (err) {
    // 廣播失敗同樣不影響通知本身。
  }
}

async function handleNotificationClick(event) {
  var data = event.notification.data || {};
  var url = (typeof data.url === "string" && data.url) || PUSH_FALLBACK_URL;

  // §6.3 備援路徑:點一下測試通知就是「使用者真的看到了」的最強證據。把 token 帶回頁面,
  // 由頁面用使用者自己的 JWT 確認(畫面文案見 §6.5)。
  if (data.kind === "test" && typeof data.ackUrl === "string" && data.ackUrl) {
    try {
      var token = new URL(data.ackUrl).searchParams.get("token");
      if (token) {
        url = url + (url.indexOf("?") >= 0 ? "&" : "?") + "push_test_ack=" + token;
      }
    } catch (err) {
      // 解析失敗就用原本的網址,不影響導頁。
    }
  }

  var clientList = await clients.matchAll({ type: "window", includeUncontrolled: true });

  for (var i = 0; i < clientList.length; i++) {
    var client = clientList[i];
    if ("focus" in client) {
      await client.focus();
      if ("navigate" in client) {
        try {
          await client.navigate(url);
        } catch (err) {
          // 部分瀏覽器對已聚焦分頁呼叫 navigate 可能失敗,忽略即可(使用者已經看到分頁被帶到前景)。
        }
      }
      return;
    }
  }

  if (clients.openWindow) {
    await clients.openWindow(url);
  }
}
