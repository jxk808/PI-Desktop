import { buildProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";
import { providerHeadersEqual } from "./provider-headers.js";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .filter(([, entry]) => typeof entry !== "function" && entry !== undefined)
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function signature(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function endpoint(value: string): string {
  try { return new URL(value).toString().replace(/\/+$/, ""); }
  catch { return value.trim().replace(/\/+$/, ""); }
}

/** A retry may replace authentication, never the request's model/transport. */
export function compatibleOAuthAccount(
  primary: RuntimeProviderConfig,
  candidate: RuntimeProviderConfig,
): boolean {
  const vendor = primary.vendorKey?.trim().toLowerCase();
  if (!vendor || primary.authKind !== "oauth" || candidate.authKind !== "oauth" ||
      primary.extensionAgentKey || candidate.extensionAgentKey || primary.id === candidate.id ||
      vendor !== candidate.vendorKey?.trim().toLowerCase() ||
      primary.modelId !== candidate.modelId ||
      !providerHeadersEqual(primary.headers, candidate.headers) ||
      primary.supportsReasoning !== candidate.supportsReasoning ||
      signature(primary.supportedThinkingLevels) !== signature(candidate.supportedThinkingLevels)) return false;
  const first = buildProviderModel(primary);
  const next = buildProviderModel(candidate);
  // Prices and account labels are reporting metadata, not wire behavior.
  const { cost: _firstCost, name: _firstName, ...firstWire } = first;
  const { cost: _nextCost, name: _nextName, ...nextWire } = next;
  return signature({ ...firstWire, baseUrl: endpoint(first.baseUrl) }) ===
    signature({ ...nextWire, baseUrl: endpoint(next.baseUrl) });
}

/** One session-local pool; one visit per account per user run. No tokens are persisted. */
export class ProviderAccountFallback {
  readonly initial: RuntimeProviderConfig;
  private readonly pool: RuntimeProviderConfig[];
  private index = 0;
  private visited = new Set<string>();

  constructor(primary: RuntimeProviderConfig, candidates: RuntimeProviderConfig[] = []) {
    this.initial = primary;
    const seen = new Set([primary.id]);
    this.pool = [primary, ...candidates.filter((candidate) => {
      if (seen.has(candidate.id) || !compatibleOAuthAccount(primary, candidate)) return false;
      seen.add(candidate.id);
      return true;
    })];
    this.beginRun();
  }

  beginRun(): void {
    this.visited = new Set([this.pool[this.index].id]);
  }

  next(current: RuntimeProviderConfig): RuntimeProviderConfig | undefined {
    if (current.id !== this.pool[this.index].id || current.extensionAgentKey) return undefined;
    for (let offset = 1; offset < this.pool.length; offset++) {
      const index = (this.index + offset) % this.pool.length;
      const candidate = this.pool[index];
      if (this.visited.has(candidate.id)) continue;
      this.visited.add(candidate.id);
      this.index = index;
      return candidate;
    }
    return undefined;
  }

  matches(primary: RuntimeProviderConfig, candidates: RuntimeProviderConfig[] = []): boolean {
    return signature(this.pool) === signature(new ProviderAccountFallback(primary, candidates).pool);
  }
}
