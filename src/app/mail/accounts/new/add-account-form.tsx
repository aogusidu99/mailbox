"use client";

import { CheckCircle2, ChevronDown, Loader2, XCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ConnectionTestResult } from "@/server/providers/types";
import { createAccountAction, testConnectionAction } from "../actions";

/** 传给客户端的预设信息（不含函数）。 */
export interface PresetOption {
  id: string;
  label: string;
  authType: "password" | "oauth2";
  help: string;
  domains: string[];
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  domainHosts?: Record<string, { imap: string; smtp: string }>;
}

function hostsFor(preset: PresetOption, email: string) {
  const domain = email.split("@")[1]?.toLowerCase();
  const override = domain ? preset.domainHosts?.[domain] : undefined;
  return {
    imapHost: override?.imap ?? preset.imap.host,
    imapPort: preset.imap.port,
    imapSecure: preset.imap.secure,
    smtpHost: override?.smtp ?? preset.smtp.host,
    smtpPort: preset.smtp.port,
    smtpSecure: preset.smtp.secure,
  };
}

export function AddAccountForm({ presets }: { presets: PresetOption[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [chosenPresetId, setChosenPresetId] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  /** 用户在高级设置里手动改过的主机字段（覆盖预设推导值） */
  const [hostOverrides, setHostOverrides] = useState<Partial<ReturnType<typeof hostsFor>>>({});
  const [syncWindowDays, setSyncWindowDays] = useState(30);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testing, startTest] = useTransition();
  const [saving, startSave] = useTransition();

  // 未手动选择服务商时，按邮箱域名自动识别
  const detectedPresetId = useMemo(() => {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return "custom";
    return presets.find((p) => p.domains.includes(domain))?.id ?? "custom";
  }, [email, presets]);
  const presetId = chosenPresetId ?? detectedPresetId;
  const preset = useMemo(() => presets.find((p) => p.id === presetId) ?? presets[presets.length - 1], [presets, presetId]);

  // 主机配置 = 预设推导值 + 用户覆盖
  const hosts = useMemo(() => ({ ...hostsFor(preset, email), ...hostOverrides }), [preset, email, hostOverrides]);
  const setHosts = (updater: (h: ReturnType<typeof hostsFor>) => ReturnType<typeof hostsFor>) => {
    setHostOverrides(updater(hosts));
  };

  const payload = () => ({
    email: email.trim(),
    password,
    presetId,
    displayName: displayName.trim() || undefined,
    ...hosts,
    syncWindowDays,
  });

  const onTest = () => {
    setTestResult(null);
    startTest(async () => {
      const r = await testConnectionAction(payload());
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setTestResult(r.data);
      if (r.data.imap.ok && r.data.smtp.ok) toast.success("连接成功");
    });
  };

  const onSave = () => {
    startSave(async () => {
      const r = await createAccountAction(payload());
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("邮箱已添加，正在开始同步");
      router.push("/mail");
      router.refresh();
    });
  };

  const oauthOnly = preset.authType === "oauth2";

  return (
    <div className="space-y-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">邮箱地址</FieldLabel>
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com / you@qq.com" autoFocus />
        </Field>

        <Field>
          <FieldLabel htmlFor="preset">邮箱服务商</FieldLabel>
          <select
            id="preset"
            value={presetId}
            onChange={(e) => {
              setChosenPresetId(e.target.value);
              setHostOverrides({});
            }}
            className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <FieldDescription className="whitespace-pre-line">{preset.help}</FieldDescription>
        </Field>

        {preset.id === "gmail" || preset.id === "outlook" ? (
          <div className="rounded-md border p-3 text-sm">
            <div className="font-medium">也可以用 OAuth 授权登录</div>
            <div className="text-xs text-muted-foreground">
              先在 <Link href="/mail/settings/oauth" className="underline">OAuth 设置</Link> 里填入 {preset.id === "gmail" ? "Google" : "Microsoft"} 应用凭据，然后
              <a className="ml-1 underline" href={`/api/oauth/${preset.id === "gmail" ? "google" : "microsoft"}/start${email ? `?login_hint=${encodeURIComponent(email)}` : ""}`}>
                点这里授权连接
              </a>
              。
            </div>
          </div>
        ) : null}
        {oauthOnly ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            {preset.label} 已停用密码登录，请使用上面的 OAuth 授权方式。
          </div>
        ) : (
          <Field>
            <FieldLabel htmlFor="password">授权码 / 应用专用密码</FieldLabel>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" placeholder="不是网页登录密码" />
            <FieldDescription>
              获取方法见上方说明；也可参考文档 <code>docs/PLAN.md</code> 附录 A。
            </FieldDescription>
          </Field>
        )}

        <Field>
          <FieldLabel htmlFor="displayName">显示名称（可选）</FieldLabel>
          <Input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="例如：工作邮箱" />
        </Field>

        <Field>
          <FieldLabel htmlFor="syncWindow">初次同步范围</FieldLabel>
          <select
            id="syncWindow"
            value={syncWindowDays}
            onChange={(e) => setSyncWindowDays(Number(e.target.value))}
            className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
          >
            <option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
            <option value={365}>最近 1 年</option>
          </select>
          <FieldDescription>更早的邮件可以之后在设置里回填。</FieldDescription>
        </Field>
      </FieldGroup>

      <div>
        <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronDown className={advanced ? "size-4 rotate-180 transition" : "size-4 transition"} /> 服务器高级设置
        </button>
        {advanced || preset.id === "custom" ? (
          <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="imapHost">IMAP 主机</FieldLabel>
              <Input id="imapHost" value={hosts.imapHost} onChange={(e) => setHosts((h) => ({ ...h, imapHost: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="imapPort">IMAP 端口</FieldLabel>
                <Input id="imapPort" type="number" value={hosts.imapPort} onChange={(e) => setHosts((h) => ({ ...h, imapPort: Number(e.target.value) }))} />
              </Field>
              <Field>
                <FieldLabel htmlFor="imapSecure">IMAP TLS</FieldLabel>
                <select
                  id="imapSecure"
                  value={hosts.imapSecure ? "1" : "0"}
                  onChange={(e) => setHosts((h) => ({ ...h, imapSecure: e.target.value === "1" }))}
                  className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
                >
                  <option value="1">SSL/TLS（993）</option>
                  <option value="0">STARTTLS（143）</option>
                </select>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="smtpHost">SMTP 主机</FieldLabel>
              <Input id="smtpHost" value={hosts.smtpHost} onChange={(e) => setHosts((h) => ({ ...h, smtpHost: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="smtpPort">SMTP 端口</FieldLabel>
                <Input id="smtpPort" type="number" value={hosts.smtpPort} onChange={(e) => setHosts((h) => ({ ...h, smtpPort: Number(e.target.value) }))} />
              </Field>
              <Field>
                <FieldLabel htmlFor="smtpSecure">SMTP TLS</FieldLabel>
                <select
                  id="smtpSecure"
                  value={hosts.smtpSecure ? "1" : "0"}
                  onChange={(e) => setHosts((h) => ({ ...h, smtpSecure: e.target.value === "1" }))}
                  className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
                >
                  <option value="1">SSL/TLS（465）</option>
                  <option value="0">STARTTLS（587）</option>
                </select>
              </Field>
            </div>
          </div>
        ) : null}
      </div>

      {testResult ? (
        <div className="space-y-1 rounded-md border p-3 text-sm">
          <ResultLine label="IMAP 收信" ok={testResult.imap.ok} detail={testResult.imap.ok ? `已找到 ${testResult.imap.folders ?? 0} 个文件夹` : testResult.imap.error} />
          <ResultLine label="SMTP 发信" ok={testResult.smtp.ok} detail={testResult.smtp.ok ? "登录成功" : testResult.smtp.error} />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onTest} disabled={testing || saving || oauthOnly || !email || !password}>
          {testing ? <Loader2 className="size-4 animate-spin" /> : null} 测试连接
        </Button>
        <Button onClick={onSave} disabled={saving || testing || oauthOnly || !email || !password}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null} 保存并开始同步
        </Button>
      </div>
    </div>
  );
}

function ResultLine({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-start gap-2">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 text-destructive" />}
      <div>
        <span className="font-medium">{label}</span>
        <span className="ml-2 text-muted-foreground">{detail}</span>
      </div>
    </div>
  );
}
