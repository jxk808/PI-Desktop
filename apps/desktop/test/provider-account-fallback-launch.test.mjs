import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("launch authorizes only compatible enabled account fallbacks, in wrapped order, without secrets", async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.account-fallback-test-"));
  const home = process.env.HOME;
  process.env.HOME = temp;
  try {
    const output = join(temp, "launch.mjs");
    await build({ entryPoints: [join(root, "apps/desktop/electron/main/runtime/session-launch.ts")], outfile: output,
      bundle: true, platform: "node", format: "esm", packages: "external", nodePaths: [join(root, "apps/desktop/node_modules")] });
    const { createSessionLaunchRuntime } = await import(pathToFileURL(output).href);
    const row = (id, overrides = {}) => ({ id, name: id, vendorKey: "fixture-vendor", authKind: "oauth", hasOauth: true,
      enabled: true, apiStyle: "chat_completions", baseUrl: "https://fixture.invalid/v1", models: [{ id: "fixture-model" }], ...overrides });
    const providers = [row("before"), row("selected"), row("next"), row("disabled", { enabled: false }),
      row("other-vendor", { vendorKey: "other" }), row("other-model", { models: [{ id: "other" }] }),
      row("unavailable"), row("different-endpoint"), row("different-headers", { headers: { "X-Account": "other" } })];
    const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
    const bindings = [];
    const calls = [];
    const host = { isAvailable: () => true, async call(method, params) {
      calls.push(method);
      if (method === "providers.list") return { providers };
      if (method === "commandShells.list") return { effective: shell, choices: [shell], configuredId: "bash", fallback: false };
      if (method === "skills.disabledBuiltins" || method === "agents.disabledBuiltins") return { disabled: [] };
      if (method === "skills.active") return { skills: [] };
      if (method === "agents.active") return { subagents: [] };
      if (method === "mcp.active") return { servers: [] };
      throw new Error(`Unexpected host call: ${method} ${JSON.stringify(params)}`);
    } };
    const catalog = { async ensureLoaded() {}, configureAccount() {}, findModel() { return undefined; } };
    const dependencies = {
      runtimeState: { host, sidecar: { setVendorAuthBindings(session, rows) { bindings.push({ session, rows }); } } },
      logger: { app() {} }, userMcp: { setRecords() {}, async toolsForProject() { return []; } },
      plugins: { getTools: () => [], getSkills: () => [], listLoaded: () => [], getAgentExtensions: () => [] },
      sessionProjects: new Map(), dataDir: temp,
      vendorOAuth: { async bindingFor(id) {
        if (id === "unavailable") throw new Error("Optional account unavailable");
        return { apiStyle: "chat_completions", baseUrl: id === "different-endpoint" ? "https://other.invalid/v1" : "https://fixture.invalid/v1" };
      } },
      modelsDevCatalog: catalog, getWorkspacePath: () => null, pluginActiveInProject: () => true,
      bindingForModel: (provider, id) => provider.models.find(model => model.id === id),
      effectiveSubagentModelConfig: () => ({ modelConfig: undefined, capabilities: {} }),
      normalizeThinkingLevel: value => value ?? "off",
    };
    const service = createSessionLaunchRuntime(dependencies);
    const result = await service.resolveAgentRuntimeLaunch("fixture-session", { providerId: "selected", modelId: "fixture-model" }, {});
    assert.deepEqual(result.sidecarParams.providerFallbacks.map(p => p.id), ["next", "before"]);
    assert.equal(result.providerId, "selected");
    assert.deepEqual(bindings.at(-1).rows.map(p => p.providerId), ["selected", "next", "before"]);
    assert.ok(!calls.includes("providers.getSecret"));
    for (const candidate of result.sidecarParams.providerFallbacks) {
      assert.equal(candidate.apiKey, "");
      assert.equal(candidate.resolveAuth, undefined);
      assert.equal(candidate.modelId, "fixture-model");
    }
    providers.splice(providers.findIndex(p => p.id === "next"), 1);
    const refreshed = await service.resolveAgentRuntimeLaunch("fixture-session", { providerId: "selected", modelId: "fixture-model" }, {});
    assert.deepEqual(refreshed.sidecarParams.providerFallbacks.map(p => p.id), ["before"]);
    assert.deepEqual(bindings.at(-1).rows.map(p => p.providerId), ["selected", "before"]);
  } finally {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    await rm(temp, { recursive: true, force: true });
  }
});
