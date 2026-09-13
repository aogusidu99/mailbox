"use client";

import { CheckCircle2, Loader2, RefreshCw, Trash2, XCircle } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { AiRemoteModel, AiRole } from "@/db/schema";
import type { AiSettingsView, PresetId } from "@/server/ai/settings";
import type { UsageSummary } from "@/server/ai/usage";
import { cn } from "cn";
import {
  addCustomProviderAction,
  applyPresetAction,
  backfillTriageAction,
  fetchModelsAction,
  removeCustomProviderAction,
  saveBehaviorAction,
  saveCandidatesAction,
  saveDefaultsAction,
  saveProviderKeyAction,
  saveRoleAction,
  testProviderAction,
} from "../actions";

const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-sm";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export function AiSettingsPanel({
  initial,
  usage,
  accounts,
}: {
  initial: AiSettingsView;
  usage: UsageSummary;
  accounts: Array<{ id: string; email: string; aiEnabled: boolean }>;
}) {
  const [view, setView] = useState(initial);
  const [activeId, setActiveId] = useState(initial.data.defaultProvider);
  const [keyInput, setKeyInput] = useState("");
  const [remoteModels, setRemoteModels] = useState<AiRemoteModel[] | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [custom, setCustom] = useState({ id: "", name: "", baseUrl: "", apiKeyHint: "" });
  const [backfillLimit, setBackfillLimit] = useState(100);

  const active = view.providers.find((p) => p.id === activeId) ?? view.providers[0];
  const candidates = view.data.candidates[active.id] ?? [];
  const hasKey = Boolean(view.maskedKeys[active.id]);

  /** 执行一个返回新设置视图的 Server Action；成功返回 true */
  const apply = (promise: Promise<ActionResult<AiSettingsView>>, success?: string) =>
    new Promise<boolean>((resolve) => {
      start(async () => {
        const r = await promise;
        if (!r.ok) {
          toast.error(r.error);
          resolve(false);
          return;
        }
        setView(r.data);
        if (success) toast.success(success);
        resolve(true);
      });
    });

  const saveKey = () =>
    void apply(saveProviderKeyAction(active.id, keyInput), keyInput ? "已保存 API Key" : "已清除 API Key").then((ok) => {
      if (ok) setKeyInput("");
    });

  const refreshModels = () =>
    start(async () => {
      const r = await fetchModelsAction(active.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setRemoteModels(r.data);
      toast.success(`拉取到 ${r.data.length} 个模型，勾选后保存到候选池`);
    });

  const toggleCandidate = (m: AiRemoteModel, on: boolean) => {
    const next = on ? [...candidates.filter((c) => c.id !== m.id), { id: m.id, name: m.name, description: m.description }] : candidates.filter((c) => c.id !== m.id);
    // 先乐观更新勾选状态，Server Action 返回后再以服务端为准
    setView((v) => ({ ...v, data: { ...v.data, candidates: { ...v.data.candidates, [active.id]: next } } }));
    void apply(saveCandidatesAction(active.id, next));
  };

  const test = () =>
    start(async () => {
      setTestResult(null);
      const model = view.data.defaultProvider === active.id ? view.data.defaultModel : candidates[0]?.id;
      if (!model) {
        toast.error("候选池为空，先刷新并勾选模型");
        return;
      }
      const r = await testProviderAction(active.id, model);
      if (!r.ok) {
        setTestResult({ ok: false, text: r.error });
        return;
      }
      setTestResult(r.data.ok ? { ok: true, text: `${r.data.model} 回复：${r.data.reply}` } : { ok: false, text: r.data.error });
    });

  const roleConfig = (role: AiRole) => view.data.roles[role] ?? {};
  const modelsFor = (providerId: string | undefined) => view.data.candidates[providerId ?? view.data.defaultProvider] ?? [];

  return (
    <div className="space-y-6">
      {/* 一键预设 */}
      <Card>
        <CardHeader>
          <CardTitle>一键预设</CardTitle>
          <CardDescription>把各任务等级填成推荐组合（都用 Anthropic；embedding 在有 Gemini / OpenAI Key 时自动选择），之后仍可逐项修改。当前：{presetLabel(view.data.preset)}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {(["quality", "balanced", "economy"] as PresetId[]).map((p) => (
            <Button key={p} variant={view.data.preset === p ? "default" : "outline"} size="sm" disabled={pending} onClick={() => apply(applyPresetAction(p), `已应用「${presetLabel(p)}」预设`)}>
              {presetLabel(p)}
            </Button>
          ))}
        </CardContent>
      </Card>

      {/* 厂商与 Key */}
      <Card>
        <CardHeader>
          <CardTitle>厂商与 API Key</CardTitle>
          <CardDescription>选择厂商后填写 Key，点「刷新模型列表」从厂商拉取最新模型并勾选进候选池。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {view.providers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setActiveId(p.id);
                  setRemoteModels(null);
                  setTestResult(null);
                  setKeyInput("");
                }}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm",
                  active.id === p.id ? "border-primary bg-primary/5" : "hover:bg-muted",
                )}
              >
                <span>{p.icon}</span>
                <span>{p.name}</span>
                {view.maskedKeys[p.id] ? <CheckCircle2 className="size-3.5 text-emerald-600" /> : null}
                {view.data.defaultProvider === p.id ? <span className="rounded bg-muted px-1 text-[10px]">默认</span> : null}
              </button>
            ))}
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="text-sm font-medium">
              {active.icon} {active.name}
              <span className="ml-2 text-xs text-muted-foreground">{active.description}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="password"
                autoComplete="off"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={hasKey ? `已保存：${view.maskedKeys[active.id]}（输入新值可替换）` : active.apiKeyPlaceholder}
                className="max-w-md"
                aria-label={`${active.name} API Key`}
              />
              <Button size="sm" onClick={saveKey} disabled={pending || (!keyInput && !hasKey)}>
                {keyInput ? "保存 Key" : "清除 Key"}
              </Button>
              <Button size="sm" variant="outline" onClick={refreshModels} disabled={pending || !hasKey}>
                <RefreshCw className="size-4" /> 刷新模型列表
              </Button>
              <Button size="sm" variant="outline" onClick={test} disabled={pending || !hasKey}>
                测试连接
              </Button>
              {active.custom ? (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    void apply(removeCustomProviderAction(active.id), "已删除自定义厂商").then((ok) => {
                      if (ok) setActiveId("anthropic");
                    })
                  }
                  disabled={pending}
                >
                  <Trash2 className="size-4" /> 删除厂商
                </Button>
              ) : null}
            </div>
            <div className="text-xs text-muted-foreground">{active.apiKeyHint}</div>
            {testResult ? (
              <div className={cn("flex items-center gap-2 text-sm", testResult.ok ? "text-emerald-700" : "text-destructive")}>
                {testResult.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
                {testResult.text}
              </div>
            ) : null}

            <div className="text-xs font-medium text-muted-foreground">候选池（{candidates.length}）</div>
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((m) => (
                <span key={m.id} className="rounded bg-muted px-2 py-0.5 text-xs" title={m.description}>
                  {m.name || m.id}
                </span>
              ))}
              {candidates.length === 0 ? <span className="text-xs text-muted-foreground">空</span> : null}
            </div>
            {remoteModels ? (
              <div className="max-h-64 overflow-auto rounded border p-2">
                {remoteModels.map((m) => {
                  const on = candidates.some((c) => c.id === m.id);
                  return (
                    <label key={m.id} className="flex cursor-pointer items-center gap-2 py-0.5 text-sm">
                      <input type="checkbox" checked={on} onChange={(e) => toggleCandidate(m, e.target.checked)} disabled={pending} />
                      <span>{m.name || m.id}</span>
                      {m.name && m.name !== m.id ? <span className="text-xs text-muted-foreground">{m.id}</span> : null}
                    </label>
                  );
                })}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
              <span className="text-muted-foreground">默认模型（全局）：</span>
              <select
                className={selectClass}
                value={view.data.defaultProvider === active.id ? view.data.defaultModel : ""}
                onChange={(e) => apply(saveDefaultsAction(active.id, e.target.value), "已更新默认模型")}
                disabled={pending}
              >
                <option value="">{view.data.defaultProvider === active.id ? "请选择" : `（当前默认厂商：${view.data.defaultProvider}）`}</option>
                {candidates.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">添加 OpenAI 兼容厂商（Moonshot、OpenRouter、Ollama、SiliconFlow…）</summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Input placeholder="id（小写字母/数字/连字符，如 moonshot）" value={custom.id} onChange={(e) => setCustom({ ...custom, id: e.target.value })} />
              <Input placeholder="名称" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
              <Input placeholder="baseUrl，如 https://api.moonshot.cn/v1" value={custom.baseUrl} onChange={(e) => setCustom({ ...custom, baseUrl: e.target.value })} className="sm:col-span-2" />
              <Input placeholder="Key 获取提示（可选）" value={custom.apiKeyHint} onChange={(e) => setCustom({ ...custom, apiKeyHint: e.target.value })} className="sm:col-span-2" />
            </div>
            <Button
              size="sm"
              className="mt-2"
              disabled={pending || !custom.id || !custom.name || !custom.baseUrl}
              onClick={() => {
                const id = custom.id.trim();
                void apply(addCustomProviderAction({ ...custom, apiKeyHint: custom.apiKeyHint || undefined }), "已添加厂商，请填写 Key").then((ok) => {
                  if (!ok) return;
                  setActiveId(id);
                  setCustom({ id: "", name: "", baseUrl: "", apiKeyHint: "" });
                });
              }}
            >
              添加
            </Button>
          </details>
        </CardContent>
      </Card>

      {/* 任务等级路由 */}
      <Card>
        <CardHeader>
          <CardTitle>按任务等级选择模型</CardTitle>
          <CardDescription>留空表示跟随全局默认（{view.data.defaultProvider} / {view.data.defaultModel}）。effort 只对支持推理强度的模型生效。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-3">等级</th>
                  <th className="py-1 pr-3">厂商</th>
                  <th className="py-1 pr-3">模型</th>
                  <th className="py-1 pr-3">effort</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {view.roles.map(({ role, label, hint }) => {
                  const cfg = roleConfig(role);
                  const providerId = cfg.provider ?? "";
                  return (
                    <tr key={role} className="border-t">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{label}</div>
                        <div className="text-xs text-muted-foreground">{hint}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <select
                          className={selectClass}
                          value={providerId}
                          disabled={pending}
                          onChange={(e) => apply(saveRoleAction(role, e.target.value ? { provider: e.target.value, model: modelsFor(e.target.value)[0]?.id, effort: cfg.effort } : null))}
                        >
                          <option value="">跟随默认</option>
                          {view.providers.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2 pr-3">
                        <select
                          className={selectClass}
                          value={cfg.model ?? ""}
                          disabled={pending || !providerId}
                          onChange={(e) => apply(saveRoleAction(role, { provider: providerId, model: e.target.value, effort: cfg.effort }))}
                        >
                          <option value="">{providerId ? "请选择" : "—"}</option>
                          {modelsFor(providerId || undefined).map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name || m.id}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2 pr-3">
                        <select
                          className={selectClass}
                          value={cfg.effort ?? ""}
                          disabled={pending || !providerId}
                          onChange={(e) => apply(saveRoleAction(role, { provider: providerId, model: cfg.model, effort: e.target.value || undefined }))}
                        >
                          <option value="">默认</option>
                          {EFFORTS.map((ef) => (
                            <option key={ef} value={ef}>
                              {ef}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2">
                        {providerId ? (
                          <Button size="xs" variant="ghost" disabled={pending} onClick={() => apply(saveRoleAction(role, null))}>
                            清除
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* 行为 */}
      <Card>
        <CardHeader>
          <CardTitle>自动分析与写回</CardTitle>
          <CardDescription>在「邮箱管理」里为账号打开「AI 处理」后，新邮件拉取正文时会自动分类。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex items-center justify-between gap-4">
            <span>Gmail：把分类写成标签 AI/&lt;类别&gt;（手机上可见）</span>
            <Switch checked={view.data.writeBack.gmailLabels} disabled={pending} onCheckedChange={(v) => apply(saveBehaviorAction({ writeBack: { gmailLabels: Boolean(v), imapFolders: view.data.writeBack.imapFolders } }))} />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span>其它 IMAP：复制一份到 AI/&lt;类别&gt; 文件夹（默认关闭，避免打扰其它客户端）</span>
            <Switch checked={view.data.writeBack.imapFolders} disabled={pending} onCheckedChange={(v) => apply(saveBehaviorAction({ writeBack: { gmailLabels: view.data.writeBack.gmailLabels, imapFolders: Boolean(v) } }))} />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span>自动分析范围</span>
            <select className={selectClass} value={view.data.autoTriageScope} disabled={pending} onChange={(e) => apply(saveBehaviorAction({ autoTriageScope: e.target.value as "inbox" | "all" }))}>
              <option value="inbox">只分析收件箱</option>
              <option value="all">所有文件夹</option>
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <span>对已有邮件回填分析：最近</span>
            <Input type="number" className="w-24" value={backfillLimit} onChange={(e) => setBackfillLimit(Number(e.target.value) || 50)} />
            <span>封</span>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || accounts.length === 0}
              onClick={() =>
                start(async () => {
                  const r = await backfillTriageAction(null, backfillLimit);
                  if (r.ok) toast.success(`已加入队列：${r.data} 封`);
                  else toast.error(r.error);
                })
              }
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} 开始回填
            </Button>
            <span className="text-xs text-muted-foreground">
              账号：{accounts.map((a) => `${a.email}${a.aiEnabled ? "" : "（AI 未开启）"}`).join("、") || "无"}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* 用量 */}
      <Card>
        <CardHeader>
          <CardTitle>最近 30 天用量</CardTitle>
          <CardDescription>
            共 {usage.totalCalls} 次调用，估算 ${usage.totalCostUsd.toFixed(4)}；降级 {usage.fallbacks} 次。未知单价的模型按 0 计。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {usage.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有调用记录。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-3">等级</th>
                    <th className="py-1 pr-3">模型</th>
                    <th className="py-1 pr-3">调用</th>
                    <th className="py-1 pr-3">输入 / 输出 token</th>
                    <th className="py-1 pr-3">估算成本</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.rows.map((r) => (
                    <tr key={`${r.role}-${r.provider}-${r.model}`} className="border-t">
                      <td className="py-1.5 pr-3">{r.role}</td>
                      <td className="py-1.5 pr-3">
                        {r.provider} / {r.model}
                      </td>
                      <td className="py-1.5 pr-3">{r.calls}</td>
                      <td className="py-1.5 pr-3">
                        {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
                      </td>
                      <td className="py-1.5 pr-3">{r.priceKnown ? `$${r.costUsd.toFixed(4)}` : "未知单价"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function presetLabel(p: string): string {
  return p === "quality" ? "质量优先" : p === "balanced" ? "均衡" : p === "economy" ? "省钱" : "自定义";
}
