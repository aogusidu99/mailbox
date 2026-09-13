"use client";

import { useSyncExternalStore } from "react";

/** 订阅 CSS 媒体查询（SSR 时返回 false）。 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}
