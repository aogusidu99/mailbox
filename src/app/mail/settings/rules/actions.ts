"use server";

import { revalidatePath } from "next/cache";
import type { CompiledRule } from "@/db/schema";
import { compileRule, compiledRuleSchema, compileRules, createRule, createRules, deleteRule, listRules, normalizeCompiled, previewRule, previewRules, runAllRules, runRuleNow, updateRule } from "@/server/ai/rules";
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

/** 批量编译：每行一条 → 逐行编译 + 一次性试算命中数 */
export async function compileRulesAction(text: string) {
  return run(async () => {
    const user = await requireUser();
    const t = text.trim();
    if (!t) throw new Error("请粘贴规则（每行一条）");
    const { items, errors } = await compileRules(user.id, t);
    const preview = await previewRules(user.id, items.map((it) => it.compiled));
    return {
      scanned: preview.scanned,
      items: items.map((it, i) => ({ naturalText: it.naturalText, compiled: it.compiled, matchCount: preview.counts[i] ?? 0 })),
      errors,
    };
  });
}

/** 批量保存规则 */
export async function createRulesAction(input: { items: Array<{ naturalText: string; compiled: unknown }>; accountId?: string | null }) {
  return run(async () => {
    const user = await requireUser();
    const items = input.items.map((it) => ({ naturalText: it.naturalText, compiled: normalize(it.compiled) }));
    const created = await createRules(user.id, items, input.accountId ?? null);
    revalidatePath("/mail/settings/rules");
    return { created };
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

/** 一键把所有启用的规则跑一遍存量邮件 */
export async function runAllRulesAction() {
  return run(async () => {
    const user = await requireUser();
    const r = await runAllRules(user.id);
    revalidatePath("/mail/settings/rules");
    return r;
  });
}

export async function listRulesAction() {
  return run(async () => {
    const user = await requireUser();
    return listRules(user.id);
  });
}
