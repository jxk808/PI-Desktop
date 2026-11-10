import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HELPER_SOURCES, PYTHON_PACKAGES } from "./automation-runtime.mjs";

export const MAC_PYTHON = ".python-runtime/bin/python3";
export const MAC_SITE = ".python-runtime/lib/python3.12/site-packages";
export const MAC_NODE = ".node-runtime/node-v24.22.2-darwin-arm64/bin/node";
export const MAC_PINS = { playwright: "1.63.0", greenlet: "3.5.6", pyee: "13.0.1", typing_extensions: "4.16.0" };
const BLOCKED = /^(?:\.git|\.venv|\.env(?:\..*)?|\.links|\.ssh|\.aws|\.npmrc|\.pypirc|\.DS_Store|__pycache__|\.cache|caches?|profiles?(?: \d+)?|user[ _-]?data|sessions?(?:\.(?:json|sqlite|txt))?|cookies?(?:\.(?:json|sqlite|txt))?|Login Data|Local State|storage[ _-]?state(?:\.json)?|号\.txt|auth\.json|tokens?\.json|credentials(?:\.(?:json|txt|yaml|yml|ini))?|.*\.(?:py[co]|pth|egg-link|pem|key|log)|direct_url\.json|sitecustomize\.py|usercustomize\.py)$/i;
const json = path => JSON.parse(readFileSync(path, "utf8"));
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const inside = (base, path) => { const r = relative(base, path); return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !/^(?:[A-Za-z]:|\/|\\)/.test(r)); };

// Read fat or thin Mach-O headers without executing untrusted inputs. Universal2 is OK.
export function hasArm64(path) {
  const b = readFileSync(path);
  if (b.length < 8) return false;
  if (b.readUInt32LE(0) === 0xfeedfacf) return b.readUInt32LE(4) === 0x0100000c;
  const magic = b.readUInt32BE(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false;
  const count = b.readUInt32BE(4), stride = magic === 0xcafebabf ? 32 : 20;
  if (count > 64 || b.length < 8 + count * stride) return false;
  for (let i = 0; i < count; i++) if (b.readUInt32BE(8 + i * stride) === 0x0100000c) return true;
  return false;
}

export function macProbeEnvironment(root) {
  // Do not inherit Python/Node injection, browser overrides, proxy auth or login state.
  const env = { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: process.env.TMPDIR || "/tmp", LANG: "en_US.UTF-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PLAYWRIGHT_BROWSERS_PATH: join(root, ".playwright-browsers") };
  return env;
}
function run(root, exe, args) {
  const r = spawnSync(join(root, exe), args, { cwd: root, env: macProbeEnvironment(root), encoding: "utf8", timeout: 60000 });
  if (r.error || r.status !== 0) throw new Error(`Mac runtime probe failed (${exe}): ${r.error?.message || r.stderr}`);
  return r.stdout.trim();
}

export function validateMacRuntime(root, helper, { probe = false } = {}) {
  if (!root) throw new Error("Set PI_CUSTOM_AUTOMATION_RUNTIME to a prepared macOS arm64 runtime");
  root = realpathSync(resolve(root)); helper = resolve(helper);
  const files = new Map();
  // Every traversed link must stay inside its approved component, including intermediate links.
  function visit(path, base, trail = new Set(), prune = () => false) {
    const full = join(root, path);
    if (path.split("/").some(part => BLOCKED.test(part)) || prune(path)) return;
    if (!existsSync(full)) throw new Error(`Incomplete Mac runtime: missing ${path}`);
    const actual = realpathSync(full), approved = join(root, base);
    if (!inside(root, approved) || !inside(approved, actual)) throw new Error(`Runtime link escapes approved root: ${path}`);
    const actualRelative = relative(root, actual).split(sep).join("/");
    if (actualRelative.split("/").some(part => BLOCKED.test(part)) || prune(actualRelative)) throw new Error(`Runtime link targets excluded input: ${path}`);
    const stat = statSync(actual);
    if (stat.isDirectory()) {
      if (trail.has(actual)) throw new Error(`Runtime link cycle: ${path}`);
      const next = new Set(trail).add(actual);
      for (const name of readdirSync(actual).sort()) visit(`${path}/${name}`, base, next, prune);
    } else if (stat.isFile()) files.set(path, { path, source: actual, mode: stat.mode & 0o777 });
    else throw new Error(`Unsupported runtime entry: ${path}`);
  }
  function required(path) {
    const f = files.get(path);
    if (!f || !statSync(f.source).size) throw new Error(`Incomplete Mac runtime: missing ${path}`);
    return f.source;
  }
  for (const path of HELPER_SOURCES) {
    const source = join(helper, path);
    if (!lstatSync(source).isFile() || !statSync(source).size) throw new Error(`Missing regular helper source: ${path}`);
    files.set(path, { path, source, mode: statSync(source).mode & 0o777 });
  }
  const notices = fileURLToPath(new URL("./automation-notices.txt", import.meta.url));
  files.set("THIRD-PARTY-NOTICES.txt", { path: "THIRD-PARTY-NOTICES.txt", source: notices, mode: 0o644 });
  visit(MAC_PYTHON, ".python-runtime/bin");
  visit(".python-runtime/lib/python3.12", ".python-runtime/lib/python3.12", new Set(), path => path === MAC_SITE || path.startsWith(`${MAC_SITE}/`));
  // Exact dynamic-library allowlist from the pinned standalone distribution.
  for (const name of ["libpython3.12.dylib", "libtcl9.0.dylib", "libtcl9tk9.0.dylib"]) {
    const path = `.python-runtime/lib/${name}`;
    if (name === "libpython3.12.dylib" || existsSync(join(root, path))) visit(path, path);
  }
  for (const name of PYTHON_PACKAGES) visit(`${MAC_SITE}/${name}`, `${MAC_SITE}/${name}`);
  for (const path of [MAC_NODE, ".node-runtime/node-v24.22.2-darwin-arm64/LICENSE"]) visit(path, ".node-runtime/node-v24.22.2-darwin-arm64");
  const browserMetadata = json(required(`${MAC_SITE}/playwright/driver/package/browsers.json`));
  const browserRoots = [];
  for (const name of ["chromium", "chromium-headless-shell", "ffmpeg"]) {
    const entry = browserMetadata.browsers?.find(b => b.name === name);
    if (!entry || !/^\d+$/.test(entry.revision) || (name.startsWith("chromium") && entry.revision !== "1243") || (name === "ffmpeg" && entry.revision !== "1011")) throw new Error(`Invalid pinned browser revision: ${name}`);
    const path = `.playwright-browsers/${name.replaceAll("-", "_")}-${entry.revision}`;
    visit(path, path); browserRoots.push(path);
  }
  const lock = json(join(helper, "package-lock.json"));
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (!/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(path) || path.split("/").some(p => p === "." || p === ".." || p.includes("\\"))) throw new Error(`Unsafe npm lock path: ${path}`);
    if (metadata.dev || (metadata.optional && !existsSync(join(root, path)))) continue;
    visit(path, path, new Set(), p => p.startsWith(`${path}/node_modules/`) || p === `${path}/node_modules`);
    if (json(required(`${path}/package.json`)).version !== metadata.version) throw new Error(`Runtime npm version mismatch: ${path}`);
  }
  required("node_modules/puppeteer-real-browser/lib/cjs/index.js");
  required("node_modules/puppeteer-real-browser/LICENSE.md");
  required(".python-runtime/lib/python3.12/LICENSE.txt");
  required(".python-runtime/lib/libpython3.12.dylib");
  for (const [name, version] of Object.entries(MAC_PINS)) {
    const base = `${MAC_SITE}/${name}-${version}.dist-info`;
    if (!readFileSync(required(`${base}/METADATA`), "utf8").split(/\r?\n/).includes(`Version: ${version}`)) throw new Error(`Python dependency version mismatch: ${name}`);
    if (![...files.keys()].some(path => path.startsWith(`${base}/`) && /(?:license|licence|copying|notice)/i.test(path.slice(base.length)))) throw new Error(`Missing dependency license: ${name}`);
  }
  const chromium = [...files.keys()].filter(p => p.startsWith(`${browserRoots[0]}/`) && /\.app\/Contents\/MacOS\/(?:Chromium|Google Chrome for Testing)$/.test(p));
  if (chromium.length !== 1) throw new Error("Expected one mac-arm64 Chromium application executable");
  if (![...files.keys()].some(p => p.startsWith(`${browserRoots[0]}/`) && /\/(?:ABOUT|LICENSE(?:\.[^/]*)?|credits\.html)$/i.test(p))) throw new Error("Missing Chromium license notices");
  const headless = [...files.keys()].filter(p => p.startsWith(`${browserRoots[1]}/`) && p.endsWith("/chrome-headless-shell"));
  if (headless.length !== 1) throw new Error("Missing mac-arm64 Chromium headless shell");
  for (const path of [MAC_PYTHON, MAC_NODE, `${MAC_SITE}/playwright/driver/node`, chromium[0], headless[0], `${browserRoots[2]}/ffmpeg-mac`]) {
    if (!hasArm64(required(path))) throw new Error(`Expected arm64 Mach-O executable: ${path}`);
    if (process.platform !== "win32" && !(files.get(path).mode & 0o111)) throw new Error(`Missing executable mode: ${path}`);
  }
  const sorted = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
  const inventory = sorted.map(({ path, source }) => ({ path, sha256: hash(source) }));
  const digest = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  if (process.env.PI_CUSTOM_AUTOMATION_SHA256 && process.env.PI_CUSTOM_AUTOMATION_SHA256 !== digest) throw new Error("Mac runtime inventory SHA-256 mismatch");
  if (probe) {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Mac runtime probes require native darwin-arm64");
    const output = run(root, MAC_PYTHON, ["-c", "import sys,platform,ssl,ctypes,greenlet,pyee,playwright,codex_oauth,json; from playwright.sync_api import sync_playwright; assert sys.version_info[:3]==(3,12,16); assert platform.machine()=='arm64'; p=sync_playwright().start(); print(json.dumps(p.chromium.executable_path)); p.stop()"]);
    if (resolve(JSON.parse(output.split(/\r?\n/).at(-1))) !== resolve(root, chromium[0])) throw new Error("Playwright executable_path does not match approved mac-arm64 Chromium");
    run(root, MAC_NODE, ["-e", "if(process.version!=='v24.22.2'||process.arch!=='arm64')process.exit(1);require('puppeteer-real-browser')"]);
  }
  return { files: sorted, inventory, digest };
}

export function assembleMacRuntime(root, helper, destination) {
  if (existsSync(destination)) throw new Error("Mac runtime destination must not exist");
  const { files, inventory, digest } = validateMacRuntime(root, helper, { probe: true });
  const expected = new Map(inventory.map(f => [f.path, f.sha256]));
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  mkdirSync(destination); // Exclusive claim: never merge into a pre-existing tree.
  try {
    for (const { path, source, mode } of files) {
      const target = join(destination, path);
      mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target); chmodSync(target, mode);
      if (hash(target) !== expected.get(path)) throw new Error(`Mac runtime copy integrity failure: ${path}`);
    }
    writeFileSync(join(destination, "runtime-integrity.json"), JSON.stringify({ schemaVersion: 1, sha256: digest, files: inventory }, null, 2));
    return digest;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
