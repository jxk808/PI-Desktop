import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  CodexBatchAutomation,
  validateCodexAuthorizationUrl,
} = await import("../electron/main/codex-batch-automation.ts");

function authUrl(overrides = {}) {
  const url = new URL("https://auth.openai.com/oauth/authorize");
  const values = {
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirect_uri: "http://localhost:1455/auth/callback",
    response_type: "code",
    code_challenge_method: "S256",
    state: "state",
    code_challenge: "challenge",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.toString();
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 123;
  killed = false;

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 1));
    return true;
  }
}

function harness(outputs) {
  const calls = [];
  const children = [];
  const automation = new CodexBatchAutomation({
    pickCredentialsFile: async () => "O:\\AutoCodexAuth\\号.txt",
    pathExists: async () => {},
    newId: () => "batch-1",
    platform: "win32",
    spawnHelper: (executable, args, options) => {
      calls.push({ executable, args, options });
      const child = new FakeChild();
      children.push(child);
      const output = outputs.shift();
      if (output) {
        queueMicrotask(() => {
          if (output.stdout) child.stdout.write(output.stdout);
          if (output.stderr) child.stderr.write(output.stderr);
          child.emit("exit", output.code ?? 0);
        });
      }
      return child;
    },
  });
  return { automation, calls, children };
}

test("authorization URL accepts only the PI OpenAI PKCE callback", () => {
  assert.equal(validateCodexAuthorizationUrl(authUrl()), authUrl());
  for (const bad of [
    authUrl().replace("auth.openai.com", "evil.example"),
    authUrl({ redirect_uri: "http://localhost:9999/callback" }),
    authUrl({ code_challenge_method: "plain" }),
    authUrl({ state: "" }),
  ]) assert.throws(() => validateCodexAuthorizationUrl(bad));
});

test("selection validates beside the chosen file and returns no path", async () => {
  const h = harness([{ stdout: '{"event":"validated","count":2}\n' }]);
  const selected = await h.automation.select();
  assert.deepEqual(selected, { batchId: "batch-1", total: 2, fileName: "号.txt" });
  assert.equal(JSON.stringify(selected).includes("AutoCodexAuth"), false);
  assert.equal(h.calls[0].executable, "O:\\AutoCodexAuth\\.venv\\Scripts\\python.exe");
  assert.deepEqual(h.calls[0].args.slice(-2), ["--validate-only", "--json-events"]);
});

test("one account run uses only the selected batch and validated URL", async () => {
  const h = harness([
    { stdout: '{"event":"validated","count":2}\n' },
    { stdout: 'browser log\n{"event":"completed","index":2,"total":2}\n' },
  ]);
  const selected = await h.automation.select();
  await h.automation.run({
    batchId: selected.batchId,
    index: 2,
    authorizationUrl: authUrl(),
    headed: false,
  });
  const args = h.calls[1].args;
  assert.equal(args[args.indexOf("--account-index") + 1], "2");
  assert.equal(args[args.indexOf("--authorization-url") + 1], authUrl());
  assert.ok(args.includes("--headless"));
  assert.equal(args.includes("--api-url"), false);
});

test("invalid index and URL never spawn an account helper", async () => {
  const h = harness([{ stdout: '{"event":"validated","count":1}\n' }]);
  const selected = await h.automation.select();
  await assert.rejects(
    h.automation.run({ batchId: selected.batchId, index: 2, authorizationUrl: authUrl(), headed: false }),
    /outside/,
  );
  await assert.rejects(
    h.automation.run({ batchId: selected.batchId, index: 1, authorizationUrl: "https://evil.example", headed: false }),
    /OpenAI/,
  );
  assert.equal(h.calls.length, 1);
});

test("finish forgets the batch and terminates an active helper", async () => {
  const h = harness([{ stdout: '{"event":"validated","count":1}\n' }, null]);
  const selected = await h.automation.select();
  const running = h.automation.run({
    batchId: selected.batchId,
    index: 1,
    authorizationUrl: authUrl(),
    headed: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await h.automation.finish(selected.batchId);
  assert.equal(h.children[1].killed, true);
  await assert.rejects(running, /failed/);
  await assert.rejects(
    h.automation.run({ batchId: selected.batchId, index: 1, authorizationUrl: authUrl(), headed: false }),
    /missing or expired/,
  );
});


test("credentials file may live outside the trusted helper root", async () => {
  const calls = [];
  const helperRoot = "O:\\AutoCodexAuth";
  const automation = new CodexBatchAutomation({
    pickCredentialsFile: async () => "C:\\Users\\Administrator\\Downloads\\accounts.txt",
    helperRoots: [helperRoot],
    platform: "win32",
    pathExists: async (path) => {
      if (!path.startsWith(helperRoot)) throw new Error("missing");
    },
    newId: () => "batch-external",
    spawnHelper: (executable, args, options) => {
      calls.push({ executable, args, options });
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.write('{"event":"validated","count":3}\n');
        child.emit("exit", 0);
      });
      return child;
    },
  });
  const selected = await automation.select();
  assert.deepEqual(selected, { batchId: "batch-external", total: 3, fileName: "accounts.txt" });
  assert.equal(calls[0].executable, "O:\\AutoCodexAuth\\.venv\\Scripts\\python.exe");
  assert.ok(calls[0].args.includes("C:\\Users\\Administrator\\Downloads\\accounts.txt"));
});
