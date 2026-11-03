import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const custom = dirname(fileURLToPath(import.meta.url));
const root = resolve(custom, "..");
const read = (name) => readFileSync(join(root, name), "utf8");
test("custom build preflight validates all three components", () => {
  const result = spawnSync(process.execPath, [join(custom, "build.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /core.*subscription-quota.*automation helper/);
});
test("quota manifest retains explicit host permission and original license", () => {
  const manifest = JSON.parse(read("custom/subscription-quota/manifest.json"));
  assert.equal(manifest.id, "io.github.czp0312.subscription-quota");
  assert.ok(manifest.permissions.includes("models.usage"));
  assert.ok(existsSync(join(custom, "subscription-quota/LICENSE")));
  assert.match(read("custom/subscription-quota/main.js"), /source: "host"/);
});
test("host discovers the integrated runtime without an O drive", () => {
  const main = read("apps/desktop/electron/main/index.ts");
  assert.ok(main.includes('join(app.getPath("home"), ".pi-desktop", "codex-automation")'));
  assert.ok(main.includes('"custom", "auto-codex-auth"'));
});
test("custom installer includes quota and only allowlisted helper sources", () => {
  const build = read("custom/build.mjs");
  assert.match(build, /to: `plugins\/\$\{manifest.id\}`/);
  assert.match(build, /to: "codex-automation"/);
  assert.match(build, /"\*\.py", "\*\.js", "\*\.ps1"/);
  assert.doesNotMatch(build, /filter: \["\*\*\/\*"\s*\}.*codex-automation/s);
});
test("helper source has no account file or generated runtime", () => {
  const files = readdirSync(join(custom, "auto-codex-auth"));
  for (const forbidden of ["号.txt", "auth.json", ".venv", ".node-runtime", ".playwright-browsers", "node_modules"]) {
    assert.ok(!files.includes(forbidden), `Unexpected ${forbidden}`);
  }
  const ignores = read("custom/.gitignore");
  for (const value of ["号.txt", "auth.json", ".venv", ".node-runtime", ".playwright-browsers"]) assert.ok(ignores.includes(value));
});
test("setup installs required runtimes with fail-fast exit checks", () => {
  const setup = read("custom/auto-codex-auth/setup.ps1");
  assert.match(setup, /\$LASTEXITCODE -ne 0/);
  assert.match(setup, /install_playwright_chromium.py/);
  assert.match(setup, /install_turnstile_browser.py/);
  assert.doesNotMatch(setup, /Copy-Item[^\n]*-Recurse/);
});
