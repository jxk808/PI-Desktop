import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function inventory(root) {
  const manifest = JSON.parse(readFileSync(join(root, "runtime-integrity.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error("Invalid automation runtime inventory");
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || !entry.path || entry.path.includes("\\") || isAbsolute(entry.path) || entry.path.split("/").some(part => !part || part === "." || part === ".." || part.includes(":")) || !/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.path)) throw new Error("Unsafe automation runtime inventory entry");
    seen.add(entry.path);
  }
  if (createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex") !== manifest.sha256) throw new Error("Automation inventory digest mismatch");
  return manifest;
}
function safeFile(root, name) {
  const full = resolve(root, name);
  if (relative(resolve(root), full).startsWith("..") || !existsSync(full)) throw new Error(`Missing automation file: ${name}`);
  const stat = lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || relative(realpathSync(root), realpathSync(full)).startsWith("..")) throw new Error(`Nonportable automation file: ${name}`);
  return full;
}
export function verifyPackagedRuntime(root) {
  const manifest = inventory(root);
  for (const entry of manifest.files) if (digest(safeFile(root, entry.path)) !== entry.sha256) throw new Error(`Packaged automation hash mismatch: ${entry.path}`);
  return manifest.files.length;
}
/** extraResources applies global node_modules exclusions; restore the already-validated inventory after copying. */
export function copyPackagedRuntime(stage, destination) {
  const manifest = inventory(stage);
  for (const entry of manifest.files) {
    const source = safeFile(stage, entry.path);
    if (digest(source) !== entry.sha256) throw new Error(`Staged automation hash mismatch: ${entry.path}`);
    const target = join(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  copyFileSync(join(stage, "runtime-integrity.json"), join(destination, "runtime-integrity.json"));
  return verifyPackagedRuntime(destination);
}
