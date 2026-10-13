"use server";

import { revalidatePath } from "next/cache";
import { enqueueSyncAccount, enqueueSyncFolder } from "@/server/jobs/queues";
import { requireUser } from "@/server/auth/session";
import {
  accountInputSchema,
  createMailAccount,
  deleteMailAccount,
  getAccountForUser,
  resyncAccountDeep,
  setAccountAi,
  setAccountBccSelf,
  testAccountConnection,
} from "@/server/mail/accounts";
import type { ConnectionTestResult } from "@/server/providers/types";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

function parseInput(raw: unknown) {
  const parsed = accountInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("；"));
  }
  return parsed.data;
}

export async function testConnectionAction(raw: unknown): Promise<ActionResult<ConnectionTestResult>> {
  try {
    await requireUser();
    const input = parseInput(raw);
    const result = await testAccountConnection(input);
    return { ok: true, data: result };
  } catch (err) {
    return fail(err);
  }
}

export async function createAccountAction(raw: unknown): Promise<ActionResult<{ accountId: string }>> {
  try {
    const user = await requireUser();
    const input = parseInput(raw);
    const account = await createMailAccount(user.id, input);
    revalidatePath("/mail");
    return { ok: true, data: { accountId: account.id } };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteAccountAction(accountId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await deleteMailAccount(user.id, accountId);
    revalidatePath("/mail");
    return { ok: true, data: undefined };
  } catch (err) {
    return fail(err);
  }
}

export async function resyncAccountAction(accountId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const account = await getAccountForUser(user.id, accountId);
    if (!account) throw new Error("账号不存在");
    await enqueueSyncAccount(accountId, "manual");
    return { ok: true, data: undefined };
  } catch (err) {
    return fail(err);
  }
}

/** 深度重新同步：按新窗口把历史邮件补齐（重置后重新初始同步，已存在的不重复） */
export async function resyncDeepAction(accountId: string, windowDays: number): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await resyncAccountDeep(user.id, accountId, windowDays);
    revalidatePath("/mail/accounts");
    return { ok: true, data: undefined };
  } catch (err) {
    return fail(err);
  }
}

export async function refreshFolderAction(accountId: string, folderId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const account = await getAccountForUser(user.id, accountId);
    if (!account) throw new Error("账号不存在");
    // 「所有邮件」视图没有单个文件夹，刷新 = 同步整个账号
    if (folderId === "__all__") await enqueueSyncAccount(accountId, "manual");
    else await enqueueSyncFolder(accountId, { folderId });
    return { ok: true, data: undefined };
  } catch (err) {
    return fail(err);
  }
}

export async function toggleAccountAiAction(accountId: string, enabled: boolean): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await setAccountAi(user.id, accountId, enabled);
    revalidatePath("/mail/accounts");
    return { ok: true, data: undefined };
  } catch (err) {
    return fail(err);
  }
}

export async function toggleAccountBccSelfAction(accountId: string, enabled: boolean): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await setAccountBccSelf(user.id, accountId, enabled);
    revalidatePath("/mail/accounts");
    return { ok: true, data: undefined };
  } catch (err) {
    return fail(err);
  }
}
