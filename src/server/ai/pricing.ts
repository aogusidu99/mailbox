/**
 * 已知模型单价（美元 / 百万 token），用于成本面板估算。未知模型按 0 计（面板会标注「未知单价」）。
 */
const PRICES: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /^claude-fable-5/, input: 10, output: 50 },
  { match: /^claude-opus-5/, input: 5, output: 25 },
  { match: /^claude-opus-4-[678]/, input: 5, output: 25 },
  { match: /^claude-sonnet-5/, input: 2, output: 10 },
  { match: /^claude-sonnet-4-6/, input: 3, output: 15 },
  { match: /^claude-haiku-4-5/, input: 1, output: 5 },
  { match: /^gpt-5-mini/, input: 0.25, output: 2 },
  { match: /^gpt-5/, input: 1.25, output: 10 },
  { match: /^gpt-4\.1-mini/, input: 0.4, output: 1.6 },
  { match: /^gpt-4\.1/, input: 2, output: 8 },
  { match: /^gpt-4o-mini/, input: 0.15, output: 0.6 },
  { match: /^gpt-4o/, input: 2.5, output: 10 },
  { match: /^text-embedding-3-small/, input: 0.02, output: 0 },
  { match: /^text-embedding-3-large/, input: 0.13, output: 0 },
  { match: /^gemini-2\.5-pro/, input: 1.25, output: 10 },
  { match: /^gemini-2\.5-flash-lite/, input: 0.1, output: 0.4 },
  { match: /^gemini-2\.5-flash/, input: 0.3, output: 2.5 },
  { match: /^gemini-embedding/, input: 0.15, output: 0 },
  { match: /^deepseek-chat/, input: 0.27, output: 1.1 },
  { match: /^deepseek-reasoner/, input: 0.55, output: 2.19 },
];

export function priceFor(model: string): { input: number; output: number } | null {
  const hit = PRICES.find((p) => p.match.test(model));
  return hit ? { input: hit.input, output: hit.output } : null;
}

export function estimateCostUsd(model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  const p = priceFor(model);
  if (!p) return 0;
  const cacheRead = usage.cacheReadTokens * p.input * 0.1;
  const cacheWrite = usage.cacheWriteTokens * p.input * 1.25;
  const input = Math.max(0, usage.inputTokens - usage.cacheReadTokens) * p.input;
  const output = usage.outputTokens * p.output;
  return (input + output + cacheRead + cacheWrite) / 1_000_000;
}
