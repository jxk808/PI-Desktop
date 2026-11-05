# Codex OAuth 批量上号工具

这是一个用于**批量登录 OpenAI 账号，并将 Codex OAuth 凭据导入管理端**的 Python
命令行工具。脚本从账号文件读取邮箱、密码和 TOTP 密钥，使用
`puppeteer-real-browser` 启动浏览器，再由 Playwright 依次完成登录，获取 OAuth Token 后
调用管理端接口创建或更新账号。

## Windows 快速开始

首次部署时，在项目根目录依次执行：

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe .\install_playwright_chromium.py
.\.venv\Scripts\python.exe .\install_turnstile_browser.py
```

准备好 `号.txt` 后，直接运行：

```powershell
.\.venv\Scripts\python.exe .\codex_oauth.py
```

默认使用无头模式，不显示浏览器窗口。需要观察页面或人工处理额外验证时使用：

```powershell
.\.venv\Scripts\python.exe .\codex_oauth.py --headed
```

首次安装需要联网下载 Python 依赖、项目内 Chromium、项目内 Node.js 和 Node 依赖。安装
完成后，不需要系统全局安装 Chrome 或 Node.js。

## PI-Desktop 原生批量登录模式

本项目可以作为 PI-Desktop 模型管理的受信任本地登录助手。该模式与默认的“换取 Token
并导入管理端”模式严格分离：

1. PI-Desktop 创建独立 Provider 行、PKCE verifier、state 和授权链接。
2. PI-Desktop 只把公开的 `https://auth.openai.com/oauth/authorize` 链接和账号序号交给本脚本。
3. 本脚本从账号文件读取指定账号，使用项目内 Chromium 完成登录，并在浏览器到达
   `http://localhost:1455/auth/callback` 后退出。
4. OAuth 回调、授权码校验、Token 交换和加密保存全部由 PI-Desktop 完成；本脚本不会取得
   PI-Desktop 的 access token 或 refresh token，也不会在此模式下调用管理端导入接口。
5. PI-Desktop 按文件顺序串行处理账号，每个成功账号都会显示为模型管理中的独立 Provider。

PI-Desktop 内部调用的命令如下；通常不需要手动执行：

```powershell
# 仅校验整份账号文件并返回账号数量
.\.venv\Scripts\python.exe .\codex_oauth.py `
  --credentials-file .\号.txt --validate-only --json-events

# 自动完成第 1 个账号的 PI-Desktop 授权页面
.\.venv\Scripts\python.exe .\codex_oauth.py `
  --credentials-file .\号.txt --account-index 1 `
  --authorization-url "https://auth.openai.com/oauth/authorize?..." `
  --headless --json-events
```

安全限制：外部授权 URL 必须使用 OpenAI 官方 HTTPS 主机、固定客户端 ID、
`http://localhost:1455/auth/callback` 回调和 PKCE S256，否则脚本会在打开浏览器前拒绝。
Account files contain plaintext passwords and TOTP keys; keep them outside the application and restrict access.
The custom PI-Desktop installer uses the complete portable runtime in `process.resourcesPath/codex-automation` first.
`PI_CODEX_AUTOMATION_ROOT` is an explicit fallback to another complete portable runtime, not a default developer drive.
Target machines do not need this README's legacy development setup; see [portable runtime preparation](../AUTOMATION-RUNTIME.md) for build-time provisioning.

## 当前进度

下表描述的是**当前源码已经实现的能力**，不代表外部登录页面或管理端接口在任何环境下
都能稳定兼容。

| 模块 | 状态 | 当前实现 |
| --- | --- | --- |
| 多账号读取 | 已实现 | 从文本文件读取多行账号，并在开始前校验全部行 |
| TOTP | 已实现 | 本地生成 RFC 6238、SHA-1、30 秒周期的 6 位验证码；剩余不足 5 秒时等待下一周期 |
| OAuth 安全参数 | 已实现 | 每个账号独立生成 PKCE 和 `state`，回调时校验 `state` |
| 浏览器登录 | 已实现 | 自动填写邮箱、密码、TOTP，并尝试点击 Codex 授权确认按钮 |
| OAuth 回调与换 Token | 已实现 | 本地监听 `127.0.0.1:1455`，使用授权码换取 Token |
| 管理端导入 | 已实现 | 组装 Codex Session 数据并调用管理端导入接口，已存在账号会请求更新 |
| 管理端登录 | 已实现 | 动态获取管理员 Token、内存缓存、临近过期刷新；导入遇到 HTTP 401 时刷新并重试一次 |
| 批次容错 | 已实现 | 单个账号在登录或导入阶段失败后继续下一个，结束时汇总成功和失败数量 |
| 并发上号 | 未实现 | 当前严格按文件顺序串行处理，每个账号单独启动浏览器 |
| Cloudflare Turnstile | 已接入 | 使用 `puppeteer-real-browser@1.4.4` 的 `turnstile: true` 持续检测并点击验证区域 |
| 断点续跑与失败重试 | 未实现 | 不保存进度；除管理端 HTTP 401 外没有自动重试 |
| 配置外置 | 部分实现 | 文件、接口和超时可通过命令行配置；管理员凭据和导入策略仍写在源码中 |
| 自动化测试与 CI | 部分实现 | 已覆盖 PI-Desktop 外部授权模式的无网络单元测试；尚未配置 CI |

## 执行流程

程序启动后先读取并校验整份账号文件，然后对每个账号依次执行：

1. 在 `127.0.0.1:1455` 启动本地 OAuth 回调服务。
2. 生成新的 PKCE、OAuth `state` 和授权链接。
3. 由 `puppeteer-real-browser` 使用 `turnstile: true` 启动项目内 Chromium，Playwright
   通过 CDP 接管并访问 OpenAI 授权页面。
4. 自动填写邮箱、密码；如果页面要求验证器验证码，则根据 TOTP 密钥生成并填写。
5. 如果出现 Codex 授权确认页，尝试点击继续、允许或授权按钮。
6. 收到回调后校验 `state`，使用授权码和 PKCE verifier 换取 Token。
7. 从 `id_token` 提取邮箱、账号 ID 和套餐类型，生成管理端所需的 Codex Session。
8. 登录管理端并发送账号导入请求。
9. 关闭当前浏览器和回调服务，再处理下一个账号。

OAuth Token、管理员 Token 和导入载荷只在内存中使用，脚本不会主动把它们写入本地授权
文件。

## 环境要求

- Python 3.10 或更高版本
- 能访问 `https://auth.openai.com`
- 项目本地安装的 Playwright Chromium
- 项目本地安装的 Node.js 和 `puppeteer-real-browser` 依赖
- 能访问目标管理端 API
- 本机 TCP 端口 `1455` 未被占用

项目将 Playwright 固定为 `playwright==1.63.0`，保证 Python 包与项目本地 Chromium
版本一致；Turnstile 启动桥固定使用 `puppeteer-real-browser@1.4.4`。

## 浏览器策略

- 浏览器固定安装到项目根目录的 `.playwright-browsers`。
- 程序会覆盖外部的 `PLAYWRIGHT_BROWSERS_PATH`，并校验可执行文件必须位于该目录。
- 系统 Chrome、Microsoft Edge 和其他浏览器不会作为后备方案。
- 不生成随机浏览器指纹，也不随机覆盖 User-Agent、Client Hints、平台或时区。
- `puppeteer-real-browser` 会使用它自身的标准浏览器启动参数、鼠标坐标修正和
  `turnstile: true` 点击循环。浏览器默认以无头模式运行；如果 Cloudflare 要求图片题或
  其他进一步验证，可以使用 `--headed` 打开窗口人工完成。
- 无头模式会使用本机 Chromium 的真实版本、Client Hints 和主屏幕尺寸，只去除
  `HeadlessChrome` 与 `navigator.webdriver` 两个自动化标记；不会生成随机指纹。
- `turnstile: true` 不是通用的 Cloudflare 绕过方案。如果 OpenAI 的后台登录接口被 WAF
  直接返回 HTTP 403 HTML，页面会显示 `Unexpected token '<'`，此时没有可供脚本点击的
  Turnstile 控件，需要更换正常可用的网络出口或人工完成外部验证。

## 安装

### Windows PowerShell

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe .\install_playwright_chromium.py
.\.venv\Scripts\python.exe .\install_turnstile_browser.py
```

### Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
python install_playwright_chromium.py --with-deps
python install_turnstile_browser.py
```

如果 Linux 系统已经安装 Chromium 所需的运行库，可以只执行：

```bash
python install_playwright_chromium.py
```

Chromium 安装器将浏览器放入 `.playwright-browsers`。Turnstile 安装器从 Node.js 官网
下载固定版本的 Node.js 到 `.node-runtime`，并在项目的 `node_modules` 中安装固定版本的
`puppeteer-real-browser`；这些运行时目录都不会提交到 Git。运行程序时无需手动设置环境
变量，也不需要激活虚拟环境。

## 准备账号文件

默认读取脚本同目录下的 `号.txt`。标准账号行包含三个字段；也兼容供应商导出的第四个
来源 URL（该 URL 只校验格式，不会访问或保存）。所有账号之后的无邮箱尾部元数据会被忽略，
但夹在账号之间的无效行仍会拒绝整批：

```text
邮箱----密码----BASE32格式的TOTP密钥
user@example.com----your-password----JBSWY3DPEHPK3PXP
user@example.com----your-password----JBSWY3DPEHPK3PXP----https://example.com/source
```

第三项是绑定身份验证器时得到的 Base32 密钥，不是身份验证器当前显示的 6 位动态验证码。
字段前后的空白会被去除，空行会被忽略。

程序会在处理第一个账号前校验整份文件。只要任意一行格式、邮箱或 TOTP 密钥无效，本次
批次就不会开始；这与运行过程中“单个账号失败后继续”的容错行为不同。

`号.txt` 当前没有加入 `.gitignore`，Git 会把它视为普通项目文件。它仍是明文敏感文件，
提交或推送前必须确认其中不含真实账号凭据。在 Linux 上建议限制读取权限：

```bash
chmod 600 号.txt
```

也可以使用其他文件：

```bash
python codex_oauth.py --credentials-file /secure/path/accounts.txt
```

## 管理端配置

默认导入接口为：

```text
http://127.0.0.1:28082/api/v1/admin/accounts/import/codex-session
```

脚本会根据导入地址的协议、主机和端口，自动生成管理员登录地址
`/api/v1/auth/login`。例如上面的默认配置会登录：

```text
http://127.0.0.1:28082/api/v1/auth/login
```

管理员邮箱和密码目前由 `codex_oauth.py` 中的 `ADMIN_EMAIL`、`ADMIN_PASSWORD` 常量
提供，还不能通过命令行或环境变量传入。部署前应替换为目标管理端凭据，并严格限制源码
文件的读取权限。这是当前版本明确的安全债务。

使用远程管理端时，传入完整导入接口地址：

```bash
python codex_oauth.py \
  --api-url https://admin.example.com/api/v1/admin/accounts/import/codex-session
```

## 运行

使用默认配置：

```bash
python codex_oauth.py
```

以可编辑模式安装后，也可以使用命令入口：

```bash
codex-oauth
```

常用示例：

```bash
# 默认使用无头模式，不显示浏览器窗口
python codex_oauth.py

# 显式写出无头模式
python codex_oauth.py --headless

# 显示浏览器窗口，便于人工处理额外验证
python codex_oauth.py --headed

# 指定账号文件与管理端接口
python codex_oauth.py \
  --credentials-file /secure/path/accounts.txt \
  --api-url http://127.0.0.1:28082/api/v1/admin/accounts/import/codex-session

# 调整页面步骤和 OAuth 回调等待时间
python codex_oauth.py --browser-timeout 90 --timeout 300
```

查看程序提供的完整帮助：

```bash
python codex_oauth.py --help
```

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `--api-url` | `http://127.0.0.1:28082/api/v1/admin/accounts/import/codex-session` | 完整的管理端账号导入接口 |
| `--credentials-file` | 脚本目录下的 `号.txt` | 账号文件路径 |
| `--headed` | 关闭 | 显示浏览器窗口，便于人工处理额外验证 |
| `--headless` | 开启 | 使用无界面模式，并启用真实 UA、Client Hints 和屏幕参数兼容处理 |
| `--timeout` | `300` 秒 | 等待 OAuth 回调的最长时间 |
| `--browser-timeout` | `60` 秒 | 等待每个登录页面步骤的最长时间 |
| `--validate-only` | 关闭 | 只校验整份账号文件，不打开浏览器或访问管理端 |
| `--authorization-url` | 无 | 使用 PI-Desktop 生成的 OpenAI 授权链接，只完成浏览器登录 |
| `--account-index` | 无 | PI 模式使用的 1-based 账号序号，必须与 `--authorization-url` 同时提供 |
| `--json-events` | 关闭 | 输出供 PI-Desktop 解析的 JSON 完成事件 |

## 当前导入策略

以下值目前固定在 `codex_oauth.py` 中，不能通过命令行修改：

| 字段 | 当前值 |
| --- | --- |
| 账号名称 | OAuth `id_token` 中的邮箱 |
| 并发数 | `10` |
| 优先级 | `1` |
| 速率倍率 | `1` |
| 分组 | `[2]` |
| 代理 | 不指定（`null`） |
| 凭据过期后自动暂停 | `true` |
| 更新已存在账号 | `true` |
| Responses WebSocket v2 | 关闭 |

模型映射同样由源码中的 `MODEL_MAPPING` 固定提供，当前包含：

```text
codex-auto-review
gpt-5.6-luna
gpt-5.6-sol
gpt-5.6-terra
gpt-6-astra
gpt-6-luna
gpt-6-sol
gpt-6.1-sol
gpt-reserve
```

## 失败行为与退出码

- 账号文件不存在、为空或任意一行格式错误：批次不启动，退出码为 `1`。
- 单个账号登录、OAuth、Token 交换或管理端导入失败：记录失败并继续后续账号。
- OpenAI 登录接口被 Cloudflare/WAF 返回 HTML：当前账号失败，并明确报告
  `Unexpected token '<'` 对应的 WAF 拒绝。
- OAuth 回调超过 `--timeout`，或页面步骤超过 `--browser-timeout`：当前账号失败。
- PI 模式收到非 OpenAI 官方主机、错误客户端、错误回调地址、缺少 state 或非 S256 PKCE 的
  授权 URL：在启动浏览器前失败。
- 管理端导入返回 HTTP 401：刷新管理员 Token 并重试一次；其他 HTTP 错误不会重试。
- 全部账号成功：退出码为 `0`。
- 至少一个账号失败：处理完整个批次后退出码为 `1`。
- 用户中断（`Ctrl+C`）：退出码为 `130`。

脚本把管理端的 HTTP 非错误响应视为导入成功，并打印响应正文；当前不会进一步校验响应
JSON 中的业务状态码。

## 工作区目录与清理

| 路径 | 类型 | 是否运行必需 | 说明 |
| --- | --- | --- | --- |
| `.venv/` | 本地运行环境 | 是 | Python 虚拟环境；删除后需要重新安装 Python 依赖 |
| `.playwright-browsers/` | 本地运行环境 | 是 | 项目固定使用的 Chromium；删除后重新运行 Chromium 安装器 |
| `.node-runtime/` | 本地运行环境 | 是 | 项目内 Node.js；删除后重新运行 Turnstile 安装器 |
| `node_modules/` | 本地运行环境 | 是 | `puppeteer-real-browser` 及其依赖；删除后重新运行 Turnstile 安装器 |
| `__pycache__/` | 缓存 | 否 | Python 自动生成，可以安全删除 |
| `号.txt` | 敏感输入 | 是 | 明文账号、密码和 TOTP 密钥，不能上传或随意复制 |

`.venv`、`.playwright-browsers`、`.node-runtime`、`node_modules` 和 `__pycache__` 都已加入
`.gitignore`。清理工作区时通常只需要删除 `__pycache__`；其余四个运行环境目录虽然都能
重新生成，但删除后项目不能直接运行，必须重新执行对应安装步骤。

项目不使用持久浏览器 profile。每次账号处理完成后，浏览器及其临时 profile 会由启动器
关闭和清理。

## 项目结构

```text
.
├── .gitignore # Git 忽略规则
├── .venv/ # Python 虚拟环境；自动生成且不提交 Git
├── .playwright-browsers/ # 项目本地 Chromium；自动生成且不提交 Git
├── .node-runtime/ # 项目本地 Node.js；自动生成且不提交 Git
├── node_modules/ # Node 依赖；自动生成且不提交 Git
├── codex_oauth.py   # OAuth、浏览器自动化、TOTP、管理端导入和 CLI 入口
├── install_playwright_chromium.py # 项目本地 Chromium 安装器
├── install_turnstile_browser.py # 项目本地 Node.js 和浏览器桥依赖安装器
├── package.json # 固定 puppeteer-real-browser 版本
├── package-lock.json # Node 依赖锁文件
├── turnstile_browser_bridge.js # turnstile: true 浏览器启动桥
├── tests/ # PI-Desktop 外部授权模式的无网络单元测试
├── pyproject.toml   # 包信息、依赖和 codex-oauth 命令入口
├── README.md        # 项目说明
└── 号.txt           # 本地账号文件，当前未被 .gitignore 忽略
```
