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

export function startFakeOpenAIServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if ((req.headers.authorization ?? "") !== "Bearer test-key") return send(401, { error: { message: "Incorrect API key" } });
    if (req.method === "GET" && req.url === "/v1/models") return send(200, { data: [{ id: "fake-smart", created: 1700000000 }, { id: "fake-fast", created: 1600000000 }] });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { model?: string; response_format?: { type: string }; messages?: Array<{ content: string }> };
      if (req.url === "/v1/chat/completions") {
        const content = body.response_format ? JSON.stringify(TRIAGE) : body.messages?.some((m) => m.content.includes("请只回复")) ? "ok" : "您好，发票已收到，谢谢！\n\n[你的名字]";
        return send(200, { model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
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
