import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateRuntime } from "./automation-runtime.mjs";

export const PYTHON_ARCHIVE_SHA256 = "144ee3fa0c4171f98ec554ac01bb44ee1e895d154609f143b1d20b52c3fe383e";
export const WHEELS = { playwright: "1.63.0", greenlet: "3.5.6", pyee: "13.0.1", typing_extensions: "4.16.0" };
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (data) => createHash("sha256").update(data).digest("hex");

export function pickWheel(metadata, name, version) {
  if (metadata.info?.version !== version) throw new Error(`PyPI version mismatch: ${name}`);
  const candidates = metadata.urls.filter(file => file.packagetype === "bdist_wheel" && !file.yanked &&
    /-(?:cp312-cp312-win_amd64|py3-none-win_amd64|py3-none-any|py2\.py3-none-any)\.whl$/.test(file.filename));
  if (candidates.length !== 1) throw new Error(`Expected one compatible wheel for ${name}==${version}`);
  const wheel = candidates[0];
  const url = new URL(wheel.url);
  if (url.protocol !== "https:" || url.hostname !== "files.pythonhosted.org" ||
      !/^[\w.+-]+\.whl$/.test(wheel.filename) || !/^[a-f0-9]{64}$/.test(wheel.digests?.sha256)) throw new Error(`Unsafe PyPI wheel metadata: ${name}`);
  return wheel;
}

export function checkedArchive(data, expected, label) {
  if (!/^[a-f0-9]{64}$/i.test(expected) || hash(data) !== expected.toLowerCase()) throw new Error(`${label} SHA-256 mismatch`);
  return data;
}

async function download(url) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${new URL(url).hostname}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) { last = error; }
  }
  throw last;
}
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: "inherit", timeout: 600000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed with ${result.status}`);
}
function expand(archive, destination) {
  mkdirSync(destination, { recursive: true });
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $env:PI_EXPAND_SOURCE -DestinationPath $env:PI_EXPAND_DESTINATION"], {
    env: { ...process.env, PI_EXPAND_SOURCE: archive, PI_EXPAND_DESTINATION: destination },
  });
}

export async function prepareRuntime(destination, buildPython = "python") {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Portable runtime provisioning requires Windows x64");
  if (existsSync(destination)) throw new Error("Runtime output already exists; use a fresh isolated directory");
  const helper = join(root, "custom/auto-codex-auth");
  const downloads = `${destination}-downloads`;
  mkdirSync(downloads, { recursive: true });
  mkdirSync(destination, { recursive: true });
  const provenance = [];
  const pythonUrl = "https://www.python.org/ftp/python/3.12.2/python-3.12.2-embed-amd64.zip";
  const pythonZip = join(downloads, "python.zip");
  writeFileSync(pythonZip, checkedArchive(await download(pythonUrl), PYTHON_ARCHIVE_SHA256, "Python embedded archive"));
  expand(pythonZip, join(destination, ".python-runtime"));
  provenance.push({ url: pythonUrl, sha256: PYTHON_ARCHIVE_SHA256 });
  const site = join(destination, ".python-runtime/Lib/site-packages");
  for (const [name, version] of Object.entries(WHEELS)) {
    const metadata = JSON.parse((await download(`https://pypi.org/pypi/${name}/${version}/json`)).toString("utf8"));
    const wheel = pickWheel(metadata, name, version);
    const file = join(downloads, wheel.filename);
    writeFileSync(file, checkedArchive(await download(wheel.url), wheel.digests.sha256, name));
    run(buildPython, ["-m", "pip", "install", "--disable-pip-version-check", "--no-deps", "--no-index", "--no-compile", "--target", site, file]);
    provenance.push({ package: `${name}==${version}`, url: wheel.url, sha256: wheel.digests.sha256 });
  }
  writeFileSync(join(destination, ".python-runtime/python312._pth"), "python312.zip\n.\nLib/site-packages\n..\n");
  const nodeAsset = "node-v24.22.2-win-x64.zip";
  const nodeBase = "https://nodejs.org/dist/v24.22.2/";
  const sums = (await download(`${nodeBase}SHASUMS256.txt`)).toString("utf8");
  const sum = sums.split(/\r?\n/).find(line => line.trim().endsWith(`  ${nodeAsset}`))?.split(/\s+/)[0];
  const nodeZip = join(downloads, "node.zip");
  writeFileSync(nodeZip, checkedArchive(await download(nodeBase + nodeAsset), sum ?? "", "Node archive"));
  const nodeExtract = join(downloads, "node");
  expand(nodeZip, nodeExtract);
  const nodeFolder = "node-v24.22.2-win-x64";
  mkdirSync(join(destination, ".node-runtime", nodeFolder), { recursive: true });
  for (const name of ["node.exe", "LICENSE"]) copyFileSync(join(nodeExtract, nodeFolder, name), join(destination, ".node-runtime", nodeFolder, name));
  provenance.push({ url: nodeBase + nodeAsset, sha256: sum });
  for (const name of ["package.json", "package-lock.json"]) copyFileSync(join(helper, name), join(destination, name));
  const env = { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true", PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PLAYWRIGHT_BROWSERS_PATH: join(destination, ".playwright-browsers") };
  const npmCli = join(nodeExtract, nodeFolder, "node_modules/npm/bin/npm-cli.js");
  run(process.execPath, [npmCli, "ci", "--prefix", destination, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], { env });
  run(join(destination, ".python-runtime/python.exe"), ["-m", "playwright", "install", "chromium"], { env });
  rmSync(join(destination, ".playwright-browsers/.links"), { recursive: true, force: true });
  const checked = validateRuntime(destination, helper, { probe: true });
  writeFileSync(join(destination, "download-provenance.json"), JSON.stringify(provenance, null, 2));
  console.log(`Prepared portable automation: ${checked.files.length} allowlisted files, inventory ${checked.digest}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Usage: node custom/prepare-runtime.mjs <fresh-output-directory> [build-python]");
  await prepareRuntime(resolve(destination), process.argv[3]);
}
