import { describe, expect, test } from "bun:test";
import { addCustomProvider, DEFAULT_SETTINGS, presetRoles, removeCustomProvider, resolveRole, setCandidates, type LoadedAiSettings } from "@/server/ai/settings";

function settings(partial: Partial<LoadedAiSettings["data"]> = {}, keys: Record<string, string> = { anthropic: "k" }): LoadedAiSettings {
  return {
    data: {
      ...DEFAULT_SETTINGS,
      candidates: {
        anthropic: [
          { id: "claude-opus-5", name: "Opus" },
          { id: "claude-sonnet-5", name: "Sonnet" },
          { id: "claude-haiku-4-5", name: "Haiku" },
        ],
        ...(partial.candidates ?? {}),
      },
      ...partial,
    },
    keys,
  };
}

describe("AI 设置解析", () => {
  test("没有覆盖时用全局默认，并给出同厂商候选池里的备用模型", () => {
    const r = resolveRole(settings(), "draft");
    expect(r.providerId).toBe("anthropic");
    expect(r.model).toBe("claude-opus-5");
    expect(r.fallbackModels).toEqual(["claude-sonnet-5", "claude-haiku-4-5"]);
  });

  test("等级覆盖优先；只覆盖厂商时用该厂商候选池第一个模型", () => {
    const s = settings({
      roles: { triage: { provider: "anthropic", model: "claude-haiku-4-5", effort: "low" }, summary: { provider: "deepseek" } },
      candidates: { deepseek: [{ id: "deepseek-chat", name: "V3" }] },
    }, { anthropic: "k", deepseek: "d" });
    const triage = resolveRole(s, "triage");
    expect(triage.model).toBe("claude-haiku-4-5");
    expect(triage.effort).toBe("low");
    expect(triage.fallbackModels).toEqual([]);
    const summary = resolveRole(s, "summary");
    expect(summary.providerId).toBe("deepseek");
    expect(summary.model).toBe("deepseek-chat");
  });

  test("缺少 API Key 时给出明确错误", () => {
    expect(() => resolveRole(settings({}, {}), "draft")).toThrow(/API Key/);
  });

  test("预设：质量优先全 Opus，省钱用 Haiku/Sonnet，embedding 按可用 Key 选择", () => {
    const quality = presetRoles("quality", false, false);
    expect(quality.draft?.model).toBe("claude-opus-5");
    expect(quality.embedding).toBeUndefined();
    const economy = presetRoles("economy", true, true);
    expect(economy.triage?.model).toBe("claude-haiku-4-5");
    expect(economy.draft?.model).toBe("claude-sonnet-5");
    expect(economy.embedding).toEqual({ provider: "google", model: "gemini-embedding-001" });
    expect(presetRoles("balanced", false, true).embedding?.provider).toBe("openai");
  });

  test("自定义厂商：添加、作为默认、删除后回退", () => {
    let data = addCustomProvider(DEFAULT_SETTINGS, { id: "moonshot", name: "Moonshot", baseUrl: "https://api.moonshot.cn/v1" });
    data = setCandidates(data, "moonshot", [{ id: "kimi-latest", name: "Kimi" }]);
    data = { ...data, defaultProvider: "moonshot", defaultModel: "kimi-latest", roles: { draft: { provider: "moonshot", model: "kimi-latest" } } };
    const r = resolveRole({ data, keys: { moonshot: "m" } }, "draft");
    expect(r.providerId).toBe("moonshot");
    expect(r.provider.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(() => addCustomProvider(data, { id: "openai", name: "x", baseUrl: "https://x" })).toThrow(/内置/);
    const removed = removeCustomProvider(data, "moonshot");
    expect(removed.defaultProvider).toBe("anthropic");
    expect(removed.roles.draft).toBeUndefined();
    expect(removed.candidates.moonshot).toBeUndefined();
  });
});
