"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/session";
import { deleteOAuthClient, saveOAuthClient } from "@/server/oauth/clients";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "@/server/oauth/providers";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function assertProvider(p: string): OAuthProviderId {
  if (!(p in OAUTH_PROVIDERS)) throw new Error("未知厂商");
  return p as OAuthProviderId;
}

export async function saveOAuthClientAction(provider: string, clientId: string, clientSecret: string) {
  return run(async () => {
    const user = await requireUser();
    const p = assertProvider(provider);
    if (!clientId.trim()) throw new Error("请填写客户端 ID");
    if (!clientSecret.trim()) throw new Error("请填写客户端密钥");
    await saveOAuthClient(user.id, p, clientId.trim(), clientSecret.trim());
    revalidatePath("/mail/settings/oauth");
  });
}

export async function deleteOAuthClientAction(provider: string) {
  return run(async () => {
    const user = await requireUser();
    await deleteOAuthClient(user.id, assertProvider(provider));
    revalidatePath("/mail/settings/oauth");
  });
}
