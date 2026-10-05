"use server";

import { revalidatePath } from "next/cache";
import type { CompiledRule } from "@/db/schema";
import { compileRule, compiledRuleSchema, compileRules, createRule, createRules, deleteRule, draftStrongRules, listRules, normalizeCompiled, previewRule, previewRules, runAllRules, runRuleNow, suggestStrongRules, updateRule } from "@/server/ai/rules";
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

export async function previewRuleAction(compiled: unknown, limit = 500) {
  return run(async () => {
    const user = await requireUser();
    return previewRule(user.id, normalize(compiled), limit);
  });
}

export async function createRuleAction(input: { naturalText: string; compiled: unknown; accountIds?: string[] }) {
  return run(async () => {
    const user = await requireUser();
    const rule = await createRule(user.id, { naturalText: input.naturalText, compiled: normalize(input.compiled), accountIds: input.accountIds ?? [] });
    revalidatePath("/mail/settings/rules");
    return { id: rule.id };
  });
}

/** 批量编译：每行一条 → 逐行编译 + 一次性试算命中数 */
export async function compileRulesAction(text: string, limit = 500) {
  return run(async () => {
    const user = await requireUser();
    const t = text.trim();
    if (!t) throw new Error("请粘贴规则（每行一条）");
    const { items, errors } = await compileRules(user.id, t);
    const preview = await previewRules(user.id, items.map((it) => it.compiled), limit);
    return {
      scanned: preview.scanned,
      items: items.map((it, i) => ({ naturalText: it.naturalText, compiled: it.compiled, matchCount: preview.counts[i] ?? 0 })),
      errors,
    };
  });
}

/** 批量保存规则 */
export async function createRulesAction(input: { items: Array<{ naturalText: string; compiled: unknown }>; accountIds?: string[] }) {
  return run(async () => {
    const user = await requireUser();
    const items = input.items.map((it) => ({ naturalText: it.naturalText, compiled: normalize(it.compiled) }));
    const created = await createRules(user.id, items, input.accountIds ?? []);
    revalidatePath("/mail/settings/rules");
    return { created };
  });
}

/** 编辑已保存的规则：改条件 / 动作 / 适用邮箱（naturalText 用描述同步刷新） */
export async function editRuleAction(input: { ruleId: string; compiled: unknown; naturalText: string; accountIds?: string[] }) {
  return run(async () => {
    const user = await requireUser();
    const compiled = normalize(input.compiled);
    // accountId 置空：改用 accountIds 作为唯一来源（清掉旧的单账号回退）
    await updateRule(user.id, input.ruleId, { compiled, name: compiled.name, naturalText: input.naturalText, accountIds: input.accountIds ?? [], accountId: null });
    revalidatePath("/mail/settings/rules");
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

export async function runRuleNowAction(ruleId: string, limit = 2000) {
  return run(async () => {
    const user = await requireUser();
    const n = await runRuleNow(user.id, ruleId, limit);
    revalidatePath("/mail/settings/rules");
    return { applied: n };
  });
}

/** 从现有邮件分布归纳强规则建议（按发件人 → 文件夹），返回与批量审核同样的结构供编辑/保存 */
export async function suggestStrongRulesAction(limit = 10000) {
  return run(async () => {
    const user = await requireUser();
    const suggestions = await suggestStrongRules(user.id, limit);
    const preview = await previewRules(user.id, suggestions.map((s) => s.compiled), limit);
    return {
      scanned: preview.scanned,
      items: suggestions.map((s, i) => ({ naturalText: s.reason, compiled: s.compiled, matchCount: preview.counts[i] ?? 0 })),
      errors: [] as Array<{ line: string; error: string }>,
    };
  });
}

/** 用自然语言目标 + 邮箱真实数据，让 AI 起草强规则（读邮箱接地），返回与批量审核同样的结构 */
export async function draftStrongRulesAction(instruction: string, accountIds: string[] = [], limit = 8000) {
  return run(async () => {
    const user = await requireUser();
    const t = instruction.trim();
    if (!t) throw new Error("请先用一句话描述你想要的规则目标");
    const suggestions = await draftStrongRules(user.id, t, accountIds, limit);
    const preview = await previewRules(user.id, suggestions.map((s) => s.compiled), limit);
    return {
      scanned: preview.scanned,
      items: suggestions.map((s, i) => ({ naturalText: s.reason, compiled: s.compiled, matchCount: preview.counts[i] ?? 0 })),
      errors: [] as Array<{ line: string; error: string }>,
    };
  });
}

/** 一键把所有启用的规则跑一遍存量邮件；scope=inbox 只收件箱（日常），scope=all 含已分类文件夹（纠错） */
export async function runAllRulesAction(scope: "inbox" | "all" = "all", limit = 1000) {
  return run(async () => {
    const user = await requireUser();
    const r = await runAllRules(user.id, scope, limit);
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
