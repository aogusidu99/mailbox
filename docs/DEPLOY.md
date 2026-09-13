# 部署到阿里云（完整版 · Docker Compose + 预构建镜像 + Tailscale）

本应用要**单实例常驻运行**（IMAP IDLE 实时收信、进程内 worker 定时同步、SSE 推送），用一台**一直开机的虚拟机**跑 `docker compose`，不要用 Serverless / 抢占式实例。

> 这份文档按真实部署踩过的坑整理，照抄即可。核心经验：① 地域要选对（既连得上 Gmail 又用得了 AI）；② 用 GitHub Actions 预构建的镜像，服务器不构建（小内存也不会 OOM）；③ 提前配好 Docker DNS 和 Tailscale 的 `--accept-dns=false`，避免解析失败。

## 0. 地域怎么选（最关键）

| 地域 | Gmail | OpenAI/Anthropic/Gemini | 备案 |
|---|---|---|---|
| 中国大陆 | ❌ 被墙 | ❌ 被墙 | 需要 |
| 香港 | ✅ | ❌ 地域不支持 | 免 |
| **新加坡 / 东京 / 美国（海外）** | ✅ | ✅ | 免 |

**要邮箱和 AI 都能用 → 选新加坡（或东京/美国）。** 下面以新加坡为例，其它海外地域步骤相同。

其它前提：
- **必须 HTTPS**（登录用安全 Cookie、PWA 也要求）。本文用 Tailscale 自动 HTTPS，私有、免域名、免备案。
- **单实例**：只跑一份 `app` 容器（compose 已配 `restart: unless-stopped` 开机自启）。

## 1. 买 ECS

阿里云 ECS 或轻量应用服务器：
- **地域：新加坡**（或东京/美国等海外）
- **规格：2 核 2G 及以上**；系统盘 40G
- **系统：Ubuntu 24.04 64 位**
- 计费：包年包月（常驻最划算）；带宽选**按使用流量**；不要抢占式
- 登录凭证：自定义密码（用 root 登录）

## 2. 安全组 / 防火墙

入方向**只放行 22（SSH）**。用 Tailscale 不需要开别的端口；**不要**开放 3000、5432。建议把 22 来源限制成你的 IP。

## 3. 连接服务器

```bash
ssh root@你的公网IP
```
首次问 yes/no 输 `yes`，再输密码（不显示是正常的）。**确认提示符是 `root@...:~#` 再往下贴命令**（否则命令跑进了本机 PowerShell，会报 `&&` 错）。

## 4. 装 Docker + 配 DNS + swap

整段粘贴（root）：
```bash
# 1) 装 Docker
curl -fsSL https://get.docker.com | sh

# 2) 给 Docker 配 DNS（关键！否则容器可能解析不了 imap.qq.com / api.openai.com 等）
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{ "dns": ["223.5.5.5", "8.8.8.8"] }
EOF
systemctl restart docker

# 3) 2G swap（保险；用预构建镜像不构建，2G 也够）
[ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile; }
swapon /swapfile 2>/dev/null
grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

docker --version && docker compose version && free -h | grep -i Swap
```

## 5. 拿代码（仓库已公开）

```bash
cd ~ && git clone https://github.com/aogusidu99/mailbox.git
cd ~/mailbox
```

## 6. 生成密钥 + 写配置

把 `NEWUSER` / `NEWPASS` 换成你想要的登录**用户名/密码**（可用邮箱也可用普通用户名），整段粘贴：
```bash
cd ~/mailbox
NEWUSER='aogusidu99'
NEWPASS='031083'
printf 'AUTH_SECRET=%s\nAPP_MASTER_KEY=%s\nADMIN_EMAIL=%s\nADMIN_PASSWORD=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$NEWUSER" "$NEWPASS" > .env.docker
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 16)" > .env
echo "登录用户名: $NEWUSER / 密码: $NEWPASS"
grep -E 'ADMIN_EMAIL|ADMIN_PASSWORD' .env.docker
```
> `APP_MASTER_KEY` 是邮箱凭据加密主密钥，**务必保存、别丢**（换了它已保存的邮箱要重加）。

## 7. 拉预构建镜像并启动（不构建！）

```bash
docker compose -f docker-compose.yml -f docker-compose.image.yml up -d --pull always --no-build
# 等 ~20 秒验证
sleep 20 && docker compose -f docker-compose.yml -f docker-compose.image.yml ps
curl -s http://localhost:3000/api/health
```
看到 db、app 都 `Up`、`{"ok":true,...}` 即成功。因为不在服务器构建，几十秒完成、不会 OOM。

## 8. Tailscale（自动 HTTPS，手机/电脑可访问）

```bash
# 装 + 登录
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up            # 打印一个链接，复制到浏览器用你的账号授权这台机器

# 授权后立刻关掉 Tailscale 接管 DNS（否则服务器解析会坏，签证书会超时）
tailscale set --accept-dns=false

# 签发 HTTPS 证书 + 后台反代到 3000
tailscale cert "$(tailscale status --json | grep -oE '[a-z0-9-]+\.[a-z0-9-]+\.ts\.net' | head -1)" || true
tailscale serve --bg 3000
tailscale serve status   # 显示 https://<机器名>.<tailnet>.ts.net —— 这就是访问地址
```
- 首次用 Tailscale HTTPS 需在后台启用一次（若之前启用过则跳过）：https://login.tailscale.com/admin/dns → 「HTTPS Certificates」→ Enable HTTPS。
- 想让网址好记：Tailscale 后台 Machines → 这台机器 → 改名（如 `mailbox`）。
- **手机/电脑装 Tailscale、登录同一账号**，才能打开这个 `*.ts.net` 网址（这是它的私有安全性）。

## 9. 登录使用

浏览器打开第 8 步的 `https://<机器名>.ts.net` → 用第 6 步的**用户名 + 密码**登录。

## 10. 配置 AI（按地域选厂商）

设置（齿轮）→ AI 设置 → 选厂商 → 填 API Key → 刷新模型 → 设默认 → 测试连接。
- **海外地域（新加坡等）**：可用 **OpenAI / Anthropic(Claude) / Google Gemini**（都需各自的 Key，海外地域不被地域限制）。
- **国产、任何地域都能用**：**DeepSeek**（platform.deepseek.com 拿 Key，便宜）；**阿里百炼/Qwen**（OpenAI 兼容端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`，带 embedding 可做语义搜索）。
- 用了「一键预设」会把各等级指到 Claude；若你不用 Claude，记得在「按任务等级选择模型」里改成你的厂商或清空（=跟随默认）。

## 11. 添加邮箱

「添加邮箱」→ 密码栏填**授权码 / 应用专用密码**（不是网页登录密码）：
- **Gmail**：先开两步验证 → https://myaccount.google.com/apppasswords 生成 16 位应用专用密码（去空格）。
- **QQ**：mail.qq.com → 设置 → 账号 → 开 IMAP/SMTP → 生成授权码（16 位）。
- **163/126**：设置 → POP3/SMTP/IMAP → 开启 → 授权密码。

## 12. 以后更新（不再在服务器构建）

改动 push 到 main → GitHub Actions 自动构建镜像（Actions 页面变绿，约 3–5 分钟）→ 服务器拉新镜像重启：
```bash
cd ~/mailbox && git pull && docker compose -f docker-compose.yml -f docker-compose.image.yml up -d --pull always --no-build && docker image prune -f
```
（本地也可用项目根目录的 `update-server.bat` 双击一键更新，或服务器上的 `~/update-mailbox.sh`。）

## 13. 维护

```bash
# 备份数据库
cd ~/mailbox && docker compose exec -T db pg_dump -U mailbox mailbox | gzip > ~/backup-$(date +%F).sql.gz
# 看日志 / 状态
docker compose -f docker-compose.yml -f docker-compose.image.yml logs -f app
docker compose -f docker-compose.yml -f docker-compose.image.yml ps
```
数据卷 `pgdata`（邮件缓存/AI 标注/设置/对话/摘要）、`appdata`（附件缓存）随更新保留。**换服务器时邮件会从邮箱服务器重新同步**，只需重新添加邮箱、重填 AI Key（AI 设置/规则不迁移；要迁就用 pg_dump 导出再导入）。

## 14. 常见问题（都是实测踩过的）

- **AI 报 `User location is not supported` / OpenAI 报国家不支持**：地域不对。香港/大陆用不了 Western AI，换新加坡等海外地域；或改用 DeepSeek/百炼。
- **加邮箱报 `getaddrinfo EAI_AGAIN`**：容器 DNS 没配好。做第 4 步的 `daemon.json` 并 `systemctl restart docker`，再 `docker compose ... up -d --force-recreate`。
- **Tailscale `tailscale cert` 报 `lookup ... i/o timeout`**：Tailscale 接管了服务器 DNS。跑 `tailscale set --accept-dns=false`；仍不行临时 `echo "nameserver 223.5.5.5" > /etc/resolv.conf` 再签。
- **网址 `ERR_SSL_PROTOCOL_ERROR`**：HTTPS 证书没就绪。后台启用 HTTPS（§8）+ `tailscale cert`，用装了 Tailscale 的设备打开。
- **网址打不开**：打开它的设备没装/没登录同一个 Tailscale 账号。
- **登录报错**：用户名/密码看 `.env.docker`（系统每次启动会按它校准）：`grep ADMIN ~/mailbox/.env.docker`。
- **SSH `Connection reset`**：机器过载（一般是在服务器本地构建 OOM）。改用预构建镜像（§7）就不会。控制台重启实例即可恢复。
- **Gmail 同步超时**：地域不对（大陆连不上 Gmail），换海外地域。
- **`git clone` 要账号密码**：仓库应为 Public（Settings → Danger Zone → 公开）。
