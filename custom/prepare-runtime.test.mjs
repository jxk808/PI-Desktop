import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkedArchive, pickWheel, PYTHON_ARCHIVE_SHA256, WHEELS } from "./prepare-runtime.mjs";
const custom = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(custom, "../packages/agent-runtime/package.json"));
const { parse } = require("yaml");
function wheel(filename = "greenlet-3.5.6-cp312-cp312-win_amd64.whl") {
 return { filename, url: `https://files.pythonhosted.org/packages/${filename}`, packagetype: "bdist_wheel", yanked: false, digests: { sha256: "a".repeat(64) } };
}
test("wheel selection is version/ABI/platform pinned and fail-closed", () => {
 const valid = wheel();
 assert.equal(pickWheel({ info: { version: "3.5.6" }, urls: [valid, wheel("greenlet-3.5.6-cp312-cp312-win32.whl")] }, "greenlet", "3.5.6"), valid);
 assert.throws(() => pickWheel({ info: { version: "other" }, urls: [valid] }, "greenlet", "3.5.6"), /version mismatch/);
 assert.throws(() => pickWheel({ info: { version: "3.5.6" }, urls: [valid, valid] }, "greenlet", "3.5.6"), /one compatible wheel/);
 for (const value of [{ ...valid, url: "https://untrusted.invalid/file.whl" }, { ...valid, digests: { sha256: "bad" } }]) {
  assert.throws(() => pickWheel({ info: { version: "3.5.6" }, urls: [value] }, "greenlet", "3.5.6"), /Unsafe PyPI/);
 }
});
test("archive digest validation rejects modified bytes and pins Python provenance", () => {
 const data = Buffer.from("fixture archive"), digest = createHash("sha256").update(data).digest("hex");
 assert.equal(checkedArchive(data, digest, "test"), data);
 assert.throws(() => checkedArchive(Buffer.from("changed"), digest, "test"), /SHA-256 mismatch/);
 assert.match(PYTHON_ARCHIVE_SHA256, /^[a-f0-9]{64}$/);
 assert.equal(WHEELS.playwright, "1.63.0");
});
test("custom workflow is manually dispatched, read-only, source-built and verifies before artifact upload", () => {
 const text = readFileSync(join(custom, "../.github/workflows/custom-windows.yml"), "utf8");
 const workflow = parse(text);
 assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
 assert.deepEqual(workflow.permissions, { contents: "read" });
 const job = workflow.jobs.build;
 assert.equal(job["runs-on"], "windows-latest");
 assert.doesNotMatch(JSON.stringify(job.env), /runner\.temp/);
 assert.match(job.steps.find(s => s.name === "Prepare isolated scratch").run, /GITHUB_ENV/);
 assert.match(job.if, /jxk808\/PI-Desktop/);
 assert.match(job.if, /refs\/heads\/custom\/main/);
 const build = job.steps.find(s => s.name === "Build full custom installer from source");
 assert.match(build.run, /cargo build --release --locked -p host-core/);
 assert.match(build.run, /node custom\/build.mjs/);
 assert.doesNotMatch(text, /reuse-installed-host|contents: write|gh release|--publish always/);
 const verify = job.steps.findIndex(s => s.run?.includes("verify-windows-package.mjs"));
 const upload = job.steps.findIndex(s => s.uses?.startsWith("actions/upload-artifact@"));
 assert.ok(verify > 0 && upload > verify);
 assert.equal(job.steps.find(s => s.uses?.startsWith("actions/checkout@")).with["persist-credentials"], false);
});
