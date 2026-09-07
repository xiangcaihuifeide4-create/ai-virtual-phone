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
