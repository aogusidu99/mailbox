import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { aiSettings, type AiCustomProvider, type AiRemoteModel, type AiRole, type AiRoleConfig, type AiSettingsData } from "@/db/schema";
import { getEnv } from "@/env";
import { decryptJson, encryptJson } from "@/server/crypto/secrets";
import { BUILT_IN_PROVIDERS, customProviderAdapter, getBuiltInProvider, type ProviderAdapter } from "./providers";

/**
 * AI 设置：多厂商 Key、候选池、默认模型、按任务等级路由（沿用 assistant 项目的语义）。
 *
 * 解析规则 resolveRole(role)：
 *   roles[role] 覆盖 → 全局默认 (defaultProvider/defaultModel) → FINAL_FALLBACK（全项目唯一写死的模型）。
 */

export const FINAL_FALLBACK = { provider: "anthropic", model: "claude-opus-5" } as const;

export const AI_ROLES: Array<{ role: AiRole; label: string; hint: string }> = [
  { role: "triage", label: "分类 / 优先级", hint: "高频、短输入，适合便宜快速的模型" },
  { role: "summary", label: "摘要 / 每日摘要", hint: "高频、中等长度" },
  { role: "extract", label: "待办 / 日程 / 账单抽取", hint: "结构化输出，准确性重要" },
  { role: "draft", label: "回复起草", hint: "低频、质量敏感" },
  { role: "rules", label: "自然语言规则编译", hint: "低频、需要推理" },
  { role: "chat", label: "和邮箱对话", hint: "多轮、工具调用" },
  { role: "embedding", label: "语义搜索向量", hint: "批量，需要支持 embedding 的厂商" },
];

export const DEFAULT_SETTINGS: AiSettingsData = {
  defaultProvider: FINAL_FALLBACK.provider,
  defaultModel: FINAL_FALLBACK.model,
  candidates: {},
  roles: {},
  preset: "quality",
  customProviders: [],
  writeBack: { gmailLabels: true, imapFolders: false },
  autoTriageScope: "inbox",
};

export type PresetId = "quality" | "balanced" | "economy";

/** 一键预设 → 各等级配置 */
export function presetRoles(preset: PresetId, hasGoogle: boolean, hasOpenAI: boolean): Partial<Record<AiRole, AiRoleConfig>> {
  const embedding: AiRoleConfig | undefined = hasGoogle
    ? { provider: "google", model: "gemini-embedding-001" }
    : hasOpenAI
      ? { provider: "openai", model: "text-embedding-3-small" }
      : undefined;
  const a = (model: string, effort?: AiRoleConfig["effort"]): AiRoleConfig => ({ provider: "anthropic", model, effort });
  const roles: Partial<Record<AiRole, AiRoleConfig>> =
    preset === "quality"
      ? {
          triage: a("claude-opus-5", "low"),
          summary: a("claude-opus-5", "low"),
          extract: a("claude-opus-5", "medium"),
          draft: a("claude-opus-5", "high"),
          rules: a("claude-opus-5", "high"),
          chat: a("claude-opus-5", "high"),
        }
      : preset === "balanced"
        ? {
            triage: a("claude-haiku-4-5"),
            summary: a("claude-sonnet-5", "low"),
            extract: a("claude-sonnet-5", "medium"),
            draft: a("claude-opus-5", "high"),
            rules: a("claude-opus-5", "high"),
            chat: a("claude-opus-5", "high"),
          }
        : {
            triage: a("claude-haiku-4-5"),
            summary: a("claude-haiku-4-5"),
            extract: a("claude-haiku-4-5"),
            draft: a("claude-sonnet-5", "medium"),
            rules: a("claude-sonnet-5", "medium"),
            chat: a("claude-sonnet-5", "medium"),
          };
  if (embedding) roles.embedding = embedding;
  return roles;
}

export interface LoadedAiSettings {
  data: AiSettingsData;
  /** 明文 Key（仅服务端使用，绝不返回给前端） */
  keys: Record<string, string>;
}

function normalize(data: Partial<AiSettingsData> | undefined): AiSettingsData {
  const merged: AiSettingsData = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
  merged.candidates = { ...(data?.candidates ?? {}) };
  merged.roles = { ...(data?.roles ?? {}) };
  merged.customProviders = [...(data?.customProviders ?? [])];
  merged.writeBack = { ...DEFAULT_SETTINGS.writeBack, ...(data?.writeBack ?? {}) };
  // 内置厂商没有候选池时用兜底列表填充
  for (const p of BUILT_IN_PROVIDERS) {
    if (!merged.candidates[p.id] || merged.candidates[p.id].length === 0) merged.candidates[p.id] = [...p.fallbackModels];
  }
  return merged;
}

export async function loadAiSettings(userId: string): Promise<LoadedAiSettings> {
  const db = await getDb();
  const row = await db.query.aiSettings.findFirst({ where: eq(aiSettings.userId, userId) });
  const env = getEnv();
  let keys: Record<string, string> = {};
  if (row?.providerKeysEnc) {
    try {
      keys = decryptJson<Record<string, string>>(row.providerKeysEnc, env.APP_MASTER_KEY);
    } catch {
      keys = {};
    }
  }
  // 环境变量里的 Key 只作为种子：设置页没填时才用
  if (!keys.anthropic && env.ANTHROPIC_API_KEY) keys.anthropic = env.ANTHROPIC_API_KEY;
  return { data: normalize(row?.data), keys };
}

export async function saveAiSettings(userId: string, updater: (current: LoadedAiSettings) => LoadedAiSettings | void): Promise<LoadedAiSettings> {
  const db = await getDb();
  const current = await loadAiSettings(userId);
  const next = updater(current) ?? current;
  // 不把环境变量种子写进库
  const env = getEnv();
  const keysToStore = { ...next.keys };
  if (env.ANTHROPIC_API_KEY && keysToStore.anthropic === env.ANTHROPIC_API_KEY) delete keysToStore.anthropic;
  const providerKeysEnc = Object.keys(keysToStore).length ? encryptJson(keysToStore, env.APP_MASTER_KEY) : null;
  const data = normalize(next.data);
  await db
    .insert(aiSettings)
    .values({ userId, data, providerKeysEnc })
    .onConflictDoUpdate({ target: aiSettings.userId, set: { data, providerKeysEnc } });
  return { data, keys: next.keys };
}

/** 所有可用厂商（内置 + 自定义） */
export function allProviders(data: AiSettingsData): ProviderAdapter[] {
  return [...BUILT_IN_PROVIDERS, ...data.customProviders.map(customProviderAdapter)];
}

export function getProviderAdapter(data: AiSettingsData, id: string): ProviderAdapter | undefined {
  return getBuiltInProvider(id) ?? data.customProviders.filter((c) => c.id === id).map(customProviderAdapter)[0];
}

export interface ResolvedRole {
  role: AiRole;
  provider: ProviderAdapter;
  providerId: string;
  model: string;
  effort?: AiRoleConfig["effort"];
  apiKey: string;
  /** 同厂商候选池里排在当前模型之后的备用模型 */
  fallbackModels: string[];
}

/** 解析某个任务等级该用哪个厂商 / 模型 / Key。 */
export function resolveRole(settings: LoadedAiSettings, role: AiRole): ResolvedRole {
  const { data, keys } = settings;
  const override = data.roles[role];
  let providerId = override?.provider || data.defaultProvider || FINAL_FALLBACK.provider;
  let model = override?.model || (override?.provider ? "" : data.defaultModel) || "";
  if (!model) {
    // 覆盖了厂商但没选模型：用该厂商候选池第一个
    model = data.candidates[providerId]?.[0]?.id || (providerId === FINAL_FALLBACK.provider ? FINAL_FALLBACK.model : "");
  }
  let provider = getProviderAdapter(data, providerId);
  if (!provider || !model) {
    providerId = FINAL_FALLBACK.provider;
    model = FINAL_FALLBACK.model;
    provider = getProviderAdapter(data, providerId)!;
  }
  const apiKey = keys[providerId];
  if (!apiKey) {
    throw new Error(`还没有配置 ${provider.name} 的 API Key，请到「AI 设置」填写。`);
  }
  const pool = (data.candidates[providerId] ?? []).map((m) => m.id);
  const idx = pool.indexOf(model);
  const fallbackModels = (idx >= 0 ? pool.slice(idx + 1) : pool.filter((m) => m !== model)).filter((m) => !/embedding/i.test(m)).slice(0, 2);
  return { role, provider, providerId, model, effort: override?.effort, apiKey, fallbackModels };
}

/** 给前端的安全视图：Key 只显示掩码 */
export function maskApiKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 6)}${"•".repeat(Math.min(12, key.length - 10))}${key.slice(-4)}`;
}

export interface AiSettingsView {
  data: AiSettingsData;
  maskedKeys: Record<string, string>;
  providers: Array<{
    id: string;
    name: string;
    icon: string;
    description: string;
    apiKeyPlaceholder: string;
    apiKeyHint: string;
    custom: boolean;
    capabilities: ProviderAdapter["capabilities"];
  }>;
  roles: typeof AI_ROLES;
}

export function toSettingsView(settings: LoadedAiSettings): AiSettingsView {
  const customIds = new Set(settings.data.customProviders.map((c) => c.id));
  return {
    data: settings.data,
    maskedKeys: Object.fromEntries(Object.entries(settings.keys).map(([k, v]) => [k, maskApiKey(v)])),
    providers: allProviders(settings.data).map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      description: p.description,
      apiKeyPlaceholder: p.apiKeyPlaceholder,
      apiKeyHint: p.apiKeyHint,
      custom: customIds.has(p.id),
      capabilities: p.capabilities,
    })),
    roles: AI_ROLES,
  };
}

export function addCustomProvider(data: AiSettingsData, cfg: AiCustomProvider): AiSettingsData {
  if (BUILT_IN_PROVIDERS.some((p) => p.id === cfg.id)) throw new Error(`厂商 id "${cfg.id}" 已被内置厂商占用`);
  const customProviders = [...data.customProviders.filter((c) => c.id !== cfg.id), cfg];
  return { ...data, customProviders };
}

export function removeCustomProvider(data: AiSettingsData, id: string): AiSettingsData {
  const customProviders = data.customProviders.filter((c) => c.id !== id);
  const candidates = { ...data.candidates };
  delete candidates[id];
  const roles = { ...data.roles };
  for (const key of Object.keys(roles) as AiRole[]) {
    if (roles[key]?.provider === id) delete roles[key];
  }
  const next: AiSettingsData = { ...data, customProviders, candidates, roles };
  if (next.defaultProvider === id) {
    next.defaultProvider = FINAL_FALLBACK.provider;
    next.defaultModel = FINAL_FALLBACK.model;
  }
  return next;
}

export function setCandidates(data: AiSettingsData, providerId: string, models: AiRemoteModel[]): AiSettingsData {
  const next: AiSettingsData = { ...data, candidates: { ...data.candidates, [providerId]: models } };
  if (next.defaultProvider === providerId && models.length && !models.some((m) => m.id === next.defaultModel)) {
    next.defaultModel = models[0].id;
  }
  return next;
}
