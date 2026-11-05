import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HELPER_SOURCES = ["codex_oauth.py", "turnstile_browser_bridge.js", "package.json", "package-lock.json", "pyproject.toml"];
export const PYTHON_PACKAGES = ["playwright", "playwright-1.63.0.dist-info", "greenlet", "greenlet-3.5.6.dist-info", "pyee", "pyee-13.0.1.dist-info", "typing_extensions.py", "typing_extensions-4.16.0.dist-info"];
export const PYTHON_FILES = "libcrypto-3.dll libffi-8.dll libssl-3.dll LICENSE.txt pyexpat.pyd python.cat python.exe python3.dll python312.dll python312.zip python312._pth pythonw.exe select.pyd sqlite3.dll unicodedata.pyd vcruntime140.dll vcruntime140_1.dll winsound.pyd _asyncio.pyd _bz2.pyd _ctypes.pyd _decimal.pyd _elementtree.pyd _hashlib.pyd _lzma.pyd _msi.pyd _multiprocessing.pyd _overlapped.pyd _queue.pyd _socket.pyd _sqlite3.pyd _ssl.pyd _uuid.pyd _wmi.pyd _zoneinfo.pyd".split(" ");
export const BROWSERS = ["chromium-1243", "chromium_headless_shell-1243", "ffmpeg-1011", "winldd-1007"];
const BLOCKED = /^(?:\.git|\.venv|\.env(?:\..*)?|\.links|__pycache__|\.cache|cache|profiles?|user[ _-]?data|号\.txt|auth\.json|tokens?\.json|credentials(?:\..*)?|.*\.py[co]|.*\.pth)$/i;
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function required(root, path) {
  const full = join(root, path);
  if (!existsSync(full) || !lstatSync(full).isFile() || lstatSync(full).size === 0) throw new Error(`Incomplete portable automation runtime: missing ${path}`);
  return full;
}

/** Enumerate only approved trees. Never follow junctions, editable installs, caches or profiles. */
export function runtimeFiles(root, helper) {
  const files = HELPER_SOURCES.map((path) => ({ path, source: required(helper, path) }));
  files.push({ path: "THIRD-PARTY-NOTICES.txt", source: fileURLToPath(new URL("./automation-notices.txt", import.meta.url)) });
  function visit(path) {
    const full = join(root, path);
    if (!existsSync(full)) throw new Error(`Incomplete portable automation runtime: missing ${path}`);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`Runtime links are not portable: ${path}`);
    const name = path.split("/").at(-1);
    if (BLOCKED.test(name)) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(full).sort()) {
        if (path.startsWith("node_modules/") && entry === "node_modules") continue;
        visit(`${path}/${entry}`);
      }
    } else if (stat.isFile()) files.push({ path, source: full });
    else throw new Error(`Unsupported runtime entry: ${path}`);
  }
  for (const name of PYTHON_FILES) visit(`.python-runtime/${name}`);
  for (const name of PYTHON_PACKAGES) visit(`.python-runtime/Lib/site-packages/${name}`);
  for (const name of ["node.exe", "LICENSE"]) visit(`.node-runtime/node-v24.22.2-win-x64/${name}`);
  for (const name of BROWSERS) visit(`.playwright-browsers/${name}`);
  const lock = json(join(helper, "package-lock.json"));
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (!/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(path)) throw new Error(`Unsafe npm lock path: ${path}`);
    if (metadata.optional && !existsSync(join(root, path))) continue;
    if (json(required(root, `${path}/package.json`)).version !== metadata.version) throw new Error(`Runtime npm version mismatch: ${path}`);
    visit(path);
  }
  // Keep a deterministic, duplicate-free inventory for release verification.
  return [...new Map(files.map((file) => [file.path, file])).values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export function validateRuntime(root, helper, { probe = false } = {}) {
  if (!root) throw new Error("Set PI_CUSTOM_AUTOMATION_RUNTIME to an approved prepared portable runtime; source-only installers are not supported.");
  const pth = readFileSync(required(root, ".python-runtime/python312._pth"), "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (JSON.stringify(pth) !== JSON.stringify(["python312.zip", ".", "Lib/site-packages", ".."])) throw new Error("Embedded Python must use only relative isolated python312._pth entries (no import site)");
  const browsers = json(required(root, ".python-runtime/Lib/site-packages/playwright/driver/package/browsers.json"));
  if (browsers.browsers.find((item) => item.name === "chromium")?.revision !== "1243") throw new Error("Playwright Chromium revision must be 1243");
  for (const [name, version] of [["playwright", "1.63.0"], ["greenlet", "3.5.6"], ["pyee", "13.0.1"], ["typing_extensions", "4.16.0"]]) {
    const base = `.python-runtime/Lib/site-packages/${name}-${version}.dist-info`;
    if (!readFileSync(required(root, `${base}/METADATA`), "utf8").includes(`Version: ${version}`)) throw new Error(`Python dependency version mismatch: ${name}`);
    const notices = readdirSync(join(root, base), { recursive: true }).filter((path) => /licen[cs]e|copying|notice/i.test(String(path)));
    if (!notices.length) throw new Error(`Missing dependency license: ${name}`);
  }
  for (const path of [".python-runtime/LICENSE.txt", ".node-runtime/node-v24.22.2-win-x64/LICENSE", ".playwright-browsers/chromium-1243/chrome-win64/chrome.exe", "node_modules/puppeteer-real-browser/lib/cjs/index.js"]) required(root, path);
  const files = runtimeFiles(root, helper);
  const inventory = files.map(({ path, source }) => ({ path, sha256: hash(source) }));
  const digest = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  if (process.env.PI_CUSTOM_AUTOMATION_SHA256 && process.env.PI_CUSTOM_AUTOMATION_SHA256 !== digest) throw new Error("Portable runtime inventory SHA-256 does not match PI_CUSTOM_AUTOMATION_SHA256");
  if (probe) {
    const env = { ...process.env, PATH: join(process.env.SystemRoot || "C:/Windows", "System32"), PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" };
    for (const key of ["PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "NODE_PATH"]) delete env[key];
    for (const [exe, args] of [
      [".python-runtime/python.exe", ["-c", "import sys,ssl,ctypes,greenlet,pyee,playwright; assert sys.version_info[:3] == (3,12,2)"]],
      [".node-runtime/node-v24.22.2-win-x64/node.exe", ["-e", "if(process.version!=='v24.22.2')process.exit(1);require('puppeteer-real-browser')"]],
    ]) {
      const result = spawnSync(join(root, exe), args, { cwd: root, env, encoding: "utf8", timeout: 30_000, windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`Portable runtime probe failed (${exe}): ${result.error?.message || result.stderr}`);
    }
  }
  return { files, inventory, digest };
}

export function assembleRuntime(root, helper, destination) {
  const { files, inventory, digest } = validateRuntime(root, helper, { probe: true });
  const expected = new Map(inventory.map((file) => [file.path, file.sha256]));
  for (const { path, source } of files) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    if (hash(target) !== expected.get(path)) throw new Error(`Runtime copy integrity failure: ${path}`);
  }
  writeFileSync(join(destination, "runtime-integrity.json"), JSON.stringify({ schemaVersion: 1, sha256: digest, files: inventory }, null, 2));
  return digest;
}
