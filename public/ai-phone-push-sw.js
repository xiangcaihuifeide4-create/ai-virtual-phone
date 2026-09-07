// public/ai-phone-push-sw.js
importScripts('https://unpkg.com/@rei-standard/amsg-sw@0.9.0/dist/runtime.js');

self.addEventListener('install', (event) => {
    // 强制立即接管控制权
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // 立即控制所有客户端
    event.waitUntil(self.clients.claim());
});

// 处理来自主页面的后台接管请求
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'amsg-push-handover') {
        const payload = event.data.payload;
        
        // 取得真实的服务端 instant 地址
        // 这里只是演示，实际使用时需要前端在 localStorage 或环境变量里传入
        const INSTANT_SERVER_URL = "http://localhost:3000/instant"; 
        
        event.waitUntil(
            fetch(INSTANT_SERVER_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify(payload)
            }).catch(e => {
                console.error("[SW] Handover fetch failed:", e);
            })
        );
    }
});
