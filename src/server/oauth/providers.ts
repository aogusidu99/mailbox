import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OAuth2 授权码 + PKCE 流程的纯函数部分：厂商端点、state 签名、code 交换、token 刷新、身份获取。
 * 网络端点可注入（测试时指向本地假服务）。
 */

export type OAuthProviderId = "google" | "microsoft";

export interface OAuthEndpoints {
  authUrl: string;
  tokenUrl: string;
  userinfoUrl?: string;
}

export interface OAuthProviderConfig extends OAuthEndpoints {
  id: OAuthProviderId;
  label: string;
  scopes: string[];
  extraAuthParams: Record<string, string>;
  /** 对应的邮箱预设 */
  presetId: "gmail" | "outlook";
  help: string[];
}

export const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProviderConfig> = {
  google: {
    id: "google",
    label: "Google（Gmail）",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    scopes: ["openid", "email", "https://mail.google.com/"],
    extraAuthParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    presetId: "gmail",
    help: [
      "打开 https://console.cloud.google.com/ 新建（或选择）一个项目。",
      "「API 和服务 → OAuth 同意屏幕」：用户类型选「外部」，填写应用名称与邮箱；测试用户里加上你自己的 Gmail。",
      "「API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID」：应用类型选「Web 应用」，已获授权的重定向 URI 填下面显示的回调地址。",
      "把生成的客户端 ID 与客户端密钥填到这里保存，然后点「连接 Gmail 账号」。",
      "同意屏幕处于「测试」状态时，授权 7 天后需要重新连接；发布应用后不再受限（Gmail 范围属于受限范围，仅个人使用无需验证）。",
    ],
  },
  microsoft: {
    id: "microsoft",
    label: "Microsoft（Outlook / Microsoft 365）",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["openid", "email", "offline_access", "https://outlook.office.com/IMAP.AccessAsUser.All", "https://outlook.office.com/SMTP.Send"],
    extraAuthParams: { prompt: "select_account" },
    presetId: "outlook",
    help: [
      "打开 https://portal.azure.com/ →「Microsoft Entra ID → 应用注册 → 新注册」。",
      "「支持的账户类型」必须选第三项「任何组织目录中的账户（多租户）和个人 Microsoft 账户（例如 Skype、Xbox）」；默认的「仅此组织目录」会让 outlook.com / hotmail.com 个人账号报「does not exist in tenant」。已建好的应用可在「身份验证 → 支持的账户类型」里改，或把清单里的 signInAudience 改为 AzureADandPersonalMicrosoftAccount。",
      "重定向 URI 平台选「Web」，填下面显示的回调地址（本地是 http://localhost:3000/...，Azure 允许 localhost 用 http）。",
      "「证书和密码 → 新客户端密码」生成密钥（复制的是「值」不是「密码 ID」）。",
      "「API 权限 → 添加权限 → 我的组织使用的 API」搜索 Office 365 Exchange Online，勾选委托权限 IMAP.AccessAsUser.All、SMTP.Send；再在 Microsoft Graph 里加 openid、email、offline_access。",
      "把「应用程序（客户端）ID」与密钥填到这里保存，然后点「连接 Outlook 账号」。",
    ],
  },
};

export function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** PKCE：随机 verifier 与 S256 challenge */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export interface OAuthState {
  userId: string;
  provider: OAuthProviderId;
  nonce: string;
  ts: number;
}

/** state = base64url(json).hmac，防篡改；15 分钟内有效 */
export function signState(state: OAuthState, secret: string): string {
  const payload = base64url(Buffer.from(JSON.stringify(state), "utf8"));
  const mac = base64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${mac}`;
}

export function verifyState(token: string, secret: string, maxAgeMs = 15 * 60_000): OAuthState | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = base64url(createHmac("sha256", secret).update(payload).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (!state.userId || !state.provider || !state.nonce || typeof state.ts !== "number") return null;
    if (Date.now() - state.ts > maxAgeMs) return null;
    return state;
  } catch {
    return null;
  }
}

export function buildAuthUrl(cfg: OAuthProviderConfig, params: { clientId: string; redirectUri: string; state: string; codeChallenge: string; loginHint?: string }): string {
  const url = new URL(cfg.authUrl);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cfg.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  for (const [k, v] of Object.entries(cfg.extraAuthParams)) url.searchParams.set(k, v);
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  idToken?: string;
  scope?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(tokenUrl: string, form: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(`OAuth 令牌请求失败：${json.error_description || json.error || res.status}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    idToken: json.id_token,
    scope: json.scope,
  };
}

export function exchangeCode(cfg: OAuthEndpoints, params: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string }): Promise<TokenSet> {
  return postToken(cfg.tokenUrl, {
    grant_type: "authorization_code",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
}

export function refreshAccessToken(cfg: OAuthEndpoints, params: { clientId: string; clientSecret: string; refreshToken: string }): Promise<TokenSet> {
  return postToken(cfg.tokenUrl, {
    grant_type: "refresh_token",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
  });
}

/** 从 id_token（JWT）里读邮箱，不校验签名（token 直接来自厂商 token 端点） */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { email?: string; preferred_username?: string; upn?: string };
    const email = claims.email || claims.preferred_username || claims.upn;
    return email && email.includes("@") ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** 获取授权账号的邮箱：优先 id_token，其次 userinfo 端点 */
export async function fetchIdentityEmail(cfg: OAuthEndpoints, tokens: TokenSet): Promise<string> {
  const fromToken = emailFromIdToken(tokens.idToken);
  if (fromToken) return fromToken;
  if (cfg.userinfoUrl) {
    const res = await fetch(cfg.userinfoUrl, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      const json = (await res.json()) as { email?: string };
      if (json.email) return json.email.toLowerCase();
    }
  }
  throw new Error("无法获取授权账号的邮箱地址，请确认已授予 email 权限");
}
