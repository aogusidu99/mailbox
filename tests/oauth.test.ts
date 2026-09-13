import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.APP_MASTER_KEY = "f".repeat(64);
process.env.ADMIN_EMAIL = "admin@example.com";
process.env.ADMIN_PASSWORD = "password123";

import { createDbHandle, setDbHandleForTests, type DbHandle } from "@/db";
import { mailAccounts, users } from "@/db/schema";
import { stopBossForTests } from "@/server/jobs/boss";
import { getOAuthClient, saveOAuthClient } from "@/server/oauth/clients";
import { completeOAuth, startOAuth } from "@/server/oauth/connect";
import { buildAuthUrl, createPkce, emailFromIdToken, OAUTH_PROVIDERS, signState, verifyState } from "@/server/oauth/providers";
import { ensureFreshAccessToken } from "@/server/oauth/tokens";
import { decryptCredentials } from "@/server/providers/factory";

function fakeIdToken(email: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ email })}.sig`;
}

describe("OAuth 纯函数", () => {
  test("PKCE 与 state 签名校验", () => {
    const pkce = createPkce();
    expect(pkce.verifier.length).toBeGreaterThan(30);
    expect(pkce.challenge).not.toBe(pkce.verifier);
    const token = signState({ userId: "u1", provider: "google", nonce: "n", ts: Date.now() }, "secret");
    expect(verifyState(token, "secret")?.userId).toBe("u1");
    expect(verifyState(token, "other")).toBeNull();
    expect(verifyState(`${token}x`, "secret")).toBeNull();
    const old = signState({ userId: "u1", provider: "google", nonce: "n", ts: Date.now() - 20 * 60_000 }, "secret");
    expect(verifyState(old, "secret")).toBeNull();
  });

  test("授权 URL 包含必要参数", () => {
    const url = new URL(buildAuthUrl(OAUTH_PROVIDERS.google, { clientId: "cid", redirectUri: "http://localhost:3000/api/oauth/google/callback", state: "s", codeChallenge: "c" }));
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("https://mail.google.com/");
    expect(emailFromIdToken(fakeIdToken("Me@Gmail.com"))).toBe("me@gmail.com");
    expect(emailFromIdToken("garbage")).toBeNull();
  });
});

describe("OAuth 流程（假令牌端点 + PGlite）", () => {
  let handle: DbHandle;
  let userId = "";
  let tokenServer: ReturnType<typeof Bun.serve>;
  const calls: Array<Record<string, string>> = [];
  const endpoints = { authUrl: "http://127.0.0.1:11770/auth", tokenUrl: "http://127.0.0.1:11770/token" };

  beforeAll(async () => {
    tokenServer = Bun.serve({
      port: 11770,
      async fetch(req) {
        const form = Object.fromEntries(new URLSearchParams(await req.text()));
        calls.push(form);
        if (form.grant_type === "authorization_code") {
          if (form.code !== "good-code" || !form.code_verifier) return Response.json({ error: "invalid_grant" }, { status: 400 });
          return Response.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, id_token: fakeIdToken("me@gmail.com") });
        }
        if (form.grant_type === "refresh_token" && form.refresh_token === "rt-1") {
          return Response.json({ access_token: "at-2", expires_in: 3600 });
        }
        return Response.json({ error: "invalid_grant", error_description: "bad refresh" }, { status: 400 });
      },
    });
    handle = await createDbHandle({ pgliteDataDir: null });
    setDbHandleForTests(handle);
    const [user] = await handle.db.insert(users).values({ email: "o@example.com", passwordHash: "x" }).returning();
    userId = user.id;
  });

  afterAll(async () => {
    await stopBossForTests();
    setDbHandleForTests(undefined);
    await handle.close();
    tokenServer.stop(true);
  });

  test("保存的 client secret 加密存储并可读回", async () => {
    await saveOAuthClient(userId, "google", "cid", "csecret");
    const client = await getOAuthClient(userId, "google");
    expect(client).toEqual({ provider: "google", clientId: "cid", clientSecret: "csecret" });
  });

  test("开始授权 → 回调换 token → 创建 OAuth 账号", async () => {
    const started = await startOAuth(userId, "google", "http://localhost:3000");
    const url = new URL(started.url);
    const state = url.searchParams.get("state")!;
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/oauth/google/callback");

    await expect(completeOAuth({ provider: "google", code: "bad", state, cookieValue: started.cookieValue, origin: "http://localhost:3000", endpoints })).rejects.toThrow(/令牌请求失败/);
    const result = await completeOAuth({ provider: "google", code: "good-code", state, cookieValue: started.cookieValue, origin: "http://localhost:3000", endpoints });
    expect(result.created).toBe(true);
    expect(result.email).toBe("me@gmail.com");
    expect(result.account.authType).toBe("oauth2");
    expect(result.account.imapHost).toBe("imap.gmail.com");
    const creds = decryptCredentials(result.account.credentialsEnc);
    expect(creds.accessToken).toBe("at-1");
    expect(creds.refreshToken).toBe("rt-1");
    expect(calls.at(-1)?.code_verifier).toBeTruthy();

    // 再次授权同一邮箱：更新而不是重复创建
    const again = await startOAuth(userId, "google", "http://localhost:3000");
    const r2 = await completeOAuth({ provider: "google", code: "good-code", state: new URL(again.url).searchParams.get("state")!, cookieValue: again.cookieValue, origin: "http://localhost:3000", endpoints });
    expect(r2.created).toBe(false);
    expect(await handle.db.query.mailAccounts.findMany({ where: eq(mailAccounts.userId, userId) })).toHaveLength(1);
  });

  test("state / cookie 不匹配时拒绝", async () => {
    const a = await startOAuth(userId, "google", "http://localhost:3000");
    const b = await startOAuth(userId, "google", "http://localhost:3000");
    const stateA = new URL(a.url).searchParams.get("state")!;
    await expect(completeOAuth({ provider: "google", code: "good-code", state: stateA, cookieValue: b.cookieValue, origin: "http://localhost:3000", endpoints })).rejects.toThrow(/不匹配/);
    await expect(completeOAuth({ provider: "google", code: "good-code", state: stateA, cookieValue: undefined, origin: "http://localhost:3000", endpoints })).rejects.toThrow(/cookie/);
  });

  test("access token 到期后自动刷新并写回", async () => {
    const account = (await handle.db.query.mailAccounts.findFirst({ where: eq(mailAccounts.userId, userId) }))!;
    const expired = { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() - 1000 };
    const fresh = await ensureFreshAccessToken(account, expired, endpoints);
    expect(fresh.accessToken).toBe("at-2");
    expect(fresh.refreshToken).toBe("rt-1");
    const stored = decryptCredentials((await handle.db.query.mailAccounts.findFirst({ where: eq(mailAccounts.id, account.id) }))!.credentialsEnc);
    expect(stored.accessToken).toBe("at-2");
    const stillValid = { accessToken: "at-9", refreshToken: "rt-1", expiresAt: Date.now() + 3600_000 };
    expect((await ensureFreshAccessToken(account, stillValid, endpoints)).accessToken).toBe("at-9");
    await expect(ensureFreshAccessToken(account, { accessToken: "x", expiresAt: 0 }, endpoints)).rejects.toThrow(/重新授权/);
  });
});
