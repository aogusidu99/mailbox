import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailAccounts, messages, type EmailAddress } from "@/db/schema";
import { withProvider } from "@/server/providers/factory";
import { buildMime } from "./compose";

/**
 * 退订助手（RFC 2369 List-Unsubscribe / RFC 8058 一键退订）：
 * 1. 有 List-Unsubscribe-Post: List-Unsubscribe=One-Click 且有 https 链接 → 服务端直接 POST；
 * 2. 有 mailto: → 用该账号 SMTP 发一封退订邮件；
 * 3. 只有 https 链接 → 交给浏览器打开。
 */

export type UnsubscribeResult = { method: "one-click" | "mailto"; detail: string } | { method: "link"; url: string } | { method: "none" };

export function parseListUnsubscribe(header: string | string[] | undefined | null): { mailto: URL[]; https: URL[] } {
  const text = Array.isArray(header) ? header.join(",") : (header ?? "");
  const out = { mailto: [] as URL[], https: [] as URL[] };
  for (const m of text.matchAll(/<([^>]+)>/g)) {
    try {
      const u = new URL(m[1].trim());
      if (u.protocol === "mailto:") out.mailto.push(u);
      else if (u.protocol === "https:" || u.protocol === "http:") out.https.push(u);
    } catch {
      /* ignore */
    }
  }
  return out;
}

export async function unsubscribe(userId: string, messageId: string): Promise<UnsubscribeResult> {
  const db = await getDb();
  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) throw new Error("邮件不存在");
  const account = await db.query.mailAccounts.findFirst({ where: eq(mailAccounts.id, message.accountId) });
  if (!account || account.userId !== userId) throw new Error("邮件不存在");
  const headers = message.headers ?? {};
  const targets = parseListUnsubscribe(headers["list-unsubscribe"]);
  const post = headers["list-unsubscribe-post"];
  const oneClick = (Array.isArray(post) ? post.join(" ") : (post ?? "")).toLowerCase().includes("list-unsubscribe=one-click");

  if (oneClick && targets.https[0]) {
    const url = targets.https[0];
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`退订请求失败（${res.status}）`);
    return { method: "one-click", detail: url.host };
  }

  if (targets.mailto[0]) {
    const to = targets.mailto[0];
    const address = to.pathname;
    const subject = to.searchParams.get("subject") || "unsubscribe";
    const body = to.searchParams.get("body") || "unsubscribe";
    const from: EmailAddress = { name: account.displayName ?? undefined, address: account.email };
    const { mime } = await buildMime({ from, to: [{ address }], subject, text: body });
    await withProvider(account, (provider) => provider.send(mime, { from: account.email, to: [address] }));
    return { method: "mailto", detail: address };
  }

  if (targets.https[0]) return { method: "link", url: targets.https[0].toString() };
  return { method: "none" };
}
