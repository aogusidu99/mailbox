import { z } from "zod";

/**
 * 服务端环境变量定义与校验。
 *
 * - 只在服务端使用（不要在客户端组件里 import）。
 * - 采用惰性读取：`next build` 阶段不会因为缺少变量而失败，
 *   只有真正调用 getEnv() 时才校验并抛出可读的错误。
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /** 生产库连接串；留空则使用嵌入式 PGlite（零安装）。 */
  DATABASE_URL: z.string().min(1).optional(),
  /** PGlite 数据目录（仅在 DATABASE_URL 为空时生效）。 */
  PGLITE_DATA_DIR: z.string().min(1).default("./data/pglite"),

  /** Auth.js 会话签名密钥。 */
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET 至少 16 个字符"),
  /** 邮箱凭据加密主密钥（建议 32 字节 base64/hex；任意 ≥32 字符的口令也可，将做 SHA-256 派生）。 */
  APP_MASTER_KEY: z.string().min(32, "APP_MASTER_KEY 至少 32 个字符"),

  /** 单用户模式：登录用户名（可填邮箱，也可填普通用户名如 aogusidu99），启动时据此种子生成管理员。 */
  ADMIN_EMAIL: z.string().min(1, "ADMIN_EMAIL 不能为空"),
  ADMIN_PASSWORD: z.string().min(1, "ADMIN_PASSWORD 不能为空"),

  /** Anthropic API Key（可选）：只作为首次启动的种子，正式以设置页保存的加密 Key 为准。 */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  /** 对外访问地址（OAuth 回调用），不填则按请求的 origin 推断，例如 https://mail.example.com */
  APP_BASE_URL: z.string().url().optional(),

  /** 是否在本进程内启动后台 worker（同步/AI 任务）。 */
  WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** 读取并校验环境变量（首次调用后缓存）。 */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `环境变量校验失败，请检查 .env.local（可运行 \`bun run setup\` 生成）：\n${issues}`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** 仅测试用：重置缓存，便于用不同的 process.env 重新校验。 */
export function resetEnvCache(): void {
  cached = undefined;
}
