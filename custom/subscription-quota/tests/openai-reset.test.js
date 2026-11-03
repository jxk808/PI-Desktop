"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createOpenAiReset, normalizeCredits } = require("../lib/openai-reset");
const reply = (data, status = 200) => ({ status, bodyText: JSON.stringify(data) });
const credit = (id = "credit-1", overrides = {}) => ({ id, reset_type: "codex_rate_limits", status: "available", expires_at: "2030-01-01T00:00:00Z", ...overrides });

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "quota-reset-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-10-12T00:00:00Z"), offline = false, changed = 0;
  let accounts = [{ id: "plugin-a", vendor: "openai-codex" }, { id: "plugin-b", vendor: "openai-codex" }, { id: "claude", vendor: "anthropic" }];
  const credentials = { "plugin-a": { token: "private-a", accountId: "upstream-a" }, "plugin-b": { token: "private-b", accountId: "upstream-b" } };
  let credits = [credit(), credit("credit-2")];
  const requests = [];
  let respond = (input) => input.method === "GET" ? reply({ available_count: credits.length, credits }) : reply({ code: "reset", windows_reset: 2 });
  const deps = { getDataPath: async () => dir, isOffline: async () => offline,
    listAccounts: async () => accounts, credential: async (id) => credentials[id],
    getCapabilities: async () => ({ fetchRedirectModes: ["error"] }),
    fetch: async (input) => { requests.push(input); return respond(input); }, onChange: () => changed++ };
  const make = (options = {}) => createOpenAiReset(deps, { now: () => now, ...options });
  return { service: make(), make, deps, requests, credentials, dir,
    setCredits: (items) => { credits = items; }, respond: (fn) => { respond = fn; },
    remove: (id) => { accounts = accounts.filter((a) => a.id !== id); },
    duplicate: () => { accounts.push({ id: "duplicate-a", vendor: "openai-codex" }); credentials["duplicate-a"] = credentials["plugin-a"]; },
    offline: () => { offline = true; }, advance: (ms) => { now += ms; }, get changed() { return changed; } };
}

const error = (code) => (err) => err.code === code;

test("only nonexpired available Codex grants are eligible; unsupported or duplicate rows are excluded", () => {
  const rows = normalizeCredits({ credits: [credit(), credit(), credit("expired", { expires_at: "2020-01-01" }),
    credit("used", { status: "redeemed" }), credit("other", { reset_type: "other_entitlement" }), credit("bad", { expires_at: "invalid" }),
    credit("no-expiry", { expires_at: null })] }, Date.now());
  assert.deepEqual(rows.filter((c) => c.eligible).map((c) => c.id), ["credit-1", "no-expiry"]);
  assert.throws(() => normalizeCredits({ available_count: 5 }, Date.now()), error("RESET_RESPONSE_INVALID"));
});

test("list is read-only and returns safe metadata, not credentials or upstream response fields", async (t) => {
  const f = await fixture(t);
  const result = await f.service.list("plugin-a");
  assert.equal(result.availableCount, 2);
  assert.equal(result.pending, null);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, "GET");
  assert.equal(f.requests[0].redirect, "error");
  assert.equal(f.requests[0].headers.authorization, "Bearer private-a");
  assert.equal(f.requests[0].headers["chatgpt-account-id"], "upstream-a");
  assert.ok(!JSON.stringify(result).includes("private-a"));
  assert.ok(!JSON.stringify(result).includes("upstream-a"));
});

test("explicit confirmation consumes exactly the selected credit on the selected account and persists no token", async (t) => {
  const f = await fixture(t);
  const prepared = await f.service.prepare("plugin-b", "credit-2");
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 0);
  await assert.rejects(f.service.consume(prepared.operationId, false), error("RESET_CONFIRM_REQUIRED"));
  const result = await f.service.consume(prepared.operationId, true);
  assert.deepEqual(result, { ok: true, code: "reset", windowsReset: 2 });
  const post = f.requests.find((r) => r.method === "POST");
  assert.equal(post.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
  assert.equal(post.headers["chatgpt-account-id"], "upstream-b");
  assert.equal(post.redirect, "error");
  assert.deepEqual(JSON.parse(post.body), { credit_id: "credit-2", redeem_request_id: prepared.operationId });
  assert.ok(!(await fs.readFile(path.join(f.dir, "openai-reset-operations.json"), "utf8")).includes("private-"));
  assert.ok(f.changed > 0);
});

test("no eligible credit, expired confirmation, removed account and identity change never POST", async (t) => {
  const f = await fixture(t);
  f.setCredits([]);
  assert.equal((await f.service.list("plugin-a")).availableCount, 0);
  await assert.rejects(f.service.prepare("plugin-a", "fake"), error("RESET_CREDIT_UNAVAILABLE"));
  f.setCredits([credit()]);
  const prepared = await f.service.prepare("plugin-a", "credit-1");
  f.credentials["plugin-a"].accountId = "another-upstream";
  await assert.rejects(f.service.consume(prepared.operationId, true), error("RESET_ACCOUNT_CHANGED"));
  f.credentials["plugin-a"].accountId = "upstream-a";
  f.advance(600000);
  await assert.rejects(f.service.consume(prepared.operationId, true), error("RESET_CONFIRM_EXPIRED"));
  f.remove("plugin-a");
  await assert.rejects(f.service.consume(prepared.operationId, true), error("RESET_ACCOUNT_INVALID"));
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 0);
});

test("the account is rechecked after credit lookup before any consumption", async (t) => {
  const f = await fixture(t);
  const prepared = await f.service.prepare("plugin-a", "credit-1");
  f.respond((input) => { f.credentials["plugin-a"].accountId = "changed"; return reply({ credits: [credit()] }); });
  await assert.rejects(f.service.consume(prepared.operationId, true), error("RESET_ACCOUNT_CHANGED"));
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 0);
});

test("duplicate clicks and duplicate account logins cannot create multiple redemptions", async (t) => {
  const f = await fixture(t);
  const first = await f.service.prepare("plugin-a", "credit-1");
  const second = await f.service.prepare("plugin-a", "credit-1");
  assert.equal(first.operationId, second.operationId);
  await assert.rejects(f.service.prepare("plugin-a", "credit-2"), error("RESET_PENDING_DIFFERENT_CREDIT"));
  assert.equal(first.creditId, "credit-1");
  f.duplicate();
  await assert.rejects(f.service.prepare("duplicate-a", "credit-2"), error("RESET_PENDING_OTHER_LOGIN"));
  assert.equal((await f.service.list("duplicate-a")).pending.accountId, "plugin-a");
  const results = await Promise.all([f.service.consume(first.operationId, true), f.service.consume(first.operationId, true)]);
  assert.equal(results[0].code, "reset");
  assert.equal(results[1].code, "reset");
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
});

test("timeout is not retried automatically; restart and manual resume reuse the exact redemption body", async (t) => {
  const f = await fixture(t);
  const first = await f.service.prepare("plugin-a", "credit-1");
  f.respond((input) => { if (input.method === "POST") throw Error("network private-a"); return reply({ credits: [credit(), credit("credit-2")] }); });
  await assert.rejects(f.service.consume(first.operationId, true), error("RESET_UNCERTAIN"));
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
  const restarted = f.make();
  assert.equal((await restarted.list("plugin-a")).pending.uncertain, true);
  await assert.rejects(restarted.prepare("plugin-a", "credit-2"), error("RESET_PENDING_DIFFERENT_CREDIT"));
  assert.equal((await restarted.prepare("plugin-a", "credit-1")).operationId, first.operationId);
  f.respond((input) => input.method === "POST" ? reply({ code: "already_redeemed", windows_reset: 2 }) : reply({ credits: [credit()] }));
  assert.equal((await restarted.consume(first.operationId, true)).code, "already_redeemed");
  const posts = f.requests.filter((r) => r.method === "POST");
  assert.equal(posts[0].body, posts[1].body);
});

test("uncertain operations can be reconciled read-only; missing evidence cannot unlock a fresh credit", async (t) => {
  const f = await fixture(t);
  const op = await f.service.prepare("plugin-a", "credit-1");
  f.respond((input) => { if (input.method === "POST") throw Error(); return reply({ credits: [credit()] }); });
  await assert.rejects(f.service.consume(op.operationId, true), error("RESET_UNCERTAIN"));
  f.setCredits([]);
  f.respond(() => reply({ credits: [] }));
  await assert.rejects(f.service.consume(op.operationId, true), error("RESET_UNCERTAIN"));
  await assert.rejects(f.service.cancel(op.operationId), error("RESET_UNCERTAIN"));
  f.respond(() => reply({ credits: [credit("credit-1", { status: "redeemed" })] }));
  assert.equal((await f.service.consume(op.operationId, true)).code, "already_redeemed");
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
});

test("nothing_to_reset and no_credit are distinct terminal results, not success messages", async (t) => {
  const f = await fixture(t);
  for (const code of ["nothing_to_reset", "no_credit"]) {
    const op = await f.service.prepare("plugin-a", "credit-1");
    f.respond((input) => input.method === "POST" ? reply({ code }) : reply({ credits: [credit()] }));
    assert.equal((await f.service.consume(op.operationId, true)).code, code);
  }
});

test("cancel never consumes; demo, non-OpenAI accounts and unsupported hosts fail closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.list("claude"), error("RESET_ACCOUNT_INVALID"));
  f.deps.getCapabilities = async () => ({ fetchRedirectModes: ["follow"] });
  await assert.rejects(f.service.list("plugin-a"), error("RESET_HOST_UNSUPPORTED"));
  f.deps.getCapabilities = async () => ({ fetchRedirectModes: ["error"] });
  const op = await f.service.prepare("plugin-a", "credit-1");
  await f.service.cancel(op.operationId);
  await assert.rejects(f.service.consume(op.operationId, true), error("RESET_OPERATION_INVALID"));
  f.offline();
  await assert.rejects(f.service.list("plugin-a"), error("RESET_OFFLINE"));
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 0);
});

test("malformed upstream replies, HTTP errors and thrown exceptions never leak bodies or credentials", async (t) => {
  const f = await fixture(t);
  for (const status of [302, 401, 403, 429, 500]) {
    f.respond(() => reply({ error: "Bearer private-a" }, status));
    await assert.rejects(f.service.list("plugin-a"), (err) => !err.message.includes("private-a"));
  }
  f.respond(() => reply({ credits: [credit()] }));
  const op = await f.service.prepare("plugin-a", "credit-1");
  f.respond((input) => input.method === "POST" ? reply({ code: "new-unknown-code", secret: "private-a" }) : reply({ credits: [credit()] }));
  await assert.rejects(f.service.consume(op.operationId, true), error("RESET_UNCERTAIN"));
});

test("corrupt store or failed pre-dispatch persistence never POST; unload blocks new operations", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dir, "openai-reset-operations.json"), "bad-json");
  await assert.rejects(f.service.list("plugin-a"), error("RESET_STORE_UNAVAILABLE"));
  await fs.unlink(path.join(f.dir, "openai-reset-operations.json"));
  const valid = f.make();
  const op = await valid.prepare("plugin-a", "credit-1");
  const broken = f.make({ fs: { ...fs, rename: async () => { throw Error("disk full"); } } });
  await assert.rejects(broken.consume(op.operationId, true), error("RESET_STORE_UNAVAILABLE"));
  assert.equal(f.requests.filter((r) => r.method === "POST").length, 0);
  await valid.stop();
  await assert.rejects(valid.list("plugin-a"), error("RESET_STOPPED"));
});
