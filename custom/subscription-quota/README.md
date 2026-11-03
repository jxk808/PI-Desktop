# 订阅额度 · Subscription Quotas

> 在 PI-Desktop 右侧工作面板里，一眼看清你的 AI 订阅还剩多少额度。
> 支持 Anthropic (Claude Pro/Max)、OpenAI (ChatGPT Plus/Pro)、GitHub Copilot、OpenRouter，
> 以及 Kimi Code / Meta / Radius / xAI 的自定义来源。**只显示本机已登录的账号。**

## Local OpenAI manual-reset extension

This checkout is a local `0.4.3-reset.1` extension of the community plugin, not an upstream release.
OpenAI cards now provide **query reset credits → choose one credit → confirm consumption → refresh quota**.
Requires separate OpenAI authorization in this plugin and an available official Codex reset credit.
The operation consumes one entitlement; it is not unlimited quota clearing. CLI/manual sources stay read-only.
See [OPENAI-RESET.md](OPENAI-RESET.md) for installation, recovery, compatibility and test instructions.

![界面预览](assets/preview.png)

*（上图是内置演示数据，用于展示界面；真实使用时按你的账号渲染。）*

---

## 功能

- **按周期展示额度**：5 小时窗口、周额度、月额度、余额，各带独立进度条。
- **剩余为核心**：进度条 **绿色填充 = 剩余额度**，灰色底槽 = 已用掉的额度；
  右侧大号数字是剩余百分比，颜色随剩余风险变化（>30% 绿、10–30% 橙、<10% 红）。
- **重置倒计时**：每秒刷新，30 分钟内变橙。
- **只显示已登录的**：拿不到凭据的服务商不会出现在列表里，不占位、不报错。
- **跟随应用外观**：深浅色、语言与 PI-Desktop 设计令牌一致。
- **无需安装 CLI**：ChatGPT / Claude / Copilot 可在面板「管理账号」中独立授权；已有 CLI 登录仍可自动发现。
- **账号名自动识别**：插件账号直接显示检测到的身份——ChatGPT 用昵称（profile claim 的 `name`）、邮箱作为卡片 chip；Claude 用邮箱；GitHub Copilot 用登录名。无需手填备注，也不提供改名。

## 支持的服务商

厂商 id 与 PI-Desktop「用订阅登录」列表一致。

| 服务商 | 厂商 id | 凭据来源 | 额度接口 | 窗口 |
|---|---|---|---|---|
| Anthropic (Claude Pro/Max) | `anthropic` | 插件内 OAuth / Claude Code / 手工令牌 | `api.anthropic.com/api/oauth/usage` | 5 小时 · 周（全部 / Sonnet / Opus） |
| OpenAI (ChatGPT Plus/Pro) | `openai-codex` | 插件内 OAuth / Codex CLI / 手工令牌 | `chatgpt.com/backend-api/wham/usage` | 5 小时 · 周 |
| GitHub Copilot | `github-copilot` | 插件内设备码授权 / 编辑器凭据 / 手工令牌 | `api.github.com/copilot_internal/user` | 月（高级请求 / 聊天 / 补全） |
| OpenRouter | `openrouter` | 手工令牌 | `openrouter.ai/api/v1/key` | 余额 |
| Kimi Code (subscription) | `kimi-coding` | 手工令牌 + 自定义来源 | 需自行配置 | 取决于接口 |
| Meta (Muse subscription) | `meta` | 手工令牌 + 自定义来源 | 需自行配置 | 取决于接口 |
| Radius | `radius` | 手工令牌 + 自定义来源 | 需自行配置 | 取决于接口 |
| xAI (Grok/X subscription) | `xai` | 手工令牌 + 自定义来源 | 需自行配置 | 取决于接口 |

后四种没有公开的额度接口，配一次「自定义来源」即可显示，无需改代码：

```json
[
  {
    "vendor": "xai",
    "label": "xAI (Grok/X)",
    "url": "https://api.x.ai/v1/<你的额度接口>",
    "token": "你的令牌",
    "windows": [
      { "path": "rate_limits", "period": "week", "usedField": "used_percent",
        "resetField": "reset_at", "minutesField": "window_minutes" }
    ]
  }
]
```

省略 `windows` 时插件会**自动识别**这些常见字段名：
`used_percent` / `usedPercent` / `utilization` / `percent_remaining`、
`window_minutes` / `limit_window_seconds`、`reset_at` / `resets_in_seconds` / `reset_after_seconds`，
并从键名猜测周期（`five_hour` → 5 小时，`seven_day` → 周，`month` → 月）。

## 安装

需要 PI-Desktop。三种方式任选：

**方式一 · 插件市场（推荐）**

1. PI-Desktop → **插件** → **市场**。
2. 搜索「订阅额度」，或直接打开
   [plugins.aiuo.net/plugins/io.github.czp0312.subscription-quota](https://plugins.aiuo.net/plugins/io.github.czp0312.subscription-quota)。
3. 安装时审阅权限并授权（`net.fetch` 属高风险权限）。

插件 id 是 `io.github.czp0312.subscription-quota`。源码当前版本为 `0.4.2`；市场版本以市场实际发布记录为准。

**方式二 · 安装插件包**

1. 打开 **插件**（扩展）页。
2. 右上角溢出菜单 → **安装插件包**。
3. 选择 `io.github.czp0312.subscription-quota-<版本>.piplug`。
4. 审阅权限后安装（`net.fetch` 属高风险权限，需你显式授权）。

插件包从本仓库的 [Releases](../../releases) 下载，或按下方「打包」一节自行构建。

**方式三 · 加载开发插件**

1. 插件页 → **加载开发插件**。
2. 选择本仓库根目录（含 `manifest.json` 的那一层）。
3. 之后改动会热重载；**新增/放宽权限需要重新加载目录**。

装好后：右侧工作面板的视图菜单里会出现 **订阅额度**；
命令面板（`Ctrl+K`）执行 **Subscription Quotas: Open Panel** 可打开独立面板窗口。

## 不安装 CLI：在插件中登录

1. 升级后**重新加载插件并批准新增权限**（`shell.openExternal` 和授权域名）；仅热重载不会授予新权限。
2. 打开「订阅额度」→ **管理账号**，选择 ChatGPT、Claude 或 GitHub Copilot。
3. ChatGPT / Claude：在系统浏览器完成授权，插件通过本机回调接收结果。
   如果端口被占用或浏览器未自动返回，复制最终 `http://localhost:…` 跳转地址，粘贴到面板提交。
   必须是本次授权的完整地址（含 `code` 和 `state`），不能只填验证码。
4. Copilot：在 GitHub 授权页输入面板显示的设备码，等待完成。
5. 授权成功后自动刷新额度；ChatGPT / Claude 令牌临近过期时自动刷新。

插件独立授权仍可使用；在支持 `models.usage` 的 PI-Desktop 中，插件还会显示模型管理里
每个已登录 Codex Provider 的额度。额度请求由宿主使用自己的加密凭据完成，插件只接收邮箱标签、
套餐和标准化额度窗口，不读取或解密宿主密钥库，也拿不到 access/refresh token。
升级此本地扩展后，需要在 PI-Desktop 插件中心重新加载并明确批准高风险
`models.usage` 权限；未批准时插件保持原有的插件授权 / CLI 回退行为。
`usage.listTurns` 仍只是本地对话统计，不是订阅剩余额度。
浏览器若已有登录会话，通常不必再输入密码，但仍需确认授权。

- 账号名自动显示检测到的身份：ChatGPT 用 profile claim 的 `name`（昵称）作标题、`email` 显示为卡片上的 chip；Claude 调用同源的 `/api/oauth/profile` 读取 account.email（无昵称，故只用邮箱）；GitHub Copilot 用额度接口返回的登录名。都拿不到时只显示厂商名——插件不提供手填备注，也不能改名。
  - 每个支持 OAuth 的服务商最多保存 **10 个插件账号**，一次只能进行一个登录流程。
- PI-Desktop 宿主账号与插件 OAuth 账号都会逐个显示额度；手工令牌独立显示。
  仅当该厂商没有宿主账号、插件账号和手工令牌时，才使用开启的 CLI 自动发现回退。
- 「删除插件授权」只删除选中的插件账号，不退出宿主/CLI、不移除手工令牌，也不撤销服务商端授权。
  需要撤销时请到服务商账号安全页操作。删除最后一个插件账号后，CLI 回退卡片可能重新出现。
- 演示/独立预览模式不能发起真实登录。
- OpenRouter 仍填写 API Key；Kimi / Meta / Radius / xAI 仍需手工令牌及 `sources`。
  **授权能力不等于有额度接口**，本次不虚构这四家的 OAuth/额度支持。


### 多账号与优先级

1. 在「管理账号」选择服务商，点击 **添加账号**（账号名会自动显示检测到的用户名/邮箱）。
2. 在浏览器中切换到目标账号再确认授权；已有浏览器登录会话可能仍是上一个账号。
   插件不会把无法可靠识别的账号自动合并，**重复授权同一账号不代表获得额外额度**，请自行删除重复项。
3. 每个账号可重新授权或删除。**添加账号**新增记录；**重新授权**仅更新所选记录，其他账号不变。
4. 使用 **上移 / 下移** 调整同一服务商内的优先级（数字越小越优先），顺序会持久保存。
5. 插件分别查询各账号额度，并标出当前优先级最高的可推荐账号。

推荐仅参考上次查询返回的额度：任一已知窗口归零则视为耗尽；查询失败、空数据、窗口重置已到期或无效数值视为未知。
只有所有已返回窗口都剩余大于零、且未过重置时间的账号参与推荐。全部耗尽/未知时不会推荐。
服务商可能还存在未返回的限制或模型专属窗口，因此这不是模型级可用性保证。CLI/手工来源不参与插件账号优先级推荐。

**需要你在 Pi-Desktop 中手动切换到对应账号；插件不会自动切换对话账号或转发请求。**
0.3.0 的单账号凭据会自动迁移为第一条账号记录，保留授权；新格式请勿用旧版插件写入，降级前应备份插件数据目录。
## 凭据发现路径

| 服务商 | 查找的文件 |
|---|---|
| `anthropic` | `$CLAUDE_CONFIG_DIR/.credentials.json`、`~/.claude/.credentials.json` |
| `openai-codex` | `~/.codex/auth.json`（`tokens.access_token` + `tokens.account_id`） |
| `github-copilot` | `~/.config/github-copilot/hosts.json`、`…/apps.json`、`%APPDATA%\github-copilot\hosts.json`、`%LOCALAPPDATA%\github-copilot\hosts.json` |
| 其余 | 无可发现路径，只认手工令牌 |

CLI 回退只读取上表的明确路径，不遍历目录。关闭「自动发现 CLI / 编辑器账号」即可停止读取；不影响插件独立授权和手工令牌。

## 设置

设置 → 扩展 → 订阅额度：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `autoDetect` | boolean | `true` | 仅控制 CLI / 编辑器凭据回退，不控制插件授权及手工令牌 |
| `demoMode` | boolean | `false` | 只渲染内置演示数据，不访问网络 |
| `refreshSeconds` | number | `300` | 轮询间隔（30–3600 秒） |
| `credentials` | json | `{}` | `厂商 id → 令牌`，填了即视为已登录 |
| `sources` | json | `[]` | 自定义额度来源（见上） |
| `accounts` | json | `[]` | 完全手填的窗口，不联网 |

手工令牌示例：

```json
{
  "openrouter": "sk-or-v1-...",
  "anthropic": "...",
  "openai-codex": "...",
  "github-copilot": "ghu_..."
}
```

完全手填的窗口示例（不联网）：

```json
[
  {
    "id": "my-relay",
    "label": "自建中转",
    "plan": "team",
    "windows": [
      { "period": "session", "used": 12, "limit": 60, "unit": "次", "resetsAt": "2026-01-01T12:00:00Z" },
      { "period": "week", "label": "本周额度", "usedPercent": 42.5 },
      { "period": "month", "used": 980, "limit": 5000, "unit": "请求" }
    ]
  }
]
```

`period` 取 `session` / `day` / `week` / `month` / `credit`；
额度可写 `usedPercent`，或 `used` + `limit`（自动换算百分比）；`resetsAt` 支持 ISO 字符串。

## 权限与安全

| 权限 | 用途 |
|---|---|
| `ui.view` | 工作面板停靠视图 |
| `ui.panel` | 命令打开独立面板窗口 |
| `net.fetch` | 请求额度接口（高风险，安装时需显式授权） |
| `shell.openExternal` | 打开服务商授权页面 |

`net.domains` 包含额度域名 `api.anthropic.com`、`chatgpt.com`、`api.github.com`、
`openrouter.ai`、`api.kimi.com`、`api.meta.ai`、`radius.pi.dev`、`api.x.ai`，
以及 OAuth 端点 `auth.openai.com`、`platform.claude.com`、`github.com`。
自定义来源同样受这份白名单约束 —— 填非白名单地址会被宿主拒绝。

- OAuth 令牌不写日志、不进入额度快照、不返回界面；授权 state/链接及设备用户码仅用于登录 UI。
- OAuth 凭据由 Node fs 写入 `pi.plugin.getDataPath()` 返回的**本插件数据目录**
  （Windows 实测为 `%USERPROFILE%\.pi-desktop\plugins\data\io.github.czp0312.subscription-quota\`）：
  `quota-oauth.enc`（AES-256-GCM 密文，格式 `[1B 版本=1][12B IV][16B tag][密文]`）、
  `quota-oauth.key`（32 字节本地随机密钥）。原子替换文件；POSIX 新文件权限为 `0600`。
  密文内容是 `{ version, accounts: [{ id, vendor, label, credential: { access, refresh, expires, accountId?, email? } }] }`
  —— **含长期有效的 refresh token**，等价于这些账号的长期凭据。
- **密钥与密文同目录，安全依赖操作系统文件权限，不是系统钥匙串，也不能抵御同用户权限的恶意程序。**
  Windows 上 POSIX `0600` 不生效，实际依赖数据目录继承的 ACL。请勿分享/提交这两个文件。
- 手工令牌（设置里的 `credentials`）由宿主按普通插件设置保存为该插件数据目录下的 `settings.json`，
  不属于上面的密文存储；CLI 凭据只读原文件、不复制。
- 删除插件账号只清本地密文里的那一条记录，**不会撤销服务商侧的授权**；要撤销请到服务商账号安全页。
- 授权期间 Node HTTP 只监听 `127.0.0.1:1455`（ChatGPT）或 `127.0.0.1:53692`（Claude），
  校验回调路径、随机 state 与 PKCE；完成、取消、超时或卸载后关闭。最长 10 分钟。
- 插件不读取 PI-Desktop 的密钥库，也不碰 `~/.ssh`、`.env*`、`*.pem` 等无关凭据路径。
- 本插件不提供系统级通知、不注册常驻服务、不注入 Agent 提示词。

## 从源码校验与打包

使用 Node.js 22+ 运行不含真实账号/网络授权的测试：

```bash
node --test tests/*.test.js
node --check main.js
```

在 PI-Desktop 中可使用 `PluginCheck` 校验目录、`PluginPack` 生成安装包。

需要 PI-Desktop 仓库检出（devkit 目前是仓库内私有包）：

```bash
pnpm install
pnpm --filter @pi-desktop/plugin-devkit... build
pnpm pi-plugin check <本仓库路径>
pnpm pi-plugin pack  <本仓库路径>
# → dist/io.github.czp0312.subscription-quota-0.4.2.piplug
```

生成的 `.piplug` 是 store-only ZIP，请勿用普通 `zip` 重打（安装器只接受未压缩归档）。
`dist/` 已加入 `.gitignore`，发布时把 `.piplug` 挂到对应的 GitHub Release 上。

## 目录结构

```
.
├── manifest.json      # 插件身份、贡献点、权限、域名白名单
├── main.js            # 插件进程：服务商注册表、凭据发现、额度归一化、通道路由
├── lib/oauth.js       # 独立授权状态机、回调、刷新
├── lib/auth-store.js  # 本插件凭据密文存储
├── tests/             # 无真实凭据的自动化回归测试
├── views/quota.html   # 视图 / 面板共用的界面（无构建步骤）
├── assets/preview.png # 本 README 的界面预览图
├── README.md
├── CHANGELOG.md
└── LICENSE
```

`views/quota.html` 在 PI-Desktop 之外直接打开会进入「独立预览」模式：
检测不到 `window.pluginBridge` 时渲染内置演示数据，方便调样式。

## 已知限制

- 上游额度接口都是服务商私有接口，非公开契约；结构变化时界面会显示失败原因，而不会静默给出错误数字。
- Kimi Code / Meta / Radius / xAI 没有公开的额度接口，需要你在 `sources` 里配一次。
- OpenRouter 只对**设了 limit 的密钥**给出剩余比例；没设上限时只提示、不显示数字。
- 只在 PI-Desktop 登录仍不能自动继承；需在本插件「管理账号」授权一次，无需 CLI。
- 自动刷新仅支持本插件取得的 ChatGPT / Claude OAuth 令牌；CLI/手工令牌失效需在原来源更新，Copilot 被撤销需重新授权。
- 服务商的公共客户端/私有额度接口可能受地区、账号策略或服务端变更限制；登录成功不保证账号拥有订阅额度。
- 自动化测试使用模拟授权响应与本机回调，没有代替真实账号的端到端授权验收。
- 依赖 `net.anyHost` 的自建中转站地址在当前稳定版宿主上不可用（该权限尚未进入发布版本）。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

[MIT](LICENSE)
