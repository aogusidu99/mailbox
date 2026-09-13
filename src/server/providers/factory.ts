import type { MailAccount } from "@/db/schema";
import { getEnv } from "@/env";
import { decryptJson, encryptJson } from "@/server/crypto/secrets";
import { ImapProvider, type ImapAccountConfig } from "./imap";
import type { MailProvider } from "./types";

/**
 * 根据账号记录构造提供方：解密凭据后交给 ImapProvider。
 * 凭据 JSON 形如 { password } 或 { refreshToken, accessToken, expiresAt }（M5 OAuth）。
 */

export interface StoredCredentials {
  password?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
}

export function encryptCredentials(creds: StoredCredentials): string {
  return encryptJson(creds, getEnv().APP_MASTER_KEY);
}

export function decryptCredentials(payload: string): StoredCredentials {
  return decryptJson<StoredCredentials>(payload, getEnv().APP_MASTER_KEY);
}

export function accountToImapConfig(account: MailAccount, creds: StoredCredentials): ImapAccountConfig {
  const auth =
    account.authType === "oauth2"
      ? { user: account.email, accessToken: creds.accessToken ?? "" }
      : { user: account.email, pass: creds.password ?? "" };
  return {
    email: account.email,
    imap: { host: account.imapHost, port: account.imapPort, secure: account.imapSecure },
    smtp: { host: account.smtpHost, port: account.smtpPort, secure: account.smtpSecure },
    auth,
  };
}

export async function createProviderForAccount(account: MailAccount): Promise<MailProvider> {
  const creds = decryptCredentials(account.credentialsEnc);
  if (account.authType === "oauth2") {
    // M5：按需刷新 access token
    const { ensureFreshAccessToken } = await import("@/server/oauth/tokens");
    const fresh = await ensureFreshAccessToken(account, creds);
    return new ImapProvider(accountToImapConfig(account, fresh));
  }
  return new ImapProvider(accountToImapConfig(account, creds));
}

/** 以短连接执行一段操作，结束后自动断开。 */
export async function withProvider<T>(account: MailAccount, fn: (provider: MailProvider) => Promise<T>): Promise<T> {
  const provider = await createProviderForAccount(account);
  await provider.connect();
  try {
    return await fn(provider);
  } finally {
    await provider.disconnect();
  }
}
