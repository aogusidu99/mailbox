/**
 * 测试用的假 OpenAI 兼容服务（Bun.serve）：
 * - GET  /v1/models            → 几个模型
 * - POST /v1/chat/completions  → 按请求返回文本 / JSON / 工具调用；model=fake-broken 返回 500；可模拟不支持 json_schema
 * - POST /v1/embeddings        → 固定维度向量（按文本内容略有差异，便于测排序）
 */

export interface FakeOpenAIOptions {
  port: number;
  /** 收到 json_schema 时返回 400（模拟不支持结构化输出的端点） */
  rejectJsonSchema?: boolean;
  /** 自定义 JSON 回复（默认按系统提示判断返回 triage 或规则） */
  jsonReply?: (messages: Array<{ role: string; content: string }>) => unknown;
  textReply?: (messages: Array<{ role: string; content: string }>) => string;
}

export interface FakeOpenAI {
  baseUrl: string;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  stop(): void;
}

export const DEFAULT_TRIAGE_REPLY = {
  category: "billing",
  priority: "high",
  needsReply: false,
  summary: "9 月发票已开具，请查收附件。",
  actionItems: [{ title: "核对发票金额", dueAt: "2026-09-15" }],
  reason: "邮件主题和正文都在说发票。",
};

export const DEFAULT_RULE_REPLY = {
  name: "发票归档",
  match: "any",
  conditions: [
    { field: "category", op: "equals", value: "billing" },
    { field: "subject", op: "contains", value: "发票" },
  ],
  actions: [{ type: "mark_read", value: null }, { type: "flag", value: null }],
  stopProcessing: false,
};

/** 简单可重复的伪向量：按字符统计生成 8 维 */
export function fakeVector(text: string): number[] {
  const v = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % 8] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function startFakeOpenAI(opts: FakeOpenAIOptions): FakeOpenAI {
  const requests: FakeOpenAI["requests"] = [];
  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== "Bearer test-key") return Response.json({ error: { message: "Incorrect API key" } }, { status: 401 });
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: "fake-smart", created: 1700000000 }, { id: "fake-fast", created: 1600000000 }, { id: "fake-broken", created: 1500000000 }, { id: "fake-embed", created: 1400000000 }] });
      }
      const body = (await req.json()) as Record<string, unknown>;
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/v1/embeddings") {
        const input = body.input as string[];
        return Response.json({ data: input.map((t, i) => ({ index: i, embedding: fakeVector(t) })), usage: { prompt_tokens: 12 }, model: body.model });
      }
      if (url.pathname === "/v1/chat/completions") {
        if (body.model === "fake-broken") return Response.json({ error: { message: "boom" } }, { status: 500 });
        const messages = body.messages as Array<{ role: string; content: string; tool_call_id?: string }>;
        const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } };

        // 工具调用：第一轮返回 search_mail，之后（已有 tool 结果）返回最终回答
        if (Array.isArray(body.tools) && (body.tools as unknown[]).length > 0) {
          const hasToolResult = messages.some((m) => m.role === "tool");
          if (!hasToolResult) {
            return Response.json({
              model: body.model,
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search_mail", arguments: JSON.stringify({ query: "发票", limit: 5 }) } }] },
                },
              ],
              usage,
            });
          }
          const toolResult = messages.find((m) => m.role === "tool")?.content ?? "";
          const idMatch = toolResult.match(/id=([0-9a-f-]{36})/);
          const proposed = messages.filter((m) => m.role === "tool").length >= 2;
          if (idMatch && !proposed) {
            return Response.json({
              model: body.model,
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{ id: "call_2", type: "function", function: { name: "propose_actions", arguments: JSON.stringify({ actions: [{ messageId: idMatch[1], action: "flag", reason: "发票需要跟进" }] }) } }],
                  },
                },
              ],
              usage,
            });
          }
          return Response.json({ model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "找到 1 封关于发票的邮件：《发票已开具》，建议加星标跟进。" } }], usage });
        }

        const format = body.response_format as { type?: string } | undefined;
        if (format?.type === "json_schema" && opts.rejectJsonSchema) {
          return Response.json({ error: { message: "response_format json_schema is not supported" } }, { status: 400 });
        }
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const content = format
          ? JSON.stringify(opts.jsonReply ? opts.jsonReply(messages) : system.includes("规则编译器") ? DEFAULT_RULE_REPLY : DEFAULT_TRIAGE_REPLY)
          : opts.textReply
            ? opts.textReply(messages)
            : "ok";
        return Response.json({ model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${opts.port}/v1`, requests, stop: () => server.stop(true) };
}
