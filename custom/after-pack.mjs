import { join } from "node:path";
import { copyPackagedRuntime } from "./packaged-runtime.mjs";
export default async function afterPack(context) {
  const entries = context.packager.config.extraResources;
  const runtime = Array.isArray(entries) ? entries.find(entry => typeof entry === "object" && entry.to === "codex-automation") : undefined;
  if (!runtime || typeof runtime.from !== "string") throw new Error("Portable automation staging is missing from installer configuration");
  const count = copyPackagedRuntime(runtime.from, join(context.appOutDir, "resources", "codex-automation"));
  console.log(`Verified complete packaged automation runtime: ${count} files`);
}
