import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { CodexBatchController } = await import("../src/lib/codex-batch-controller.ts");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeApi({ total = 2, runRejectAt = 0 } = {}) {
  const listeners = new Set();
  const calls = [];
  let loginCounter = 0;
  const loginIds = [];
  const api = {
    calls,
    loginIds,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    onOauthLogin(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async startOauthLogin(input) {
      calls.push({ method: "start", input });
      const loginId = `login-${++loginCounter}`;
      loginIds.push(loginId);
      return { loginId };
    },
    async respondOauthLogin(input) {
      calls.push({ method: "respond", ...input });
      return { ok: true };
    },
    async cancelOauthLogin(loginId) {
      calls.push({ method: "cancel-oauth", loginId });
      return { ok: true };
    },
    async selectCodexBatch() {
      calls.push({ method: "select" });
      return { batchId: "batch-1", total, fileName: "accounts.txt" };
    },
    async runCodexBatchAccount(input) {
      calls.push({ method: "run", ...input });
      if (input.index === runRejectAt) throw new Error("automation failed");
      return { ok: true };
    },
    async cancelCodexBatchAccount(batchId) {
      calls.push({ method: "cancel-helper", batchId });
      return { ok: true };
    },
    async finishCodexBatch(batchId) {
      calls.push({ method: "finish", batchId });
      return { ok: true };
    },
  };
  return api;
}

function prompt(api, index) {
  api.emit({
    loginId: api.loginIds[index - 1],
    vendorId: "openai-codex",
    kind: "prompt",
    request: {
      promptId: `prompt-${index}`,
      type: "select",
      message: "method",
      options: [
        { id: "browser", label: "Browser" },
        { id: "device_code", label: "Device" },
      ],
    },
  });
}

function auth(api, index) {
  api.emit({
    loginId: api.loginIds[index - 1],
    vendorId: "openai-codex",
    kind: "authUrl",
    url: `https://auth.openai.com/oauth/authorize?account=${index}`,
    opened: false,
  });
}

function done(api, index) {
  api.emit({
    loginId: api.loginIds[index - 1],
    vendorId: "openai-codex",
    kind: "done",
    providerId: `provider-${index}`,
  });
}

test("batch runs accounts serially and automatically chooses browser login", async () => {
  const api = fakeApi({ total: 2 });
  let completed = 0;
  const controller = new CodexBatchController({ api, onComplete: () => { completed += 1; } });
  await controller.start();
  await tick();
  assert.deepEqual(api.calls.find((call) => call.method === "start").input, {
    vendorId: "openai-codex",
    openExternal: false,
  });

  prompt(api, 1);
  await tick();
  assert.equal(api.calls.find((call) => call.method === "respond").value, "browser");
  auth(api, 1);
  await tick();
  assert.equal(api.calls.filter((call) => call.method === "run").length, 1);
  done(api, 1);
  await tick();
  assert.equal(api.calls.filter((call) => call.method === "start").length, 2);
  assert.equal(controller.snapshot().current, 2);

  prompt(api, 2);
  auth(api, 2);
  await tick();
  done(api, 2);
  await tick();
  assert.deepEqual(controller.snapshot(), {
    phase: "completed",
    fileName: "accounts.txt",
    total: 2,
    current: 2,
    succeeded: 2,
    failed: 0,
    message: "signed_in",
    lastError: "",
  });
  assert.equal(completed, 1);
  assert.equal(api.calls.filter((call) => call.method === "finish").length, 1);
});

test("automation failure counts once and continues with the next account", async () => {
  const api = fakeApi({ total: 2, runRejectAt: 1 });
  const controller = new CodexBatchController({ api });
  await controller.start();
  await tick();
  prompt(api, 1);
  auth(api, 1);
  await tick();
  await tick();
  assert.equal(controller.snapshot().failed, 1);
  assert.equal(controller.snapshot().current, 2);
  assert.equal(api.calls.filter((call) => call.method === "start").length, 2);
  assert.ok(api.calls.some((call) => call.method === "cancel-helper"));

  // A late terminal event from the failed login cannot settle the next account.
  done(api, 1);
  await tick();
  assert.equal(controller.snapshot().current, 2);
  assert.equal(controller.snapshot().succeeded, 0);
});

test("duplicate terminal events settle one account only", async () => {
  const api = fakeApi({ total: 1 });
  const controller = new CodexBatchController({ api });
  await controller.start();
  await tick();
  prompt(api, 1);
  auth(api, 1);
  await tick();
  done(api, 1);
  done(api, 1);
  await tick();
  assert.equal(controller.snapshot().succeeded, 1);
  assert.equal(api.calls.filter((call) => call.method === "finish").length, 1);
});

test("cancel stops OAuth, helper, and the in-memory batch", async () => {
  const api = fakeApi({ total: 2 });
  const controller = new CodexBatchController({ api });
  await controller.start();
  await tick();
  await controller.cancel();
  assert.equal(controller.snapshot().phase, "cancelled");
  assert.ok(api.calls.some((call) => call.method === "cancel-oauth"));
  assert.ok(api.calls.some((call) => call.method === "cancel-helper"));
  assert.ok(api.calls.some((call) => call.method === "finish"));
});


test("cancel during validation cleans the eventual batch", async () => {
  const api = fakeApi({ total: 1 });
  let release;
  api.selectCodexBatch = () => new Promise((resolve) => { release = resolve; });
  const controller = new CodexBatchController({ api });
  const starting = controller.start();
  await tick();
  await controller.cancel();
  assert.equal(controller.snapshot().phase, "cancelling");
  release({ batchId: "batch-1", total: 1, fileName: "accounts.txt" });
  assert.equal(await starting, false);
  assert.equal(controller.snapshot().phase, "cancelled");
  assert.ok(api.calls.some((call) => call.method === "finish"));
  assert.equal(api.calls.some((call) => call.method === "start"), false);
});


test("preparation failure exposes the real error without a fake account total", async () => {
  const api = fakeApi();
  api.selectCodexBatch = async () => { throw new Error("line 1 has four fields"); };
  const controller = new CodexBatchController({ api });
  assert.equal(await controller.start(), false);
  assert.deepEqual(controller.snapshot(), {
    phase: "error",
    fileName: "",
    total: 0,
    current: 0,
    succeeded: 0,
    failed: 0,
    message: "line 1 has four fields",
    lastError: "",
  });
});


test("manual-code fallback waits for the browser callback instead of failing", async () => {
  const api = fakeApi({ total: 1 });
  const controller = new CodexBatchController({ api });
  await controller.start();
  await tick();
  prompt(api, 1);
  await tick();
  api.emit({
    loginId: api.loginIds[0],
    vendorId: "openai-codex",
    kind: "prompt",
    request: {
      promptId: "manual-fallback",
      type: "manual_code",
      message: "Paste redirect URL",
    },
  });
  await tick();
  assert.equal(controller.snapshot().phase, "logging-in");
  assert.equal(controller.snapshot().failed, 0);
  assert.equal(controller.snapshot().message, "waiting_callback");
  assert.equal(
    api.calls.some((call) => call.method === "respond" && call.promptId === "manual-fallback"),
    false,
  );
});
