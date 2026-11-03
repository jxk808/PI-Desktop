"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createAuth } = require("../lib/oauth");
const { createAuthStore } = require("../lib/auth-store");
const response = (data) => ({ status: 200, bodyText: JSON.stringify(data) });
const token = (access = "mock-new") => ({ access_token: access, refresh_token: `refresh-${access}`, expires_in: 3600 });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const record = (id, vendor = "openai-codex", expires = 0) => ({ id, vendor, label: `Label ${id}`,
  credential: { access: `access-${id}`, refresh: `refresh-${id}`, expires, accountId: `upstream-${id}` } });
const schema = (...accounts) => ({ version: 2, accounts });
function fixture(t, saved = schema(), handler = () => response(token()), extra = {}) {
  let stored = structuredClone(saved), loads = 0, saves = 0, saving = 0, maxSaving = 0;
  const requests = [];
  const store = {
    load: async () => { loads++; return structuredClone(stored); },
    save: async (value) => {
      saves++; saving++; maxSaving = Math.max(maxSaving, saving);
      try { await store.beforeSave?.(value); stored = structuredClone(value); }
      finally { saving--; }
    },
  };
  const auth = createAuth({ net: { fetch: async (input) => { requests.push(input); return handler(input); } },
    shell: { openExternal: async () => {} } }, { store, listen: async () => () => {}, ...extra });
  t.after(() => auth.stop());
  return { auth, store, requests, get saved() { return stored; }, get loads() { return loads; },
    get saves() { return saves; }, get maxSaving() { return maxSaving; } };
}
function redirect(flow) {
  const params = new URL(flow.url).searchParams;
  return `${params.get("redirect_uri")}?code=mock-code&state=${params.get("state")}`;
}
async function authorize(auth, vendor = "openai-codex", options) {
  const { login } = await auth.start(vendor, options);
  const result = await auth.submit(login.id, redirect(login));
  assert.equal(result.login.status, "success");
  return result;
}

test("legacy migration is deduplicated, committed before use, stable and secret-free", async (t) => {
  const old = { "openai-codex": record("one", "openai-codex", Date.now() + 3600_000).credential,
    anthropic: record("two", "anthropic", Date.now() + 3600_000).credential,
    "github-copilot": { access: "mock-github" } };
  const gate = deferred();
  const f = fixture(t, old);
  f.store.beforeSave = () => gate.promise;
  let settled = false;
  const pending = Promise.all([f.auth.status(), f.auth.listAccounts(), f.auth.credential("legacy-openai-codex")])
    .then((result) => { settled = true; return result; });
  await flush();
  assert.equal(f.loads, 1); assert.equal(f.saves, 1); assert.equal(settled, false);
  assert.deepEqual(f.saved, old);
  gate.resolve();
  const [status, list, credential] = await pending;
  assert.deepEqual(status.accounts, list);
  assert.deepEqual(list, Object.keys(old).map((vendor) => ({ id: `legacy-${vendor}`, vendor,
    label: `${vendor} 1`, priority: 1, connected: true })));
  assert.deepEqual(credential, { token: "access-one", accountId: "upstream-one", source: "plugin" });
  assert.equal(f.saved.version, 2);
  assert.deepEqual(f.saved.accounts.map((a) => a.credential), Object.values(old));
  assert.ok(!JSON.stringify(status).includes("upstream"));
  assert.ok(!JSON.stringify(status).includes("access-one"));
  const restarted = fixture(t, f.saved);
  assert.deepEqual(await restarted.auth.listAccounts(), list);
  assert.equal(restarted.saves, 0);
});

test("failed migration keeps legacy credentials intact and can retry", async (t) => {
  const old = { anthropic: record("one").credential };
  const f = fixture(t, old);
  f.store.beforeSave = () => { throw new Error("mock-secret-storage-error"); };
  const results = await Promise.allSettled([f.auth.status(), f.auth.listAccounts()]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.code, "AUTH_STORAGE");
    assert.match(result.reason.message, /迁移/);
    assert.ok(!result.reason.message.includes("mock-secret"));
  }
  assert.equal(f.loads, 1); assert.equal(f.saves, 1);
  assert.deepEqual(f.saved, old);
  f.store.beforeSave = null;
  assert.equal((await f.auth.listAccounts())[0].id, "legacy-anthropic");
  assert.deepEqual(f.saved.accounts[0].credential, old.anthropic);
});

test("invalid stored schemas fail closed without discarding records", async (t) => {
  for (const saved of [schema(record("same"), record("same")), schema(record("anthropic")),
    { version: 3, accounts: [] }, { anthropic: { access: "mock-incomplete" } },
    schema(...Array.from({ length: 11 }, (_, i) => record(`id-${i}`)))]) {
    const f = fixture(t, saved);
    await assert.rejects(f.auth.status(), { code: "AUTH_STORAGE" });
    assert.equal(f.saves, 0);
    assert.deepEqual(f.saved, saved);
  }
});

test("new authorizations never merge upstream identity; reauthorization targets only its internal id", async (t) => {
  const access = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "shared-upstream" } })).toString("base64url")}.b`;
  const f = fixture(t, schema(), () => response(token(access)));
  const first = await authorize(f.auth);
  const second = await authorize(f.auth);
  const [a, b] = second.accounts;
  assert.notEqual(a.id, b.id); assert.notEqual(a.id, "shared-upstream");
  assert.equal(a.id, first.login.accountId); assert.equal(b.id, second.login.accountId);
  assert.equal(a.label, "openai-codex 1"); assert.equal(b.label, "openai-codex 2");
  assert.equal(a.priority, 1); assert.equal(b.priority, 2);
  assert.deepEqual(Object.keys(a).sort(), ["connected", "id", "label", "priority", "vendor"]);
  assert.equal((await f.auth.credential(a.id)).accountId, "shared-upstream");
  assert.equal((await f.auth.credential(b.id)).token, access);
  assert.ok(!JSON.stringify(second).includes("shared-upstream"));
  const before = structuredClone(f.saved.accounts[0]);
  const again = await authorize(f.auth, "openai-codex", { accountId: b.id });
  assert.equal(again.login.accountId, b.id); assert.equal(again.accounts.length, 2);
  assert.deepEqual(f.saved.accounts[0], before); assert.equal(again.accounts[1].label, "openai-codex 2");
  const removed = await f.auth.logout(a.id);
  assert.deepEqual(removed.accounts, [{ ...b, priority: 1 }]);
  assert.equal(await f.auth.credential(a.id), null);
  assert.equal((await f.auth.credential(b.id)).token, access);
});

test("vendor-local ordering persists through encrypted restart and legacy migration", async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, "quota-multi-auth-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createAuthStore(async () => root);
  await store.save({ "openai-codex": record("old").credential });
  const f = fixture(t, schema(), undefined, { store });
  await f.auth.status();
  await authorize(f.auth, "anthropic");
  const added = await authorize(f.auth);
  const id = added.login.accountId;
  assert.equal(added.accounts.at(-1).label, "openai-codex 2");
  const moved = await f.auth.move(id, "up");
  assert.deepEqual(moved.accounts.map((a) => [a.id, a.priority]),
    [[id, 1], [added.accounts[1].id, 1], ["legacy-openai-codex", 2]]);
  assert.deepEqual((await f.auth.move(id, "up")).accounts, moved.accounts);
  const restored = await f.auth.move(id, "down");
  assert.equal(restored.accounts.at(-1).id, id);
  const encrypted = await fs.readFile(path.join(root, "quota-oauth.enc"));
  assert.ok(!encrypted.includes(Buffer.from("mock-new")));
  await f.auth.stop();
  const restarted = fixture(t, schema(), undefined, { store: createAuthStore(async () => root) });
  assert.deepEqual(await restarted.auth.listAccounts(), restored.accounts);
  assert.equal((await restarted.auth.credential(id)).token, "mock-new");
});

test("exact internal ids, vendor matching and movement are validated", async (t) => {
  const f = fixture(t, schema(record("one"), record("two", "anthropic")));
  const before = structuredClone(f.saved);
  for (const id of [undefined, null, {}, "", "unknown", "openai-codex", "anthropic", "github-copilot", "upstream-one", "__proto__"]) {
    assert.equal(await f.auth.credential(id), null);
    await assert.rejects(f.auth.logout(id), { code: "INVALID_ARGUMENT" });
    await assert.rejects(f.auth.move(id, "up"), { code: "INVALID_ARGUMENT" });
    await assert.rejects(f.auth.move(id, "up"), { code: "INVALID_ARGUMENT" });
    if (id !== undefined) await assert.rejects(f.auth.start("openai-codex", { accountId: id }), { code: "INVALID_ARGUMENT" });
  }
  await assert.rejects(f.auth.start("anthropic", { accountId: "one" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(f.auth.move("one", "left"), { code: "INVALID_ARGUMENT" });
  assert.deepEqual(f.saved, before); assert.equal(f.saves, 0);
});

test("ten-account limit is per vendor and does not block reauthorization", async (t) => {
  const f = fixture(t, schema(...Array.from({ length: 9 }, (_, i) => record(`id-${i}`))));
  await authorize(f.auth);
  assert.equal(f.saved.accounts.length, 10);
  await assert.rejects(f.auth.start("openai-codex"), { code: "INVALID_ARGUMENT" });
  await authorize(f.auth, "anthropic");
  await authorize(f.auth, "openai-codex", { accountId: "id-0" });
  assert.equal(f.saved.accounts.length, 11);
  assert.equal(f.saved.accounts[0].label, "Label id-0");
  await f.auth.logout("id-1");
  await authorize(f.auth);
  assert.equal(f.saved.accounts.length, 11);
});

test("refreshes deduplicate per account; deleting one does not cancel its sibling", async (t) => {
  const gates = { "refresh-one": deferred(), "refresh-two": deferred() };
  const f = fixture(t, schema(record("one"), record("two")), (input) => gates[new URLSearchParams(input.body).get("refresh_token")].promise);
  const first = Array.from({ length: 4 }, () => f.auth.credential("one"));
  const rejected = first.map((p) => assert.rejects(p, { code: "AUTH_CANCELLED" }));
  const second = Array.from({ length: 4 }, () => f.auth.credential("two"));
  await flush(); assert.equal(f.requests.length, 2);
  await f.auth.logout("one");
  gates["refresh-one"].resolve(response(token("late-one")));
  gates["refresh-two"].resolve(response(token("fresh-two")));
  await Promise.all(rejected);
  assert.ok((await Promise.all(second)).every((c) => c.token === "fresh-two"));
  assert.deepEqual(f.saved.accounts.map((a) => a.id), ["two"]);
  assert.equal(f.saved.accounts[0].credential.refresh, "refresh-fresh-two");
  assert.equal(await f.auth.credential("one"), null);
});

test("serialized refresh-first writes preserve ordering and refresh rotation", async (t) => {
  const f = fixture(t, schema(record("one"), record("other", "anthropic"), record("two")));
  await f.auth.status();
  const gate = deferred(); let blocked = false;
  f.store.beforeSave = async () => { if (!blocked) { blocked = true; await gate.promise; } };
  const first = f.auth.credential("one");
  await flush(); assert.equal(blocked, true);
  const rest = [f.auth.move("two", "up"), f.auth.credential("one"), f.auth.credential("two")];
  await flush(); assert.equal(f.saves, 1);
  gate.resolve();
  await Promise.all([first, ...rest]);
  assert.equal(f.maxSaving, 1);
  assert.deepEqual(f.saved.accounts.map((a) => a.id), ["two", "other", "one"]);
  assert.equal(f.saved.accounts[2].credential.refresh, "refresh-mock-new");
  assert.equal(f.saved.accounts[0].credential.refresh, "refresh-mock-new");
  assert.deepEqual(f.saved.accounts[1], record("other", "anthropic"));
});

test("forced refresh is account-local even for unexpired credentials", async (t) => {
  const f = fixture(t, schema(record("one", "openai-codex", Date.now() + 3600_000), record("two", "openai-codex", Date.now() + 3600_000)));
  assert.equal((await f.auth.credential("one")).token, "access-one");
  assert.equal(f.requests.length, 0);
  assert.equal((await f.auth.credential("one", { force: true })).token, "mock-new");
  assert.equal((await f.auth.credential("two")).token, "access-two");
  assert.equal(f.requests.length, 1);
});

test("reauthorization invalidates prior refresh only for that account", async (t) => {
  const gate = deferred();
  const f = fixture(t, schema(record("one"), record("two")), (input) =>
    new URLSearchParams(input.body).get("refresh_token") === "refresh-one" ? gate.promise : response(token()));
  const rejected = assert.rejects(f.auth.credential("one"), { code: "AUTH_CANCELLED" });
  await flush();
  await authorize(f.auth, "openai-codex", { accountId: "one" });
  assert.equal((await f.auth.credential("two")).token, "mock-new");
  gate.resolve(response(token("stale-one")));
  await rejected;
  assert.ok(f.saved.accounts.every((a) => a.credential.access === "mock-new"));
});

test("cancelled reauthorization during save rolls back only that change and preserves queued edits", async (t) => {
  const f = fixture(t, schema(record("one"), record("two")));
  const { login } = await f.auth.start("openai-codex", { accountId: "one" });
  const gate = deferred(); let count = 0;
  f.store.beforeSave = async () => { if (count++ === 0) await gate.promise; };
  const submitted = f.auth.submit(login.id, redirect(login));
  await flush();
  const moved = f.auth.move("two", "up");
  const movedAgain = f.auth.move("two", "up");
  await f.auth.cancel(login.id);
  gate.resolve();
  assert.equal((await submitted).login.status, "cancelled");
  await Promise.all([moved, movedAgain]);
  assert.equal(f.maxSaving, 1);
  assert.deepEqual(f.saved.accounts[1], record("one"));
  assert.equal(f.saved.accounts[0].id, "two");
});

test("logout of a pending new account during save cannot revive it or affect existing accounts", async (t) => {
  const f = fixture(t, schema(record("one")));
  const { login } = await f.auth.start("openai-codex");
  const gate = deferred(); let count = 0;
  f.store.beforeSave = async () => { if (count++ === 0) await gate.promise; };
  const submitted = f.auth.submit(login.id, redirect(login));
  await flush();
  const loggedOut = f.auth.logout(login.accountId);
  await flush(); gate.resolve();
  await Promise.all([submitted, loggedOut]);
  assert.deepEqual(f.saved, schema(record("one")));
  assert.equal((await f.auth.status()).login.status, "cancelled");
});

test("stop during login disk write rolls back and blocks subsequent mutations and credentials", async (t) => {
  const f = fixture(t, schema(record("one")));
  const { login } = await f.auth.start("openai-codex");
  const gate = deferred(); let count = 0;
  f.store.beforeSave = async () => { if (count++ === 0) await gate.promise; };
  const submitted = f.auth.submit(login.id, redirect(login));
  await flush();
  const stopped = f.auth.stop();
  gate.resolve(); await Promise.all([submitted, stopped]);
  assert.deepEqual(f.saved, schema(record("one")));
  for (const operation of [() => f.auth.start("anthropic"),
    () => f.auth.move("one", "up"), () => f.auth.logout("one"), () => f.auth.credential("one")])
    await assert.rejects(operation(), { code: "AUTH_CANCELLED" });
  assert.deepEqual(f.saved, schema(record("one")));
});

test("stop during refresh or listener startup cannot resurrect authorization", async (t) => {
  const gate = deferred();
  const f = fixture(t, schema(record("one")), () => gate.promise);
  const rejected = assert.rejects(f.auth.credential("one"), { code: "AUTH_CANCELLED" });
  await flush(); await f.auth.stop();
  gate.resolve(response(token("late"))); await rejected;
  assert.deepEqual(f.saved, schema(record("one"))); assert.equal(f.saves, 0);
  const listener = deferred(); let closed = 0;
  const pending = fixture(t, schema(), undefined, { listen: () => listener.promise });
  const started = pending.auth.start("openai-codex");
  await flush(); await pending.auth.stop();
  listener.resolve(() => { closed++; });
  assert.equal((await started).login.status, "cancelled");
  assert.equal(closed, 1); assert.deepEqual(pending.saved, schema());
});

test("device accounts are independent and late cancelled polling never adds an account", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = deferred(); let poll = 0;
  const f = fixture(t, schema(record("github-one", "github-copilot")), (input) =>
    input.url.endsWith("/device/code") ? response({ device_code: "mock-private-device", user_code: "MOCK-CODE", expires_in: 600, interval: 5 })
      : ++poll === 1 ? response({ access_token: "mock-new-github" }) : gate.promise);
  const first = await f.auth.start("github-copilot");
  t.mock.timers.tick(5000); await flush();
  assert.equal((await f.auth.credential(first.login.accountId)).token, "mock-new-github");
  assert.equal((await f.auth.credential("github-one")).token, "access-github-one");
  const second = await f.auth.start("github-copilot");
  t.mock.timers.tick(5000); await flush();
  await f.auth.cancel(second.login.id);
  gate.resolve(response({ access_token: "mock-late-github" })); await flush();
  assert.equal((await f.auth.listAccounts()).length, 2);
  assert.equal(await f.auth.credential(second.login.accountId), null);
});

test("new credential refresh never joins a stale refresh started during reauthorization", async (t) => {
  const gate = deferred();
  const f = fixture(t, schema(record("one")), (input) => {
    const body = new URLSearchParams(input.body);
    return body.get("refresh_token") === "refresh-one" ? gate.promise
      : response(token(body.get("grant_type") === "refresh_token" ? "fresh-new" : "authorized-new"));
  });
  const { login } = await f.auth.start("openai-codex", { accountId: "one" });
  const stale = assert.rejects(f.auth.credential("one"), { code: "AUTH_CANCELLED" });
  await flush();
  await f.auth.submit(login.id, redirect(login));
  const fresh = f.auth.credential("one", { force: true });
  await flush();
  const requests = f.requests.length;
  gate.resolve(response(token("stale")));
  const [result] = await Promise.allSettled([fresh, stale]);
  assert.equal(requests, 3);
  assert.equal(result.status, "fulfilled");
  assert.equal(result.value.token, "fresh-new");
  assert.equal(f.saved.accounts[0].credential.access, "fresh-new");
});

test("failed metadata writes preserve credentials and do not poison the write queue", async (t) => {
  const f = fixture(t, schema(record("one"), record("two")));
  f.store.beforeSave = () => { throw new Error("mock-save-failure"); };
  await assert.rejects(f.auth.move("one", "up"), { code: "AUTH_STORAGE" });
  assert.deepEqual(f.saved, schema(record("one"), record("two")));
  assert.equal((await f.auth.listAccounts())[0].label, "Label one");
  f.store.beforeSave = null;
  await f.auth.move("two", "up");
  assert.equal(f.saved.accounts[0].id, "two");
  assert.deepEqual(f.saved.accounts[1].credential, record("one").credential);
});

test("login stores the ChatGPT id_token email and the Claude token-response email", async (t) => {
  const idToken = `h.${Buffer.from(JSON.stringify({ email: "user@example.com" })).toString("base64url")}.s`;
  const codex = fixture(t, schema(), () => response({ ...token("access-codex"), id_token: idToken }));
  const codexLogin = await authorize(codex.auth, "openai-codex");
  assert.equal(codex.saved.accounts[0].credential.email, "user@example.com");
  assert.equal((await codex.auth.credential(codexLogin.login.accountId)).email, "user@example.com");
  assert.ok(!JSON.stringify(codexLogin).includes("user@example.com"));

  const claude = fixture(t, schema(), () => response({ ...token("access-claude"), account: { uuid: "u1", email_address: "claude@example.com" } }));
  const claudeLogin = await authorize(claude.auth, "anthropic");
  assert.equal(claude.saved.accounts[0].credential.email, "claude@example.com");
  assert.equal((await claude.auth.credential(claudeLogin.login.accountId)).email, "claude@example.com");
});

test("a token response without identity leaves the credential shape unchanged", async (t) => {
  const f = fixture(t, schema());
  const result = await authorize(f.auth, "openai-codex");
  assert.ok(!("email" in f.saved.accounts[0].credential));
  assert.deepEqual(await f.auth.credential(result.login.accountId),
    { token: "mock-new", accountId: null, source: "plugin" });
});
