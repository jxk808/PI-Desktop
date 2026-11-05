import {
  capabilitiesFromModelConfig,
  compatibleOAuthAccount,
  optionalProviderHeaders,
  type RuntimeProviderConfig,
} from "@pi-desktop/agent-runtime";
import { OAUTH_AUTH_KIND } from "../oauth";
import type { VendorOAuth } from "../oauth";
import { catalogModelConfigFor, type ModelsDevCatalog } from "../models-dev-catalog";
import type { RuntimeProvider } from "./provider-catalog";

/** Resolve a bounded snapshot of enabled account rows without reading any secrets. */
export async function resolveProviderAccountFallbacks(input: {
  primary: RuntimeProviderConfig;
  providers: RuntimeProvider[];
  vendorOAuth: Pick<VendorOAuth, "bindingFor">;
  catalog: ModelsDevCatalog;
}): Promise<RuntimeProviderConfig[]> {
  const { primary, providers, vendorOAuth, catalog } = input;
  const vendor = primary.vendorKey?.trim().toLowerCase();
  if (!vendor || primary.authKind !== OAUTH_AUTH_KIND || primary.extensionAgentKey) return [];
  const selected = providers.findIndex((row) => row.id === primary.id);
  const ordered = selected < 0 ? providers : [...providers.slice(selected + 1), ...providers.slice(0, selected)];
  const candidates: RuntimeProviderConfig[] = [];
  const seen = new Set([primary.id]);
  for (const row of ordered) {
    if (seen.has(row.id) || row.enabled === false || row.authKind !== OAUTH_AUTH_KIND ||
        row.vendorKey?.trim().toLowerCase() !== vendor ||
        !row.models?.some((binding) => binding.id === primary.modelId)) continue;
    seen.add(row.id);
    // An unavailable optional account must not prevent the selected account starting.
    const binding = await vendorOAuth.bindingFor(row.id, primary.modelId).catch(() => undefined);
    if (!binding) continue;
    const apiStyle = binding.apiStyle ?? row.apiStyle;
    const baseUrl = binding.baseUrl ?? row.baseUrl;
    const modelConfig = binding.modelConfig ?? catalogModelConfigFor(catalog, {
      providerId: row.id, vendorKey: row.vendorKey, baseUrl, apiStyle, modelId: primary.modelId,
    });
    const capabilities = capabilitiesFromModelConfig(modelConfig);
    const candidate: RuntimeProviderConfig = {
      id: row.id,
      name: row.name,
      vendorKey: row.vendorKey,
      modelId: primary.modelId,
      baseUrl,
      apiStyle,
      authKind: OAUTH_AUTH_KIND,
      apiKey: "",
      ...optionalProviderHeaders(row.headers),
      supportsReasoning: capabilities.supportsReasoning,
      supportedThinkingLevels: [...capabilities.supportedThinkingLevels],
      modelConfig,
    };
    if (compatibleOAuthAccount(primary, candidate)) candidates.push(candidate);
  }
  return candidates;
}
