import type { z } from "zod";
import type { AiEffort, AiRemoteModel } from "@/db/schema";

/**
 * AI 厂商适配器契约（沿用 assistant 项目的设计）：
 * - 模型列表运行时从厂商 /models 拉取，不写死版本；
 * - 每个适配器实现统一的 generate（文本 / JSON）与可选 embed；
 * - 新增厂商 = 新建一个文件并在 index.ts 注册；OpenAI 兼容端点可由用户在设置页动态添加。
 */

export type RemoteModel = AiRemoteModel;

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  effort?: AiEffort;
  /** 传入 zod schema 时要求返回严格 JSON，并用该 schema 校验 */
  schema?: z.ZodType;
  schemaName?: string;
  signal?: AbortSignal;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface GenerateResult {
  text: string;
  json?: unknown;
  usage: AiUsage;
  model: string;
  finishReason?: string;
}

export interface EmbedOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  texts: string[];
  signal?: AbortSignal;
}

export interface EmbedResult {
  vectors: number[][];
  usage: AiUsage;
  model: string;
}

/** 工具调用（M4「和邮箱对话」Agent） */
export interface AiToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  input: unknown;
  /** 厂商附加数据（如 Gemini 的 thought_signature），回传时必须原样带上 */
  extra?: unknown;
}

export type AiChatMessage =
  | AiMessage
  | { role: "assistant"; content: string; toolCalls: AiToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ChatWithToolsOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  system?: string;
  messages: AiChatMessage[];
  tools: AiToolDefinition[];
  maxTokens?: number;
  effort?: AiEffort;
  signal?: AbortSignal;
}

export interface ChatWithToolsResult {
  text: string;
  toolCalls: AiToolCall[];
  usage: AiUsage;
  model: string;
  finishReason: "stop" | "tool_calls" | "length" | "refusal" | "other";
}

export interface ProviderAdapter {
  id: string;
  name: string;
  icon: string;
  description: string;
  apiKeyPlaceholder: string;
  apiKeyHint: string;
  /** 默认端点（自定义厂商用用户填写的 baseUrl） */
  baseUrl?: string;
  capabilities: { embeddings: boolean; tools: boolean; jsonSchema: boolean };
  /** 用户还没刷新过模型列表时的初始候选池 */
  fallbackModels: RemoteModel[];
  fetchModels(apiKey: string, baseUrl?: string): Promise<RemoteModel[]>;
  generate(opts: GenerateOptions): Promise<GenerateResult>;
  embed?(opts: EmbedOptions): Promise<EmbedResult>;
  chatWithTools?(opts: ChatWithToolsOptions): Promise<ChatWithToolsResult>;
}

/** 调用失败的分类，用于决定是否降级到备用模型 */
export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth" | "rate_limit" | "invalid_request" | "refusal" | "network" | "server" | "parse" | "unknown",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AiProviderError";
  }

  /** 认证错误 / 参数错误不值得换模型重试 */
  get retryableWithFallback(): boolean {
    return this.kind !== "auth" && this.kind !== "invalid_request";
  }
}

export const EMPTY_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
