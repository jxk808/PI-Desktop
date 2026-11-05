# v5-v7 source migration validation

## Candidate and scope

- Target: local `custom/main`, based on `41d35a9e109eba61d7add6ea3186340b1cea043d`.
- Request worktree/branch: `fix/source-v5-v7`, isolated from the target worktree.
- No upstream merge, remote push, user-data migration, live provider request,
  automatic client installation, dependency upgrade or binary addition to Git.
- Existing compatible dependencies were reused by task-local links. Workspace
  package links resolve to the task worktree, not the target's old generated code.
- Node 24.7.0 was used. The host pnpm launcher is 10.29.2 while the root metadata
  declares 12.8.1; validation used equivalent direct Node/TypeScript/build entries
  without changing the lockfile or declaring a pnpm install successful.

## Passed

1. `tsc -b packages/shared packages/i18n packages/agent-runtime --pretty false`.
2. `tsc -p apps/desktop/tsconfig.json --noEmit --pretty false`.
3. `node packages/agent-runtime/scripts/bundle.mjs` from the runtime package.
4. Electron Vite production build of main, preload and renderer. Only chunk-size
   warnings; no build errors. No installer was generated in this source task.
5. Vitest: runtime, provider-retry, provider-recovery-flow,
   resume-provider-identity and the two new account-fallback suites: **431 passed**.
   The existing provider-binding suite also passed (**57 tests**) in a prior
   targeted run. New flow tests cover full retry budgets, authentication isolation,
   preserved completed tools, continued active-account reuse, removal invalidation,
   terminal exhaustion, infinite retry and cancellation.
6. Main session-launch and Jev launch integration: **2 passed**, including exact
   fallback authorization IDs and credential-free launch payloads.
7. Custom integration/runtime assembly, Codex helper, vendor OAuth, plugin-risk
   and plugin-completion targeted suites: **87 passed**, with the optional real
   runtime integration initially skipped. Re-run with the approved prepared
   fixture supplied: **all 4 runtime assembly checks passed**, none skipped.
8. `PI_CUSTOM_AUTOMATION_RUNTIME=<approved fixture> node custom/build.mjs --check`:
   portable inventory and existing quota plugin `0.4.3-host.1` checked. The prepared
   runtime path is build input, not an installed developer-path dependency.
9. Quota plugin existing tests: **82 passed**. Plugin source/permissions were not
   changed; the custom build still bundles it.
10. Composer alias and real production component user-path tests: **3 passed**
    using the provisioned JSDOM runner, source aliases and real Composer input/menu
    wiring. Covers Chinese/English IDs, keyboard/pointer selection, IME, file and
    folder references, Escape, late catalog replies and local/remote scope guards.
    JSDOM supplies visible anchor geometry because it has no layout engine; the
    production AnchoredMenu's offscreen-close behavior was not changed.
11. Agent-policy sync and `git diff --check` passed. No credentials, virtualenv,
    browser profiles, generated runtimes or dependency caches staged.

## Not claimed

- The host dependency Electron package has no downloaded distribution. The
  Electron deep-file-search test could not start its binary; this is not a passing
  E2E result. The new Composer user-path passed with the provisioned DOM runner.
- No fresh Rust host build, complete source-built NSIS artifact, second-computer
  installation, real OAuth login or paid-model delegation was performed here.
- The one optional delegated review could not run because its service returned a
  usage-limit error. No independent-review approval is claimed; the parent checked
  the targeted diff and ran the validation above.
- Existing v5-v7 installer artifacts are not rebuilt by these source commits.
