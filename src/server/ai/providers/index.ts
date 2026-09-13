import type { AiCustomProvider } from "@/db/schema";
import anthropic from "./anthropic";
import { createOpenAICompatibleAdapter } from "./openai-compatible";
import type { ProviderAdapter, RemoteModel } from "./types";

/**
 * 内置厂商注册表。用户还可以在设置页添加任意 OpenAI 兼容端点（见 settings.ts）。
 */

const openai = createOpenAICompatibleAdapter({
  id: "openai",
  name: "OpenAI",
  icon: "🟩",
  description: "GPT 系列模型。",
  baseUrl: "https://api.openai.com/v1",
  apiKeyHint: "在 https://platform.openai.com/api-keys 创建",
  fallbackModels: [
    { id: "gpt-5", name: "GPT-5" },
    { id: "gpt-5-mini", name: "GPT-5 mini" },
    { id: "gpt-4.1", name: "GPT-4.1" },
  ],
  useMaxCompletionTokens: true,
  supportsReasoningEffort: true,
  filterModels: (id) => /^(gpt-|o\d|chatgpt-)/i.test(id) && !/(embedding|whisper|tts|audio|moderation|image|dall-e|realtime|search-preview|transcribe)/i.test(id),
});

const google = createOpenAICompatibleAdapter({
  id: "google",
  name: "Google Gemini",
  icon: "🟦",
  description: "Gemini 系列模型（OpenAI 兼容端点），有免费额度。",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKeyPlaceholder: "AIzaSy...",
  apiKeyHint: "在 https://aistudio.google.com/app/apikey 创建",
  fallbackModels: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-embedding-001", name: "Gemini Embedding 001" },
  ],
  supportsReasoningEffort: true,
  async fetchModels(apiKey) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Gemini ListModels ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      models?: Array<{ name: string; displayName?: string; description?: string; supportedGenerationMethods?: string[] }>;
    };
    return (json.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.some((g) => g === "generateContent" || g === "embedContent"))
      .map<RemoteModel>((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name.replace(/^models\//, ""), description: m.description }))
      .sort((a, b) => b.id.localeCompare(a.id));
  },
});

const deepseek = createOpenAICompatibleAdapter({
  id: "deepseek",
  name: "DeepSeek",
  icon: "🟪",
  description: "性价比很高的国产模型。",
  baseUrl: "https://api.deepseek.com",
  apiKeyHint: "在 https://platform.deepseek.com/api_keys 创建",
  fallbackModels: [
    { id: "deepseek-chat", name: "DeepSeek V3" },
    { id: "deepseek-reasoner", name: "DeepSeek R1" },
  ],
  capabilities: { jsonSchema: false, embeddings: false },
});

export const BUILT_IN_PROVIDERS: ProviderAdapter[] = [anthropic, openai, google, deepseek];

export function getBuiltInProvider(id: string): ProviderAdapter | undefined {
  return BUILT_IN_PROVIDERS.find((p) => p.id === id);
}

/** 用户自定义的 OpenAI 兼容端点 → 适配器 */
export function customProviderAdapter(cfg: AiCustomProvider): ProviderAdapter {
  return createOpenAICompatibleAdapter({
    id: cfg.id,
    name: cfg.name,
    icon: "⚪",
    description: `OpenAI 兼容端点：${cfg.baseUrl}`,
    baseUrl: cfg.baseUrl,
    apiKeyHint: cfg.apiKeyHint || `端点：${cfg.baseUrl}`,
  });
}

export { createOpenAICompatibleAdapter };
export type { ProviderAdapter, RemoteModel };
