import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { createOpenAICompatibleAdapter, extractJson } from "@/server/ai/providers/openai-compatible";
import { AiProviderError } from "@/server/ai/providers/types";
import { startFakeOpenAI, type FakeOpenAI } from "./helpers/fake-openai";

describe("OpenAI 兼容适配器", () => {
  let fake: FakeOpenAI;
  let strictFake: FakeOpenAI;
  const schema = z.object({ category: z.string(), priority: z.string(), summary: z.string() });

  beforeAll(() => {
    fake = startFakeOpenAI({ port: 11720 });
    strictFake = startFakeOpenAI({ port: 11721, rejectJsonSchema: true });
  });
  afterAll(() => {
    fake.stop();
    strictFake.stop();
  });

  const adapter = (baseUrl: string) =>
    createOpenAICompatibleAdapter({ id: "fake", name: "Fake", icon: "⚪", description: "", baseUrl, supportsReasoningEffort: true });

  test("拉取模型列表并按创建时间排序", async () => {
    const models = await adapter(fake.baseUrl).fetchModels("test-key");
    expect(models.map((m) => m.id)).toEqual(["fake-smart", "fake-fast", "fake-broken", "fake-embed"]);
  });

  test("文本生成：请求体带 reasoning_effort，返回用量", async () => {
    const r = await adapter(fake.baseUrl).generate({ model: "fake-fast", apiKey: "test-key", messages: [{ role: "user", content: "hi" }], effort: "xhigh", maxTokens: 50 });
    expect(r.text).toBe("ok");
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 });
    const last = fake.requests[fake.requests.length - 1].body;
    expect(last.reasoning_effort).toBe("high");
    expect(last.max_tokens).toBe(50);
  });

  test("JSON 生成：json_schema 模式并用 zod 校验", async () => {
    const r = await adapter(fake.baseUrl).generate({ model: "fake-fast", apiKey: "test-key", messages: [{ role: "user", content: "分类" }], schema });
    expect((r.json as { category: string }).category).toBe("billing");
    const last = fake.requests[fake.requests.length - 1].body as { response_format: { type: string; json_schema: { schema: { properties: object } } } };
    expect(last.response_format.type).toBe("json_schema");
    expect(Object.keys(last.response_format.json_schema.schema.properties)).toEqual(["category", "priority", "summary"]);
  });

  test("端点不支持 json_schema 时降级为 json_object", async () => {
    const r = await adapter(strictFake.baseUrl).generate({ model: "fake-fast", apiKey: "test-key", messages: [{ role: "user", content: "分类" }], schema });
    expect((r.json as { summary: string }).summary).toContain("发票");
    const kinds = strictFake.requests.map((q) => (q.body.response_format as { type: string }).type);
    expect(kinds).toEqual(["json_schema", "json_object"]);
  });

  test("错误分类：401 → auth（不降级），500 → server（可降级）", async () => {
    await expect(adapter(fake.baseUrl).generate({ model: "fake-fast", apiKey: "wrong", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ kind: "auth", retryableWithFallback: false });
    try {
      await adapter(fake.baseUrl).generate({ model: "fake-broken", apiKey: "test-key", messages: [{ role: "user", content: "x" }] });
      throw new Error("should fail");
    } catch (err) {
      expect(err).toBeInstanceOf(AiProviderError);
      expect((err as AiProviderError).kind).toBe("server");
      expect((err as AiProviderError).retryableWithFallback).toBe(true);
    }
  });

  test("embeddings", async () => {
    const r = await adapter(fake.baseUrl).embed!({ model: "fake-embed", apiKey: "test-key", texts: ["a", "b"] });
    expect(r.vectors).toHaveLength(2);
    expect(r.vectors[0]).toHaveLength(8);
    expect(r.vectors[0]).not.toEqual(r.vectors[1]);
    expect(r.usage.inputTokens).toBe(12);
  });

  test("extractJson 兼容围栏与前后杂文", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('结果如下：{"a":{"b":2}} 谢谢')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("没有 json")).toThrow();
  });
});
