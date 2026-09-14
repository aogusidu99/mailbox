"use server";

import { revalidatePath } from "next/cache";
import type { CompiledRule } from "@/db/schema";
import { compileRule, compiledRuleSchema, createRule, deleteRule, listRules, normalizeCompiled, previewRule, runRuleNow, updateRule } from "@/server/ai/rules";
import { requireUser } from "@/server/auth/session";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function normalize(raw: unknown): CompiledRule {
  return normalizeCompiled(compiledRuleSchema.parse(raw));
}

export async function compileRuleAction(naturalText: string) {
  return run(async () => {
    const user = await requireUser();
    const text = naturalText.trim();
    if (!text) throw new Error("请先描述规则");
    const compiled = await compileRule(user.id, text);
    const preview = await previewRule(user.id, compiled);
    return { compiled, preview };
  });
}

export async function previewRuleAction(compiled: unknown) {
  return run(async () => {
    const user = await requireUser();
    return previewRule(user.id, normalize(compiled));
  });
}

export async function createRuleAction(input: { naturalText: string; compiled: unknown; accountId?: string | null }) {
  return run(async () => {
    const user = await requireUser();
    const rule = await createRule(user.id, { naturalText: input.naturalText, compiled: normalize(input.compiled), accountId: input.accountId ?? null });
    revalidatePath("/mail/settings/rules");
    return { id: rule.id };
  });
}

export async function toggleRuleAction(ruleId: string, enabled: boolean) {
  return run(async () => {
    const user = await requireUser();
    await updateRule(user.id, ruleId, { enabled });
    revalidatePath("/mail/settings/rules");
  });
}

export async function deleteRuleAction(ruleId: string) {
  return run(async () => {
    const user = await requireUser();
    await deleteRule(user.id, ruleId);
    revalidatePath("/mail/settings/rules");
  });
}

export async function runRuleNowAction(ruleId: string) {
  return run(async () => {
    const user = await requireUser();
    const n = await runRuleNow(user.id, ruleId);
    revalidatePath("/mail/settings/rules");
    return { applied: n };
  });
}

export async function listRulesAction() {
  return run(async () => {
    const user = await requireUser();
    return listRules(user.id);
  });
}
