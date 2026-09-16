import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { googleConnections, type GoogleConnection } from "@/db/schema";
import { getEnv } from "@/env";
import { decryptJson, encryptJson } from "@/server/crypto/secrets";
import { getOAuthClient } from "@/server/oauth/clients";
import { appBaseUrl } from "@/server/oauth/connect";
import {
  buildAuthUrl,
  createPkce,
  exchangeCode,
  fetchIdentityEmail,
  OAUTH_PROVIDERS,
  refreshAccessToken,
  signState,
  verifyState,
  type OAuthProviderConfig,
} from "@/server/oauth/providers";

/**
 * Google 服务连接（日历 / 任务）的生命周期：
 * - 与「连接邮箱」的 OAuth 分开，复用同一套 Google 客户端 ID / 密钥（在「OAuth 授权登录」里保存），
 *   但申请的是 calendar + tasks 授权范围，token 单独加密存 `google_connections` 表。
 * - 日历 / 任务页直接调 Google API（Google 为唯一真相源，读写实时双向同步）。
 */

export const GCONN_COOKIE = "mailbox_gconn";

/** 需要的授权范围：身份（拿邮箱）+ 日历读写 + 任务读写 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
];
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";

/** 存储在 credentials_enc 里的 token 结构 */
interface GoogleCreds {
  accessToken: string;
  refreshToken?: string;
  /** 毫秒时间戳 */
  expiresAt: number;
  clientId: string;
}

/** 申请日历 / 任务范围的 Google 配置（authUrl / tokenUrl 复用 Gmail 那套，仅换 scope） */
function googleServicesConfig(): OAuthProviderConfig {
  return { ...OAUTH_PROVIDERS.google, scopes: GOOGLE_SCOPES };
}

export function googleRedirectUri(origin: string): string {
  return `${appBaseUrl(origin)}/api/google/callback`;
}

// ---------- 连接流程 ----------

export async function startGoogleConnect(userId: string, origin: string): Promise<{ url: string; cookieValue: string }> {
  const client = await getOAuthClient(userId, "google");
  if (!client) throw new Error("请先在「设置 → OAuth 授权登录」里填写 Google 的客户端 ID 与密钥");
  const pkce = createPkce();
  const nonce = randomBytes(12).toString("base64url");
  const state = signState({ userId, provider: "google", nonce, ts: Date.now() }, getEnv().AUTH_SECRET);
  const url = buildAuthUrl(googleServicesConfig(), {
    clientId: client.clientId,
    redirectUri: googleRedirectUri(origin),
    state,
    codeChallenge: pkce.challenge,
  });
  const cookieValue = encryptJson({ verifier: pkce.verifier, nonce }, getEnv().APP_MASTER_KEY);
  return { url, cookieValue };
}

export interface CompleteGoogleInput {
  code: string;
  state: string;
  cookieValue: string | undefined;
  origin: string;
}

export async function completeGoogleConnect(input: CompleteGoogleInput): Promise<{ email: string }> {
  const env = getEnv();
  const state = verifyState(input.state, env.AUTH_SECRET);
  if (!state || state.provider !== "google") throw new Error("授权状态无效或已过期，请重新发起授权");
  if (!input.cookieValue) throw new Error("缺少授权会话（cookie），请在同一浏览器里重新发起授权");
  let session: { verifier: string; nonce: string };
  try {
    session = decryptJson<{ verifier: string; nonce: string }>(input.cookieValue, env.APP_MASTER_KEY);
  } catch {
    throw new Error("授权会话无效，请重新发起授权");
  }
  if (session.nonce !== state.nonce) throw new Error("授权会话与请求不匹配，请重新发起授权");

  const client = await getOAuthClient(state.userId, "google");
  if (!client) throw new Error("缺少 Google OAuth 应用凭据");
  const cfg = googleServicesConfig();
  const tokens = await exchangeCode(cfg, {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    code: input.code,
    redirectUri: googleRedirectUri(input.origin),
    codeVerifier: session.verifier,
  });
  if (!tokens.refreshToken) {
    // 没拿到 refresh_token 通常是之前已授权过、Google 不再下发；提示用户到账户里撤销后重连
    throw new Error("未获得长期授权（refresh token）。请到 https://myaccount.google.com/permissions 撤销本应用后重新连接。");
  }
  const email = await fetchIdentityEmail(cfg, tokens).catch(() => "");
  const creds: GoogleCreds = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, clientId: client.clientId };
  const db = await getDb();
  await db
    .insert(googleConnections)
    .values({ userId: state.userId, email, credentialsEnc: encryptJson(creds, env.APP_MASTER_KEY), scope: tokens.scope ?? GOOGLE_SCOPES.join(" ") })
    .onConflictDoUpdate({
      target: googleConnections.userId,
      set: { email, credentialsEnc: encryptJson(creds, env.APP_MASTER_KEY), scope: tokens.scope ?? GOOGLE_SCOPES.join(" "), updatedAt: new Date() },
    });
  return { email };
}

// ---------- 状态 / 断开 ----------

export interface GoogleStatus {
  connected: boolean;
  email: string | null;
  hasCalendar: boolean;
  hasTasks: boolean;
}

async function getConnection(userId: string): Promise<GoogleConnection | undefined> {
  const db = await getDb();
  return db.query.googleConnections.findFirst({ where: eq(googleConnections.userId, userId) });
}

export async function getGoogleStatus(userId: string): Promise<GoogleStatus> {
  const row = await getConnection(userId);
  if (!row) return { connected: false, email: null, hasCalendar: false, hasTasks: false };
  const scopes = (row.scope ?? "").split(/\s+/);
  return { connected: true, email: row.email, hasCalendar: scopes.includes(CALENDAR_SCOPE), hasTasks: scopes.includes(TASKS_SCOPE) };
}

export async function disconnectGoogle(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(googleConnections).where(eq(googleConnections.userId, userId));
}

// ---------- 访问令牌（按需刷新） ----------

/** 拿一个有效的 access token；快过期（或 force）时用 refresh token 换新并写回。 */
export async function getAccessToken(userId: string, opts: { force?: boolean } = {}): Promise<string> {
  const db = await getDb();
  const row = await getConnection(userId);
  if (!row) throw new Error("尚未连接 Google 账号，请先在「日历」页点「连接 Google」");
  const env = getEnv();
  const creds = decryptJson<GoogleCreds>(row.credentialsEnc, env.APP_MASTER_KEY);
  const soon = Date.now() + 60_000;
  if (!opts.force && creds.accessToken && creds.expiresAt > soon) return creds.accessToken;
  if (!creds.refreshToken) {
    if (creds.accessToken && creds.expiresAt > Date.now()) return creds.accessToken;
    throw new Error("Google 授权已过期，请到「日历」页重新连接");
  }
  const client = await getOAuthClient(userId, "google");
  if (!client) throw new Error("缺少 Google OAuth 应用凭据");
  const tokens = await refreshAccessToken(OAUTH_PROVIDERS.google, { clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: creds.refreshToken });
  const next: GoogleCreds = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? creds.refreshToken,
    expiresAt: tokens.expiresAt,
    clientId: client.clientId,
  };
  await db
    .update(googleConnections)
    .set({ credentialsEnc: encryptJson(next, env.APP_MASTER_KEY), scope: tokens.scope ?? row.scope, updatedAt: new Date() })
    .where(eq(googleConnections.id, row.id));
  return next.accessToken;
}
