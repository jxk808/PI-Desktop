import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { register } from "node:module";
import { HELPER_SOURCES, PYTHON_FILES, PYTHON_PACKAGES, BROWSERS, validateRuntime, assembleRuntime } from "./automation-runtime.mjs";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { resolveCodexAutomationRoots } = await import("../apps/desktop/electron/main/codex-batch-runtime.ts");
const { CodexBatchAutomation } = await import("../apps/desktop/electron/main/codex-batch-automation.ts");
const helper = fileURLToPath(new URL("./auto-codex-auth", import.meta.url));
const fixture = process.env.PI_TEST_AUTOMATION_ROOT;

test("resource-relative bundled root wins over explicit override on another drive", () => {
  assert.deepEqual(resolveCodexAutomationRoots({ resourcesPath: "D:\\应用 有空格\\resources", overrideRoot: "E:\\manual runtime" }), ["D:\\应用 有空格\\resources\\codex-automation", "E:\\manual runtime"]);
  assert.deepEqual(resolveCodexAutomationRoots({}), []);
});
test("helper source allowlist contains no deployment scripts or wildcard source globs", () => {
  assert.deepEqual(HELPER_SOURCES, ["codex_oauth.py", "turnstile_browser_bridge.js", "package.json", "package-lock.json", "pyproject.toml"]);
  assert.throws(() => validateRuntime(undefined, helper), /PI_CUSTOM_AUTOMATION_RUNTIME/);
  assert.throws(() => validateRuntime(join(helper, "not-a-runtime"), helper), /missing .python-runtime\/python312._pth/);
});

test("prepared input validation excludes unrelated code, secrets, editable installs and caches", () => {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "runtime-input-test-"));
  const put = (path, text = "fixture") => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  try {
    for (const name of PYTHON_FILES) put(`.python-runtime/${name}`);
    put(".python-runtime/python312._pth", "python312.zip\n.\nLib/site-packages\n..\n");
    for (const name of PYTHON_PACKAGES) {
      const base = `.python-runtime/Lib/site-packages/${name}`;
      if (name.endsWith(".py")) put(base);
      else if (name.endsWith(".dist-info")) {
        put(`${base}/METADATA`, `Version: ${name.split("-")[1]}\n`);
        put(`${base}/licenses/LICENSE`);
      } else put(`${base}/__init__.py`);
    }
    put(".python-runtime/Lib/site-packages/playwright/driver/package/browsers.json", JSON.stringify({ browsers: [{ name: "chromium", revision: "1243" }] }));
    for (const name of BROWSERS) put(`.playwright-browsers/${name}/fixture`);
    put(".playwright-browsers/chromium-1243/chrome-win64/chrome.exe");
    for (const name of ["node.exe", "LICENSE"]) put(`.node-runtime/node-v24.22.2-win-x64/${name}`);
    const lock = JSON.parse(readFileSync(join(helper, "package-lock.json"), "utf8"));
    for (const [path, metadata] of Object.entries(lock.packages)) {
      if (path && !metadata.optional) put(`${path}/package.json`, JSON.stringify({ version: metadata.version }));
    }
    put("node_modules/puppeteer-real-browser/lib/cjs/index.js");
    for (const path of ["号.txt", "auth.json", "codex_oauth.py", "unlisted.py", ".git/config", ".venv/Scripts/python.exe", "node_modules/unlisted/index.js", ".python-runtime/Lib/site-packages/unlisted.py", ".python-runtime/Lib/site-packages/playwright/editable.pth", ".python-runtime/Lib/site-packages/playwright/__pycache__/test.pyc", ".playwright-browsers/.links/developer", "node_modules/puppeteer-real-browser/profile/auth.json", "node_modules/puppeteer-real-browser/node_modules/unlisted/index.js"]) put(path, "must-not-ship");
    const { files } = validateRuntime(root, helper);
    assert.ok(files.every(({ source }) => readFileSync(source, "utf8") !== "must-not-ship"));
    assert.equal(files.find(({ path }) => path === "codex_oauth.py").source, join(helper, "codex_oauth.py"));
    put(".python-runtime/python312._pth", "C:\\system-python\nimport site\n");
    assert.throws(() => validateRuntime(root, helper), /relative isolated/);
    put(".python-runtime/python312._pth", "python312.zip\n.\nLib/site-packages\n..\n");
    rmSync(join(root, ".node-runtime/node-v24.22.2-win-x64/node.exe"));
    assert.throws(() => validateRuntime(root, helper), /missing .node-runtime/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("optional prepared runtime: staged relocated Python selection, Chromium and Node without PATH dependencies", { skip: !fixture && "Set PI_TEST_AUTOMATION_ROOT to the approved portable fixture", timeout: 240_000 }, async () => {
  const temporary = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "portable-source-test-"));
  const root = join(temporary, "迁移 有空格", "resources", "codex-automation");
  try {
    const checked = validateRuntime(fixture, helper);
    assert.ok(checked.files.some((file) => file.path === ".python-runtime/LICENSE.txt"));
    assert.ok(checked.files.some((file) => /playwright.*licenses/.test(file.path)));
    assert.ok(checked.files.every(({ path }) => !/(?:^|\/)(?:__pycache__|\.git|\.venv|\.links|号\.txt|auth\.json)(?:\/|$)|\.pth$/.test(path)));
    const digest = assembleRuntime(fixture, helper, root);
    assert.equal(digest, checked.digest);
    const manifest = JSON.parse(readFileSync(join(root, "runtime-integrity.json"), "utf8"));
    assert.equal(manifest.sha256, digest);
    assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
    const credentials = join(temporary, "账号 文件", "synthetic.txt");
    mkdirSync(dirname(credentials), { recursive: true });
    writeFileSync(credentials, "test@example.invalid----NotARealPassword123----JBSWY3DPEHPK3PXP\n");
    writeFileSync(join(dirname(credentials), "codex_oauth.py"), "raise RuntimeError('untrusted adjacent code')\n");
    const env = { ...process.env, PATH: join(process.env.SystemRoot, "System32"), PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" };
    for (const key of ["PI_CODEX_AUTOMATION_ROOT", "PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "NODE_PATH", "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "PLAYWRIGHT_BROWSERS_PATH"]) delete env[key];
    const calls = [];
    const automation = new CodexBatchAutomation({
      helperRoots: resolveCodexAutomationRoots({ resourcesPath: dirname(root) }),
      pickCredentialsFile: async () => credentials,
      spawnHelper: (exe, args, options) => {
        calls.push(exe);
        return spawn(exe, args, { ...options, env, stdio: ["ignore", "pipe", "pipe"] });
      },
    });
    const selected = await automation.select();
    assert.equal(selected.total, 1);
    assert.deepEqual(calls, [join(root, ".python-runtime/python.exe")]);
    await automation.finish(selected.batchId);
    const probe = `import sys, pathlib, codex_oauth\nfrom playwright.sync_api import sync_playwright\nroot=pathlib.Path(codex_oauth.__file__).parent\nassert all(str(root).lower() in p.lower() for p in sys.path), sys.path\ncodex_oauth.configure_project_playwright_browser_path()\nwith sync_playwright() as p:\n browser=p.chromium.launch(executable_path=codex_oauth.select_playwright_chromium_executable(p.chromium),headless=True)\n page=browser.new_page()\n page.set_content('<title>portable-ok</title>')\n assert page.title()=='portable-ok'\n browser.close()\n`;
    for (const [exe, args] of [
      [".python-runtime/python.exe", ["-c", probe]],
      [".node-runtime/node-v24.22.2-win-x64/node.exe", ["-e", "require('puppeteer-real-browser')"]],
    ]) {
      const result = spawnSync(join(root, exe), args, { cwd: root, env, encoding: "utf8", timeout: 60_000 });
      assert.equal(result.status, 0, `${result.error || ""}\n${result.stderr}\n${result.stdout}`);
    }
    assert.equal(existsSync(join(root, "号.txt")), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
