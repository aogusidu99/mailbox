# 部署到阿里云（Docker Compose）

本应用要**单实例常驻运行**（IMAP IDLE 长连接实时收信、进程内 worker 定时同步、SSE 推送），所以用一台**一直开机的虚拟机**跑 `docker compose`，不要用 Serverless / 弹性伸缩 / 抢占式实例。

> 这份文档是按真实部署踩过的坑整理的：小内存机器构建容易卡死/把 SSH 拖挂，所以**构建一律放到后台跑**（见第 6 步），别在前台 SSH 会话里等——SSH 一断构建就被杀。

## 流程速览

1. 买香港地域、≥2G 内存的机器（§1）
2. SSH 连上（§2）
3. 装 Docker + 配 4G swap（§3）
4. 把 GitHub 仓库设为公开（或配部署密钥）（§4）
5. 拉代码 + 生成密钥 + 写配置（§5）
6. **后台**构建并启动（§6）
7. 配 HTTPS：Tailscale 或 域名+Caddy（§7）
8. 开放安全组端口（§8）→ 登录使用（§9）

---

## 0. 关键前提（务必先读）

- **地域选香港**：邮箱里有 Gmail 的话，**阿里云中国大陆地域连不上 Gmail**（`imap.gmail.com` 被墙，同步一直超时失败）。用**香港地域**：海外网络能连 Gmail，QQ/163/Outlook 也都正常，而且**香港服务器免 ICP 备案**（大陆地域用域名开 80/443 要备案）。
- **必须 HTTPS**：登录用安全 Cookie、PWA 也要求 HTTPS，别用「裸 IP + http」。第 7 步给了两种拿 HTTPS 的方式。
- **单实例**：只跑一份 `app` 容器（compose 已配 `restart: unless-stopped` 开机自启）。
- **内存**：≥2G。**2G 能跑起来，但构建 Next 很吃内存**——必须配 4G swap 并把构建放后台（§3、§6）；嫌慢可临时把实例升配到 4G 构建一次再降回（§11）。

## 1. 买什么

**阿里云 · 香港地域 · 2 核 2G 及以上 · Ubuntu 22.04/24.04**。
- 轻量应用服务器（最便宜、自带公网 IP 和防火墙面板）或 ECS 都行；本文命令通用。
- 系统盘 20–40G 够用。
- 计费：**包年包月**（常驻最划算）；带宽选**按使用流量**（邮箱流量小）；**不要用抢占式**（会被自动释放，数据丢）。
- 登录凭证用自定义密码或密钥对都行；用密码记得在安全组把 22 端口来源限制成你的 IP。

## 2. 连接服务器

用任意终端 SSH 登录（把 IP 换成你的公网 IP）：

```bash
ssh root@你的公网IP
```

- 首次问 `yes/no` 输 `yes`，再输服务器密码（输入时不显示是正常的）。
- **确认提示符已经变成 `root@...:~#` 再往下贴命令。** 如果贴 bash 命令时报 `&&/|| 不是有效语句分隔符`，说明你没连上、命令跑到了本机 Windows PowerShell 里——先把 SSH 连上。
- 建议**固定用同一个终端窗口**操作，别开一堆窗口来回切。

## 3. 装 Docker + 配 4G swap

登录后整段粘贴（Ubuntu，root）：

```bash
# 装 Docker（官方脚本，自动适配 Ubuntu）
curl -fsSL https://get.docker.com | sh

# 配 4G swap（2G 内存构建必备，避免 OOM 把机器/SSH 拖挂）
[ -f /swapfile ]  || { fallocate -l 2G /swapfile  && chmod 600 /swapfile  && mkswap /swapfile;  }
[ -f /swapfile2 ] || { fallocate -l 2G /swapfile2 && chmod 600 /swapfile2 && mkswap /swapfile2; }
swapon /swapfile 2>/dev/null; swapon /swapfile2 2>/dev/null
grep -q /swapfile  /etc/fstab || echo '/swapfile none swap sw 0 0'  >> /etc/fstab
grep -q /swapfile2 /etc/fstab || echo '/swapfile2 none swap sw 0 0' >> /etc/fstab

# 验证
docker --version && docker compose version && free -h | grep -i Swap
```

看到 Docker 版本号、`Swap` 那行约 `4.0Gi` 即可。

## 4. 让服务器能拿到代码

仓库默认是**私有**的，服务器 `git clone` 会要认证。二选一：

- **A. 设为公开（最简单）**：GitHub 打开 `aogusidu99/mailbox` → Settings → 底部 Danger Zone → Change visibility → **Public**。代码里**没有任何密钥**（`.env*` 都被 gitignore），公开的只是源码。
- **B. 保持私有 + 部署密钥**：服务器上
  ```bash
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
  cat ~/.ssh/id_ed25519.pub    # 复制这行
  ```
  把公钥加到 GitHub 仓库 → Settings → Deploy keys（只读即可），之后用 SSH 方式 clone：
  `git clone git@github.com:aogusidu99/mailbox.git`。

## 5. 拉代码 + 生成密钥 + 写配置

整段粘贴（会随机生成密钥、写好两个配置文件，并**打印一次管理员登录信息——务必记下来**）：

```bash
cd ~ && git clone https://github.com/aogusidu99/mailbox.git 2>/dev/null || (cd ~/mailbox && git pull)
cd ~/mailbox
cat > /tmp/mk-env.sh <<'SCRIPT'
#!/usr/bin/env bash
set -e
cd ~/mailbox
AUTH_SECRET=$(openssl rand -hex 32)
APP_MASTER_KEY=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -hex 12)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
printf 'AUTH_SECRET=%s\nAPP_MASTER_KEY=%s\nADMIN_EMAIL=admin@mailbox.local\nADMIN_PASSWORD=%s\n' \
  "$AUTH_SECRET" "$APP_MASTER_KEY" "$ADMIN_PASSWORD" > .env.docker
printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD" > .env
echo "==================== 登录信息（务必记下）===================="
echo "登录邮箱: admin@mailbox.local"
echo "登录密码: $ADMIN_PASSWORD"
echo "============================================================"
SCRIPT
bash /tmp/mk-env.sh
```

说明：
- `AUTH_SECRET`（会话签名）、`APP_MASTER_KEY`（**邮箱凭据加密主密钥**）只在服务器本地生成、写进 `.env.docker`，不外传。**`APP_MASTER_KEY` 千万别丢**——换了它，已保存的邮箱凭据就解不开了。
- `POSTGRES_PASSWORD` 写进 `.env`（`docker compose` 的变量插值文件），不是 `.env.docker`。
- 想改登录邮箱/密码，编辑 `.env.docker` 的 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 即可（改完在 §6 重启生效）。
- 用 Tailscale 时 `APP_BASE_URL` 可不填；只有走 Gmail/Outlook 的 OAuth 授权登录才需要把它填成你的公开地址。

## 6. 启动应用（两种方式）

小内存机器（2G）在本机构建 Next 很容易被 OOM 杀掉。**推荐用方式 A：拉 CI 预构建好的镜像，服务器不构建。**

### 方式 A ⭐ 用 GitHub Actions 预构建的镜像（推荐，小机器首选）

原理：`.github/workflows/docker-image.yml` 会在 push 到 main 时，由 GitHub 的服务器（内存充足、免费）构建镜像并推到 GHCR；你的服务器只 `docker pull`。

一次性准备：
1. push 代码到 GitHub（CI 会自动跑，约 3–5 分钟构建完）。在仓库 **Actions** 页面能看到 “Build and push Docker image” 变绿。
2. 把镜像包设为公开（这样服务器免登录就能拉）：GitHub → 你的头像 → **Packages** → `mailbox` → Package settings → Change visibility → **Public**。

服务器上启动 / 更新（不构建，几十秒）：
```bash
cd ~/mailbox && git pull
docker compose -f docker-compose.yml -f docker-compose.image.yml up -d --pull always --no-build
```
以后每次更新都用这条：CI 出新镜像后，服务器 `--pull always` 拉最新的重启即可。

### 方式 B 在服务器本地构建（内存 ≥4G 或已加够 swap 时）

**别在前台等构建**——用 `nohup` 丢到后台，SSH 断了也不会中断，还能扛过内存高峰：

```bash
cd ~/mailbox
nohup docker compose up -d --build > ~/build.log 2>&1 &
echo "构建已在后台启动（PID=$!）。日志在 ~/build.log"
```

**看进度**（随时可跑，退出不影响构建）：

```bash
tail -f ~/build.log        # 实时滚动，Ctrl+C 退出看日志（构建继续）
```

一条命令看总状态：

```bash
cd ~/mailbox && echo "=== 容器 ===" && docker compose ps && echo "=== 日志末尾 ===" && tail -n 15 ~/build.log && echo "=== 健康 ===" && (curl -s localhost:3000/api/health || echo "应用还没起来")
```

判断：
- **成功**：`docker compose ps` 里 **db 和 app 两个都 Up**，`curl` 返回 `{"ok":true,...}`。
- **还在构建**：日志在动（`bun run build` / `Creating an optimized production build` 最久）；2G 内存走 swap 会**慢，10–20 分钟属正常**。
- **失败（内存不足）**：日志里出现 `Killed` / `out of memory`，或 SSH 开始 `Connection reset`（机器被拖挂）→ 见 §11 先重启，再考虑临时升配 4G。

应用此时监听在服务器本机 `3000` 端口。**先别把 3000 开到公网**，按 §7 套 HTTPS。

## 7. 加 HTTPS（二选一）

### 方式 A：Tailscale（推荐自用，私有、免域名、免备案、不开公网端口）

```bash
# 服务器上
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up                     # 会打印一个登录链接
```

复制打印出来的链接**到浏览器打开、用你的 Tailscale 账号（可用 Google/GitHub 登录，免费）授权**这台机器加入你的网络。授权后：

```bash
tailscale serve --bg 3000        # 用 Tailscale 证书对外提供 https，反代到本机 3000
tailscale serve status           # 显示形如 https://<机器名>.<tailnet>.ts.net
```

把显示的 `https://<机器名>.<tailnet>.ts.net` 记下（如需 OAuth 再填进 `.env.docker` 的 `APP_BASE_URL` 并 `docker compose up -d` 重启）。**手机/电脑装上 Tailscale、登录同一账号**，浏览器打开这个地址即可访问。安全组**只放 22**。

### 方式 B：域名 + Caddy（任意网络直接打开、可分享、可装 PWA）

前提：有域名，一条 **A 记录**（如 `mail.你的域名`）解析到服务器公网 IP。在 `.env` 里加 `APP_DOMAIN=mail.你的域名`，然后：

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build
```

Caddy 自动申请/续期 Let's Encrypt 证书。安全组放行 **80、443、22**（80 用于证书校验）。浏览器打开 `https://mail.你的域名`。

## 8. 安全组 / 防火墙端口

阿里云控制台（轻量：「防火墙」；ECS：「安全组」）放行入方向：

| 方式 | 放行端口 |
|---|---|
| A · Tailscale | 只放 **22**（SSH） |
| B · 域名 + Caddy | **80、443、22** |

任何情况都**不要**把 **3000**、**5432**（Postgres）开放到公网。建议把 22 的来源限制为你的 IP。

## 9. 首次使用

浏览器打开你的地址 → 用 §5 打印的 `admin@mailbox.local` + 登录密码登录 → 「添加邮箱」。QQ/163/Gmail 用**授权码 / 应用专用密码**（见 `docs/GETTING-STARTED.md` 与 `PLAN.md` 附录 A）。

> 用 Gmail/Outlook 的 **OAuth 授权登录**（而非应用专用密码）时，需在 Google Cloud / Azure 的应用里把回调地址加成 `${APP_BASE_URL}/api/oauth/google/callback`、`${APP_BASE_URL}/api/oauth/microsoft/callback`，并确保 `APP_BASE_URL` 是你的公开地址。

## 10. 维护

```bash
# 备份数据库
cd ~/mailbox && docker compose exec -T db pg_dump -U mailbox mailbox | gzip > ~/backup-$(date +%F).sql.gz

# 升级到新版本（同样后台构建）
cd ~/mailbox && git pull && nohup docker compose up -d --build > ~/build.log 2>&1 &
#（用了 Caddy 就加 -f docker-compose.yml -f docker-compose.caddy.yml）

# 看容器 / 日志
docker compose ps
docker compose logs -f app
```

数据卷 `pgdata`（邮件缓存/AI 标注/设置/对话/摘要）、`appdata`（附件缓存/上传）随容器重建保留。

## 11. 常见问题

- **SSH 报 `Connection reset` / `kex_exchange_identification: read: Connection reset`**：机器被拖挂了（通常是小内存机在前台构建时 OOM 狂刷 swap，sshd 都响应不了）。**去阿里云控制台「重启」实例**（此时应用还没起来，重启不丢数据），恢复后重连，改用 §6 的**后台构建 + 4G swap**。
- **构建长时间不动 / 日志出现 `Killed`**：内存不足。确保 §3 的 4G swap 已生效并用 §6 后台构建；仍不行就**临时升配到 4G**：控制台停机 → 更改实例规格到 4G → 开机 → 后台构建（几分钟）→ 需要的话再降回 2G（运行时 2G 足够）。
- **Gmail 一直「同步出错 / 超时」**：服务器建在了大陆地域。换香港（或其它海外）地域。
- **粘贴命令报 `不是有效语句分隔符`**：命令跑到了本机 Windows PowerShell（不支持 `&&`），不是服务器上。先确认 SSH 提示符是 `root@...:~#`。
- **网页打不开 / 证书报错**：方式 B 确认 A 记录已生效（`ping mail.你的域名` 指向服务器 IP）、安全组放行了 80/443；方式 A 确认手机也登录了同一个 Tailscale 账号。
- **`git clone` 要求账号密码**：仓库还是私有，按 §4 设为公开或配部署密钥。
- **忘了 `APP_MASTER_KEY`**：换 key 后已保存的邮箱凭据无法解密，需在「邮箱管理」里删除并重新添加邮箱。请务必保存好这个 key。
