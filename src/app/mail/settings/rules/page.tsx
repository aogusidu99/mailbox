import type { Metadata } from "next";
import { listRules } from "@/server/ai/rules";
import { requireUserPage } from "@/server/auth/session";
import { listAccounts } from "@/server/mail/accounts";
import { RulesPanel } from "./rules-panel";

export const metadata: Metadata = { title: "邮件规则 · Mailbox" };

export default async function RulesPage() {
  const user = await requireUserPage();
  const [rules, accounts] = await Promise.all([listRules(user.id), listAccounts(user.id)]);
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">邮件规则</h1>
        <p className="text-sm text-muted-foreground">用一句话描述你想怎么处理邮件，AI 会把它编译成结构化规则；新邮件到达时自动执行，动作同步到邮件服务器。</p>
      </div>
      <RulesPanel
        initialRules={rules.map((r) => ({
          id: r.id,
          name: r.name,
          naturalText: r.naturalText,
          compiled: r.compiled,
          enabled: r.enabled,
          accountId: r.accountId,
          runCount: r.runCount,
          lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
        }))}
        accounts={accounts.map((a) => ({ id: a.id, email: a.email }))}
      />
    </main>
  );
}
