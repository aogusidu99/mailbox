import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { mailAccounts, messages } from "@/db/schema";
import { requireUserPage } from "@/server/auth/session";

/**
 * 邮件短链接：/mail/m/<messageId> → 解析出账号 / 文件夹后跳到该邮件。
 * 供「和邮箱对话」、每日摘要等只知道 messageId 的地方引用邮件用（不必拼 accountId/folderId）。
 */
export default async function MessageRedirectPage(props: PageProps<"/mail/m/[messageId]">) {
  const user = await requireUserPage();
  const { messageId } = await props.params;
  const db = await getDb();
  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (message) {
    const account = await db.query.mailAccounts.findFirst({
      where: and(eq(mailAccounts.id, message.accountId), eq(mailAccounts.userId, user.id)),
    });
    if (account) redirect(`/mail/${message.accountId}/${message.folderId}?m=${messageId}`);
  }
  redirect("/mail");
}
