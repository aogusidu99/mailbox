import { z } from "zod";
import type { AiEffort } from "@/db/schema";
import {
  AiProviderError,
  EMPTY_USAGE,
  type AiChatMessage,
  type AiUsage,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type EmbedOptions,
  type EmbedResult,
  type GenerateOptions,
  type GenerateResult,
  type ProviderAdapter,
  type RemoteModel,
} from "./types";

/**
 * OpenAI 兼容适配器工厂：OpenAI、DeepSeek、Gemini（OpenAI 兼容端点）、Moonshot、OpenRouter、Ollama……
 * 都暴露 /chat/completions、/embeddings、/models 这套接口，只需换 baseUrl。
 */

export interface CompatibleInit {
  id: string;
  name: string;
  icon: string;
  description: string;
  baseUrl: string;
  apiKeyPlaceholder?: string;
  apiKeyHint?: string;
  fallbackModels?: RemoteModel[];
  capabilities?: Partial<ProviderAdapter["capabilities"]>;
  /** 过滤 /models 列表 */
  filterModels?: (id: string) => boolean;
  /** 自定义模型列表接口（Gemini 用原生接口） */
  fetchModels?: (apiKey: string, baseUrl: string) => Promise<RemoteModel[]>;
  /** OpenAI 新模型只认 max_completion_tokens */
  useMaxCompletionTokens?: boolean;
  /** 是否发送 reasoning_effort */
  supportsReasoningEffort?: boolean;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
    if (typeof body.error === "string") return body.error;
    return body.error?.message || body.message || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

async function request<T>(url: string, apiKey: string, body: unknown, signal?: AbortSignal, name = "provider"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new AiProviderError(`无法连接 ${name}：${err instanceof Error ? err.message : String(err)}`, "network");
  }
  if (!res.ok) {
    const message = await readError(res);
    if (res.status === 401 || res.status === 403) throw new AiProviderError(`${name} API Key 无效或无权限：${message}`, "auth", res.status);
    if (res.status === 429) throw new AiProviderError(`${name} 请求过于频繁：${message}`, "rate_limit", 429);
    if (res.status === 400 || res.status === 404 || res.status === 422) throw new AiProviderError(`${name} 参数错误：${message}`, "invalid_request", res.status);
    throw new AiProviderError(`${name} 服务错误（${res.status}）：${message}`, "server", res.status);
  }
  return (await res.json()) as T;
}

interface ChatCompletion {
  model?: string;
  choices: Array<{
    finish_reason?: string;
    message: { content?: string | null; refusal?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

function toUsage(u: ChatCompletion["usage"]): AiUsage {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
  };
}

function mapEffort(effort?: AiEffort): "low" | "medium" | "high" | undefined {
  if (!effort) return undefined;
  if (effort === "xhigh" || effort === "max") return "high";
  return effort;
}

/** 从可能带 ```json 围栏的文本里提取 JSON */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new AiProviderError("模型没有返回可解析的 JSON", "parse");
  }
}

export function createOpenAICompatibleAdapter(init: CompatibleInit): ProviderAdapter {
  const base = trimBase(init.baseUrl);
  const caps = { embeddings: true, tools: true, jsonSchema: true, ...init.capabilities };
  const label = init.name;

  const buildBody = (opts: GenerateOptions, mode: "schema" | "json_object" | "text") => {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    const max = opts.maxTokens ?? 4096;
    if (init.useMaxCompletionTokens) body.max_completion_tokens = max;
    else body.max_tokens = max;
    if (opts.temperature !== undefined && !init.useMaxCompletionTokens) body.temperature = opts.temperature;
    const effort = mapEffort(opts.effort);
    if (effort && init.supportsReasoningEffort) body.reasoning_effort = effort;
    if (mode === "schema" && opts.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: opts.schemaName ?? "result", schema: z.toJSONSchema(opts.schema, { target: "draft-7" }), strict: false },
      };
    } else if (mode === "json_object") {
      body.response_format = { type: "json_object" };
    }
    return body;
  };

  return {
    id: init.id,
    name: init.name,
    icon: init.icon,
    description: init.description,
    apiKeyPlaceholder: init.apiKeyPlaceholder ?? "sk-...",
    apiKeyHint: init.apiKeyHint ?? `端点：${base}`,
    baseUrl: base,
    capabilities: caps,
    fallbackModels: init.fallbackModels ?? [],

    async fetchModels(apiKey, baseUrl) {
      const b = baseUrl ? trimBase(baseUrl) : base;
      if (init.fetchModels) return init.fetchModels(apiKey, b);
      let res: Response;
      try {
        res = await fetch(`${b}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        throw new AiProviderError(`无法连接 ${label}：${err instanceof Error ? err.message : String(err)}`, "network");
      }
      if (!res.ok) {
        const message = await readError(res);
        throw new AiProviderError(`${label} /models 请求失败：${message}`, res.status === 401 ? "auth" : "server", res.status);
      }
      const json = (await res.json()) as { data?: Array<{ id: string; created?: number }> };
      return (json.data ?? [])
        .filter((m) => (init.filterModels ? init.filterModels(m.id) : true))
        .map((m) => ({ id: m.id, name: m.id, createdAt: m.created ? m.created * 1000 : undefined }))
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    },

    async generate(opts) {
      const b = opts.baseUrl ? trimBase(opts.baseUrl) : base;
      const url = `${b}/chat/completions`;
      const call = (mode: "schema" | "json_object" | "text") => request<ChatCompletion>(url, opts.apiKey, buildBody(opts, mode), opts.signal, label);

      let completion: ChatCompletion;
      if (opts.schema) {
        // 优先 json_schema；不支持的端点会返回 400，降级为 json_object + 提示词约束
        const jsonMessages = [...opts.messages];
        jsonMessages.push({ role: "user", content: "只输出一个 JSON 对象，不要包含其它文字。" });
        if (caps.jsonSchema) {
          try {
            completion = await call("schema");
          } catch (err) {
            if (err instanceof AiProviderError && err.kind === "invalid_request" && /response_format|json_schema/i.test(err.message)) {
              completion = await request<ChatCompletion>(url, opts.apiKey, buildBody({ ...opts, messages: jsonMessages }, "json_object"), opts.signal, label);
            } else {
              throw err;
            }
          }
        } else {
          completion = await request<ChatCompletion>(url, opts.apiKey, buildBody({ ...opts, messages: jsonMessages }, "json_object"), opts.signal, label);
        }
      } else {
        completion = await call("text");
      }

      const choice = completion.choices?.[0];
      if (!choice) throw new AiProviderError(`${label} 没有返回结果`, "server");
      if (choice.message.refusal) throw new AiProviderError("模型拒绝了该请求", "refusal");
      const text = choice.message.content ?? "";
      const result: GenerateResult = { text, usage: toUsage(completion.usage), model: completion.model ?? opts.model, finishReason: choice.finish_reason };
      if (opts.schema) {
        const raw = extractJson(text);
        const parsed = opts.schema.safeParse(raw);
        if (!parsed.success) throw new AiProviderError(`模型返回的 JSON 不符合要求：${parsed.error.issues.map((i) => i.message).join("；")}`, "parse");
        result.json = parsed.data;
      }
      return result;
    },

    async embed(opts: EmbedOptions): Promise<EmbedResult> {
      const b = opts.baseUrl ? trimBase(opts.baseUrl) : base;
      const json = await request<{ data: Array<{ embedding: number[]; index: number }>; usage?: { prompt_tokens?: number }; model?: string }>(
        `${b}/embeddings`,
        opts.apiKey,
        { model: opts.model, input: opts.texts },
        opts.signal,
        label,
      );
      const vectors = [...json.data].sort((a, b2) => a.index - b2.index).map((d) => d.embedding);
      return { vectors, usage: { ...EMPTY_USAGE, inputTokens: json.usage?.prompt_tokens ?? 0 }, model: json.model ?? opts.model };
    },

    async chatWithTools(opts: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
      const b = opts.baseUrl ? trimBase(opts.baseUrl) : base;
      const messages: Array<Record<string, unknown>> = [];
      if (opts.system) messages.push({ role: "system", content: opts.system });
      for (const m of opts.messages as AiChatMessage[]) {
        if (m.role === "tool") {
          messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
        } else if (m.role === "assistant" && "toolCalls" in m && m.toolCalls.length) {
          messages.push({
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })),
          });
        } else {
          messages.push({ role: m.role, content: m.content });
        }
      }
      const body: Record<string, unknown> = {
        model: opts.model,
        messages,
        tools: opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      };
      const max = opts.maxTokens ?? 8192;
      if (init.useMaxCompletionTokens) body.max_completion_tokens = max;
      else body.max_tokens = max;
      const effort = mapEffort(opts.effort);
      if (effort && init.supportsReasoningEffort) body.reasoning_effort = effort;
      const completion = await request<ChatCompletion>(`${b}/chat/completions`, opts.apiKey, body, opts.signal, label);
      const choice = completion.choices?.[0];
      if (!choice) throw new AiProviderError(`${label} 没有返回结果`, "server");
      const toolCalls = (choice.message.tool_calls ?? []).map((c) => {
        let input: unknown = {};
        try {
          input = c.function.arguments ? JSON.parse(c.function.arguments) : {};
        } catch {
          input = {};
        }
        return { id: c.id, name: c.function.name, input };
      });
      const finishReason: ChatWithToolsResult["finishReason"] =
        toolCalls.length > 0 ? "tool_calls" : choice.finish_reason === "length" ? "length" : choice.message.refusal ? "refusal" : "stop";
      return { text: choice.message.content ?? "", toolCalls, usage: toUsage(completion.usage), model: completion.model ?? opts.model, finishReason };
    },
  };
}
