/**
 * Next.js instrumentation：服务实例启动时执行一次。
 * 只在 Node.js 运行时引导数据库与后台 worker（Edge 运行时不支持这些依赖）。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrap } = await import("./server/bootstrap");
    await bootstrap();
  }
}
