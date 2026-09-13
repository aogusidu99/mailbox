# ---- 构建阶段 ----
FROM node:24-bookworm-slim AS builder
WORKDIR /app
RUN npm install -g bun@1.3.11
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
ENV DOCKER_BUILD=1 NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# ---- 运行阶段 ----
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# standalone 输出 + 静态资源 + 运行时需要从磁盘读取的迁移文件
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle
# 附件缓存 / 上传 / PGlite 数据（生产建议用 PostgreSQL）
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server.js"]
