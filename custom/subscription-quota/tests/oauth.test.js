"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { createAuth, listenCallback } = require("../lib/oauth");
const { createAuthStore } = require("../lib/auth-store");
const response = (data, status = 200) => ({ status, bodyText: JSON.stringify(data) });
const token = (access = "test-access") => ({ access_token: access, refresh_token: "test-refresh", expires_in: 3600 });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(t, saved = {}, handler = () => response(token())) {
  let stored = structuredClone(saved), callback, closed = 0, now = Date.now();
  const requests = [], opened = [];
  const store = { load: async () => structuredClone(stored), save: async (data) => { stored = structuredClone(data); } };
  const auth = createAuth({ net: { fetch: async (input) => { requests.push(input); return handler(input); } },
    shell: { openExternal: async (url) => { opened.push(url); } } }, {
    store, now: () => now, listen: async (_redirect, accept) => { callback = accept; return () => { closed++; }; },
  });
  t.after(() => auth.stop());
  return { auth, requests, opened, store, get saved() { return stored; }, get closed() { return closed; },
    callback: (input) => callback(input), advance: (ms) => { now += ms; } };
}
function redirect(flow, code = "test-code") {
  const params = new URL(flow.url).searchParams;
  return `${params.get("redirect_uri")}?code=${code}&state=${params.get("state")}`;
}

test("ChatGPT PKCE login without CLI; whitelist status; plugin-only logout", async (t) => {
  const access = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } })).toString("base64url")}.b`;
  const f = fixture(t, {}, () => response(token(access)));
  const { login } = await f.auth.start("openai-codex");
  assert.equal(login.status, "waiting");
  assert.equal(f.opened.length, 1);
  const result = await f.auth.submit(login.id, redirect(login));
  assert.equal(result.login.status, "success");
  assert.equal(result.accounts.find((a) => a.vendor === "openai-codex").connected, true);
  const body = new URLSearchParams(f.requests[0].body);
  const challenge = crypto.createHash("sha256").update(body.get("code_verifier")).digest("base64url");
  assert.equal(challenge, new URL(login.url).searchParams.get("code_challenge"));
  assert.equal(body.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal((await f.auth.credential(login.accountId)).accountId, "acct-123");
  assert.equal(f.closed, 1);
  for (const secret of [access, "test-refresh", body.get("code_verifier"), "test-code"]) assert.ok(!JSON.stringify(result).includes(secret));
  await f.auth.logout(login.accountId);
  assert.equal(await f.auth.credential(login.accountId), null);
  assert.deepEqual(f.saved, { version: 2, accounts: [] });
});

test("Claude uses JSON token exchange and validates callback state/origin", async (t) => {
  const f = fixture(t);
  const { login } = await f.auth.start("anthropic");
  for (const input of ["test-code", redirect(login).replace("state=", "wrong="), redirect(login).replace("localhost", "evil.example"), redirect(login) + "&state=bad"]) {
    await assert.rejects(f.auth.submit(login.id, input), { code: "INVALID_ARGUMENT" });
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.callback(redirect(login)), true);
  assert.equal(f.callback(redirect(login)), false); // no double exchange
  await flush();
  assert.equal((await f.auth.status()).login.status, "success");
  assert.equal(f.requests[0].url, "https://platform.claude.com/v1/oauth/token");
  assert.equal(JSON.parse(f.requests[0].body).state, new URL(login.url).searchParams.get("state"));
});

test("only one login; cancel/timeout closes callback and cannot be submitted", async (t) => {
  const f = fixture(t);
  const { login } = await f.auth.start("openai-codex");
  await assert.rejects(f.auth.start("anthropic"), { code: "AUTH_BUSY" });
  await f.auth.cancel(login.id);
  assert.equal(f.closed, 1);
  await assert.rejects(f.auth.submit(login.id, redirect(login)), { code: "INVALID_ARGUMENT" });
  const next = await f.auth.start("anthropic");
  f.advance(11 * 60_000);
  assert.equal((await f.auth.status()).login.status, "error");
  assert.equal(f.closed, 2);
  await assert.rejects(f.auth.submit(next.login.id, redirect(next.login)), { code: "INVALID_ARGUMENT" });
  assert.equal(f.requests.length, 0);
});

test("late token exchange after cancellation never persists", async (t) => {
  const gate = deferred();
  const f = fixture(t, {}, () => gate.promise);
  const { login } = await f.auth.start("openai-codex");
  const submitted = f.auth.submit(login.id, redirect(login));
  await flush();
  await f.auth.cancel(login.id);
  gate.resolve(response(token()));
  assert.equal((await submitted).login.status, "cancelled");
  assert.deepEqual(f.saved, { version: 2, accounts: [] });
});

test("cancellation during disk save rolls back new credentials", async (t) => {
  const f = fixture(t);
  await f.auth.status(); // Complete first-load migration before blocking login writes.
  const gate = deferred();
  const save = f.store.save;
  let count = 0;
  f.store.save = async (data) => { if (count++ === 0) await gate.promise; await save(data); };
  const { login } = await f.auth.start("openai-codex");
  const submitted = f.auth.submit(login.id, redirect(login));
  await flush();
  await f.auth.cancel(login.id);
  gate.resolve();
  await submitted;
  assert.deepEqual(f.saved, { version: 2, accounts: [] });
});

test("expired token refresh is deduplicated, rotation persisted, no quota request needed", async (t) => {
  const f = fixture(t, { "openai-codex": { access: "old", refresh: "old-refresh", expires: 0 } });
  const results = await Promise.all(Array.from({ length: 8 }, () => f.auth.credential("legacy-openai-codex")));
  assert.ok(results.every((c) => c.token === "test-access"));
  assert.equal(f.requests.length, 1);
  assert.equal(new URLSearchParams(f.requests[0].body).get("grant_type"), "refresh_token");
  assert.equal(f.saved.accounts[0].credential.refresh, "test-refresh");
  await f.auth.credential("legacy-openai-codex");
  assert.equal(f.requests.length, 1);
});

test("logout during refresh cannot resurrect the credential", async (t) => {
  const gate = deferred();
  const f = fixture(t, { anthropic: { access: "old", refresh: "old-refresh", expires: 0 } }, () => gate.promise);
  const refreshed = f.auth.credential("legacy-anthropic");
  const rejected = assert.rejects(refreshed, { code: "AUTH_CANCELLED" });
  await flush();
  await f.auth.logout("legacy-anthropic");
  gate.resolve(response(token()));
  await rejected;
  assert.deepEqual(f.saved, { version: 2, accounts: [] });
});

test("invalid grants and malicious token errors never leak response contents", async (t) => {
  const f = fixture(t, {}, () => response({ error: "invalid_grant", access_token: "secret-leak", error_description: "secret-leak" }, 400));
  const { login } = await f.auth.start("anthropic");
  const result = await f.auth.submit(login.id, redirect(login));
  assert.equal(result.login.status, "error");
  assert.ok(!JSON.stringify(result).includes("secret-leak"));
  assert.deepEqual(f.saved, { version: 2, accounts: [] });
});

test("device flow respects initial interval and slow_down; hides device token", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let polls = 0;
  const f = fixture(t, {}, (input) => {
    if (input.url.endsWith("/device/code")) return response({ device_code: "private-device-token", user_code: "ABCD-EFGH", expires_in: 600, interval: 5, verification_uri: "https://evil.example" });
    polls++;
    return response(polls === 1 ? { error: "slow_down" } : polls === 2 ? { error: "authorization_pending" } : { access_token: "gh-private-token" });
  });
  const result = await f.auth.start("github-copilot");
  assert.equal(result.login.userCode, "ABCD-EFGH");
  assert.equal(f.opened[0], "https://github.com/login/device");
  assert.ok(!JSON.stringify(result).includes("private-device-token"));
  t.mock.timers.tick(4999); await flush(); assert.equal(polls, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(polls, 1);
  t.mock.timers.tick(9999); await flush(); assert.equal(polls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(polls, 2);
  t.mock.timers.tick(10000); await flush(); assert.equal(polls, 3);
  assert.equal((await f.auth.credential(result.login.accountId)).token, "gh-private-token");
  assert.equal((await f.auth.status()).login.status, "success");
});

test("browser/port failure leaves manual callback fallback", async (t) => {
  const auth = createAuth({ net: { fetch: async () => response(token()) }, shell: { openExternal: async () => { throw new Error("secret-leak"); } } },
    { store: { load: async () => ({}), save: async () => {} }, listen: async () => null });
  t.after(() => auth.stop());
  const { login } = await auth.start("openai-codex");
  assert.equal(login.manual, true);
  assert.equal(login.status, "waiting");
  assert.ok(!login.message.includes("secret-leak"));
  assert.equal((await auth.submit(login.id, redirect(login))).login.status, "success");
});

test("encrypted store survives restart; tamper/missing key fail closed", async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, "quota-store-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createAuthStore(async () => root);
  assert.deepEqual(await store.load(), {});
  const saved = { version: 2, accounts: [{ id: "mock-account", vendor: "anthropic", label: "测试账号", credential: { access: "sensitive-access", refresh: "sensitive-refresh", expires: 1 } }] };
  await store.save(saved);
  const bytes = await fs.readFile(path.join(root, "quota-oauth.enc"));
  assert.ok(!bytes.includes(Buffer.from("sensitive-access")));
  assert.deepEqual(await createAuthStore(async () => root).load(), saved);
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(root, "quota-oauth.key"))).mode & 0o777, 0o600);
  bytes[bytes.length - 1] ^= 1;
  await fs.writeFile(path.join(root, "quota-oauth.enc"), bytes);
  await assert.rejects(store.load(), { code: "AUTH_STORAGE" });
  await store.save(saved);
  await fs.unlink(path.join(root, "quota-oauth.key"));
  await assert.rejects(store.load(), { code: "AUTH_STORAGE" });
});

test("real callback listener validates host/path and releases its loopback port", async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const close = await listenCallback(`http://localhost:${port}/callback`, (url) => new URL(url).searchParams.get("state") === "expected");
  assert.equal(typeof close, "function");
  function get(url, host = `localhost:${port}`) {
    return new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: url, headers: { host } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject);
    });
  }
  try {
    assert.equal(await get("/callback?state=bad"), 400);
    assert.equal(await get("/elsewhere?state=expected"), 404);
    assert.equal(await get("/callback?state=expected", "evil.example"), 400);
    assert.equal(await get("/callback?state=expected"), 200);
    assert.equal(await listenCallback(`http://localhost:${port}/callback`, () => true), null);
  } finally { close(); }
});

test("old refresh started during re-login cannot overwrite the newly authorized account", async (t) => {
  const gate = deferred();
  const f = fixture(t, { "openai-codex": { access: "old-account", refresh: "old-refresh", expires: 0 } },
    (input) => new URLSearchParams(input.body).get("grant_type") === "refresh_token" ? gate.promise : response(token("new-account")));
  const { login } = await f.auth.start("openai-codex", { accountId: "legacy-openai-codex" });
  const refresh = f.auth.credential("legacy-openai-codex");
  const rejected = assert.rejects(refresh, { code: "AUTH_CANCELLED" });
  await flush();
  assert.equal((await f.auth.submit(login.id, redirect(login))).login.status, "success");
  gate.resolve(response(token("refreshed-old-account")));
  await rejected;
  assert.equal(f.saved.accounts[0].credential.access, "new-account");
});

test("timeout while saving rolls back the uncompleted authorization", async (t) => {
  const f = fixture(t);
  await f.auth.status();
  const gate = deferred();
  const save = f.store.save;
  let count = 0;
  f.store.save = async (data) => { if (count++ === 0) await gate.promise; await save(data); };
  const { login } = await f.auth.start("anthropic");
  const submitted = f.auth.submit(login.id, redirect(login));
  await flush();
  f.advance(11 * 60_000);
  assert.equal((await f.auth.status()).login.status, "error");
  gate.resolve();
  await submitted;
  assert.deepEqual(f.saved, { version: 2, accounts: [] });
});
