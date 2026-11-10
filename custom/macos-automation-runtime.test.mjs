import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { HELPER_SOURCES, PYTHON_PACKAGES } from "./automation-runtime.mjs";
import { assembleMacRuntime, hasArm64, MAC_NODE, MAC_PINS, MAC_PYTHON, MAC_SITE, macProbeEnvironment, validateMacRuntime } from "./macos-automation-runtime.mjs";
import { checkedMacArchive, pickMacWheel, prepareMacRuntime, publishedChecksum, PYTHON_ASSET, PYTHON_SHA256 } from "./prepare-macos-runtime.mjs";

const helper = fileURLToPath(new URL("./auto-codex-auth", import.meta.url));
const chromium = ".playwright-browsers/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const temp = () => mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-mac-test-"));
const macho = Buffer.from("cffaedfe0c0000010000000000000000", "hex");
function fixture() {
  const root = temp();
  const put = (path, data = "fixture") => { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, data); chmodSync(full, 0o755); };
  for (const path of [MAC_PYTHON, MAC_NODE, `${MAC_SITE}/playwright/driver/node`, chromium]) put(path, macho);
  put(".python-runtime/lib/libpython3.12.dylib"); put(".python-runtime/lib/python3.12/LICENSE.txt");
  put(".python-runtime/lib/python3.12/ssl.py"); put(".node-runtime/node-v24.22.2-darwin-arm64/LICENSE");
  put(".python-runtime/lib/python3.12/http/cookies.py");
  put(".playwright-browsers/chromium-1243/chrome-mac-arm64/ABOUT");
  for (const name of PYTHON_PACKAGES) {
    const base = `${MAC_SITE}/${name}`;
    if (name.endsWith(".py")) put(base);
    else if (name.endsWith(".dist-info")) { put(`${base}/METADATA`, `Version: ${name.split("-")[1].replace(".dist", "")}\n`); put(`${base}/licenses/LICENSE`); }
    else put(`${base}/__init__.py`);
  }
  put(`${MAC_SITE}/playwright/driver/package/browsers.json`, JSON.stringify({ browsers: [{ name: "chromium", revision: "1243" }, { name: "chromium-headless-shell", revision: "1243" }, { name: "ffmpeg", revision: "1011" }] }));
  put(".playwright-browsers/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell", macho);
  put(".playwright-browsers/ffmpeg-1011/ffmpeg-mac", macho);
  const lock = JSON.parse(readFileSync(join(helper, "package-lock.json"), "utf8"));
  for (const [path, info] of Object.entries(lock.packages)) if (path && !info.optional && !info.dev) put(`${path}/package.json`, JSON.stringify({ version: info.version }));
  put("node_modules/puppeteer-real-browser/lib/cjs/index.js");
  put("node_modules/puppeteer-real-browser/LICENSE.md");
  return { root, put };
}

test("Mac inventory is deterministic, allowlisted, and sensitive/cache/editable inputs never ship", () => {
  const { root, put } = fixture();
  try {
    const baseline = validateMacRuntime(root, helper);
    for (const path of ["auth.json", "号.txt", ".env", "unlisted.js", ".python-runtime/bin/pip", `${MAC_SITE}/pip/__init__.py`, `${MAC_SITE}/playwright/editable.pth`, `${MAC_SITE}/playwright/credentials.json`, `${MAC_SITE}/playwright/__pycache__/x.pyc`, ".python-runtime/lib/python3.12/sitecustomize.py", "node_modules/puppeteer-real-browser/profile/auth.json", "node_modules/puppeteer-real-browser/node_modules/not-locked/index.js", ".playwright-browsers/.links/build-machine", ".playwright-browsers/chromium-1243/cache/private"]) put(path, "MUST-NOT-SHIP");
    for (const path of [".python-runtime/lib/libunapproved.dylib", `${MAC_SITE}/pyee-13.0.1.dist-info/direct_url.json`, "node_modules/puppeteer-real-browser/.npmrc", ".playwright-browsers/chromium-1243/Cookies"]) put(path, "MUST-NOT-SHIP");
    const checked = validateMacRuntime(root, helper);
    assert.equal(checked.digest, baseline.digest);
    assert.equal(checked.inventory.length, new Set(checked.inventory.map(f => f.path)).size);
    assert.ok(checked.inventory.every(f => /^[a-f0-9]{64}$/.test(f.sha256)));
    assert.ok(checked.files.some(f => f.path.endsWith("/http/cookies.py")));
    for (const path of HELPER_SOURCES) assert.equal(checked.files.find(f => f.path === path).source, join(helper, path));
    put(".python-runtime/lib/python3.12/ssl.py", "changed");
    assert.notEqual(validateMacRuntime(root, helper).digest, baseline.digest);
    assert.throws(() => assembleMacRuntime(root, helper, root), /must not exist/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing files, wrong pins, wrong architecture and missing licenses fail closed", () => {
  const { root, put } = fixture();
  try {
    put(MAC_NODE, "not a Mach-O"); assert.throws(() => validateMacRuntime(root, helper), /arm64/); put(MAC_NODE, macho);
    put(`${MAC_SITE}/pyee-13.0.1.dist-info/METADATA`, "Version: 1.0\n"); assert.throws(() => validateMacRuntime(root, helper), /version mismatch/);
    put(`${MAC_SITE}/pyee-13.0.1.dist-info/METADATA`, "Version: 13.0.1\n");
    rmSync(join(root, `${MAC_SITE}/pyee-13.0.1.dist-info/licenses`), { recursive: true }); assert.throws(() => validateMacRuntime(root, helper), /license/);
    put(`${MAC_SITE}/pyee-13.0.1.dist-info/licenses/LICENSE`);
    put(`${MAC_SITE}/playwright/driver/package/browsers.json`, JSON.stringify({ browsers: [{ name: "chromium", revision: "999" }] }));
    assert.throws(() => validateMacRuntime(root, helper), /revision/);
    rmSync(join(root, MAC_PYTHON)); assert.throws(() => validateMacRuntime(root, helper), /missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("framework links dereference internally; escaping links, root junctions and cycles fail", () => {
  const { root, put } = fixture(), outside = temp();
  const base = ".playwright-browsers/chromium-1243/framework";
  try {
    put(`${base}/Versions/A/Resources/fixture`);
    const current = join(root, base, "Versions/Current");
    symlinkSync(join(root, base, "Versions/A"), current, process.platform === "win32" ? "junction" : "dir");
    const files = validateMacRuntime(root, helper).files;
    const linkFile = files.find(f => f.path === `${base}/Versions/Current/Resources/fixture`);
    assert.ok(linkFile); assert.equal(lstatSync(linkFile.source).isSymbolicLink(), false);
    rmSync(current, { recursive: true }); symlinkSync(outside, current, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => validateMacRuntime(root, helper), /escapes approved/);
    rmSync(current, { recursive: true }); symlinkSync(join(root, base), current, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => validateMacRuntime(root, helper), /cycle/);
    rmSync(current, { recursive: true });
    const ffmpeg = join(root, ".playwright-browsers/ffmpeg-1011"); rmSync(ffmpeg, { recursive: true });
    symlinkSync(outside, ffmpeg, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => validateMacRuntime(root, helper), /escapes approved/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("provisioner pins published checksums and selects arm64 wheels without dependencies", async () => {
  const data = Buffer.from("archive"), sum = createHash("sha256").update(data).digest("hex");
  assert.equal(checkedMacArchive(data, sum, "fixture"), data);
  assert.throws(() => checkedMacArchive(data, "0".repeat(64), "fixture"), /SHA-256/);
  assert.equal(publishedChecksum(`${sum}  ${PYTHON_ASSET}\n`, PYTHON_ASSET), sum);
  assert.throws(() => publishedChecksum("", PYTHON_ASSET), /checksum/);
  assert.equal(PYTHON_SHA256.length, 64);
  const wheel = filename => ({ filename, packagetype: "bdist_wheel", url: `https://files.pythonhosted.org/${filename}`, digests: { sha256: sum } });
  const meta = { info: { version: "1.63.0" }, urls: [wheel("playwright-1.63.0-py3-none-macosx_11_0_universal2.whl"), wheel("playwright-1.63.0-py3-none-macosx_11_0_arm64.whl")] };
  assert.match(pickMacWheel(meta, "playwright", "1.63.0").filename, /arm64/);
  meta.urls = [wheel("playwright-1.63.0-py3-none-macosx_11_0_x86_64.whl")];
  assert.throws(() => pickMacWheel(meta, "playwright", "1.63.0"), /arm64/);
  assert.equal(macProbeEnvironment("/runtime").PYTHONPATH, undefined);
  assert.deepEqual(Object.keys(MAC_PINS), ["playwright", "greenlet", "pyee", "typing_extensions"]);
  if (process.platform !== "darwin" || process.arch !== "arm64") await assert.rejects(prepareMacRuntime("unused"), /native darwin-arm64/);
});

const prepared = process.env.PI_TEST_MACOS_AUTOMATION_ROOT;
test("native prepared runtime relocates to Unicode/spaces; synthetic validation, offline Chromium, Node bridge", { skip: !prepared ? "Set PI_TEST_MACOS_AUTOMATION_ROOT on Mac arm64" : process.platform !== "darwin" || process.arch !== "arm64" ? "Native darwin-arm64 required" : false, timeout: 240000 }, () => {
  const work = temp(), root = join(work, "迁移 有空格", "runtime");
  try {
    const checked = validateMacRuntime(prepared, helper, { probe: true });
    assert.equal(assembleMacRuntime(prepared, helper, root), checked.digest);
    validateMacRuntime(root, root, { probe: true });
    const manifest = JSON.parse(readFileSync(join(root, "runtime-integrity.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.sha256, checked.digest); assert.deepEqual(manifest.files, checked.inventory);
    for (const f of checked.files) { assert.equal(lstatSync(join(root, f.path)).isSymbolicLink(), false); assert.equal(lstatSync(join(root, f.path)).mode & 0o777, f.mode); }
    const credentials = join(work, "synthetic 账号.txt"); writeFileSync(credentials, "test@example.invalid----NotARealPassword123----JBSWY3DPEHPK3PXP\n");
    const env = { ...macProbeEnvironment(root), HOME: work, TMPDIR: work };
    const call = (exe, args) => spawnSync(join(root, exe), args, { cwd: root, env, encoding: "utf8", timeout: 90000 });
    let r = call(MAC_PYTHON, ["codex_oauth.py", "--validate-only", "--credentials-file", credentials]);
    assert.equal(r.status, 0, `${r.error || ""}\n${r.stderr}\n${r.stdout}`);
    const script = `import pathlib,sys,codex_oauth\nfrom playwright.sync_api import sync_playwright\nassert pathlib.Path(codex_oauth.__file__).parent == pathlib.Path.cwd()\nwith sync_playwright() as p:\n browser=p.chromium.launch(executable_path=p.chromium.executable_path,headless=True,args=['--no-first-run','--disable-background-networking'])\n context=browser.new_context(offline=True)\n page=context.new_page()\n page.set_content('<title>portable-offline-ok</title>')\n assert page.title()=='portable-offline-ok'\n browser.close()\n`;
    r = call(MAC_PYTHON, ["-c", script]); assert.equal(r.status, 0, `${r.error || ""}\n${r.stderr}`);
    r = call(MAC_NODE, ["-e", "require('puppeteer-real-browser')"]); assert.equal(r.status, 0, r.stderr);
    // Loading the real bridge without configuration must reach its argument validation, not module resolution failure.
    r = call(MAC_NODE, ["turnstile_browser_bridge.js"]); assert.equal(r.status, 1); assert.match(r.stderr, /missing base64url bridge configuration/);
    assert.equal(existsSync(join(root, "号.txt")), false);
    assert.ok(hasArm64(join(root, MAC_PYTHON)));
  } finally { rmSync(work, { recursive: true, force: true }); }
});
