/**
 * 测试用的假 OpenAI 兼容服务（Bun.serve）：
 * - GET  /v1/models            → 两个模型
 * - POST /v1/chat/completions  → 按请求返回文本 / JSON；model=fake-broken 返回 500；可模拟不支持 json_schema
 * - POST /v1/embeddings        → 固定维度向量
 */

export interface FakeOpenAIOptions {
  port: number;
  /** 收到 json_schema 时返回 400（模拟不支持结构化输出的端点） */
  rejectJsonSchema?: boolean;
  /** 自定义 JSON 回复（默认是一条 triage 结果） */
  jsonReply?: () => unknown;
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
        return Response.json({ data: input.map((_, i) => ({ index: i, embedding: [0.1 * (i + 1), 0.2, 0.3] })), usage: { prompt_tokens: 12 }, model: body.model });
      }
      if (url.pathname === "/v1/chat/completions") {
        if (body.model === "fake-broken") return Response.json({ error: { message: "boom" } }, { status: 500 });
        const format = body.response_format as { type?: string } | undefined;
        if (format?.type === "json_schema" && opts.rejectJsonSchema) {
          return Response.json({ error: { message: "response_format json_schema is not supported" } }, { status: 400 });
        }
        const messages = body.messages as Array<{ role: string; content: string }>;
        const content = format ? JSON.stringify(opts.jsonReply ? opts.jsonReply() : DEFAULT_TRIAGE_REPLY) : opts.textReply ? opts.textReply(messages) : "ok";
        return Response.json({
          model: body.model,
          choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${opts.port}/v1`, requests, stop: () => server.stop(true) };
}
