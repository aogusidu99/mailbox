import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { oauthClients } from "@/db/schema";
import { getEnv } from "@/env";
import { decryptSecret, encryptSecret } from "@/server/crypto/secrets";
import type { OAuthProviderId } from "./providers";

/** OAuth 应用凭据的读写（client secret 加密存储） */

export interface OAuthClient {
  provider: OAuthProviderId;
  clientId: string;
  clientSecret: string;
}

export async function getOAuthClient(userId: string, provider: OAuthProviderId): Promise<OAuthClient | null> {
  const db = await getDb();
  const row = await db.query.oauthClients.findFirst({ where: and(eq(oauthClients.userId, userId), eq(oauthClients.provider, provider)) });
  if (!row) return null;
  return { provider, clientId: row.clientId, clientSecret: decryptSecret(row.clientSecretEnc, getEnv().APP_MASTER_KEY) };
}

export async function listOAuthClients(userId: string): Promise<Array<{ provider: OAuthProviderId; clientId: string }>> {
  const db = await getDb();
  const rows = await db.query.oauthClients.findMany({ where: eq(oauthClients.userId, userId) });
  return rows.map((r) => ({ provider: r.provider as OAuthProviderId, clientId: r.clientId }));
}

export async function saveOAuthClient(userId: string, provider: OAuthProviderId, clientId: string, clientSecret: string): Promise<void> {
  const db = await getDb();
  const clientSecretEnc = encryptSecret(clientSecret, getEnv().APP_MASTER_KEY);
  await db
    .insert(oauthClients)
    .values({ userId, provider, clientId, clientSecretEnc })
    .onConflictDoUpdate({ target: [oauthClients.userId, oauthClients.provider], set: { clientId, clientSecretEnc } });
}

export async function deleteOAuthClient(userId: string, provider: OAuthProviderId): Promise<void> {
  const db = await getDb();
  await db.delete(oauthClients).where(and(eq(oauthClients.userId, userId), eq(oauthClients.provider, provider)));
}
