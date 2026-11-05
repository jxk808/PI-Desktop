# Portable Codex automation build inputs

This Windows x64 distribution uses an explicitly approved prepared runtime, not an on-target installer and not a committed binary payload. Never point the assembler at a working account/profile directory. A clean prepared root can be reused across builds; current helper source always comes from this checkout, never from that root.

## Pinned layout

```text
codex-automation/
  .python-runtime/                     official Python 3.12.2 embedded x64
    python.exe, python312.dll, python312.zip, LICENSE.txt, DLL/PYD support files
    python312._pth
    Lib/site-packages/
      playwright/                     1.63.0, including driver and notices
      greenlet/                       3.5.6
      pyee/                           13.0.1
      typing_extensions.py            4.16.0
      <each pinned package>.dist-info/ (metadata and licenses)
  .node-runtime/node-v24.22.2-win-x64/
    node.exe
    LICENSE
  .playwright-browsers/
    chromium-1243/                    chrome-win64/chrome.exe and support files
    chromium_headless_shell-1243/
    ffmpeg-1011/
    winldd-1007/
  node_modules/                       browser bridge's locked npm dependencies
```

The helper's five explicitly listed source/metadata files are added by assembly, along with `THIRD-PARTY-NOTICES.txt` and a generated `runtime-integrity.json`. Python `.dist-info` license directories, Playwright driver notices, Node LICENSE and npm package licenses are retained. Chromium's resources/notices remain in its distribution tree. The private helper's upstream public redistribution permission is unconfirmed; do not publish this distribution without authorization.

## Preparing a clean runtime on a build machine

Use either an independently validated prepared root with this exact layout or provision a new clean directory as follows. Downloads and build Python/npm are **build-time only**. Do not use editable installs, copy `.venv`, or copy a complete developer workspace. Preserve archive/wheel provenance and official checksums in your release evidence; inventory hashing detects changes but is not a substitute for authenticating downloads.

1. Download `https://www.python.org/ftp/python/3.12.2/python-3.12.2-embed-amd64.zip` from the official Python release and verify its published provenance/checksum. Extract into `.python-runtime`. Keep the official license, standard library archive and support DLL/PYD files. Do not substitute the Windows venv launcher.
2. Using a separate Windows x64 Python 3.12 build interpreter and pip, install pinned wheels into the embedded interpreter's `Lib/site-packages`:

   ```powershell
   & $BuildPython -m pip install --only-binary=:all: --no-compile --no-deps `
     --target "$Runtime\.python-runtime\Lib\site-packages" `
     playwright==1.63.0 greenlet==3.5.6 pyee==13.0.1 typing_extensions==4.16.0
   ```

   `$BuildPython` and `$Runtime` are explicit operator-selected paths. Retain each wheel's `.dist-info` metadata/licenses. No pip, setuptools, project editable-install `.pth` or build interpreter files are shipped.
3. Replace `python312._pth` with exactly these relative entries, without `import site`:

   ```text
   python312.zip
   .
   Lib/site-packages
   ..
   ```

4. Download `https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip`; verify the archive against the official signed `SHASUMS256.txt`. Extract **only** `node.exe` and `LICENSE` into `.node-runtime/node-v24.22.2-win-x64`. Playwright also retains its own driver Node binary from its wheel.
5. Install matching browsers with the embedded Python (this step downloads only on the build machine):

   ```powershell
   $env:PLAYWRIGHT_BROWSERS_PATH = "$Runtime\.playwright-browsers"
   & "$Runtime\.python-runtime\python.exe" -m playwright install chromium
   ```

   Confirm Chromium revision `1243` against the pinned wheel's `playwright/driver/package/browsers.json`. Retain the full Chromium/headless-shell/ffmpeg/winldd distribution trees above, not browser profiles or Playwright `.links` build-machine references.
6. Copy only `custom/auto-codex-auth/package.json` and its existing `package-lock.json` to the prepared root. With build-machine npm, run `npm --prefix $Runtime ci --ignore-scripts --omit=dev` and `PUPPETEER_SKIP_DOWNLOAD=true`. Do not regenerate the lockfile. The assembler includes only lockfile-listed packages, checks installed versions and excludes `.bin`, hidden npm cache metadata and unlisted packages. Optional packages absent on Windows are permitted; nonoptional packages are required.
7. Set `PI_CUSTOM_AUTOMATION_RUNTIME` to this root and run `node custom/build.mjs --check`. Review its printed inventory SHA-256; optionally enforce it with `PI_CUSTOM_AUTOMATION_SHA256`. This digest includes the current allowlisted helper source and notices, so source changes require a newly reviewed digest. Run the fixture integration test in `README.md` before release.

The assembler rejects symbolic links within included trees and excludes caches, profiles, credentials, tokens, editable `.pth` files and bytecode caches. Root-level files are never recursively copied. Treat prepared dependencies as executable build inputs, not as untrusted user uploads. Input validation is offline and never reads account files; integration tests create only synthetic credentials in temporary scratch storage. Generated staging and manifests belong in build artifacts, not git.

## Migration acceptance

Verify an actual installer/extracted resource tree after packaging: dot-prefixed runtime directories must be present outside ASAR, launch from a moved Unicode/spaces path with no system Python/Node in PATH, select a synthetic account file on another drive, and confirm a clear reinstall error when a required component is missing. The optional source test exercises real embedded Python `select()` / `--validate-only`, bundled headless Chromium on local HTML and bundled Node imports, but is not a replacement for final installer E2E or live OAuth acceptance.
