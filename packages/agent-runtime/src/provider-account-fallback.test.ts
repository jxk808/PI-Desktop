import { describe, expect, it } from "vitest";
import { compatibleOAuthAccount, ProviderAccountFallback } from "./provider-account-fallback.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

function account(id: string, overrides: Partial<RuntimeProviderConfig> = {}): RuntimeProviderConfig {
  return {
    id, name: id, vendorKey: "fixture-vendor", modelId: "fixture-model",
    baseUrl: "https://provider.invalid/v1", apiKey: "", authKind: "oauth",
    apiStyle: "chat_completions", supportsReasoning: false, supportedThinkingLevels: ["off"],
    ...overrides,
  };
}

describe("compatible OAuth account pool", () => {
  it("permits only the same OAuth vendor, model and request contract", () => {
    const first = account("first");
    expect(compatibleOAuthAccount(first, account("second"))).toBe(true);
    for (const overrides of [
      { authKind: "api_key" }, { authKind: "none" }, { vendorKey: "other" },
      { modelId: "other" }, { baseUrl: "https://other.invalid/v1" },
      { baseUrl: "https://provider.invalid/V1" }, { apiStyle: "responses" },
      { headers: { "X-Account": "different" } }, { extensionAgentKey: "plugin" },
      { supportsReasoning: true },
    ]) expect(compatibleOAuthAccount(first, account("second", overrides))).toBe(false);
    expect(compatibleOAuthAccount(account("first", { authKind: "api_key" }), account("second"))).toBe(false);
    expect(compatibleOAuthAccount(first, first)).toBe(false);
  });

  it("compares request header values but ignores header casing and order", () => {
    const first = account("first", { headers: { "User-Agent": "fixture", "X-Test": "1" } });
    expect(compatibleOAuthAccount(first, account("second", { headers: { "x-test": "1", "user-agent": "fixture" } }))).toBe(true);
  });

  it("visits each compatible account at most once per run, without duplicates", () => {
    const a = account("a"), b = account("b"), c = account("c");
    const pool = new ProviderAccountFallback(a, [a, b, b, account("bad", { vendorKey: "other" }), c]);
    expect(pool.next(a)).toBe(b);
    expect(pool.next(b)).toBe(c);
    expect(pool.next(c)).toBeUndefined();
  });

  it("starts a later run on the retained active account and can wrap", () => {
    const a = account("a"), b = account("b"), c = account("c");
    const pool = new ProviderAccountFallback(a, [b, c]);
    pool.next(a);
    pool.beginRun();
    expect(pool.next(b)).toBe(c);
    expect(pool.next(c)).toBe(a);
    expect(pool.next(a)).toBeUndefined();
  });

  it("does not replace an extension or unrelated current account", () => {
    const pool = new ProviderAccountFallback(account("a"), [account("b")]);
    expect(pool.next(account("unknown"))).toBeUndefined();
    expect(pool.next(account("a", { extensionAgentKey: "plugin" }))).toBeUndefined();
  });

  it("retires pools when eligible configuration changes, ignoring auth callback identity", () => {
    const a = account("a"), b = account("b");
    const pool = new ProviderAccountFallback(a, [b]);
    expect(pool.matches({ ...a, resolveAuth: async () => ({ apiKey: "fixture-a" }) }, [b])).toBe(true);
    expect(pool.matches(a, [])).toBe(false);
    expect(pool.matches(a, [account("b", { baseUrl: "https://different.invalid" })])).toBe(false);
    expect(pool.matches(account("different"), [b])).toBe(false);
  });
});
