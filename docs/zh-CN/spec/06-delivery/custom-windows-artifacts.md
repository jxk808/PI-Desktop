# 定制 Windows 产物构建验收

> 本页为中文说明；以[英文源规格](/spec/06-delivery/custom-windows-artifacts)和当前源码、测试为准。

`custom-windows.yml` 仅在 `custom/main` 手动触发，仓库权限只读；它输出已验证的构建产物，不发布 GitHub Release，也不自动安装客户端。

## 必须通过的流程

1. 从官方端点准备固定版本的纯净便携运行时，验证 Python、Node 归档摘要、兼容 PyPI 轮子及 npm 锁文件。不得复制账号、浏览器资料、开发虚拟环境或机器上的环境。
2. 按 Cargo 锁文件构建、测试当前 Windows Rust 宿主；构建工作区源码并做类型检查。保留配额插件、账号恢复和中文补全行为。
3. 完整构建安装包，禁止复用已安装宿主选项。
4. 解出 NSIS 的实际载荷，核对运行时完整性、插件源码与权限、宿主/sidecar/ASAR 编译输出，并做 sidecar 健康及运行时搬移探针。
5. 只有以上验证全部成功后才上传安装包、源码提交/编译器记录和 SHA-256 清单；失败工作流不能发布貌似成功的包。

覆盖包括 `custom/prepare-runtime.test.mjs`、`custom/packaged-runtime.test.mjs`、`custom/integration.test.mjs`、账号回退测试及 `custom/verify-windows-package.mjs` 的实际安装包检查。产物必须标识准确提交与本次宿主摘要；源码推送或本地测试成功不等于云端构建成功。真实登录与第二台机器安装仍须单独验收。

临时 Windows runner 设置 `core.autocrlf=false`，仅保证夹具仓库按 LF 字节验证，不改变维护者或安装用户的 Git 配置。Rust 缓存不替代源码测试、正式编译和载荷验证；完整门禁包含能力重定位/冲突保护、Windows 路径拼写和远程 POSIX 大小写/权限回归。
