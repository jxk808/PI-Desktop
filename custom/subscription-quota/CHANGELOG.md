# 更新日志

本文件记录所有用户可见的改动，最新在前。版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.3-reset.1] - Local extension

- Add official OpenAI Codex reset-credit queries and per-credit expiry display on plugin-authorized account cards.
- Require account-scoped confirmation before manual redemption; query and polling remain read-only.
- Preserve redemption IDs across timeouts and plugin restarts, reject redirects, and never automatically consume another credit.
- Refresh quota after the upstream result and distinguish reset, already redeemed, no credit and nothing to reset.
- Fix the OpenAI plan label, add backend and real DOM-to-plugin user-path tests, and document the local installation workflow.
- Requires PI-Desktop 0.18.x with redirect-policy capabilities. No new permissions or domains.

## [0.4.2] - 未发布

- 移除账号备注：账号名只显示检测到的身份，不再支持手填或改名（管理账号里的备注输入框一并移除）。
- 插件账号自动显示检测到的身份：ChatGPT 用 profile claim 的 name（昵称）作标题、email 显示为卡片 chip；Claude 用 /api/oauth/profile 的 account.email；GitHub Copilot 用额度接口返回的登录名。都拿不到时只显示厂商名，默认编号不再出现在卡片上。
- 登录时记录账号身份：ChatGPT 从 id_token 的 email claim、Claude 从令牌响应的 account.email_address 保存 email，刷新时沿用；取不到就不写该字段，旧凭据形状不变。
- 新增 Claude 邮箱查询（同源 GET /api/oauth/profile），失败只丢账号名、不影响额度读取。

## [0.4.1] - 2026-09-29

- 修复添加账号在首次失败、取消或网络异常后无法再次点击的问题。
- 取消额度页面标题栏吸顶，避免固定遮挡滚动内容。
- 支持直接在额度卡片编辑插件账号备注，保存即时反馈，失败可重试，刷新不丢草稿。

## [0.4.0] - 未发布

- ChatGPT / Claude / Copilot 支持同厂商多个独立账号（最多 10 个），添加不覆盖已有账号。
- 新增账号备注、单账号重新授权/删除、同厂商优先级上移/下移及持久化。
- 旧版单账号凭据自动迁移，刷新与删除按账号隔离。
- 每个插件账号独立展示额度，按优先级推荐同厂商中额度已知且未耗尽的账号；未知、失败和重置过期的数据不参与推荐。
- 推荐仅供用户在 Pi-Desktop 手动切换，不自动切换或转发对话请求。
- 手工令牌独立显示；CLI 自动发现仅在该厂商没有插件账号和手工令牌时回退。
- 不新增权限或域名；仍不访问宿主密钥库。

## [0.3.0] - 未发布

### 新增

- 面板「管理账号」：ChatGPT / Claude 浏览器 OAuth、GitHub Copilot 设备码授权，无需安装 CLI。
- 插件独立的加密凭据存储、ChatGPT / Claude 令牌过期前刷新、取消及退出。
- 本机回调失败时支持粘贴完整回调 URL；PKCE/state 校验、并发刷新合并和授权竞态保护。
- 无真实账号的授权、存储、回调及额度采集回归测试。

### 修复与兼容

- `autoDetect` 只控制 CLI 凭据回退；关闭后插件内授权及手工令牌仍生效。
- 服务商并行查询，减少面板超时；不向面板回传上游错误响应正文。
- 新增 `shell.openExternal` 权限及三个授权域名，升级后需重新加载并授权。
- 不修改 PI-Desktop，不读取宿主密钥库；仍需插件内单独授权一次。
- OpenRouter 仍使用 API Key；Kimi / Meta / Radius / xAI 仍使用自定义来源。

## [0.2.0] - 2026-09-29

### 新增

- **八家订阅服务商注册表**：厂商 id 与 PI-Desktop「用订阅登录」列表对齐 ——
  `anthropic`、`openai-codex`、`github-copilot`、`kimi-coding`、`meta`、
  `openrouter`、`radius`、`xai`。
- **GitHub Copilot 适配器**：读取编辑器留下的 `hosts.json` / `apps.json`，
  展示高级请求 / 聊天 / 补全三个每月额度快照。
- **OpenRouter 适配器**：按密钥的额度上限展示余额占比与已用金额。
- **通用适配器**：没有内置接口的服务商可在设置里配置 `sources`（URL + 字段映射），
  不写映射时按常见字段名自动识别窗口。
- **手工令牌**：设置项 `credentials` 可为任意厂商直接填令牌，填了即视为已登录。

### 变更

- **只显示已登录的账号**：拿不到凭据的服务商不再渲染出「未找到凭据」这类占位行。
- 进度条语义按用户反馈反过来：**绿色填充 = 剩余额度，灰色底槽 = 已用额度**；
  颜色阈值改为按剩余判定（>30% 绿、10–30% 橙、<10% 红）。
- 账号行的汇总 chip 从「最紧张 X%」（读数是已用，易误解）改为「剩余最少 X%」。
- 窗口模型新增 `credit` 档位（余额型额度），界面标签为「额度余额」。
- 头部改为实心背景 + 伪元素渐隐，修掉滚动时下方内容透出文字的瑕疵。

### 修复

- OpenAI 额度解析改用实测到的真实字段名（`limit_window_seconds`、
  `reset_after_seconds`、`reset_at`），修掉周期误判与重置倒计时缺失。
- 手动账号在 `minutes` 字段缺失时不再抛错。

## [0.1.0] - 2026-09-29

### 新增

- 首个版本：Anthropic、OpenAI 两家的 5 小时 / 每周额度可视化。
- 视图 + 面板共用一个 HTML，跟随应用深浅色与语言。
- 手动账号与演示数据。
