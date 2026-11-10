import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { HELPER_SOURCES } from "./automation-runtime.mjs";
import { assembleMacRuntime, MAC_NODE, MAC_PINS, MAC_PYTHON, MAC_SITE, macProbeEnvironment, validateMacRuntime } from "./macos-automation-runtime.mjs";

// Confirmed via GitHub releases API and the release's SHA256SUMS (not a moving latest URL).
export const PYTHON_RELEASE = "20261026";
export const PYTHON_ASSET = "cpython-3.12.16+20261026-aarch64-apple-darwin-install_only.tar.gz";
export const PYTHON_SHA256 = "fbf4afef53c2a6b72bb741bc06d5671a9dfaf87bd84e5aa73ac9b3d0d589f14e";
const PYTHON_BASE = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/`;
const NODE_FOLDER = "node-v24.22.2-darwin-arm64";
export const NODE_SHA256 = "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a";
const helper = fileURLToPath(new URL("./auto-codex-auth", import.meta.url));

export function checkedMacArchive(data, expected, label) {
  if (!/^[a-f0-9]{64}$/.test(expected || "") || createHash("sha256").update(data).digest("hex") !== expected) throw new Error(`${label} SHA-256 mismatch`);
  return data;
}
export function publishedChecksum(text, filename) {
  const hits = text.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line)).filter(m => m?.[2] === filename);
  if (hits.length !== 1) throw new Error(`Missing or ambiguous published checksum: ${filename}`);
  return hits[0][1];
}
export function pickMacWheel(metadata, name, version) {
  if (metadata.info?.version !== version) throw new Error(`PyPI version mismatch: ${name}`);
  // Prefer native arm64 over universal2, both ahead of pure Python. Never accept x86-only wheels.
  const rank = filename => /-(?:cp312-cp312|py3-none)-macosx_\d+_\d+_arm64\.whl$/.test(filename) ? 0 : /-(?:cp312-cp312|py3-none)-macosx_\d+_\d+_universal2\.whl$/.test(filename) ? 1 : /-(?:py3|py2\.py3)-none-any\.whl$/.test(filename) ? 2 : 99;
  const candidates = (metadata.urls || []).filter(w => w.packagetype === "bdist_wheel" && !w.yanked && rank(w.filename) < 99).sort((a, b) => rank(a.filename) - rank(b.filename));
  const wheel = candidates[0];
  if (!wheel || (candidates[1] && rank(wheel.filename) === rank(candidates[1].filename))) throw new Error(`Expected one preferred arm64 wheel: ${name}`);
  const url = new URL(wheel.url);
  if (url.protocol !== "https:" || url.hostname !== "files.pythonhosted.org" || !/^[\w.+-]+\.whl$/.test(wheel.filename) || !/^[a-f0-9]{64}$/.test(wheel.digests?.sha256 || "")) throw new Error(`Unsafe PyPI wheel metadata: ${name}`);
  return wheel;
}
async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(240000), headers: { "User-Agent": "PI-Desktop-mac-runtime-provisioner" } });
  if (!r.ok) throw new Error(`Download HTTP ${r.status}: ${url}`);
  return Buffer.from(await r.arrayBuffer());
}
function run(exe, args, options = {}) {
  const r = spawnSync(exe, args, { stdio: "inherit", timeout: 600000, ...options });
  if (r.error || r.status !== 0) throw new Error(`${exe} failed: ${r.error?.message || r.status}`);
}
async function archive(url, sum, path) {
  writeFileSync(path, checkedMacArchive(await download(url), sum, url));
}

// Usage: node custom/prepare-macos-runtime.mjs <fresh-output-directory>
// The output is a runnable, dereferenced, allowlisted runtime, not an installer stub.
export async function prepareMacRuntime(destination) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Mac runtime provisioning requires native darwin-arm64");
  destination = resolve(destination);
  if (existsSync(destination)) throw new Error("Runtime output already exists; choose a fresh directory");
  const work = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-mac-provision-"));
  const stage = join(work, "stage"), output = join(work, "output");
  mkdirSync(stage); const provenance = [];
  try {
    const sumsUrl = PYTHON_BASE + "SHA256SUMS";
    const sum = publishedChecksum((await download(sumsUrl)).toString("utf8"), PYTHON_ASSET);
    if (sum !== PYTHON_SHA256) throw new Error("Published Python checksum differs from pinned release");
    const pythonUrl = PYTHON_BASE + encodeURIComponent(PYTHON_ASSET), pyArchive = join(work, "python.tar.gz");
    await archive(pythonUrl, sum, pyArchive);
    run("/usr/bin/tar", ["-xzf", pyArchive, "-C", stage]);
    renameSync(join(stage, "python"), join(stage, ".python-runtime"));
    provenance.push({ release: PYTHON_RELEASE, asset: PYTHON_ASSET, url: pythonUrl, checksumsUrl: sumsUrl, sha256: sum });
    const nodeBase = "https://nodejs.org/dist/v24.22.2/", nodeAsset = `${NODE_FOLDER}.tar.gz`;
    const nodeSum = publishedChecksum((await download(nodeBase + "SHASUMS256.txt")).toString("utf8"), nodeAsset);
    if (nodeSum !== NODE_SHA256) throw new Error("Published Node checksum differs from pinned release");
    const nodeArchive = join(work, "node.tar.gz"); await archive(nodeBase + nodeAsset, nodeSum, nodeArchive);
    mkdirSync(join(stage, ".node-runtime"));
    run("/usr/bin/tar", ["-xzf", nodeArchive, "-C", join(stage, ".node-runtime")]);
    provenance.push({ url: nodeBase + nodeAsset, checksumsUrl: nodeBase + "SHASUMS256.txt", sha256: nodeSum });
    const env = { ...macProbeEnvironment(stage), HOME: join(work, "home"), TMPDIR: work, PUPPETEER_SKIP_DOWNLOAD: "true", npm_config_cache: join(work, "npm-cache") };
    mkdirSync(env.HOME);
    for (const [name, version] of Object.entries(MAC_PINS)) {
      const metadata = JSON.parse((await download(`https://pypi.org/pypi/${name}/${version}/json`)).toString("utf8"));
      const wheel = pickMacWheel(metadata, name, version), path = join(work, wheel.filename);
      await archive(wheel.url, wheel.digests.sha256, path);
      run(join(stage, MAC_PYTHON), ["-m", "pip", "install", "--disable-pip-version-check", "--no-deps", "--no-index", "--no-compile", "--target", join(stage, MAC_SITE), path], { cwd: stage, env });
      provenance.push({ package: `${name}==${version}`, url: wheel.url, sha256: wheel.digests.sha256 });
    }
    for (const name of HELPER_SOURCES) copyFileSync(join(helper, name), join(stage, name));
    const npm = join(stage, ".node-runtime", NODE_FOLDER, "lib/node_modules/npm/bin/npm-cli.js");
    run(join(stage, MAC_NODE), [npm, "ci", "--prefix", stage, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], { cwd: stage, env });
    run(join(stage, MAC_PYTHON), ["-m", "playwright", "install", "chromium"], { cwd: stage, env });
    const digest = assembleMacRuntime(stage, helper, output);
    // Probe the stripped runtime, not just the larger build-time Python/Node distributions.
    validateMacRuntime(output, output, { probe: true });
    writeFileSync(join(output, "download-provenance.json"), JSON.stringify(provenance, null, 2));
    mkdirSync(dirname(destination), { recursive: true });
    // Copy across volumes using the same checked assembler; no build tools survive.
    assembleMacRuntime(output, output, destination);
    copyFileSync(join(output, "download-provenance.json"), join(destination, "download-provenance.json"));
    console.log(`Prepared macOS arm64 portable automation: ${digest}`);
    return digest;
  } finally { rmSync(work, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node custom/prepare-macos-runtime.mjs <fresh-output-directory>");
  await prepareMacRuntime(process.argv[2]);
}
