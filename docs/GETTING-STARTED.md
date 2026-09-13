# 从登录到读到邮件：操作指引

## 第 1 步：拿到登录账号

登录用的是**应用自己的管理员账号**，不是你的邮箱账号。它写在项目根目录的 `.env.local` 文件里（首次运行 `bun run setup` 时自动生成）。

1. 用记事本打开 `D:\Code\mailbox\.env.local`（PowerShell 里执行 `notepad D:\Code\mailbox\.env.local`）。
2. 找到这两行：
   ```
   ADMIN_EMAIL=admin@mailbox.local
   ADMIN_PASSWORD=一串随机字符
   ```
3. 登录页「邮箱」填 `admin@mailbox.local`，「密码」填 `ADMIN_PASSWORD=` 后面的整串字符（注意不要带空格）。

想换成自己记得住的密码：把 `ADMIN_PASSWORD=` 后面改成新密码（至少 8 位），保存后重启 `bun run dev`，应用会自动把管理员密码更新成新值。

## 第 2 步：添加邮箱

登录后会看到「欢迎使用 Mailbox」，点「添加邮箱」（左上角 + 号也可以）。

- 「邮箱地址」填完整邮箱，比如 `xxx@qq.com` 或 `xxx@gmail.com`，服务商会自动识别。
- 「授权码 / 应用专用密码」**不是**邮箱的登录密码，要按下面的方法生成：

### QQ 邮箱
1. 电脑浏览器登录 https://mail.qq.com。
2. 「设置」→「账号」（新版为「账号与安全 → 安全设置」）→ 找到「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务」。
3. 开启「IMAP/SMTP 服务」，点「生成授权码」，用密保手机按提示发短信验证。
4. 页面显示的 16 位字母就是授权码，只显示一次，复制下来填进应用。

### Gmail
1. 打开 https://myaccount.google.com/security，确认「两步验证」已开启。
2. 打开 https://myaccount.google.com/apppasswords，输入名字（如 Mailbox），点「创建」。
3. 复制显示的 16 位密码（可去掉空格），填进应用。

### 163 / 126 邮箱
1. 登录 https://mail.163.com →「设置」→「POP3/SMTP/IMAP」。
2. 开启「IMAP/SMTP 服务」，扫码或短信验证后页面显示 16 位授权密码，复制填进应用。

填完后先点「测试连接」，看到「IMAP 收信 ✓」和「SMTP 发信 ✓」再点「保存并开始同步」。
如果提示「认证失败」，几乎都是填了登录密码而不是授权码。

## 第 3 步：等待同步并阅读

1. 保存后会自动回到邮件页，左侧出现「正在获取文件夹…」，通常十几秒后出现「收件箱」。
2. 首次同步默认拉取最近 30 天的邮件，列表会先出现主题，正文在后台逐封下载（列表里显示「正文加载中…」的会自动补齐，点开也会立刻下载）。
3. 点任意一封邮件，右侧显示正文和附件；远程图片默认屏蔽，点「显示图片」放行。
4. 工具栏可以回复、转发、归档、删除、加星标，这些操作会同步到邮箱服务器，手机上同样可见。

## 第 4 步（可选）：打开 AI

1. 左侧「设置（齿轮）→ AI 设置」，选择厂商填入 API Key，点「刷新模型列表」勾选模型，再选一个默认模型。
2. 「设置 → 邮箱管理」里把该邮箱的「AI 处理」打开。
3. 之后新邮件会自动分类、摘要；也可以在邮件工具栏点「AI 分析」「AI 起草回复」，或到「每日摘要」「待办」「和邮箱对话」页面。

## 常见问题

| 现象 | 处理 |
|---|---|
| 登录提示「邮箱或密码错误」 | 核对 `.env.local` 里的 `ADMIN_EMAIL` / `ADMIN_PASSWORD`；改过密码要重启 `bun run dev` |
| 添加邮箱提示认证失败 | 用授权码 / 应用专用密码，不是登录密码；确认已开启 IMAP 服务 |
| 163 提示 Unsafe Login | 重新生成授权密码再试 |
| 收件箱一直是空的 | 等首次同步完成（右上角刷新按钮可手动触发）；「设置 → 邮箱管理」查看同步状态与错误信息 |
| Outlook OAuth 报「Selected user account does not exist in tenant 'Microsoft Services'」 | Azure 应用注册的「支持的账户类型」没有包含个人账户。到「应用注册 → 你的应用 → 身份验证 → 支持的账户类型」改为「任何组织目录中的账户和个人 Microsoft 账户」（或清单 `signInAudience` 改为 `AzureADandPersonalMicrosoftAccount`），保存后重新点「连接 Outlook 账号」 |
