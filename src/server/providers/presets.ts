/**
 * 常见邮箱服务商预设：用户只需填写邮箱地址和授权码。
 */
export type PresetId = "gmail" | "qq" | "163" | "outlook" | "icloud" | "custom";

export interface ProviderPreset {
  id: PresetId;
  label: string;
  provider: "imap" | "gmail" | "outlook";
  authType: "password" | "oauth2";
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** 是否需要向 IMAP 服务器发送 ID 命令（163 必需，否则报 Unsafe Login） */
  sendImapId?: boolean;
  /** 给用户看的接入说明 */
  help: string;
  /** 根据邮箱域名自动匹配 */
  domains: string[];
  /** 同一预设下按域名覆盖主机（如 126.com 用 imap.126.com） */
  domainHosts?: Record<string, { imap: string; smtp: string }>;
  /** SMTP 发送后服务器是否自动保存到「已发送」（否则由客户端 APPEND 一份） */
  serverSavesSent: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "gmail",
    label: "Gmail",
    provider: "gmail",
    authType: "password",
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    help: "密码栏填「应用专用密码」而非 Google 登录密码：先在 myaccount.google.com/security 开启两步验证，再到 myaccount.google.com/apppasswords 创建一个 16 位密码（可去掉空格）。",
    domains: ["gmail.com", "googlemail.com"],
    serverSavesSent: true,
  },
  {
    id: "qq",
    label: "QQ 邮箱",
    provider: "imap",
    authType: "password",
    imap: { host: "imap.qq.com", port: 993, secure: true },
    smtp: { host: "smtp.qq.com", port: 465, secure: true },
    help: "密码栏填「授权码」而非 QQ 密码：网页版 mail.qq.com →「设置 → 账号」（新版为「账号与安全 → 安全设置」）→「POP3/IMAP/SMTP 服务」开启 IMAP/SMTP →「生成授权码」，短信验证后得到 16 位授权码。",
    domains: ["qq.com", "foxmail.com"],
    serverSavesSent: true,
  },
  {
    id: "163",
    label: "163 / 126 邮箱",
    provider: "imap",
    authType: "password",
    imap: { host: "imap.163.com", port: 993, secure: true },
    smtp: { host: "smtp.163.com", port: 465, secure: true },
    sendImapId: true,
    help: "密码栏填「授权密码」而非登录密码：网页版 mail.163.com →「设置 → POP3/SMTP/IMAP」→ 开启 IMAP/SMTP 服务，扫码或短信验证后页面显示 16 位授权密码（只显示一次）。126 邮箱主机为 imap.126.com / smtp.126.com。",
    domains: ["163.com", "126.com", "yeah.net"],
    domainHosts: {
      "126.com": { imap: "imap.126.com", smtp: "smtp.126.com" },
      "yeah.net": { imap: "imap.yeah.net", smtp: "smtp.yeah.net" },
    },
    serverSavesSent: true,
  },
  {
    id: "icloud",
    label: "iCloud",
    provider: "imap",
    authType: "password",
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    help: "在 Apple ID 账户页生成「App 专用密码」。",
    domains: ["icloud.com", "me.com", "mac.com"],
    serverSavesSent: false,
  },
  {
    id: "outlook",
    label: "Outlook / Microsoft 365",
    provider: "outlook",
    authType: "oauth2",
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp.office365.com", port: 587, secure: false },
    help: "微软已停用 IMAP 基础认证，需要 OAuth 授权（M5 支持）。",
    domains: ["outlook.com", "hotmail.com", "live.com", "office365.com"],
    serverSavesSent: true,
  },
  {
    id: "custom",
    label: "自定义 IMAP/SMTP",
    provider: "imap",
    authType: "password",
    imap: { host: "", port: 993, secure: true },
    smtp: { host: "", port: 465, secure: true },
    help: "手动填写 IMAP 与 SMTP 主机、端口。",
    domains: [],
    serverSavesSent: false,
  },
];

/** 按邮箱域名解析实际主机（处理 126.com 这类同预设不同主机的情况）。 */
export function resolvePresetHosts(preset: ProviderPreset, email: string): Pick<ProviderPreset, "imap" | "smtp"> {
  const domain = email.split("@")[1]?.toLowerCase();
  const override = domain ? preset.domainHosts?.[domain] : undefined;
  if (!override) return { imap: preset.imap, smtp: preset.smtp };
  return {
    imap: { ...preset.imap, host: override.imap },
    smtp: { ...preset.smtp, host: override.smtp },
  };
}

export function findPresetByEmail(email: string): ProviderPreset | undefined {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return undefined;
  return PROVIDER_PRESETS.find((p) => p.domains.includes(domain));
}

export function getPreset(id: PresetId): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`未知的邮箱预设: ${id}`);
  return preset;
}
