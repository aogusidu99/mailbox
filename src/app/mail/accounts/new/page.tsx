import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PROVIDER_PRESETS } from "@/server/providers/presets";
import { AddAccountForm, type PresetOption } from "./add-account-form";

export const metadata: Metadata = { title: "添加邮箱 · Mailbox" };

export default function NewAccountPage() {
  const presets: PresetOption[] = PROVIDER_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    authType: p.authType,
    help: p.help,
    domains: p.domains,
    imap: p.imap,
    smtp: p.smtp,
    domainHosts: p.domainHosts,
  }));
  return (
    <main className="mx-auto w-full max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle>添加邮箱</CardTitle>
          <CardDescription>支持 Gmail、QQ、163/126、iCloud 以及任意 IMAP/SMTP 邮箱。密码栏填写的是授权码或应用专用密码。</CardDescription>
        </CardHeader>
        <CardContent>
          <AddAccountForm presets={presets} />
        </CardContent>
      </Card>
    </main>
  );
}
