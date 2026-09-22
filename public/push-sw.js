// 模組 15(服務人員推播通知)§7.1:純 JavaScript 靜態檔案,不經過 Vite/TypeScript 編譯
// (跟 public/manifest.json 一樣)。這個檔案被 vite.config.ts 的 VitePWA({ workbox: { importScripts }})
// 設定插入 dist/sw.js 最上方(`importScripts('/push-sw.js')`),註冊在同一個 service worker
// 執行環境下——不改動模組 7(排班與休假管理)已經踩坑修好的自動更新偵測邏輯,兩者互不干擾。
//
// 只做兩件事:收到推播時顯示通知(push)、使用者點擊通知時開啟/聚焦對應頁面(notificationclick)。
// 不做雙向互動(規格書「本模組明確不做的事」),不做深層連結(先一律導到 /app/my-calendar)。

self.addEventListener("push", function (event) {
  event.waitUntil(handlePushEvent(event));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event));
});

async function handlePushEvent(event) {
  var payload = { title: "秒約", body: "", url: "/app/my-calendar" };
  try {
    if (event.data) {
      var parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        payload = {
          title: typeof parsed.title === "string" && parsed.title ? parsed.title : payload.title,
          body: typeof parsed.body === "string" ? parsed.body : payload.body,
          url: typeof parsed.url === "string" && parsed.url ? parsed.url : payload.url,
        };
      }
    }
  } catch (err) {
    // 解析失敗時使用預設值,不讓整個 push 事件因此失敗(比照規則 4.3「安靜」精神延伸到這裡)。
  }

  await self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "/icons/icon-192.png",
    data: { url: payload.url },
  });
}

async function handleNotificationClick(event) {
  var url = (event.notification.data && event.notification.data.url) || "/app/my-calendar";
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
