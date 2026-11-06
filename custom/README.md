# 我的 PI-Desktop 自定义分支

只维护这个仓库的 `custom/main`。官方代码从 `upstream` 合并进来；插件和助手源码直接随同本分支维护，不使用子模块、不需要另外维护仓库。

## 内容

- PI 核心：Codex 批量 OAuth、独立 Provider/邮箱标签、`models.usage` 高风险权限和宿主额度 API。
- `custom/subscription-quota/`：本地定制插件 `0.4.3-host.1`，保留原作者 LICENSE。每个宿主 Codex 账号一张卡片；有宿主账号时禁用 CLI 重复卡片。
- `custom/auto-codex-auth/`：自动登录助手、安装脚本及回归测试；不含账号文件或运行环境。
- `custom/build.mjs`: Windows NSIS build; bundles the quota plugin and a complete portable automation runtime.

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

## Build a complete Windows x64 installer

The build machine needs the normal workspace toolchains. Target machines do **not** need Python, Node, setup.ps1, a developer checkout, or runtime downloads. The installer carries `resources/codex-automation`, outside ASAR. Quota plugin `0.4.3-host.1`, its license and explicit `models.usage` permission are unchanged.

Supply an explicitly prepared, approved runtime directory (see [portable runtime preparation](AUTOMATION-RUNTIME.md)); there is no developer-drive default:

```powershell
$env:PI_CUSTOM_AUTOMATION_RUNTIME = 'C:\build-inputs\codex-automation'
node custom/build.mjs --check
# Optional: pin the inventory digest printed by --check after reviewing the input.
$env:PI_CUSTOM_AUTOMATION_SHA256 = '<approved inventory SHA-256>'
node custom/build.mjs
```

`--check` without that environment variable checks source only, offline, and explicitly reports that no runtime was checked. With it, checks include component files, pinned dependency versions, browser revision, isolated Python configuration, license presence and a SHA-256 inventory. Full builds fail before invoking toolchains when the runtime is absent/incomplete; they never silently ship source only. Assembly additionally probes embedded Python and Node, copies only approved inputs to temporary staging, verifies every copy and writes `runtime-integrity.json`. Output remains `apps/desktop/release/`; nothing is installed or published automatically.

Use `--reuse-installed-host` only after independently verifying compatibility, with `PI_CUSTOM_INSTALLED_HOST` set to the selected executable's full path.

The host resolves the bundled runtime relative to `process.resourcesPath` first. `PI_CODEX_AUTOMATION_ROOT` remains an explicit fallback to a **complete portable** runtime; old `.venv` launchers are not supported and must be migrated. No default HOME, account-file directory or hardcoded drive supplies executable code. Account files may live anywhere and are not copied into the runtime. `setup.ps1` remains a legacy developer convenience, not an installer deployment requirement.

```powershell
node --test custom/integration.test.mjs custom/automation-runtime.test.mjs apps/desktop/test/codex-batch-automation.test.mjs
# Optional offline integration: copies the approved fixture into a Unicode/spaces path,
# validates synthetic credentials, launches bundled Chromium locally and loads the Node bridge.
$env:PI_TEST_AUTOMATION_ROOT = $env:PI_CUSTOM_AUTOMATION_RUNTIME
node --test custom/automation-runtime.test.mjs
```

No live OAuth, real credentials or model calls are used by these portability tests.

`custom/after-pack.mjs` restores the validated runtime inventory after electron-builder's resource copy, because its default filters exclude nested `node_modules`. Every restored file is checked against the staged SHA-256 manifest. Run `node --test custom/packaged-runtime.test.mjs` to cover this release-boundary regression; a generated EXE must also be extracted and checked against `runtime-integrity.json` before delivery.

## Source migration of v5-v7 patches

This branch now maintains the former compiled patches as typed source:
same-model compatible OAuth account fallback after exhausted rate-limit retry,
complete portable automation packaging, and localized Chinese `@` subagent
completion. See [behavior and acceptance](../docs/spec/03-runtime/custom-source-migrations.md).
The mention menu only references installed/enabled definitions; it does not
install the custom role definitions on another machine or bypass execution permissions.
Account fallback does not predict remaining quota or switch to another model/vendor.

Previously issued v5-v7 EXEs were compiled-resource patch builds. Migrating their
behavior to this branch does not retroactively rebuild those artifacts or install
the current source. A release must be rebuilt with the approved portable runtime
and the normal Rust/JS toolchains; preserve the quota plugin's explicit permission
confirmation and verify that source commit and installer digest together.

## 验收与发布

1. 构建、typecheck 与测试通过。
2. 验证模型管理中的账号邮箱和批量登录。
3. 插件中心明确确认新增的 `models.usage`，不要静默授权。
4. 验证所有宿主账号各一张额度卡片，无重复 CLI 卡片。
5. 为通过验证的提交打自己的标签，保存安装包 SHA-256 和源码提交号。

不要提交 `号.txt`、密码、TOTP、OAuth Token、SecretStore、浏览器配置、`.venv` 或下载的运行环境。账号文件应保存在仓库之外。旧 v4 安装包不包含本次新增的统一打包逻辑；本次源码提交不能等同于已经重建/安装了新的应用。
