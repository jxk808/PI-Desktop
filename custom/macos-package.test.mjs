import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import afterPack from "./after-pack.mjs";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { CodexBatchAutomation } = await import("../apps/desktop/electron/main/codex-batch-automation.ts");
const { CODEX_MACOS_PORTABLE_COMPONENTS } = await import("../apps/desktop/electron/main/codex-batch-runtime.ts");
const root = fileURLToPath(new URL("../", import.meta.url));
const read = path => readFileSync(join(root, path), "utf8");

class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() { return true; }
}
test("Mac user path selects bundled Python and completes one account without system runtimes", async (t) => {
  const keys = ["PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "NODE_PATH", "NODE_OPTIONS"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = "untrusted-external-runtime";
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const helper = join(root, "synthetic 应用", "PI-Desktop.app", "Contents/Resources/codex-automation");
  const calls = [], checked = [];
  const automation = new CodexBatchAutomation({
    helperRoots: [helper], platform: "darwin", newId: () => "mac-batch",
    pickCredentialsFile: async () => join(root, "private", "synthetic.txt"),
    pathExists: async path => { checked.push(path); },
    spawnHelper: (exe, args, options) => {
      calls.push({ exe, args, options });
      const child = new Child();
      queueMicrotask(() => {
        child.stdout.write(calls.length === 1 ? '{"event":"validated","count":1}\n' : '{"event":"completed","index":1,"total":1}\n');
        child.emit("exit", 0);
      });
      return child;
    },
  });
  const selected = await automation.select();
  assert.equal(selected.total, 1);
  assert.equal(calls[0].exe, join(helper, ".python-runtime/bin/python3"));
  assert.deepEqual(checked, CODEX_MACOS_PORTABLE_COMPONENTS.map(path => join(helper, path)));
  const url = new URL("https://auth.openai.com/oauth/authorize");
  for (const [key, value] of Object.entries({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann", redirect_uri: "http://localhost:1455/auth/callback", response_type: "code", code_challenge_method: "S256", state: "synthetic", code_challenge: "synthetic" })) url.searchParams.set(key, value);
  for (const key of keys) assert.equal(calls[0].options.env[key], undefined);
  await automation.run({ batchId: selected.batchId, index: 1, authorizationUrl: url.href, headed: true });
  assert.ok(calls[1].args.includes("--headed"));
  assert.equal(calls[1].exe, calls[0].exe);
  await automation.finish(selected.batchId);
  await assert.rejects(automation.run({ batchId: selected.batchId, index: 1, authorizationUrl: url.href, headed: true }), /missing or expired/);
});

test("Mac afterPack restores the inventory into Contents/Resources and keeps executable mode", async () => {
  const temp = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "mac-package-"));
  try {
    const stage = join(temp, "stage"), out = join(temp, "mac-arm64");
    mkdirSync(join(stage, ".python-runtime/bin"), { recursive: true });
    const path = ".python-runtime/bin/python3", data = Buffer.from("synthetic runtime");
    writeFileSync(join(stage, path), data);
    chmodSync(join(stage, path), 0o755);
    const files = [{ path, sha256: createHash("sha256").update(data).digest("hex") }];
    writeFileSync(join(stage, "runtime-integrity.json"), JSON.stringify({ schemaVersion: 1, sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files }));
    await afterPack({ appOutDir: out, electronPlatformName: "darwin", packager: { appInfo: { productFilename: "PI-Desktop" }, config: { extraResources: [{ from: stage, to: "codex-automation" }] } } });
    const copied = join(out, "PI-Desktop.app/Contents/Resources/codex-automation", path);
    assert.deepEqual(readFileSync(copied), data);
    assert.equal(existsSync(join(out, "resources")), false);
    if (process.platform !== "win32") assert.ok(statSync(copied).mode & 0o111);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("Mac workflow gates complete installers before upload and never publishes a release", () => {
  const text = read(".github/workflows/custom-macos.yml");
  assert.match(text, /runs-on: macos-15/);
  assert.match(text, /uname -m/);
  assert.match(text, /contents: read/);
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /prepare-macos-runtime\.mjs/);
  assert.match(text, /PI_TEST_MACOS_AUTOMATION_ROOT/);
  assert.match(text, /hdiutil attach/);
  assert.match(text, /ditto -x -k/);
  assert.ok(text.indexOf("verify-macos-package.mjs") < text.indexOf("actions/upload-artifact@"));
  assert.doesNotMatch(text, /contents: write|gh release|sign_macos|CSC_LINK|reuse-installed-host/);
  const build = read("custom/build.mjs");
  assert.match(build, /assembleMacRuntime\(runtime, helper, automation\)/);
  assert.match(build, /identity: "-"/);
  assert.match(build, /notarize: false/);
  assert.match(build, /signIgnore:/);
  assert.match(build, /owner: "jxk808"/);
  assert.doesNotMatch(build, /hardenedRuntime: false/);
});
