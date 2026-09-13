"use client";

import { useEffect } from "react";

/** 生产环境注册 Service Worker（离线壳 + 静态资源缓存）；开发环境不注册，避免缓存干扰热更新。 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("[pwa] service worker 注册失败:", err));
  }, []);
  return null;
}
