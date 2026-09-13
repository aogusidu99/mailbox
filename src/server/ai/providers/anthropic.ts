import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AiEffort } from "@/db/schema";
import {
  AiProviderError,
  type AiChatMessage,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type GenerateOptions,
  type GenerateResult,
  type ProviderAdapter,
  type RemoteModel,
} from "./types";

/**
 * Anthropic 官方 SDK 适配器。
 * - Claude 4.6+ 系列使用 adaptive thinking + output_config.effort；
 * - JSON 输出走 messages.parse + zodOutputFormat（结构化输出）；
 * - 工具调用用于 M4 的对话 Agent。
 */

const FALLBACK: RemoteModel[] = [
  { id: "claude-opus-5", name: "Claude Opus 5" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];

/** 支持 adaptive thinking / effort 的模型 */
function supportsAdaptive(model: string): boolean {
  return /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable|mythos)/.test(model);
}

function makeClient(apiKey: string, baseUrl?: string) {
  return new Anthropic({ apiKey, baseURL: baseUrl || undefined, maxRetries: 2, timeout: 120_000 });
}

function mapError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new AiProviderError("Anthropic API Key 无效", "auth", 401);
  if (err instanceof Anthropic.PermissionDeniedError) return new AiProviderError("Anthropic 拒绝了请求（权限不足）", "auth", 403);
  if (err instanceof Anthropic.RateLimitError) return new AiProviderError("Anthropic 请求过于频繁，请稍后再试", "rate_limit", 429);
  if (err instanceof Anthropic.BadRequestError) return new AiProviderError(`Anthropic 参数错误：${err.message}`, "invalid_request", 400);
  if (err instanceof Anthropic.NotFoundError) return new AiProviderError(`模型不存在：${err.message}`, "invalid_request", 404);
  if (err instanceof Anthropic.APIConnectionError) return new AiProviderError("无法连接到 Anthropic API", "network");
  if (err instanceof Anthropic.APIError) return new AiProviderError(`Anthropic API 错误：${err.message}`, "server", err.status);
  return new AiProviderError(err instanceof Error ? err.message : String(err), "unknown");
}

function splitMessages(messages: GenerateOptions["messages"]) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  if (rest.length === 0) rest.push({ role: "user", content: "" });
  return { system: system || undefined, messages: rest };
}

function thinkingParams(model: string, effort?: AiEffort) {
  if (!supportsAdaptive(model)) return {};
  return {
    thinking: { type: "adaptive" as const },
    ...(effort ? { output_config: { effort } } : {}),
  };
}

function toUsage(u: Anthropic.Usage | undefined) {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

const anthropic: ProviderAdapter = {
  id: "anthropic",
  name: "Anthropic Claude",
  icon: "🟧",
  description: "Claude 系列模型，官方 SDK 直连。",
  apiKeyPlaceholder: "sk-ant-...",
  apiKeyHint: "在 https://console.anthropic.com/settings/keys 创建",
  capabilities: { embeddings: false, tools: true, jsonSchema: true },
  fallbackModels: FALLBACK,

  async fetchModels(apiKey, baseUrl) {
    try {
      const client = makeClient(apiKey, baseUrl);
      const out: RemoteModel[] = [];
      for await (const m of client.models.list({ limit: 100 })) {
        out.push({ id: m.id, name: m.display_name || m.id, createdAt: m.created_at ? new Date(m.created_at).getTime() : undefined });
      }
      return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    } catch (err) {
      throw mapError(err);
    }
  },

  async generate(opts) {
    const client = makeClient(opts.apiKey, opts.baseUrl);
    const { system, messages } = splitMessages(opts.messages);
    const base = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system,
      messages,
      ...(opts.temperature !== undefined && !supportsAdaptive(opts.model) ? { temperature: opts.temperature } : {}),
    };
    try {
      if (opts.schema) {
        const thinking = thinkingParams(opts.model, opts.effort);
        const response = await client.messages.parse(
          {
            ...base,
            ...thinking,
            output_config: { ...(thinking as { output_config?: object }).output_config, format: zodOutputFormat(opts.schema) },
          },
          { signal: opts.signal },
        );
        if (response.stop_reason === "refusal") throw new AiProviderError("模型拒绝了该请求", "refusal");
        if (response.parsed_output == null) throw new AiProviderError("模型没有返回符合格式的 JSON", "parse");
        const text = response.content.find((b) => b.type === "text")?.text ?? "";
        return { text, json: response.parsed_output, usage: toUsage(response.usage), model: response.model, finishReason: response.stop_reason ?? undefined };
      }
      const response = await client.messages.create({ ...base, ...thinkingParams(opts.model, opts.effort) }, { signal: opts.signal });
      if (response.stop_reason === "refusal") throw new AiProviderError("模型拒绝了该请求", "refusal");
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text, usage: toUsage(response.usage), model: response.model, finishReason: response.stop_reason ?? undefined };
    } catch (err) {
      throw mapError(err);
    }
  },

  async chatWithTools(opts: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
    const client = makeClient(opts.apiKey, opts.baseUrl);
    const messages: Anthropic.MessageParam[] = [];
    for (const m of opts.messages as AiChatMessage[]) {
      if (m.role === "system") continue;
      if (m.role === "tool") {
        const last = messages[messages.length - 1];
        const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
        if (last && last.role === "user" && Array.isArray(last.content)) {
          (last.content as Anthropic.ContentBlockParam[]).push(block);
        } else {
          messages.push({ role: "user", content: [block] });
        }
        continue;
      }
      if (m.role === "assistant" && "toolCalls" in m && m.toolCalls.length) {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input as Record<string, unknown> });
        messages.push({ role: "assistant", content });
        continue;
      }
      messages.push({ role: m.role as "user" | "assistant", content: m.content });
    }
    try {
      const response = await client.messages.create(
        {
          model: opts.model,
          max_tokens: opts.maxTokens ?? 8192,
          system: opts.system,
          messages,
          tools: opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool["input_schema"] })),
          ...thinkingParams(opts.model, opts.effort),
        },
        { signal: opts.signal },
      );
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      const finishReason: ChatWithToolsResult["finishReason"] =
        response.stop_reason === "tool_use"
          ? "tool_calls"
          : response.stop_reason === "max_tokens"
            ? "length"
            : response.stop_reason === "refusal"
              ? "refusal"
              : response.stop_reason === "end_turn"
                ? "stop"
                : "other";
      return { text, toolCalls, usage: toUsage(response.usage), model: response.model, finishReason };
    } catch (err) {
      throw mapError(err);
    }
  },
};

export default anthropic;
