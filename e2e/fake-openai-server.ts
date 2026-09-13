import http from "node:http";

/** e2e 用的假 OpenAI 兼容服务（Node http），行为与 tests/helpers/fake-openai.ts 一致。 */
export const FAKE_OPENAI_PORT = 11740;

const TRIAGE = {
  category: "billing",
  priority: "high",
  needsReply: false,
  summary: "9 月发票已开具，请查收附件。",
  actionItems: [{ title: "核对发票金额", dueAt: "2026-09-15" }],
  reason: "主题和正文都在说发票。",
};

const RULE = {
  name: "发票加星标",
  match: "any",
  conditions: [
    { field: "subject", op: "contains", value: "发票" },
    { field: "category", op: "equals", value: "billing" },
  ],
  actions: [{ type: "flag", value: null }],
  stopProcessing: false,
};

function fakeVector(text: string): number[] {
  const v = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % 8] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function startFakeOpenAIServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if ((req.headers.authorization ?? "") !== "Bearer test-key") return send(401, { error: { message: "Incorrect API key" } });
    if (req.method === "GET" && req.url === "/v1/models") {
      return send(200, { data: [{ id: "fake-smart", created: 1700000000 }, { id: "fake-fast", created: 1600000000 }, { id: "fake-embed", created: 1500000000 }] });
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        model?: string;
        input?: string[];
        tools?: unknown[];
        response_format?: { type: string };
        messages?: Array<{ role: string; content: string | null }>;
      };
      const usage = { prompt_tokens: 50, completion_tokens: 10 };
      if (req.url === "/v1/embeddings") {
        return send(200, { data: (body.input ?? []).map((t, i) => ({ index: i, embedding: fakeVector(t) })), usage: { prompt_tokens: 12 }, model: body.model });
      }
      if (req.url === "/v1/chat/completions") {
        const messages = body.messages ?? [];
        if (body.tools && body.tools.length) {
          const hasToolResult = messages.some((m) => m.role === "tool");
          if (!hasToolResult) {
            return send(200, {
              model: body.model,
              choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search_mail", arguments: JSON.stringify({ query: "发票", limit: 5 }) } }] } }],
              usage,
            });
          }
          return send(200, { model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "找到 1 封关于发票的邮件：《发票已开具（附件）》，来自 Bob。" } }], usage });
        }
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const content = body.response_format
          ? JSON.stringify(system.includes("规则编译器") ? RULE : TRIAGE)
          : messages.some((m) => (m.content ?? "").includes("请只回复"))
            ? "ok"
            : "您好，发票已收到，谢谢！\n\n[你的名字]";
        return send(200, { model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage });
      }
      send(404, { error: { message: "not found" } });
    });
  });
  return new Promise((resolve) => {
    server.listen(FAKE_OPENAI_PORT, "127.0.0.1", () =>
      resolve({
        baseUrl: `http://127.0.0.1:${FAKE_OPENAI_PORT}/v1`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });
}
