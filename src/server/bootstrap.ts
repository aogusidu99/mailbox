import { getDbHandle } from "@/db";
import { getEnv } from "@/env";
import { seedAdminUser } from "./auth/seed-admin";
import { startWorker, stopWorker } from "./jobs/worker";

/**
 * 服务启动引导（由 src/instrumentation.ts 调用，仅 Node 运行时）：
 * 1. 校验环境变量
 * 2. 初始化数据库并应用迁移
 * 3. 种子管理员账号
 * 4. 启动后台 worker
 */
export async function bootstrap(): Promise<void> {
  const env = getEnv();
  const handle = await getDbHandle();
  console.log(`[db] 已连接 ${handle.kind === "pglite" ? `PGlite (${env.PGLITE_DATA_DIR})` : "PostgreSQL"}`);

  await seedAdminUser();

  if (env.WORKER_ENABLED) {
    await startWorker();
  } else {
    console.log("[jobs] WORKER_ENABLED=false，跳过 worker 启动");
  }

  registerShutdownHooks();
}

let hooksRegistered = false;
function registerShutdownHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const shutdown = async (signal: string) => {
    console.log(`[app] 收到 ${signal}，正在关闭…`);
    try {
      await stopWorker();
      const handle = await getDbHandle();
      await handle.close();
    } catch (err) {
      console.error("[app] 关闭时出错:", err);
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
