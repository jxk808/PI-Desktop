import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true } as const;
function account(id: string): RuntimeProviderConfig {
  return {
    id, name: id, vendorKey: "fixture-vendor", modelId: "fixture-model", apiKey: "",
    authKind: "oauth", apiStyle: "chat_completions", baseUrl: "http://provider.invalid/v1",
    supportsReasoning: false, supportedThinkingLevels: ["off"],
    resolveAuth: async () => ({ apiKey: `fixture-${id}` }),
  };
}
function sse(tool = false): Response {
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-read", type: "function", function: { name: "Read", arguments: '{"path":"fixture.txt"}' } }] }
    : { role: "assistant", content: "Recovered" };
  const chunk = (value: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
  return new Response(chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function fixture(options: { tool?: boolean; allLimited?: boolean; unauthorized?: boolean; retryAfterMs?: string } = {}) {
  const requests: Array<{ account: string; body: string }> = [];
  const events: AgentEventEnvelope[] = [];
  let reads = 0;
  const primary = account("a"), fallback = account("b");
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    requests.push({ account: authorization, body: String(init?.body) });
    if (options.unauthorized) return new Response('{"error":{"message":"Unauthorized"}}', { status: 401 });
    if (options.tool && requests.length === 1) return sse(true);
    if (authorization === "Bearer fixture-a" || options.allLimited) return new Response('{"error":{"message":"quota exceeded"}}', {
      status: 429, headers: { "retry-after-ms": options.retryAfterMs ?? "1" },
    });
    return sse();
  }));
  const runtime = new DesktopAgentRuntime({
    sessionId: "fixture", mode: "agent", provider: primary, providerFallbacks: [fallback],
    thinkingLevel: "off", commandShell: shell,
    host: { async call<T>(method: string): Promise<T> {
      if (method === "session.appendMessage") return undefined as T;
      if (method !== "tools.execute") throw new Error(`Unexpected host call: ${method}`);
      reads++;
      return { ok: true, content: "fixture contents" } as T;
    } },
    onEvent: (event) => events.push(event),
  });
  return { runtime, primary, fallback, requests, events, reads: () => reads };
}
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const observed = promise.then(value => ({ value }), error => ({ error }));
  void observed.then(() => { done = true; });
  for (let tick = 0; tick < 180 && !done; tick++) await vi.advanceTimersByTimeAsync(1000);
  expect(done, "bounded account fallback run settles").toBe(true);
  const result = await observed;
  if ("error" in result) throw result.error;
  return result.value;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("same-model account fallback through the real runtime", () => {
  it("changes OAuth credentials after ten retries, preserves completed tools and reuses the active account", async () => {
    vi.useFakeTimers();
    const f = fixture({ tool: true });
    try {
      await settle(f.runtime.prompt("Read the fixture, then report."));
      expect(f.reads()).toBe(1);
      expect(f.requests.filter(r => r.account === "Bearer fixture-a")).toHaveLength(12); // Tool response + 11 failed attempts.
      expect(f.requests.at(-1)?.account).toBe("Bearer fixture-b");
      expect(JSON.parse(f.requests.at(-1)!.body).model).toBe("fixture-model");
      expect(f.requests.at(-1)?.body).toContain("fixture contents");
      expect(f.events.filter(e => e.event.type === "error")).toHaveLength(0);
      expect(f.events.some(e => e.event.type === "message_end" && e.event.message.providerId === "b" && e.event.message.content === "Recovered")).toBe(true);
      expect(f.runtime.matches({ provider: f.primary, providerFallbacks: [f.fallback], mode: "agent", thinkingLevel: "off", commandShell: shell })).toBe(true);
      expect(f.runtime.matches({ provider: f.primary, providerFallbacks: [], mode: "agent", thinkingLevel: "off", commandShell: shell })).toBe(false);
      const before = f.requests.length;
      await settle(f.runtime.prompt("Continue on the available account."));
      expect(f.requests.length).toBe(before + 1);
      expect(f.requests.at(-1)?.account).toBe("Bearer fixture-b");
    } finally { await f.runtime.dispose(); }
  });

  it("grants each account its full retry budget and stops after every account is exhausted", async () => {
    vi.useFakeTimers();
    const f = fixture({ allLimited: true });
    try {
      await settle(f.runtime.prompt("Reply."));
      expect(f.requests.filter(r => r.account === "Bearer fixture-a")).toHaveLength(11);
      expect(f.requests.filter(r => r.account === "Bearer fixture-b")).toHaveLength(11);
      expect(f.events.filter(e => e.event.type === "error")).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  it("does not rotate accounts to repair authorization failures", async () => {
    vi.useFakeTimers();
    const f = fixture({ unauthorized: true });
    try {
      await settle(f.runtime.prompt("Reply."));
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0].account).toBe("Bearer fixture-a");
      expect(f.events.filter(e => e.event.type === "error")).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });

  it("tries the other accounts before applying infinite retry to the last account", async () => {
    vi.useFakeTimers();
    const f = fixture({ allLimited: true });
    f.runtime.setInfiniteProviderRetry(true);
    try {
      const run = f.runtime.prompt("Reply.");
      await vi.advanceTimersByTimeAsync(35);
      expect(f.requests.filter(r => r.account === "Bearer fixture-a")).toHaveLength(11);
      expect(f.requests.filter(r => r.account === "Bearer fixture-b").length).toBeGreaterThan(11);
      await f.runtime.abort();
      await settle(run);
      const total = f.requests.length;
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.requests).toHaveLength(total);
    } finally { await f.runtime.dispose(); }
  });

  it("Stop cancels backoff without using another account", async () => {
    vi.useFakeTimers();
    const f = fixture({ retryAfterMs: "10000" });
    try {
      const run = f.runtime.prompt("Reply.");
      await vi.advanceTimersByTimeAsync(1);
      expect(f.requests).toHaveLength(1);
      await f.runtime.abort();
      await settle(run);
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.requests).toHaveLength(1);
    } finally { await f.runtime.dispose(); }
  });
});
