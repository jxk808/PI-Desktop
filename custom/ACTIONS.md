# Custom Windows build artifact workflow

`custom-windows.yml` is a manually dispatched Windows build for this fork's
`custom/main`. It has only `contents: read`, does not publish a GitHub Release,
and does not install anything on the maintainer's machine. Run it from Actions
and download `custom-windows-<source commit>` after the verification job succeeds.
Artifacts expire after 14 days. Review the helper redistribution authorization
before distributing the installer outside an authorized repository.

The workflow:

1. Checks out the exact selected commit without persisting repository credentials.
2. Installs workspace dependencies from the frozen lockfile.
3. Prepares a clean portable automation input with `prepare-runtime.mjs`:
   pinned official embedded Python SHA-256, exact Windows/Python wheels verified
   against their PyPI SHA-256, a fixed Node release checked against the official
   release checksum list, locked browser-bridge npm dependencies with scripts off,
   and Playwright's matching browser distribution. No user account/profile input.
4. Builds source, runs current Rust host tests, custom boundary/runtime/plugin
   tests, then compiles the **current Rust host source** and full custom installer.
   Reusing an installed/older host is not permitted in this workflow.
5. Extracts the actual NSIS payload, checks its runtime manifest, quota-plugin
   identity/permission, compiled main/preload/renderer against build outputs,
   freshly compiled Host and sidecar hashes, and sidecar health. Re-runs the
   relocation integration on the extracted runtime with synthetic credentials.
6. Uploads only the verified installer, `SHA256SUMS.txt` and
   `build-provenance.json`. No updater feed or Release is published automatically.

A successful workflow is required before binary delivery; a pushed commit or
completed compilation alone is not proof of a complete package. Live OAuth login
and second-machine installation remain separate acceptance checks.

## Local checks

Use existing workspace dependencies:

```powershell
node --test custom/prepare-runtime.test.mjs custom/packaged-runtime.test.mjs custom/integration.test.mjs
node --check custom/prepare-runtime.mjs
node --check custom/verify-windows-package.mjs
```

For a clean Windows x64 provisioning check, pass a new temporary directory and
an explicit build Python 3.12 interpreter. This downloads dependencies and browsers:

```powershell
node custom/prepare-runtime.mjs "$env:TEMP\pi-runtime-input" 'C:\build-tools\python.exe'
$env:PI_CUSTOM_AUTOMATION_RUNTIME = "$env:TEMP\pi-runtime-input"
node custom/build.mjs --check
```

Build inputs are temporary artifacts, not repository files. The existing
`custom/build.mjs` still owns actual packaging and quota-plugin inclusion.

## Windows test environment

The ephemeral runner uses `core.autocrlf=false` so test-created Git worktrees
preserve their LF fixture bytes. This setting is never applied to the user's
machine. A Rust cache saves compile time, including failed-job outputs; all
tests and the current-source release build remain mandatory on every run.
Path tests cover normalized relocated capability keys and collision refusal,
local Windows aliases, and POSIX remote containment independent of Desktop OS.
