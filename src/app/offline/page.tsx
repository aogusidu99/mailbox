import type { Metadata } from "next";

export const metadata: Metadata = { title: "离线 · Mailbox" };

/** Service Worker 在断网时展示的页面 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-xl font-semibold">当前处于离线状态</h1>
      <p className="max-w-md text-sm text-muted-foreground">Mailbox 需要联网才能读取邮件。网络恢复后刷新页面即可。</p>
    </main>
  );
}
