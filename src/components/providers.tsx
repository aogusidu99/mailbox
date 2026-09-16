"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Locale } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/locale-context";
import { RegisterServiceWorker } from "./register-sw";

/** 客户端全局 Provider：TanStack Query、Tooltip、Toast、语言、PWA。 */
export function Providers({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // staleTime：30s 内视为新鲜，切回不重新请求；gcTime：5min 内保留缓存，
          // 会话内来回切换（邮件列表、正文等用 useQuery 的数据）秒开。
          queries: { staleTime: 30_000, gcTime: 300_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  return (
    <LocaleProvider locale={locale}>
      <QueryClientProvider client={client}>
        <TooltipProvider>{children}</TooltipProvider>
        {/* 放右下角，避免遮住顶部工具栏 */}
        <Toaster position="bottom-right" richColors />
        <RegisterServiceWorker />
      </QueryClientProvider>
    </LocaleProvider>
  );
}
