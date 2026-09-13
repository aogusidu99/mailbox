import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailAccounts, type MailAccount } from "@/db/schema";
import { encryptCredentials, type StoredCredentials } from "@/server/providers/factory";
import { getOAuthClient } from "./clients";
import { OAUTH_PROVIDERS, refreshAccessToken, type OAuthEndpoints, type OAuthProviderId } from "./providers";

/**
 * OAuth2 access token 续期：到期前 2 分钟内自动用 refresh token 换新并写回数据库。
 */

export function oauthProviderForAccount(account: Pick<MailAccount, "presetId" | "provider">): OAuthProviderId | null {
  if (account.presetId === "gmail" || account.provider === "gmail") return "google";
  if (account.presetId === "outlook" || account.provider === "outlook") return "microsoft";
  return null;
}

export async function ensureFreshAccessToken(account: MailAccount, creds: StoredCredentials, endpoints?: OAuthEndpoints): Promise<StoredCredentials> {
  if (creds.accessToken && creds.expiresAt && Date.now() < creds.expiresAt - 120_000) return creds;
  if (!creds.refreshToken) throw new Error(`${account.email} 的授权已过期且没有刷新令牌，请到「邮箱管理」重新授权`);
  const providerId = oauthProviderForAccount(account);
  if (!providerId) throw new Error("该账号不是 OAuth 账号");
  const client = await getOAuthClient(account.userId, providerId);
  if (!client) throw new Error(`缺少 ${OAUTH_PROVIDERS[providerId].label} 的 OAuth 应用凭据，请到「OAuth 设置」填写`);
  const tokens = await refreshAccessToken(endpoints ?? OAUTH_PROVIDERS[providerId], {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    refreshToken: creds.refreshToken,
  });
  const next: StoredCredentials = {
    ...creds,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? creds.refreshToken,
    expiresAt: tokens.expiresAt,
    clientId: client.clientId,
  };
  const db = await getDb();
  await db.update(mailAccounts).set({ credentialsEnc: encryptCredentials(next) }).where(eq(mailAccounts.id, account.id));
  return next;
}
