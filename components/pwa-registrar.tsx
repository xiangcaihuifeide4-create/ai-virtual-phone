"use client";

import { useEffect } from "react";

export function PWARegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    const register = () => {
      if (cancelled) return;
      // 注册宿主根作用域 SW
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
        console.warn("[PWA] Service worker registration failed:", error);
      });
      
      // 注册 AMSG 独立推送 SW（分配到子作用域，避免冲突）
      navigator.serviceWorker.register("/ai-phone-push-sw.js", { scope: "/ai-phone-push/" }).catch((error) => {
        console.warn("[PWA] AMSG Service worker registration failed:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return () => {
        cancelled = true;
      };
    }

    window.addEventListener("load", register, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
