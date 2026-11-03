# 我的 PI-Desktop 自定义分支

只维护这个仓库的 `custom/main`。官方代码从 `upstream` 合并进来；插件和助手源码直接随同本分支维护，不使用子模块、不需要另外维护仓库。

## 内容

- PI 核心：Codex 批量 OAuth、独立 Provider/邮箱标签、`models.usage` 高风险权限和宿主额度 API。
- `custom/subscription-quota/`：本地定制插件 `0.4.3-host.1`，保留原作者 LICENSE。每个宿主 Codex 账号一张卡片；有宿主账号时禁用 CLI 重复卡片。
- `custom/auto-codex-auth/`：自动登录助手、安装脚本及回归测试；不含账号文件或运行环境。
- `custom/build.mjs`：Windows NSIS 统一构建，自动将插件和助手源码打入安装包。

来源：PI 核心基线 `v0.22.0-beta.1`；助手源仓库 `AnQing1989/codexzdsh`，基线 `7be5e751dade2f91270c3f60ae003573ef8bd5e5` 加本地 PI 模式修改；插件来自 `czp0312/pi-desktop-quota-visualizer` 加本地修改。助手源仓库为私有仓库，未确认公开授权前不要将整合分支推到公开仓库。

## 同步官方更新

在干净工作树中执行：

```powershell
git switch custom/main
git fetch upstream
git merge upstream/main
# 解决冲突后运行检查、测试和构建；通过才推送。
git push origin custom/main
```

官方分支保持官方内容；不要把 `upstream/main` 的更新用 reset/覆盖文件的方式强行替换自定义分支。合并不是保证零冲突，涉及 OAuth、插件权限、打包入口时尤其要跑回归测试。

## 检查与测试

按官方说明准备 Node、pnpm、Rust 工具链后：

```powershell
pnpm install --frozen-lockfile
node custom/build.mjs --check
node --test custom/integration.test.mjs
node --test apps/desktop/test/codex-batch-*.test.mjs apps/desktop/test/vendor-oauth-login.test.mjs apps/desktop/test/plugin-runtime-risk.test.mjs apps/desktop/test/plugin-complete.test.mjs
npm --prefix custom/subscription-quota ci --ignore-scripts
npm --prefix custom/subscription-quota test
# 将 python 替换为可用的 Python 3.10+ 完整路径。
Push-Location custom/auto-codex-auth
python -m unittest discover -s tests -v
Pop-Location
pnpm --filter @pi-desktop/desktop typecheck
```

## 构建完整安装包

```powershell
node custom/build.mjs
```

脚本构建 workspace 依赖、Rust host core、agent runtime、Electron，并将此分支的插件和助手源码加入 NSIS。输出在 `apps/desktop/release/`。不会自动发布到官方 GitHub，也不会自动安装。

仅当已确认现有 host core 与源码兼容时，可显式复用：

```powershell
$env:PI_CUSTOM_INSTALLED_HOST = 'O:\PI-Desktop\resources\bin\pi-desktop-host-core.exe'
node custom/build.mjs --reuse-installed-host
```

官方安装包不会携带这些自定义改动。请安装自己构建的版本，不要直接用官方自动更新覆盖自定义版本。这里不自动修改用户的更新偏好。

## 助手部署（每台机器首次使用）

安装包带的是助手源码，不包含 Python、Chromium 或 Node 的大型运行环境。安装后，用真实 Python 3.10+ 路径运行：

```powershell
& 'O:\PI-Desktop\resources\codex-automation\setup.ps1' -Python 'C:\path\to\python.exe'
```

脚本把白名单源码部署到 `$HOME/.pi-desktop/codex-automation`，在该目录创建独立 Python venv，安装 Playwright Chromium、独立 Node 和浏览器桥。下载需要联网，系统需具备相应运行条件。再次执行会更新助手源码并安装所需依赖，不复制账号或 Token。安装路径不同请相应调整命令。

开发环境也可执行 `custom/auto-codex-auth/setup.ps1`。宿主依次检查环境变量 `PI_CODEX_AUTOMATION_ROOT`、用户目录、仓库内助手和兼容路径 `O:\AutoCodexAuth`。原有部署继续可用。

## 验收与发布

1. 构建、typecheck 与测试通过。
2. 验证模型管理中的账号邮箱和批量登录。
3. 插件中心明确确认新增的 `models.usage`，不要静默授权。
4. 验证所有宿主账号各一张额度卡片，无重复 CLI 卡片。
5. 为通过验证的提交打自己的标签，保存安装包 SHA-256 和源码提交号。

不要提交 `号.txt`、密码、TOTP、OAuth Token、SecretStore、浏览器配置、`.venv` 或下载的运行环境。账号文件应保存在仓库之外。旧 v4 安装包不包含本次新增的统一打包逻辑；本次源码提交不能等同于已经重建/安装了新的应用。
