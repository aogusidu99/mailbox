import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailAccounts, type MailAccount } from "@/db/schema";
import { getEnv } from "@/env";
import { decryptJson, encryptJson } from "@/server/crypto/secrets";
import { enqueueSyncAccount } from "@/server/jobs/queues";
import { encryptCredentials } from "@/server/providers/factory";
import { getPreset } from "@/server/providers/presets";
import { getOAuthClient } from "./clients";
import { buildAuthUrl, createPkce, exchangeCode, fetchIdentityEmail, OAUTH_PROVIDERS, signState, verifyState, type OAuthEndpoints, type OAuthProviderId, type TokenSet } from "./providers";

/**
 * 授权流程编排：开始（生成 URL + PKCE cookie）→ 回调（校验 state、换 token、取邮箱、建账号）。
 */

export const OAUTH_COOKIE = "mailbox_oauth";

/**
 * 面向浏览器的基址：优先 APP_BASE_URL。
 * 反代 / 隧道（Tailscale serve）下，进入容器的请求 origin 往往是内网监听地址（如 http://0.0.0.0:3000），
 * 直接用它拼跳转会把用户甩到打不开的地址；配置了 APP_BASE_URL 时一律以它为准。
 */
export function appBaseUrl(fallbackOrigin: string): string {
  return getEnv().APP_BASE_URL?.replace(/\/+$/, "") || fallbackOrigin;
}

export function redirectUriFor(origin: string, provider: OAuthProviderId): string {
  return `${appBaseUrl(origin)}/api/oauth/${provider}/callback`;
}

export async function startOAuth(userId: string, provider: OAuthProviderId, origin: string, loginHint?: string): Promise<{ url: string; cookieValue: string }> {
  const cfg = OAUTH_PROVIDERS[provider];
  const client = await getOAuthClient(userId, provider);
  if (!client) throw new Error(`请先在「OAuth 设置」里填写 ${cfg.label} 的客户端 ID 与密钥`);
  const pkce = createPkce();
  const nonce = randomBytes(12).toString("base64url");
  const state = signState({ userId, provider, nonce, ts: Date.now() }, getEnv().AUTH_SECRET);
  const url = buildAuthUrl(cfg, { clientId: client.clientId, redirectUri: redirectUriFor(origin, provider), state, codeChallenge: pkce.challenge, loginHint });
  const cookieValue = encryptJson({ verifier: pkce.verifier, nonce }, getEnv().APP_MASTER_KEY);
  return { url, cookieValue };
}

export interface CompleteOAuthInput {
  provider: OAuthProviderId;
  code: string;
  state: string;
  cookieValue: string | undefined;
  origin: string;
  /** 测试注入 */
  endpoints?: OAuthEndpoints;
}

export async function completeOAuth(input: CompleteOAuthInput): Promise<{ account: MailAccount; email: string; created: boolean }> {
  const env = getEnv();
  const state = verifyState(input.state, env.AUTH_SECRET);
  if (!state || state.provider !== input.provider) throw new Error("授权状态无效或已过期，请重新发起授权");
  if (!input.cookieValue) throw new Error("缺少授权会话（cookie），请在同一浏览器里重新发起授权");
  let session: { verifier: string; nonce: string };
  try {
    session = decryptJson<{ verifier: string; nonce: string }>(input.cookieValue, env.APP_MASTER_KEY);
  } catch {
    throw new Error("授权会话无效，请重新发起授权");
  }
  if (session.nonce !== state.nonce) throw new Error("授权会话与请求不匹配，请重新发起授权");

  const cfg = input.endpoints ?? OAUTH_PROVIDERS[input.provider];
  const client = await getOAuthClient(state.userId, input.provider);
  if (!client) throw new Error("缺少 OAuth 应用凭据");
  const tokens = await exchangeCode(cfg, {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    code: input.code,
    redirectUri: redirectUriFor(input.origin, input.provider),
    codeVerifier: session.verifier,
  });
  const email = await fetchIdentityEmail(cfg, tokens);
  const result = await upsertOAuthAccount(state.userId, input.provider, email, tokens, client.clientId);
  await enqueueSyncAccount(result.account.id, "oauth-connected");
  return { ...result, email };
}

export async function upsertOAuthAccount(userId: string, provider: OAuthProviderId, email: string, tokens: TokenSet, clientId: string): Promise<{ account: MailAccount; created: boolean }> {
  const db = await getDb();
  const preset = getPreset(OAUTH_PROVIDERS[provider].presetId);
  const credentialsEnc = encryptCredentials({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, clientId });
  const existing = await db.query.mailAccounts.findFirst({ where: and(eq(mailAccounts.userId, userId), eq(mailAccounts.email, email)) });
  if (existing) {
    const [account] = await db
      .update(mailAccounts)
      .set({ authType: "oauth2", credentialsEnc, syncStatus: "idle", syncError: null, provider: preset.provider, presetId: preset.id })
      .where(eq(mailAccounts.id, existing.id))
      .returning();
    return { account, created: false };
  }
  const [account] = await db
    .insert(mailAccounts)
    .values({
      userId,
      provider: preset.provider,
      presetId: preset.id,
      email,
      authType: "oauth2",
      imapHost: preset.imap.host,
      imapPort: preset.imap.port,
      imapSecure: preset.imap.secure,
      smtpHost: preset.smtp.host,
      smtpPort: preset.smtp.port,
      smtpSecure: preset.smtp.secure,
      credentialsEnc,
    })
    .returning();
  return { account, created: true };
}
