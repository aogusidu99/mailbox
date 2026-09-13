import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { folders, mailAccounts, type Folder, type MailAccount } from "@/db/schema";
import { enqueueSyncAccount } from "@/server/jobs/queues";
import { encryptCredentials } from "@/server/providers/factory";
import { ImapProvider, type ImapAccountConfig } from "@/server/providers/imap";
import { getPreset, resolvePresetHosts, type PresetId } from "@/server/providers/presets";
import type { ConnectionTestResult } from "@/server/providers/types";
import { FOLDER_ROLE_ORDER } from "@/server/sync/engine";

/**
 * 邮箱账号服务：添加（含测试连接）、列表、删除。
 */

export const accountInputSchema = z.object({
  email: z.email("请输入正确的邮箱地址"),
  password: z.string().min(1, "请输入授权码 / 应用专用密码"),
  presetId: z.enum(["gmail", "qq", "163", "icloud", "outlook", "custom"]),
  displayName: z.string().trim().max(80).optional(),
  imapHost: z.string().trim().min(1, "请填写 IMAP 主机"),
  imapPort: z.number().int().min(1).max(65535),
  imapSecure: z.boolean(),
  smtpHost: z.string().trim().min(1, "请填写 SMTP 主机"),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  syncWindowDays: z.number().int().min(1).max(3650).default(30),
});

export type AccountInput = z.infer<typeof accountInputSchema>;

/** 根据邮箱与预设推导默认主机配置（供表单预填）。 */
export function defaultsForPreset(presetId: PresetId, email: string) {
  const preset = getPreset(presetId);
  const hosts = resolvePresetHosts(preset, email);
  return {
    imapHost: hosts.imap.host,
    imapPort: hosts.imap.port,
    imapSecure: hosts.imap.secure,
    smtpHost: hosts.smtp.host,
    smtpPort: hosts.smtp.port,
    smtpSecure: hosts.smtp.secure,
  };
}

export function toImapConfig(input: AccountInput): ImapAccountConfig {
  return {
    email: input.email,
    imap: { host: input.imapHost, port: input.imapPort, secure: input.imapSecure },
    smtp: { host: input.smtpHost, port: input.smtpPort, secure: input.smtpSecure },
    auth: { user: input.email, pass: input.password },
  };
}

export async function testAccountConnection(input: AccountInput): Promise<ConnectionTestResult> {
  return ImapProvider.testConnection(toImapConfig(input));
}

export async function createMailAccount(userId: string, input: AccountInput): Promise<MailAccount> {
  const db = await getDb();
  const preset = getPreset(input.presetId);
  const email = input.email.toLowerCase();
  const existing = await db.query.mailAccounts.findFirst({
    where: and(eq(mailAccounts.userId, userId), eq(mailAccounts.email, email)),
  });
  if (existing) throw new Error("这个邮箱已经添加过了");

  const [account] = await db
    .insert(mailAccounts)
    .values({
      userId,
      provider: preset.provider,
      presetId: preset.id,
      email,
      displayName: input.displayName || null,
      authType: "password",
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapSecure: input.imapSecure,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpSecure: input.smtpSecure,
      credentialsEnc: encryptCredentials({ password: input.password }),
      syncWindowDays: input.syncWindowDays,
    })
    .returning();
  await enqueueSyncAccount(account.id, "new-account");
  return account;
}

export async function deleteMailAccount(userId: string, accountId: string): Promise<void> {
  const db = await getDb();
  const { getIdleManager } = await import("@/server/sync/idle-manager");
  await getIdleManager().stop(accountId);
  await db.delete(mailAccounts).where(and(eq(mailAccounts.userId, userId), eq(mailAccounts.id, accountId)));
}

export async function listAccounts(userId: string): Promise<MailAccount[]> {
  const db = await getDb();
  return db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId), orderBy: (t, { asc }) => [asc(t.createdAt)] });
}

export async function getAccountForUser(userId: string, accountId: string): Promise<MailAccount | undefined> {
  const db = await getDb();
  return db.query.mailAccounts.findFirst({ where: and(eq(mailAccounts.userId, userId), eq(mailAccounts.id, accountId)) });
}

export async function listFoldersForAccount(accountId: string): Promise<Folder[]> {
  const db = await getDb();
  const rows = await db.query.folders.findMany({ where: eq(folders.accountId, accountId) });
  return rows.sort(
    (a, b) => (FOLDER_ROLE_ORDER[a.role] ?? 9) - (FOLDER_ROLE_ORDER[b.role] ?? 9) || a.path.localeCompare(b.path, "zh-CN"),
  );
}

export async function setAccountAi(userId: string, accountId: string, aiEnabled: boolean): Promise<void> {
  const db = await getDb();
  await db
    .update(mailAccounts)
    .set({ aiEnabled })
    .where(and(eq(mailAccounts.userId, userId), eq(mailAccounts.id, accountId)));
}

/** 是否在回复邮件时自动密送一份给自己 */
export async function setAccountBccSelf(userId: string, accountId: string, bccSelfOnReply: boolean): Promise<void> {
  const db = await getDb();
  await db
    .update(mailAccounts)
    .set({ bccSelfOnReply })
    .where(and(eq(mailAccounts.userId, userId), eq(mailAccounts.id, accountId)));
}
