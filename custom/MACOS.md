# Complete personal macOS arm64 package

For Apple Silicon Macs, including M1/M2/M3/M4. Intel Macs are not supported by this custom lane.

## Download and install

1. Open this repository's Actions page and select **Custom macOS arm64 full installer**.
2. Run the workflow on `custom/main` (or the implementation branch while validating).
3. After the entire job succeeds, download `custom-macos-arm64-<commit>` under Artifacts.
4. Unzip the artifact. Verify the DMG with `shasum -a 256 -c SHA256SUMS.txt` from that directory.
5. Open the DMG and drag `PI-Desktop.app` into Applications. Quit any existing instance before replacing it. Do not run the app from the read-only DMG.
6. Open Applications, Control-click PI-Desktop, and select Open. If macOS blocks the personal build, use System Settings > Privacy & Security > Open Anyway for this app.

This is a personal build, **not Developer ID signed or Apple-notarized**. Only allow the exact build you downloaded from your own successful workflow. If macOS reports the app is damaged despite the matching SHA-256, remove the quarantine attribute from this application only, then retry:

```sh
xattr -dr com.apple.quarantine /Applications/PI-Desktop.app
```

Do not disable Gatekeeper globally. Do not grant permissions to a package with an unknown source or mismatched checksum.

## Included functionality

The package builds the current custom branch's Rust host and JavaScript source, including same-model OAuth account fallback and localized subagent completion. It carries the quota plugin with its original license and explicit `models.usage` confirmation, the Codex authorization helper, and native portable Python/Node/Chromium. No system Python, Node, Homebrew or first-run runtime downloads are required. Account files and browser profiles are never bundled; choose your account file separately when using batch authorization. Real OAuth still requires network access and may require manual provider verification.

Existing user data is not reset. Back up important data before replacing an installation. Update this personal build manually; no custom release/update feed is published by this workflow, and it must not be replaced with an upstream package when retaining these custom features.

## Build and acceptance

The workflow uses a native `macos-15` arm64 runner, Node 24, the locked pnpm source dependencies and stable Rust. No Apple Developer secrets are required. Runtime archives/wheels are checksum-verified and a deterministic runtime inventory is checked after packaging. Artifact uploads happen only after typecheck, Rust/custom/account-recovery tests, relocated offline Chromium/Python/Node probes, mounted-DMG verification and ZIP-payload verification.

Outputs are DMG, ZIP, `SHA256SUMS.txt`, `build-provenance.json` and this installation note. Provenance identifies the tested source commit and packaged binary hashes. The workflow does not publish a GitHub Release and artifacts expire after 30 days; save a local copy.

Native build commands (only on macOS arm64):

```sh
pnpm install --frozen-lockfile
export PI_SCRATCH_DIR="$(mktemp -d)"
export PI_CUSTOM_AUTOMATION_RUNTIME="$PI_SCRATCH_DIR/automation-input"
node custom/prepare-macos-runtime.mjs "$PI_CUSTOM_AUTOMATION_RUNTIME"
node custom/build.mjs
node custom/verify-macos-package.mjs apps/desktop/release/mac-arm64/PI-Desktop.app
```
