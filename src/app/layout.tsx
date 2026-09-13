import type { Metadata, Viewport } from "next";
import { Providers } from "@/components/providers";
import { getLocale } from "@/lib/locale-server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mailbox",
  description: "AI 邮件处理工作台",
  applicationName: "Mailbox",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Mailbox", statusBarStyle: "default" },
  icons: { icon: "/icons/icon.svg", apple: "/icons/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#171717",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale} className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
