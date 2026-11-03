"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// These are the endpoints used by openai/codex's backend-client.
const CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CONSUME_URL = `${CREDITS_URL}/consume`;
const PREPARE_TTL = 10 * 60_000;
const STATES = new Set(["prepared", "sending", "unknown", "complete", "cancelled"]);
const CODES = new Set(["reset", "already_redeemed", "nothing_to_reset", "no_credit"]);
const fail = (code) => Object.assign(new Error(code), { code });
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;
const uuid = (value) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

function normalizeCredits(data, now) {
  if (!data || !Array.isArray(data.credits) || data.credits.length > 2000) throw fail("RESET_RESPONSE_INVALID");
  const ids = new Set();
  return data.credits.flatMap((credit) => {
    if (!text(credit?.id) || ids.has(credit.id)) return [];
    ids.add(credit.id);
    const expires = credit.expires_at == null ? null : Date.parse(credit.expires_at);
    if (expires !== null && !Number.isFinite(expires)) return [];
    // Unknown grant types are not a license to consume another entitlement.
    const eligible = credit.reset_type === "codex_rate_limits" && credit.status === "available" && (expires === null || expires > now);
    return [{ id: credit.id, eligible, status: typeof credit.status === "string" ? credit.status : "unknown",
      expiresAt: expires === null ? null : new Date(expires).toISOString() }];
  });
}

function createOpenAiReset(deps, options = {}) {
  const disk = options.fs ?? fs;
  const clock = options.now ?? Date.now;
  const makeId = options.randomUUID ?? randomUUID;
  let operations = null;
  let queue = Promise.resolve();
  let stopped = false;
  let file;
  const running = () => { if (stopped) throw fail("RESET_STOPPED"); };
  function enqueue(work) {
    const result = queue.then(() => { running(); return work(); });
    queue = result.catch(() => {});
    return result;
  }
  async function load() {
    if (operations) return;
    try {
      file = path.join(await deps.getDataPath(), "openai-reset-operations.json");
      const stat = await disk.stat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw fail("RESET_STORE_UNAVAILABLE");
      const data = JSON.parse(await disk.readFile(file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.operations) || data.operations.length > 500 ||
          data.operations.some((op) => !uuid(op.id) || !text(op.accountId) || !text(op.upstreamAccountId) ||
            !text(op.creditId) || !STATES.has(op.state) || !Number.isFinite(op.createdAt) ||
            (op.expiresAt !== null && !Number.isFinite(Date.parse(op.expiresAt))) ||
            (op.state === "complete" && (!CODES.has(op.code) || !Number.isSafeInteger(op.windowsReset) || op.windowsReset < 0)))) {
        throw fail("RESET_STORE_UNAVAILABLE");
      }
      operations = data.operations;
    } catch (error) {
      if (error.code === "ENOENT" && file) operations = [];
      else throw fail("RESET_STORE_UNAVAILABLE");
    }
  }
  async function save(next) {
    try {
      await disk.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${makeId()}.tmp`;
      await disk.writeFile(temp, JSON.stringify({ version: 1, operations: next }), { mode: 0o600 });
      await disk.rename(temp, file);
      operations = next;
    } catch { throw fail("RESET_STORE_UNAVAILABLE"); }
  }
  async function update(op, changes) {
    const next = { ...op, ...changes };
    await save(operations.map((item) => item.id === op.id ? next : item));
    return next;
  }
  async function context(accountId) {
    running();
    if (await deps.isOffline()) throw fail("RESET_OFFLINE");
    if (!text(accountId)) throw fail("RESET_ACCOUNT_INVALID");
    const account = (await deps.listAccounts()).find((item) => item.id === accountId);
    if (!account || account.vendor !== "openai-codex") throw fail("RESET_ACCOUNT_INVALID");
    let credential;
    try { credential = await deps.credential(accountId); } catch { throw fail("RESET_AUTH_REQUIRED"); }
    if (!credential || typeof credential.token !== "string" || !credential.token || !text(credential.accountId)) throw fail("RESET_AUTH_REQUIRED");
    let capabilities;
    try { capabilities = await deps.getCapabilities(); } catch { throw fail("RESET_HOST_UNSUPPORTED"); }
    if (!capabilities?.fetchRedirectModes?.includes("error")) throw fail("RESET_HOST_UNSUPPORTED");
    running();
    const label = deps.accountLabel?.(credential) ?? credential.email ?? "OpenAI";
    return { accountId, upstreamAccountId: credential.accountId, token: credential.token,
      accountLabel: typeof label === "string" && label.length <= 512 ? label : "OpenAI" };
  }
  async function request(ctx, method, body) {
    running();
    let response;
    try {
      response = await deps.fetch({ url: method === "POST" ? CONSUME_URL : CREDITS_URL,
        method, redirect: "error", timeoutMs: 8_000,
        headers: { accept: "application/json", authorization: `Bearer ${ctx.token}`,
          "chatgpt-account-id": ctx.upstreamAccountId, "user-agent": "pi-desktop-subscription-quota/0.4.3-reset.1",
          ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw fail("RESET_NETWORK"); }
    if (response?.status < 200 || response?.status >= 300 || !Number.isInteger(response?.status)) {
      const status = response?.status;
      throw fail(status === 401 || status === 403 ? "RESET_AUTH_REQUIRED" : status === 429 ? "RESET_RATE_LIMITED" : "RESET_NETWORK");
    }
    try {
      if (typeof response.bodyText !== "string" || response.bodyText.length > 1024 * 1024) throw Error();
      return JSON.parse(response.bodyText);
    } catch { throw fail("RESET_RESPONSE_INVALID"); }
  }
  const readCredits = async (ctx) => normalizeCredits(await request(ctx, "GET"), clock());
  const unresolved = (op) => op.state === "sending" || op.state === "unknown";
  const publicOperation = (op) => op ? { operationId: op.id, accountId: op.accountId,
    upstreamAccountId: op.upstreamAccountId, creditId: op.creditId, label: op.accountLabel || "OpenAI",
    expiresAt: op.expiresAt, uncertain: unresolved(op) } : null;
  const outcome = (op) => ({ ok: true, code: op.code, windowsReset: op.windowsReset });
  async function finish(op, code, windowsReset = 0) {
    const saved = await update(op, { state: "complete", code, windowsReset });
    deps.onChange?.();
    return outcome(saved);
  }
  function find(id) {
    const op = uuid(id) ? operations.find((item) => item.id === id) : null;
    if (!op) throw fail("RESET_OPERATION_INVALID");
    return op;
  }
  async function pinned(op) {
    const ctx = await context(op.accountId);
    if (ctx.upstreamAccountId !== op.upstreamAccountId) throw fail("RESET_ACCOUNT_CHANGED");
    return ctx;
  }
  return {
    list(accountId) { return enqueue(async () => {
      const ctx = await context(accountId);
      await load();
      const credits = await readCredits(ctx);
      const pending = operations.find((op) => op.upstreamAccountId === ctx.upstreamAccountId &&
        (unresolved(op) || (op.state === "prepared" && clock() - op.createdAt < PREPARE_TTL)));
      // A duplicate plugin login must not prepare a second redemption for the same real account.
      return { ok: true, availableCount: credits.filter((c) => c.eligible).length,
        credits: credits.filter((c) => c.eligible).map(({ id, expiresAt }) => ({ id, expiresAt })),
        pending: publicOperation(pending) };
    }); },
    prepare(accountId, creditId) { return enqueue(async () => {
      const ctx = await context(accountId);
      await load();
      const pending = operations.find((op) => op.upstreamAccountId === ctx.upstreamAccountId &&
        (unresolved(op) || (op.state === "prepared" && clock() - op.createdAt < PREPARE_TTL)));
      if (pending) {
        if (pending.accountId !== accountId) throw fail("RESET_PENDING_OTHER_LOGIN");
        if (pending.creditId !== creditId) throw fail("RESET_PENDING_DIFFERENT_CREDIT");
        return { ok: true, ...publicOperation(pending) };
      }
      const credit = (await readCredits(ctx)).find((item) => item.id === creditId && item.eligible);
      if (!credit) throw fail("RESET_CREDIT_UNAVAILABLE");
      const op = { id: makeId(), accountId, upstreamAccountId: ctx.upstreamAccountId, creditId: credit.id,
        expiresAt: credit.expiresAt, accountLabel: ctx.accountLabel, createdAt: clock(), state: "prepared" };
      const keep = operations.filter((item) => unresolved(item) || (item.state === "prepared" && clock() - item.createdAt < PREPARE_TTL));
      const history = operations.filter((item) => !keep.includes(item)).slice(-100);
      await save([...history, ...keep, op]);
      return { ok: true, ...publicOperation(op) };
    }); },
    consume(operationId, confirmed) { return enqueue(async () => {
      if (confirmed !== true) throw fail("RESET_CONFIRM_REQUIRED");
      await load();
      let op = find(operationId);
      let ctx = await pinned(op);
      if (op.state === "complete") return outcome(op);
      if (op.state === "cancelled") throw fail("RESET_OPERATION_INVALID");
      if (op.state === "prepared" && clock() - op.createdAt >= PREPARE_TTL) throw fail("RESET_CONFIRM_EXPIRED");
      const credit = (await readCredits(ctx)).find((item) => item.id === op.creditId);
      if (unresolved(op) && ["redeemed", "consumed"].includes(credit?.status)) return finish(op, "already_redeemed");
      if (!credit?.eligible) {
        if (unresolved(op)) throw fail("RESET_UNCERTAIN");
        return finish(op, "no_credit");
      }
      // Reload after the read-only request to catch removal or reauthorization before dispatch.
      ctx = await pinned(op);
      op = await update(op, { state: "sending" });
      deps.onChange?.();
      try {
        ctx = await pinned(op);
        const data = await request(ctx, "POST", { redeem_request_id: op.id, credit_id: op.creditId });
        if (!CODES.has(data?.code) || (data.windows_reset !== undefined &&
            (!Number.isSafeInteger(data.windows_reset) || data.windows_reset < 0))) throw fail("RESET_RESPONSE_INVALID");
        return await finish(op, data.code, data.windows_reset ?? 0);
      } catch {
        try { await update(op, { state: "unknown" }); } catch { /* The durable sending record still prevents a new redemption. */ }
        throw fail("RESET_UNCERTAIN");
      }
    }); },
    cancel(operationId) { return enqueue(async () => {
      await load();
      const op = find(operationId);
      await pinned(op);
      if (op.state !== "prepared") throw fail("RESET_UNCERTAIN");
      await update(op, { state: "cancelled" });
      return { ok: true };
    }); },
    async stop() { stopped = true; await queue; },
  };
}

module.exports = { createOpenAiReset, normalizeCredits };
