import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 这些包依赖 Node 原生能力（WASM / net / fs），不打进服务端 bundle
  serverExternalPackages: ["@electric-sql/pglite", "pg", "pg-boss", "imapflow", "nodemailer", "mailparser"],
  // Docker 镜像用 standalone 输出（本地开发/构建保持默认）
  output: process.env.DOCKER_BUILD ? "standalone" : undefined,
};

export default nextConfig;
