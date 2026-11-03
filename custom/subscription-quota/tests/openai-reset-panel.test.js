"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { JSDOM } = require("jsdom");
const mainFile = path.resolve(__dirname, "../main.js");
const actualRequire = createRequire(mainFile);
const source = syncFs.readFileSync(mainFile, "utf8");
const html = syncFs.readFileSync(path.resolve(__dirname, "../views/quota.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const reply = (data) => ({ status: 200, bodyText: JSON.stringify(data) });

async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Timed out waiting for panel state");
}

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "quota-panel-test-"));
  const requests = [], calls = [];
  const records = [{ id: "a", vendor: "openai-codex", label: "OpenAI A", connected: true, priority: 1 },
    ...(options.two ? [{ id: "b", vendor: "openai-codex", label: "OpenAI B", connected: true, priority: 2 }] : [])];
  let postMode = options.code || "reset", updated = false, changed;
  let credits = options.empty ? [] : [{ id: "credit-1", reset_type: "codex_rate_limits", status: "available", expires_at: "2030-01-01T00:00:00Z" }];
  if (options.twoCredits) credits.push({ ...credits[0], id: "credit-2" });
  const settings = { autoDetect: false, demoMode: !!options.demo };
  const bindings = new Map();
  const auth = { listAccounts: async () => records,
    credential: async (id) => ({ token: `private-${id}`, accountId: bindings.get(id)?.accountId || `upstream-${id}`, email: bindings.get(id)?.email || `${id}@example.test`, source: "plugin" }),
    status: async () => ({ ok: true, accounts: records, login: null }), stop: async () => {} };
  const pi = { plugin: { getSettings: async () => settings, getDataPath: async () => dir, setSettings: async (p) => { Object.assign(settings, p); changed(); } },
    commands: { unregister: async () => {} }, net: {
      getCapabilities: async () => ({ fetchRedirectModes: ["error"] }),
      fetch: async (input) => {
        requests.push(input);
        if (input.url.endsWith("/consume")) {
          if (postMode === "timeout") throw Error("private network details");
          updated = true; credits = credits.map((c) => ({ ...c, status: "redeemed" }));
          return reply({ code: postMode, windows_reset: postMode === "reset" ? 2 : 0 });
        }
        if (input.url.endsWith("/rate-limit-reset-credits")) return reply({ available_count: credits.length, credits });
        return reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: updated ? 0 : 100, limit_window_seconds: 18000 } } });
      },
    } };
  const sandbox = { pi, module: { exports: {} }, Buffer, console, process: { env: {} }, require: (name) => {
    if (name === "./lib/oauth") return { createAuth: (_pi, opts) => { changed = opts.onChange; return auth; } };
    return actualRequire(name);
  } };
  vm.runInNewContext(source, sandbox, { filename: mainFile });
  const plugin = sandbox.module.exports;
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  t.after(async () => { dom.window.close(); await plugin.onUnload(); await fs.rm(dir, { recursive: true, force: true }); });
  const w = dom.window, d = w.document;
  w.matchMedia = () => ({ matches: false });
  w.pluginBridge = { invoke: async (channel, payload) => {
    calls.push({ channel, payload });
    if (channel === "app.getAppearance") return { locale: options.locale || "zh-CN", base: "light" };
    return plugin.onPanelInvoke(channel, payload);
  } };
  w.eval(script);
  await waitFor(() => d.querySelector(".qp-card"));
  const button = (action, id = "a") => d.querySelector(`[data-reset-account="${id}"][data-reset-action="${action}"]`);
  const posts = () => requests.filter((r) => r.method === "POST");
  async function query(id = "a") { button("list", id).click(); await waitFor(() => button("prepare", id) || d.querySelector(".qr-panel p")); }
  async function prepare(id = "a") { await query(id); button("prepare", id).click(); await waitFor(() => button("consume", id) && !button("consume", id).disabled); }
  return { d, w, calls, requests, button, query, prepare, posts,
    mode: (mode) => { postMode = mode; }, invoke: plugin.onPanelInvoke,
    reauthorize: (id, accountId, email) => bindings.set(id, { accountId, email }) };
}

test("user path uses the selected account, requires confirmation, consumes once and refreshes actual quota", async (t) => {
  const f = await fixture(t, { two: true });
  assert.ok(f.d.querySelector(".qp-chip").textContent.includes("plus"));
  await f.prepare("b");
  assert.equal(f.posts().length, 0);
  assert.match(f.d.querySelector(".qr-confirm").textContent, /b@example.test/);
  assert.match(f.d.querySelector(".qr-confirm").textContent, /不能撤销/);
  const confirm = f.button("consume", "b");
  confirm.click(); confirm.click();
  assert.equal(f.button("consume", "b").disabled, true);
  await waitFor(() => f.calls.some((c) => c.channel === "quota.refresh") && f.d.querySelector(".qr-message")?.textContent.includes("已重置"));
  assert.equal(f.posts().length, 1);
  assert.equal(f.posts()[0].headers["chatgpt-account-id"], "upstream-b");
  assert.ok(f.calls.some((c) => c.channel === "quota.openaiReset.consume" && c.payload.confirmed === true));
  await waitFor(() => f.button("list", "b").closest(".qp-card").querySelector('.qp-bar[aria-valuenow="100"]'));
  assert.ok(!f.d.body.textContent.includes("private-"));
});

test("cancelling the confirmation and querying an empty credit list never consume", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  f.button("cancel").click();
  await waitFor(() => !f.d.querySelector(".qr-confirm"));
  assert.equal(f.posts().length, 0);
  const empty = await fixture(t, { empty: true });
  await empty.query();
  assert.match(empty.d.querySelector(".qr-panel").textContent, /没有可用/);
  assert.equal(empty.button("prepare"), null);
  assert.equal(empty.posts().length, 0);
});

test("unknown results expose a manual resume path and never automatically consume another credit", async (t) => {
  const f = await fixture(t, { code: "timeout" });
  await f.prepare();
  f.button("consume").click();
  await waitFor(() => f.button("resume"));
  assert.equal(f.posts().length, 1);
  assert.match(f.d.querySelector(".qr-error").textContent, /未知/);
  const oldBody = f.posts()[0].body;
  f.mode("already_redeemed");
  f.button("resume").click();
  assert.equal(f.posts().length, 1);
  f.button("consume").click();
  await waitFor(() => f.d.querySelector(".qr-message")?.textContent.includes("已兑换"));
  assert.equal(f.posts().length, 2);
  assert.equal(f.posts()[1].body, oldBody);
});

test("the English panel distinguishes nothing-to-reset from a successful reset", async (t) => {
  const f = await fixture(t, { locale: "en", code: "nothing_to_reset" });
  assert.match(f.button("list").textContent, /Query reset credits/);
  await f.prepare();
  assert.match(f.d.querySelector(".qr-confirm").textContent, /cannot be undone/);
  f.button("consume").click();
  await waitFor(() => f.d.querySelector(".qr-message")?.textContent.includes("no window to reset"));
  assert.ok(!f.d.querySelector(".qr-message").textContent.includes("reset the usage"));
});

test("demo hides reset controls and the real channel refuses all reset queries offline", async (t) => {
  const f = await fixture(t, { demo: true });
  assert.equal(f.d.querySelectorAll("[data-reset-action]").length, 0);
  assert.equal((await f.invoke("quota.openaiReset.list", { accountId: "a" })).code, "RESET_OFFLINE");
  assert.equal(f.requests.length, 0);
});

test("a stale card cannot supply the confirmation identity after another panel reauthorizes", async (t) => {
  const f = await fixture(t);
  assert.match(f.d.querySelector(".qp-name").textContent, /a@example.test/);
  f.reauthorize("a", "upstream-new", "new@example.test");
  await f.prepare();
  const confirmation = f.d.querySelector(".qr-confirm").textContent;
  assert.match(confirmation, /new@example.test/);
  assert.match(confirmation, /upstream-new/);
  assert.match(confirmation, /credit-1/);
  assert.ok(!confirmation.includes("a@example.test"));
  f.button("consume").click();
  await waitFor(() => f.d.querySelector(".qr-message")?.textContent.includes("已重置"));
  assert.equal(f.posts()[0].headers["chatgpt-account-id"], "upstream-new");
});

test("refreshing the snapshot while confirmation is open cannot relabel its pinned identity", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  f.reauthorize("a", "upstream-other", "other@example.test");
  f.d.getElementById("refresh").click();
  await waitFor(() => f.d.querySelector(".qp-name").textContent.includes("other@example.test"));
  assert.match(f.d.querySelector(".qr-confirm").textContent, /a@example.test/);
  assert.match(f.d.querySelector(".qr-confirm").textContent, /upstream-a/);
  assert.ok(!f.d.querySelector(".qr-confirm").textContent.includes("other@example.test"));
  f.button("consume").click();
  await waitFor(() => f.d.querySelector(".qr-error")?.textContent.includes("账号身份已变化"));
  assert.equal(f.posts().length, 0);
});

test("another panel's selected credit is never substituted for a different credit selection", async (t) => {
  const f = await fixture(t, { twoCredits: true });
  await f.query();
  await f.invoke("quota.openaiReset.prepare", { accountId: "a", creditId: "credit-1" });
  f.d.querySelector('[data-reset-action="prepare"][data-reset-credit="credit-2"]').click();
  await waitFor(() => f.d.querySelector(".qr-error")?.textContent.includes("不同的券"));
  assert.equal(f.d.querySelector(".qr-confirm"), null);
  assert.equal(f.posts().length, 0);
  f.button("list").click();
  await waitFor(() => f.button("resume"));
  f.button("resume").click();
  assert.match(f.d.querySelector(".qr-confirm").textContent, /credit-1/);
  assert.ok(!f.d.querySelector(".qr-confirm").textContent.includes("credit-2"));
});
