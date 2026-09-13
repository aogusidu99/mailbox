import { Menu } from "lucide-react";
import { redirect } from "next/navigation";
import { signOut } from "@/auth";
import { Sidebar } from "@/components/mail/sidebar";
import { MobileSidebar } from "@/components/mail/mobile-sidebar";
import { RealtimeListener } from "@/lib/realtime";
import { TranslationLangsProvider } from "@/lib/translation-context";
import { loadAiSettings } from "@/server/ai/settings";
import { getSessionUser } from "@/server/auth/session";
import { getSidebarData } from "@/server/mail/queries";

/** 已登录区域的布局：左侧账号 / 文件夹栏 + 右侧内容；未登录跳转 /login。 */
export default async function MailLayout({ children }: LayoutProps<"/mail">) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const [sidebar, aiSettings] = await Promise.all([getSidebarData(user.id), loadAiSettings(user.id)]);

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <RealtimeListener />
      <div className="hidden md:flex">
        <Sidebar initial={sidebar} userEmail={user.email} signOutAction={signOutAction} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 items-center gap-2 border-b px-2 md:hidden">
          <MobileSidebar initial={sidebar} userEmail={user.email} signOutAction={signOutAction}>
            <Menu className="size-5" />
          </MobileSidebar>
          <span className="font-semibold">Mailbox</span>
        </div>
        {/* 内容区自己滚动：邮件工作区内部用 h-full，设置类长页面在这里滚动 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TranslationLangsProvider langs={aiSettings.data.translationLangs}>{children}</TranslationLangsProvider>
        </div>
      </div>
    </div>
  );
}
