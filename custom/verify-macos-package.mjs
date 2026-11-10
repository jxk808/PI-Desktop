import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyPackagedRuntime } from "./packaged-runtime.mjs";
import { validateMacRuntime } from "./macos-automation-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
function run(exe, args, options = {}) {
  const result = spawnSync(exe, args, { encoding: "utf8", timeout: 60_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${exe} failed: ${result.error?.message || result.stderr}`);
  return result.stdout.trim();
}
function equal(first, second) {
  if (!existsSync(second) || hash(first) !== hash(second)) throw new Error(`Packaged source mismatch: ${second}`);
}
export function verifyMacosPackage(app, sourceRoot = root) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Verification requires native macOS arm64");
  const resources = join(app, "Contents/Resources");
  const automation = join(resources, "codex-automation");
  const runtimeFiles = verifyPackagedRuntime(automation);
  validateMacRuntime(automation, join(sourceRoot, "custom/auto-codex-auth"), { probe: true });
  const plugin = "io.github.czp0312.subscription-quota";
  const pluginDir = join(resources, "plugins", plugin);
  const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
  if (manifest.id !== plugin || !manifest.permissions.includes("models.usage")) throw new Error("Quota plugin permission/identity missing");
  for (const name of ["main.js", "manifest.json", "LICENSE", "views/quota.html"]) equal(join(sourceRoot, "custom/subscription-quota", name), join(pluginDir, name));
  const host = join(resources, "bin/pi-desktop-host-core");
  equal(join(sourceRoot, "target/release/pi-desktop-host-core"), host);
  equal(join(sourceRoot, "packages/agent-runtime/dist-bundle/sidecar.js"), join(resources, "agent-runtime/sidecar.js"));
  for (const executable of [join(app, "Contents/MacOS/PI-Desktop"), host, join(automation, ".python-runtime/bin/python3"), join(automation, ".node-runtime/node-v24.22.2-darwin-arm64/bin/node")]) {
    if (!(statSync(executable).mode & 0o111)) throw new Error(`Executable mode missing: ${executable}`);
    if (!run("/usr/bin/lipo", ["-archs", executable]).split(/\s+/).includes("arm64")) throw new Error(`arm64 missing: ${executable}`);
  }
  // Execute only a bounded Node-mode probe, never the user's installed desktop/profile.
  const electron = join(app, "Contents/MacOS/PI-Desktop");
  if (run(electron, ["-e", "if(process.arch!=='arm64')process.exit(1);console.log('electron-arm64-ok')"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", NODE_PATH: "" } }) !== "electron-arm64-ok") throw new Error("Packaged Electron execution failed");
  run("/usr/bin/codesign", ["--verify", "--strict", app]);
  const req = createRequire(join(sourceRoot, "apps/desktop/package.json"));
  const builder = createRequire(req.resolve("electron-builder/package.json"));
  const asar = createRequire(builder.resolve("app-builder-lib/package.json"))("@electron/asar");
  const archive = join(resources, "app.asar");
  const out = join(sourceRoot, "apps/desktop/out");
  let compiledFiles = 0;
  for (const file of files(out)) {
    if (file.endsWith(".map")) continue;
    const name = join("out", relative(out, file));
    if (!readFileSync(file).equals(asar.extractFile(archive, name))) throw new Error(`Archived source differs: ${name}`);
    compiledFiles++;
  }
  const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  if (pkg.piDistribution !== "installed") throw new Error("Installed distribution metadata missing");
  const health = run(process.execPath, [join(resources, "agent-runtime/sidecar.js")], {
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sidecar.health", params: {} }) + "\n",
  });
  if (!health.split(/\r?\n/).filter(Boolean).map(JSON.parse).some(row => row.id === 1 && row.result?.ok)) throw new Error("Packaged sidecar health check failed");
  return { runtimeFiles, compiledFiles, plugin: `${manifest.id}@${manifest.version}`, hostSha256: hash(host), version: pkg.version };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = resolve(process.argv[2] ?? "apps/desktop/release/mac-arm64/PI-Desktop.app");
  const checked = verifyMacosPackage(app);
  const commit = run("git", ["rev-parse", "HEAD"], { cwd: root });
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Source commit unavailable");
  const destination = join(root, "dist/custom-macos-arm64");
  mkdirSync(destination, { recursive: true });
  const release = join(root, "apps/desktop/release");
  const artifacts = [];
  for (const [suffix, extension] of [["arm64", "dmg"], ["arm64-mac", "zip"]]) {
    const name = `PI-Desktop-${checked.version}-${suffix}.${extension}`;
    const source = join(release, name);
    const delivered = `PI-Desktop-${checked.version}-custom-${commit.slice(0, 9)}-${suffix}.${extension}`;
    const target = join(destination, delivered);
    copyFileSync(source, target);
    equal(source, target);
    artifacts.push({ name: delivered, sha256: hash(target), bytes: statSync(target).size });
  }
  writeFileSync(join(destination, "SHA256SUMS.txt"), artifacts.map(a => `${a.sha256}  ${a.name}\n`).join(""));
  writeFileSync(join(destination, "build-provenance.json"), JSON.stringify({ schemaVersion: 1, commit, ...checked, arch: "arm64", signing: "personal build; not Developer ID notarized", rust: run("rustc", ["--version"]), artifacts, builtAt: new Date().toISOString(), run: process.env.GITHUB_RUN_ID ?? null }, null, 2));
  copyFileSync(join(root, "custom/MACOS.md"), join(destination, "INSTALL.md"));
  console.log(`Verified macOS arm64 package: ${checked.runtimeFiles} runtime files, ${checked.compiledFiles} compiled files`);
}
