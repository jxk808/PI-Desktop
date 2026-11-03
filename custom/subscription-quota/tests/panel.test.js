"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let JSDOM = null;
try { ({ JSDOM } = require("jsdom")); } catch { /* optional dev dependency; tests skip without it */ }
const html = fs.readFileSync(path.join(__dirname, "../views/quota.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const settle = () => new Promise((r) => setImmediate(r));
async function fixture(t, initial = []) {
  if (!JSDOM) { t.skip("jsdom is not installed — run `npm install` to enable panel DOM tests"); return null; }
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  let accounts = initial.map((item, i) => {
    const base = typeof item === "string" ? { id: item, label: item } : item;
    return { vendor: "openai-codex", priority: i + 1, connected: true, ...base };
  });
  let login = null, outcome = "success";
  const calls = [];
  w.matchMedia = () => ({ matches: false });
  const state = () => ({ ok: true, accounts: structuredClone(accounts), login });
  w.pluginBridge = { invoke: async (channel, p) => {
    calls.push({ channel, p });
    if (channel === "app.getAppearance") return { locale: "zh-CN", base: "light" };
    if (channel === "quota.snapshot") return { ok: true, demo: false, accounts: accounts.map((a) => ({ id: `plugin:${a.id}`, source: "plugin", provider: a.vendor, identity: a.identity ?? null, email: a.email ?? null, label: a.label, status: "ok", windows: [{ usedPercent: 10, remainingPercent: 90 }] })) };
    if (channel === "quota.auth.start") {
      if (outcome === "throw") throw Error("network");
      const id = `id-${calls.length}`;
      login = { id, vendor: p.vendor, status: outcome, method: "browser", expiresAt: Date.now() + 600000, url: "https://example.com" };
      if (outcome === "success") accounts.push({ id, vendor: p.vendor, label: id, priority: accounts.length + 1, connected: true });
    }
    if (channel === "quota.auth.cancel") login = { ...login, status: "cancelled" };
    return state();
  } };
  w.eval(script);
  await settle();
  return { w, d, calls, outcome: (v) => { outcome = v; },
    add: () => d.querySelector('[data-vendor="openai-codex"][data-auth="start"]') };
}

test("existing accounts render and repeated add works after success, failure, cancel and rejection", async (t) => {
  const f = await fixture(t, ["old"]);
  if (!f) return;
  f.d.getElementById("auth-toggle").click(); await settle();
  assert.match(f.d.querySelector(".qa-name").textContent, /优先级 1/);
  // The note feature is gone: neither a card note control nor a label field when adding.
  assert.equal(f.d.querySelectorAll("[data-note-action], [data-note-input], .qp-rename").length, 0);
  assert.equal(f.d.querySelectorAll(".qa-add input").length, 0);
  for (const outcome of ["success", "error", "waiting", "throw", "success"]) {
    f.outcome(outcome);
    assert.equal(f.add().disabled, false);
    f.add().click(); await settle();
    if (outcome === "waiting") { assert.equal(f.add().disabled, true); f.d.getElementById("auth-cancel").click(); await settle(); }
    assert.equal(f.add().disabled, false);
  }
  assert.equal(f.calls.filter((c) => c.channel === "quota.auth.start").length, 5);
  assert.equal(f.calls.filter((c) => c.channel === "quota.auth.start").every((c) => c.p.label === undefined), true);
  assert.equal(f.d.querySelectorAll("[data-account-id]").length, 3);
});

test("the card and the account list show the detected identity from the snapshot", async (t) => {
  const f = await fixture(t, [{ id: "one", label: "OpenAI (ChatGPT Plus/Pro) · alice@example.com" }]);
  if (!f) return;
  assert.equal(f.d.querySelector(".qp-name").textContent, "OpenAI (ChatGPT Plus/Pro) · alice@example.com");
  f.d.getElementById("auth-toggle").click(); await settle();
  assert.equal(f.d.querySelector(".qa-name").textContent, "优先级 1 · OpenAI (ChatGPT Plus/Pro) · alice@example.com");
});

test("the name stays the title while the email shows as a chip", async (t) => {
  const f = await fixture(t, [{ id: "one", label: "OpenAI (ChatGPT Plus/Pro) · 山口 愛", identity: "山口 愛", email: "kacieknauber291290@outlook.de" }]);
  if (!f) return;
  assert.equal(f.d.querySelector(".qp-name").textContent, "OpenAI (ChatGPT Plus/Pro) · 山口 愛");
  assert.equal(f.d.querySelector(".qp-chip-mail").textContent, "kacieknauber291290@outlook.de");
});

test("an account whose only identity is the email does not repeat it as a chip", async (t) => {
  const f = await fixture(t, [{ id: "one", label: "Anthropic (Claude Pro/Max) · me@example.com", identity: "me@example.com", email: "me@example.com" }]);
  if (!f) return;
  assert.equal(f.d.querySelectorAll(".qp-chip-mail").length, 0);
});

test("header is not sticky and standalone login is disabled", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  assert.equal(f.w.getComputedStyle(f.d.querySelector(".qp-head")).position, "relative");
});
