"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { AiRemoteModel, AiRole, AiSettingsData } from "@/db/schema";
import { requireUser } from "@/server/auth/session";
import { testProvider } from "@/server/ai/client";
import {
  addCustomProvider,
  getProviderAdapter,
  loadAiSettings,
  presetRoles,
  removeCustomProvider,
  saveAiSettings,
  setCandidates,
  setTranslationLangs,
  toSettingsView,
  type AiSettingsView,
  type PresetId,
} from "@/server/ai/settings";
import { backfillTriage } from "@/server/ai/triage";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function view(userId: string): Promise<AiSettingsView> {
  revalidatePath("/mail/settings/ai");
  return toSettingsView(await loadAiSettings(userId));
}

export async function saveProviderKeyAction(providerId: string, apiKey: string) {
  return run(async () => {
    const user = await requireUser();
    const key = apiKey.trim();
    await saveAiSettings(user.id, (s) => {
      const keys = { ...s.keys };
      if (key) keys[providerId] = key;
      else delete keys[providerId];
      return { ...s, keys };
    });
    return view(user.id);
  });
}

export async function fetchModelsAction(providerId: string) {
  return run(async () => {
    const user = await requireUser();
    const settings = await loadAiSettings(user.id);
    const provider = getProviderAdapter(settings.data, providerId);
    if (!provider) throw new Error("未知厂商");
    const apiKey = settings.keys[providerId];
    if (!apiKey) throw new Error("请先填写并保存该厂商的 API Key");
    const models = await provider.fetchModels(apiKey, provider.baseUrl);
    return models;
  });
}

export async function saveCandidatesAction(providerId: string, models: AiRemoteModel[]) {
  return run(async () => {
    const user = await requireUser();
    await saveAiSettings(user.id, (s) => ({ ...s, data: setCandidates(s.data, providerId, models) }));
    return view(user.id);
  });
}

export async function saveDefaultsAction(providerId: string, model: string) {
  return run(async () => {
    const user = await requireUser();
    await saveAiSettings(user.id, (s) => ({ ...s, data: { ...s.data, defaultProvider: providerId, defaultModel: model, preset: "custom" } }));
    return view(user.id);
  });
}

const roleSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});

export async function saveRoleAction(role: AiRole, config: { provider?: string; model?: string; effort?: string } | null) {
  return run(async () => {
    const user = await requireUser();
    const parsed = config ? roleSchema.parse(config) : null;
    await saveAiSettings(user.id, (s) => {
      const roles = { ...s.data.roles };
      if (parsed && (parsed.provider || parsed.model)) roles[role] = parsed;
      else delete roles[role];
      return { ...s, data: { ...s.data, roles, preset: "custom" } };
    });
    return view(user.id);
  });
}

export async function applyPresetAction(preset: PresetId) {
  return run(async () => {
    const user = await requireUser();
    await saveAiSettings(user.id, (s) => ({
      ...s,
      data: {
        ...s.data,
        preset,
        defaultProvider: "anthropic",
        defaultModel: preset === "economy" ? "claude-sonnet-5" : "claude-opus-5",
        roles: presetRoles(preset, Boolean(s.keys.google), Boolean(s.keys.openai)),
      },
    }));
    return view(user.id);
  });
}

export async function testProviderAction(providerId: string, model: string) {
  return run(async () => {
    const user = await requireUser();
    const settings = await loadAiSettings(user.id);
    return testProvider(settings, providerId, model);
  });
}

const customSchema = z.object({
  id: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9-]+$/, "id 只能用小写字母、数字和连字符"),
  name: z.string().trim().min(1).max(40),
  baseUrl: z.string().trim().url("请输入完整的 URL，例如 https://api.moonshot.cn/v1"),
  apiKeyHint: z.string().trim().max(120).optional(),
});

export async function addCustomProviderAction(input: { id: string; name: string; baseUrl: string; apiKeyHint?: string }) {
  return run(async () => {
    const user = await requireUser();
    const cfg = customSchema.parse(input);
    await saveAiSettings(user.id, (s) => ({ ...s, data: addCustomProvider(s.data, { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, "") }) }));
    return view(user.id);
  });
}

export async function removeCustomProviderAction(id: string) {
  return run(async () => {
    const user = await requireUser();
    await saveAiSettings(user.id, (s) => {
      const keys = { ...s.keys };
      delete keys[id];
      return { keys, data: removeCustomProvider(s.data, id) };
    });
    return view(user.id);
  });
}

export async function saveBehaviorAction(patch: Partial<Pick<AiSettingsData, "writeBack" | "autoTriageScope">>) {
  return run(async () => {
    const user = await requireUser();
    await saveAiSettings(user.id, (s) => ({
      ...s,
      data: { ...s.data, ...(patch.autoTriageScope ? { autoTriageScope: patch.autoTriageScope } : {}), writeBack: { ...s.data.writeBack, ...(patch.writeBack ?? {}) } },
    }));
    return view(user.id);
  });
}

const translationLangsSchema = z.array(z.object({ code: z.string().trim().min(1).max(20), label: z.string().trim().max(40) })).max(20);

/** 保存邮件翻译目标语言列表 */
export async function saveTranslationLangsAction(langs: Array<{ code: string; label: string }>) {
  return run(async () => {
    const user = await requireUser();
    const parsed = translationLangsSchema.parse(langs);
    await saveAiSettings(user.id, (s) => ({ ...s, data: setTranslationLangs(s.data, parsed) }));
    return view(user.id);
  });
}

export async function backfillTriageAction(accountId: string | null, limit: number) {
  return run(async () => {
    const user = await requireUser();
    return backfillTriage(user.id, accountId, Math.min(Math.max(1, limit), 500));
  });
}
