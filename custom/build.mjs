import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { HELPER_SOURCES, validateRuntime, assembleRuntime } from "./automation-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const helper = join(root, "custom/auto-codex-auth");
const plugin = join(root, "custom/subscription-quota");
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!["--check", "--reuse-installed-host"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
}
const manifest = JSON.parse(readFileSync(join(plugin, "manifest.json"), "utf8"));
if (manifest.id !== "io.github.czp0312.subscription-quota" || !manifest.permissions.includes("models.usage")) {
  throw new Error("Unexpected quota plugin identity or permissions");
}
for (const name of HELPER_SOURCES) {
  if (!existsSync(join(helper, name))) throw new Error(`Missing helper source: ${name}`);
}
for (const name of ["main.js", "manifest.json", "LICENSE", "views/quota.html"]) {
  if (!existsSync(join(plugin, name))) throw new Error(`Missing quota source: ${name}`);
}
const runtime = process.env.PI_CUSTOM_AUTOMATION_RUNTIME;
if (runtime || !args.has("--check")) {
  const checked = validateRuntime(runtime, helper);
  console.log(`Portable automation inventory SHA-256: ${checked.digest}`);
} else {
  console.log("Portable runtime not supplied; source checks only. Full builds require PI_CUSTOM_AUTOMATION_RUNTIME.");
}
if (args.has("--check")) {
  console.log(`Custom sources OK: core + ${manifest.id}@${manifest.version} + automation helper`);
  process.exit(0);
}
if (process.platform !== "win32") throw new Error("This custom installer currently targets Windows x64 only");
function run(command, commandArgs, cwd = root) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit", shell: command.endsWith(".cmd") });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
}
run("pnpm.cmd", ["--filter", "@pi-desktop/desktop", "run", "build:deps"]);
if (args.has("--reuse-installed-host")) {
  const installed = process.env.PI_CUSTOM_INSTALLED_HOST;
  if (!installed || !existsSync(installed)) throw new Error("Set PI_CUSTOM_INSTALLED_HOST to the verified host-core executable");
  const target = join(root, "target/release/pi-desktop-host-core.exe");
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(installed, target);
} else {
  run("cargo", ["build", "--release", "--manifest-path", join(root, "Cargo.toml"), "-p", "host-core"]);
}
run("pnpm.cmd", ["-C", "packages/agent-runtime", "bundle"]);
run("pnpm.cmd", ["--filter", "@pi-desktop/desktop", "run", "build"]);
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const temporary = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-custom-build-"));
try {
  const automation = join(temporary, "codex-automation");
  assembleRuntime(runtime, helper, automation);
  const config = {
    ...pkg.build,
    extraMetadata: { ...pkg.build.extraMetadata, piDistribution: "installed" },
    extraResources: [
      ...(pkg.build.extraResources || []),
      { from: plugin, to: `plugins/${manifest.id}`, filter: ["**/*", "!node_modules{,/**/*}", "!tests{,/**/*}", "!package-lock.json", "!package.json"] },
      { from: automation, to: "codex-automation", filter: ["**/*", "**/.*", "**/.*/**/*"] },
    ],
  };
  const path = join(temporary, "electron-builder.json");
  writeFileSync(path, JSON.stringify(config, null, 2));
  run("pnpm.cmd", ["exec", "electron-builder", "--config", path, "--win", "nsis", "--publish", "never"], desktop);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
