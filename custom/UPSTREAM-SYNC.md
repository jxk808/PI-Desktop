# Official upstream synchronization

## Source revisions

- Custom parent: `e6c5757da184ff806bab9c5f210aa4a53d5f0b70` (`custom/main`).
- Official source: `https://github.com/vastsa/PI-Desktop.git`, `main` at
  `3169c219d0220b77557a178a6bef395d95ff1e09`.
- This is a non-rewriting merge retaining both histories, not a reset, a source
  archive overwrite, or a cherry-pick of selected official changes. The official
  snapshot introduces 673 commits relative to the custom branch's common base.
- Work was isolated on `merge/upstream-custom`; the original target remained clean
  until validation. No remote publication or installer build is included in this
  synchronization request.

## Conflict decisions

- Model catalog: use the latest official `models.dev` snapshot. The custom side's
  catalog differences came from the old official release preparation, not a
  private provider/credential configuration. Persisted user model bindings are
  unrelated and were not accessed.
- Runtime: retain upstream `firstMismatch` diagnostics, background jobs and
  computer-use/tool-state checks. Compare the custom account pool's initial
  configuration when deciding reuse and report `providerFallbacks` on pool changes.
  Current compatible-account rotation, session-scoped OAuth authorization, finite
  retry and cancellation remain in place.
- Composer: preserve upstream native agent chips, MCP/command/file completion and
  the custom localized Chinese subagent instruction rows. Chinese aliases remain
  ordinary instructions; native agent references remain subject to `agentsEnabled`.
  Neither path installs missing definitions or elevates permissions.
- Release/spec/API docs: keep both the upstream additions and custom subscription
  quota/validation sections. Remove the obsolete "no unreleased changes" line.
- The account-flow fixture now answers the upstream Host's new
  `tools.fileBatchCapabilities` query. The native mention test distinguishes
  gated native agent chips from the custom plain-text instruction group.

## Validation performed

Dependencies were installed into the isolated worktree using the merged lockfile
with `--frozen-lockfile --ignore-scripts`. Existing cached artifacts were reused;
required Pi packages moved from 1.3.0 to official 1.5.0. No manual lockfile edits,
package upgrades outside upstream, or credential reads were used.

Passed:

- Workspace TypeScript/package builds, including new `computer-use`, shared,
  i18n, runtime, host-runtime and Electron main/preload/renderer production build.
- Desktop `tsc --noEmit` and agent sidecar production bundle.
- Runtime/credential/retry suites: **557 source tests**.
- Shared contracts: **721 source tests** (excluding generated `dist` duplicates).
- Plugin SDK: **192 source tests** (excluding generated `dist` duplicates).
- Composer Chinese aliases, native agent chips, MCP and deep-file search:
  **25 tests**, including actual isolated Electron user paths.
- Existing quota plugin: **82 tests**, source unmodified.
- Custom packaging/Codex/OAuth/plugin permission and launch suites: **91 passed**;
  optional real portable-runtime check was initially skipped, then explicitly
  supplied an approved prepared runtime and **all 4 runtime checks passed**.
- Policy synchronization, exact Pi 1.5 dependency checks, all three installed
  official Pi patches, conflict-marker scan and `git diff --check`.

## Validation boundary

This machine has no Rust/Cargo toolchain. Upstream changes Rust host-core and
Windows native functionality, so **Rust tests/build, full Desktop+Host E2E and a
new complete installer have not been validated here**. Do not ship the old v8
host executable with this new source as a substitute for rebuilding current Host.
A release runner must compile the merged Rust source and validate installation,
real subscription quota/login, native functions and schema compatibility before
new binary delivery. The user's installed client, account data and old installers
were not changed by this source synchronization.
