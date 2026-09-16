import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 这些包依赖 Node 原生能力（WASM / net / fs），不打进服务端 bundle
  serverExternalPackages: ["@electric-sql/pglite", "pg", "pg-boss", "imapflow", "nodemailer", "mailparser"],
  // Docker 镜像用 standalone 输出（本地开发/构建保持默认）
  output: process.env.DOCKER_BUILD ? "standalone" : undefined,
  experimental: {
    // 客户端路由缓存（Router Cache）：Next 15+ 默认 dynamic=0（不缓存），导致每次切页都要
    // 重新在服务端跑一遍（日历/任务/摘要都要打 Google / AI，慢）。这里给动态页 30s、静态页 180s
    // 的本地缓存窗口——刚打开过的页面切回时直接用缓存的 RSC 秒开，不再每次重新请求。
    staleTimes: { dynamic: 30, static: 180 },
  },
};

export default nextConfig;
