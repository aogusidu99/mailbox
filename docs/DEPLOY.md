# 部署到阿里云（Docker Compose）

本应用要**单实例常驻运行**（IMAP IDLE 长连接实时收信、进程内 worker 定时同步、SSE 推送），所以用一台**一直开机的虚拟机**跑 `docker compose`，不要用 Serverless / 弹性伸缩。

## 0. 关键前提（务必先读）

- **地域选香港**：你的邮箱里有 Gmail，**阿里云中国大陆地域连不上 Gmail**（`imap.gmail.com` 被墙，同步会超时失败）。用**阿里云香港地域**：海外网络能连 Gmail，QQ/163/Outlook 也都正常，而且**香港服务器免 ICP 备案**（大陆地域用域名开 80/443 需要备案）。
- **必须 HTTPS**：登录用的是安全 Cookie，PWA 也要求 HTTPS，别用「裸 IP + http」。下面给了两种拿 HTTPS 的方式。
- **单实例**：只跑一份 `app` 容器（compose 已配 `restart: unless-stopped` 开机自启）。

## 1. 买什么

推荐 **阿里云「轻量应用服务器」· 香港地域 · 2GB 内存及以上 · Ubuntu 22.04/24.04**（轻量最便宜，自带公网 IP、自带防火墙面板）。
- 内存：**至少 2GB**。构建 Next 应用会短时吃内存，1GB 容易 OOM（第 3 步会加 swap 兜底）。
- 系统盘：40GB 够用。
- 也可以用 ECS，但要自己配安全组；步骤一样。

## 2. 装 Docker

SSH 登录服务器后（Ubuntu）：

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # 重新登录一次让分组生效
docker version && docker compose version
```

内存只有 2GB 时，先加 2GB swap，避免构建时被 OOM 杀掉：

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. 拿代码

```bash
git clone https://github.com/aogusidu99/mailbox.git
cd mailbox
```

## 4. 配置环境变量

**（a）应用密钥**：复制模板并填写。

```bash
cp .env.docker.example .env.docker
```

编辑 `.env.docker`：

```ini
AUTH_SECRET=<粘贴一段长随机串>          # openssl rand -base64 48
APP_MASTER_KEY=<粘贴 64 位十六进制>      # openssl rand -hex 32   ← 邮箱凭据加密主密钥，务必保存好，换了会解不开旧凭据
ADMIN_EMAIL=you@example.com             # 你的登录邮箱（随意，仅用于登录本系统）
ADMIN_PASSWORD=<一个强密码>
APP_BASE_URL=https://mail.你的域名      # 见第 6 步；用 Tailscale 则填 https://<机器名>.<tailnet>.ts.net
```

生成随机值：

```bash
echo "AUTH_SECRET=$(openssl rand -base64 48)"; echo "APP_MASTER_KEY=$(openssl rand -hex 32)"
```

**（b）Compose 变量**：新建 `.env`（`docker compose` 会自动读取，用于数据库密码与域名）。

```bash
cat > .env <<'EOF'
POSTGRES_PASSWORD=<一个数据库密码>
APP_DOMAIN=mail.你的域名
EOF
```

> `POSTGRES_PASSWORD` 要放在 `.env`（compose 变量），不是 `.env.docker`；`APP_DOMAIN` 仅在用 Caddy（方式 B）时需要。

## 5. 启动

```bash
docker compose up -d --build
docker compose logs -f app        # 看到「worker 已启动」「已连接」即正常，Ctrl+C 退出日志
curl -s http://localhost:3000/api/health   # {"ok":true,...}
```

此时应用在服务器本机 `3000` 端口。**先别急着开放 3000 到公网**，按第 6 步套 HTTPS。

## 6. 加 HTTPS（二选一）

### 方式 A：Tailscale（推荐自用，私有、免域名、免备案、不开公网端口）

在**服务器**和你要访问的**手机 / 电脑**上都装 Tailscale 并登录同一账号：

```bash
# 服务器上：
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 3000        # 用 Tailscale 的证书对外提供 https，反代到本机 3000
tailscale serve status                # 显示形如 https://<机器名>.<tailnet>.ts.net
```

把上面显示的 `https://<机器名>.<tailnet>.ts.net` 填回 `.env.docker` 的 `APP_BASE_URL`，`docker compose up -d` 重启一次。之后手机/电脑（已登录 Tailscale）浏览器直接打开这个地址即可。**安全组只放行 22（SSH）**，其它都不用开。

### 方式 B：域名 + Caddy（想在任何网络/设备直接打开，可分享）

前提：有一个域名，把一条 **A 记录**（如 `mail.你的域名`）解析到**服务器公网 IP**。确认 `.env` 里 `APP_DOMAIN=mail.你的域名`，然后：

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build
```

Caddy 会自动为该域名申请并续期 Let's Encrypt 证书。**安全组放行 80、443、22**（80 用于证书校验），**不要放行 3000**。浏览器打开 `https://mail.你的域名`。

## 7. 安全组 / 防火墙端口

在阿里云控制台（轻量：「防火墙」；ECS：「安全组」）放行：

| 方式 | 放行入方向端口 |
|---|---|
| A · Tailscale | 只放 **22**（SSH） |
| B · 域名 + Caddy | **80、443、22** |

任何情况下都**不要**把 **3000**、**5432**（Postgres）开放到公网。建议把 22 的来源限制为你的 IP。

## 8. 首次使用

浏览器打开你的地址 → 用 `.env.docker` 里的 `ADMIN_EMAIL / ADMIN_PASSWORD` 登录 → 「添加邮箱」。QQ/163/Gmail 用**授权码 / 应用专用密码**（见 `docs/GETTING-STARTED.md` 与 `PLAN.md` 附录 A），不需要在服务器上做别的配置。

> 若要用 **Gmail / Outlook 的 OAuth 授权登录**（而不是应用专用密码），需在 Google Cloud / Azure 的应用里把**回调地址**加成 `${APP_BASE_URL}/api/oauth/google/callback`、`${APP_BASE_URL}/api/oauth/microsoft/callback`，并确保 `APP_BASE_URL` 填的是你的公开地址。

## 9. 维护

```bash
# 备份数据库（导出到 backups/）
docker compose exec -T db pg_dump -U mailbox mailbox | gzip > backup-$(date +%F).sql.gz

# 升级：拉新代码后重建
git pull && docker compose up -d --build     # 用了 Caddy 就带上 -f docker-compose.caddy.yml

# 数据卷：pgdata（邮件缓存/AI 标注/设置）、appdata（附件缓存/上传），随容器重建保留
```

## 10. 常见问题

- **Gmail 一直「同步出错 / 超时」**：多半是把服务器建在了大陆地域。换香港地域（或其它海外地域）重建。
- **构建时卡死 / 被杀**：内存不足，按第 2 步加 swap，或换 2GB 以上机型。
- **打不开、证书报错**：方式 B 要确认 A 记录已生效（`ping mail.你的域名` 指向服务器 IP）、安全组放行了 80/443；方式 A 确认手机也登录了同一个 Tailscale 账号。
- **忘了 `APP_MASTER_KEY`**：换了 key 之后已保存的邮箱凭据无法解密，需要在「邮箱管理」里删除后重新添加邮箱。请妥善保存这个 key。
