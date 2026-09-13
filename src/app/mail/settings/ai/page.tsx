import type { Metadata } from "next";
import { loadAiSettings, toSettingsView } from "@/server/ai/settings";
import { usageSummary } from "@/server/ai/usage";
import { requireUserPage } from "@/server/auth/session";
import { listAccounts } from "@/server/mail/accounts";
import { AiSettingsPanel } from "./ai-settings-panel";

export const metadata: Metadata = { title: "AI 设置 · Mailbox" };

export default async function AiSettingsPage() {
  const user = await requireUserPage();
  const [settings, usage, accounts] = await Promise.all([loadAiSettings(user.id), usageSummary(user.id, 30), listAccounts(user.id)]);
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">AI 设置</h1>
        <p className="text-sm text-muted-foreground">
          配置各家厂商的 API Key，从厂商实时拉取模型列表并勾选候选池，再按任务难度为不同等级指定模型。Key 加密保存在本地数据库。
        </p>
      </div>
      <AiSettingsPanel
        initial={toSettingsView(settings)}
        usage={usage}
        accounts={accounts.map((a) => ({ id: a.id, email: a.email, aiEnabled: a.aiEnabled }))}
      />
    </main>
  );
}
