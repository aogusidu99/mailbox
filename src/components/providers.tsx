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
          queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
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
