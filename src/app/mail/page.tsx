import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getServerDict } from "@/lib/locale-server";
import { requireUserPage } from "@/server/auth/session";
import { listAccounts, listFoldersForAccount } from "@/server/mail/accounts";
import { WaitingForSync } from "./waiting-for-sync";

/** /mail：跳到第一个账号的收件箱；没有账号时引导添加。 */
export default async function MailHomePage() {
  const user = await requireUserPage();
  const accounts = await listAccounts(user.id);
  if (accounts.length === 0) {
    const t = (await getServerDict()).home;
    return (
      <main className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-xl font-semibold">{t.welcome}</h1>
        <p className="max-w-md text-sm text-muted-foreground">{t.intro}</p>
        <Button render={<Link href="/mail/accounts/new" />}>{t.add}</Button>
      </main>
    );
  }
  const first = accounts[0];
  const folders = await listFoldersForAccount(first.id);
  const inbox = folders.find((f) => f.role === "inbox") ?? folders[0];
  if (inbox) redirect(`/mail/${first.id}/${inbox.id}`);
  return <WaitingForSync accountId={first.id} />;
}
