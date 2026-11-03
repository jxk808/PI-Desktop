"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const file = path.resolve(__dirname, "../main.js");
const actualRequire = createRequire(file);
const code = fs.readFileSync(file, "utf8");
const reply = (data, status = 200) => ({ status, bodyText: JSON.stringify(data) });
function app(settings = {}, pluginCredentials = {}, fetcher, hostUsage = []) {
  let changed, cliReads = 0;
  const cliPaths = [];
  const requests = [];
  let records = Array.isArray(pluginCredentials) ? pluginCredentials : Object.entries(pluginCredentials).map(([vendor, credential]) =>
    ({ id: `saved-${vendor}`, vendor, label: `${vendor} 1`, credential }));
  const metadata = () => records.map((r) => ({ id: r.id, vendor: r.vendor, label: r.label,
    priority: records.filter((a) => a.vendor === r.vendor).indexOf(r) + 1, connected: true }));
  const auth = {
    listAccounts: async () => metadata(),
    credential: async (id) => records.find((r) => r.id === id)?.credential ?? null,
    status: async () => ({ ok: true, accounts: metadata(), login: null }),
    logout: async (id) => { records = records.filter((r) => r.id !== id); changed(); return auth.status(); },
    move: async (id, direction) => {
      const i = records.findIndex((r) => r.id === id), j = i + (direction === "up" ? -1 : 1);
      [records[i], records[j]] = [records[j], records[i]]; changed(); return auth.status();
    },
    stop: async () => {},
    start: async () => { throw new Error("must not start in demo"); },
  };
  const pi = { plugin: { getSettings: async () => settings, setSettings: async (partial) => Object.assign(settings, partial) },
    commands: { unregister: async () => {} },
    models: { subscriptionUsage: async () => structuredClone(hostUsage) },
    net: { fetch: async (input) => { requests.push(input); return fetcher(input); } } };
  const sandbox = { pi, module: { exports: {} }, console, Buffer,
    require(name) {
      if (name === "./lib/oauth") return { createAuth: (_pi, opts) => { changed = opts.onChange; return auth; } };
      if (name === "node:fs/promises") return { stat: async (file) => {
        cliReads++; cliPaths.push(String(file)); throw new Error("no CLI installed");
      } };
      if (name === "node:os") return { homedir: () => "/nonexistent-home" };
      return actualRequire(name);
    }, process: { env: {} } };
  vm.runInNewContext(code, sandbox, { filename: file });
  return { invoke: sandbox.module.exports.onPanelInvoke, requests, cliPaths,
    get cliReads() { return cliReads; } };
}



test("PI-Desktop host accounts render independently and suppress the single CLI fallback", async () => {
  const reset = new Date(Date.now() + 3_600_000).toISOString();
  const hostUsage = [1, 2, 3, 4].map((number) => ({
    providerId: `provider-${number}`,
    vendorId: "openai-codex",
    accountLabel: `user-${number}@example.com`,
    plan: number === 4 ? "pro" : "plus",
    status: "ok",
    windows: [{
      period: "session",
      labelKey: "window.session",
      windowMinutes: 300,
      usedPercent: number * 10,
      remainingPercent: 100 - number * 10,
      resetsAt: reset,
    }],
  }));
  const a = app({ autoDetect: true }, {}, () => { throw new Error("plugin network should not run"); }, hostUsage);
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.accounts, (row) => row.id), [
    "host:provider-1", "host:provider-2", "host:provider-3", "host:provider-4",
  ]);
  assert.deepEqual(Array.from(result.accounts, (row) => row.label), hostUsage.map((row) =>
    `OpenAI (ChatGPT Plus/Pro) · ${row.accountLabel}`));
  assert.deepEqual(Array.from(result.accounts, (row) => row.source), ["host", "host", "host", "host"]);
  assert.equal(result.accounts.filter((row) => row.recommended).length, 1);
  assert.equal(a.requests.length, 0);
  assert.equal(a.cliPaths.some((file) => file.includes(".codex") && file.endsWith("auth.json")), false);
  assert.ok(!JSON.stringify(result).includes("token"));
});

test("plugin login drives ChatGPT quota with autoDetect off and no CLI", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "private-plugin-token", accountId: "acct-1", source: "plugin" } }, () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.ok, true);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].windows[0].remainingPercent, 75);
  assert.equal(a.requests[0].headers["chatgpt-account-id"], "acct-1");
  assert.equal(a.requests[0].headers.authorization, "Bearer private-plugin-token");
  assert.equal(a.cliReads, 0);
  assert.ok(!JSON.stringify(result).includes("private-plugin-token"));
  await a.invoke("quota.auth.logout", { accountId: "saved-openai-codex" });
  assert.equal((await a.invoke("quota.snapshot", {})).accounts.length, 0);
});

test("manual tokens and plugin accounts are displayed independently with autoDetect off", async () => {
  const a = app({ autoDetect: false, credentials: { "openai-codex": { token: "manual", accountId: "manual-acct" }, openrouter: "or-key" } },
    { "openai-codex": { token: "plugin" } }, () => reply({}));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 3);
  const req = a.requests.find((r) => r.headers.authorization === "Bearer manual");
  assert.equal(req.headers.authorization, "Bearer manual");
  assert.equal(req.headers["chatgpt-account-id"], "manual-acct");
  assert.equal(a.cliReads, 0);
});

test("CLI discovery is optional fallback only", async () => {
  const a = app({ autoDetect: true }, { anthropic: { token: "saved" } }, () => reply({}));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].provider, "anthropic");
  assert.ok(a.cliReads > 0);
});

test("demo is offline and refuses new OAuth starts", async () => {
  const a = app({ demoMode: true, autoDetect: true });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.demo, true);
  assert.ok(result.accounts.length > 0);
  assert.equal(a.requests.length, 0);
  assert.equal(a.cliReads, 0);
  assert.equal((await a.invoke("quota.auth.start", { vendor: "openai-codex" })).code, "DEMO_MODE");
});

test("a revoked credential surfaces 401 without repeating another usage endpoint or leaking body", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "secret" } }, () => reply({ error: "secret" }, 401));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].status, "error");
  assert.match(result.accounts[0].error, /401/);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.equal(a.requests.length, 1);
});

test("logout invalidates an in-flight snapshot instead of caching the previous account", async () => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const a = app({ autoDetect: false }, { anthropic: { token: "old" } }, () => pending);
  const snapshot = a.invoke("quota.refresh", {});
  await new Promise((r) => setImmediate(r));
  await a.invoke("quota.auth.logout", { accountId: "saved-anthropic" });
  resolve(reply({ five_hour: { utilization: 10 } }));
  assert.equal((await snapshot).code, "AUTH_CHANGED");
  assert.equal((await a.invoke("quota.snapshot", {})).accounts.length, 0);
});

test("generic mapped windows accept second-based periods without window_minutes", async () => {
  const a = app({ autoDetect: false, sources: [{ vendor: "xai", url: "https://api.x.ai/quota", token: "manual",
    windows: [{ path: "rate_limit" }] }] }, {}, () => reply({ rate_limit: { used_percent: 20, limit_window_seconds: 18000 } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].status, "ok");
  assert.equal(result.accounts[0].windows[0].windowMinutes, 300);
  assert.equal(result.accounts[0].windows[0].remainingPercent, 80);
});

test("multiple ChatGPT accounts keep headers isolated; exhausted/error accounts are not recommended", async () => {
  const records = ["a", "b", "c"].map((id) => ({ id, vendor: "openai-codex", label: `Account ${id}`,
    credential: { token: `private-${id}`, accountId: `upstream-${id}`, source: "plugin" } }));
  const a = app({ autoDetect: false }, records, (req) => {
    const id = req.headers.authorization.slice(-1);
    assert.equal(req.headers["chatgpt-account-id"], `upstream-${id}`);
    if (id === "c") return reply({}, 401);
    return reply({ rate_limit: { primary_window: { used_percent: id === "a" ? 100 : 20, limit_window_seconds: 18000 } } });
  });
  const result = await a.invoke("quota.refresh", {});
  assert.deepEqual(Array.from(result.accounts, (r) => r.id), ["plugin:a", "plugin:b", "plugin:c"]);
  assert.deepEqual(Array.from(result.accounts, (r) => r.availability), ["exhausted", "available", "unknown"]);
  assert.deepEqual(Array.from(result.accounts, (r) => r.recommended), [false, true, false]);
  assert.ok(!JSON.stringify(result).includes("private-"));
  assert.ok(!JSON.stringify(result).includes("upstream-"));
  await a.invoke("quota.auth.logout", { accountId: "a" });
  assert.deepEqual(Array.from((await a.invoke("quota.snapshot", {})).accounts, (r) => r.id), ["plugin:b", "plugin:c"]);
});

test("priority changes invalidate the snapshot cache and change the recommendation", async () => {
  const a = app({ autoDetect: false }, ["a", "b"].map((id) => ({ id, vendor: "anthropic", label: id,
    credential: { token: id, source: "plugin" } })), () => reply({ five_hour: { utilization: 10 } }));
  assert.equal((await a.invoke("quota.snapshot", {})).accounts.find((r) => r.recommended).id, "plugin:a");
  await a.invoke("quota.auth.move", { accountId: "b", direction: "up" });
  const snapshot = await a.invoke("quota.snapshot", {});
  assert.equal(snapshot.accounts[0].id, "plugin:b");
  assert.equal(snapshot.accounts[0].priority, 1);
  assert.equal(snapshot.accounts[0].recommended, true);
});

const fakeJwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

test("ChatGPT plugin account prefers the profile name and still carries the email", async () => {
  const token = fakeJwt({ "https://api.openai.com/profile": { name: "山口 愛", email: "alice@example.com" } });
  const a = app({ autoDetect: false }, { "openai-codex": { token, accountId: "acct-1", source: "plugin" } },
    () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "OpenAI (ChatGPT Plus/Pro) · 山口 愛");
  assert.equal(result.accounts[0].identity, "山口 愛");
  assert.equal(result.accounts[0].email, "alice@example.com");
  assert.equal(result.accounts[0].vendorName, "OpenAI (ChatGPT Plus/Pro)");
  assert.ok(!JSON.stringify(result).includes(token));
});

test("ChatGPT plugin account falls back to the email when the token has no name", async () => {
  const token = fakeJwt({ "https://api.openai.com/profile": { email: "alice@example.com" } });
  const a = app({ autoDetect: false }, { "openai-codex": { token, accountId: "acct-1", source: "plugin" } },
    () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "OpenAI (ChatGPT Plus/Pro) · alice@example.com");
  assert.equal(result.accounts[0].identity, "alice@example.com");
});

test("ChatGPT account without a readable email falls back to the vendor name, not the default number", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "opaque-token", source: "plugin" } },
    () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "OpenAI (ChatGPT Plus/Pro)");
  assert.equal(result.accounts[0].identity, null);
});

test("Copilot plugin account shows the detected GitHub login", async () => {
  const a = app({ autoDetect: false }, { "github-copilot": { token: "gh", source: "plugin" } },
    () => reply({ login: "octocat", copilot_plan: "individual" }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "GitHub Copilot · octocat");
  assert.equal(result.accounts[0].identity, "octocat");
});

test("Claude plugin account shows the email from the OAuth profile endpoint", async () => {
  const a = app({ autoDetect: false }, { anthropic: { token: "claude-token", source: "plugin" } }, (req) =>
    req.url.includes("/api/oauth/profile")
      ? reply({ account: { uuid: "u1", email: "claude@example.com" } })
      : reply({ five_hour: { utilization: 10 } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "Anthropic (Claude Pro/Max) · claude@example.com");
  assert.equal(result.accounts[0].identity, "claude@example.com");
  assert.ok(!JSON.stringify(result).includes("claude-token"));
});

test("a stored Claude email skips the profile request", async () => {
  const a = app({ autoDetect: false }, { anthropic: { token: "t", email: "stored@example.com", source: "plugin" } }, (req) => {
    assert.ok(!req.url.includes("/api/oauth/profile"), "profile must not be fetched when the email is already known");
    return reply({ five_hour: { utilization: 10 } });
  });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].identity, "stored@example.com");
});

test("a failing Claude profile request only loses the name, not the quota", async () => {
  const a = app({ autoDetect: false }, { anthropic: { token: "t", source: "plugin" } }, (req) =>
    req.url.includes("/api/oauth/profile") ? reply({ error: "nope" }, 500) : reply({ five_hour: { utilization: 10 } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].status, "ok");
  assert.equal(result.accounts[0].label, "Anthropic (Claude Pro/Max)");
  assert.equal(result.accounts[0].identity, null);
});

test("a stored ChatGPT email wins over the access token claims", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "opaque", email: "id@example.com", source: "plugin" } },
    () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].identity, "id@example.com");
});
