import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyPackagedRuntime } from "./packaged-runtime.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]); }
function equal(first, second, label) {
  if (!existsSync(second) || digest(first) !== digest(second)) throw new Error(`Packaged source mismatch: ${label}`);
}
export function verifyWindowsPackage(payload, sourceRoot = root) {
  const root = sourceRoot;
  const resources = join(payload, "resources");
  const runtimeFiles = verifyPackagedRuntime(join(resources, "codex-automation"));
  const plugin = "io.github.czp0312.subscription-quota";
  const pluginDir = join(resources, "plugins", plugin);
  const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
  if (manifest.id !== plugin || !manifest.permissions.includes("models.usage")) throw new Error("Quota plugin identity/permission missing");
  for (const name of ["main.js", "manifest.json", "LICENSE", "views/quota.html"]) equal(join(root, "custom/subscription-quota", name), join(pluginDir, name), `quota/${name}`);
  equal(join(root, "target/release/pi-desktop-host-core.exe"), join(resources, "bin/pi-desktop-host-core.exe"), "Rust host");
  equal(join(root, "packages/agent-runtime/dist-bundle/sidecar.js"), join(resources, "agent-runtime/sidecar.js"), "sidecar");
  const req = createRequire(join(root, "apps/desktop/package.json"));
  const builder = createRequire(req.resolve("electron-builder/package.json"));
  const asar = createRequire(builder.resolve("app-builder-lib/package.json"))("@electron/asar");
  const archive = join(resources, "app.asar");
  const outputRoot = join(root, "apps/desktop/out");
  let compiledFiles = 0;
  for (const file of files(outputRoot)) {
    if (file.endsWith(".map")) continue;
    const name = join("out", relative(outputRoot, file));
    if (!readFileSync(file).equals(asar.extractFile(archive, name))) throw new Error(`Archived code differs: ${name}`);
    compiledFiles++;
  }
  const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  if (pkg.piDistribution !== "installed") throw new Error("Application distribution metadata is not installed");
  const result = spawnSync(process.execPath, [join(resources, "agent-runtime/sidecar.js")], {
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sidecar.health", params: {} }) + "\n", encoding: "utf8", timeout: 30000,
  });
  if (result.error || result.status !== 0 || !result.stdout.split(/\r?\n/).filter(Boolean).map(JSON.parse).some(row => row.id === 1 && row.result?.ok)) throw new Error("Packaged sidecar health check failed");
  return { runtimeFiles, compiledFiles, plugin: `${manifest.id}@${manifest.version}`, hostSha256: digest(join(resources, "bin/pi-desktop-host-core.exe")), version: pkg.version };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const payload = resolve(process.argv[2] ?? "apps/desktop/release/win-unpacked");
  const checked = verifyWindowsPackage(payload);
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (git.status !== 0 || !/^[a-f0-9]{40}$/.test(git.stdout.trim())) throw new Error("Source commit unavailable");
  const commit = git.stdout.trim();
  const destination = join(root, "dist/custom-windows");
  mkdirSync(destination, { recursive: true });
  const filename = `PI-Desktop-Setup-${checked.version}-custom-${commit.slice(0, 9)}.exe`;
  const original = join(root, "apps/desktop/release", `PI-Desktop-Setup-${checked.version}.exe`);
  const delivered = join(destination, filename);
  copyFileSync(original, delivered);
  equal(original, delivered, "installer artifact copy");
  writeFileSync(join(destination, "SHA256SUMS.txt"), `${digest(delivered)}  ${filename}\n`);
  const rust = spawnSync("rustc", ["--version"], { encoding: "utf8" });
  if (rust.status !== 0) throw new Error("Rust compiler provenance unavailable");
  writeFileSync(join(destination, "build-provenance.json"), JSON.stringify({ schemaVersion: 1, commit, ...checked, rust: rust.stdout.trim(), installer: filename, bytes: statSync(delivered).size, sha256: digest(delivered), builtAt: new Date().toISOString(), run: process.env.GITHUB_RUN_ID ?? null }, null, 2));
  console.log(`Verified installer ${filename}: ${checked.runtimeFiles} runtime files, ${checked.compiledFiles} archived source outputs`);
}
