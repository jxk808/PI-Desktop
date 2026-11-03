import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("model management exposes batch login only for the native Codex vendor", async () => {
  const source = await read("src/components/settings/ModelConfigPage.tsx");
  assert.match(source, /vendor\.vendorId === "openai-codex"/);
  assert.match(source, /settings\.codexBatchButton/);
  assert.match(source, /new CodexBatchController/);
  assert.match(source, /Promise\.all\(\[reloadAccounts\(\), refreshProviders\(\)\]\)/);
});

test("batch dialog renders only non-secret aggregate state", async () => {
  const source = await read("src/components/settings/CodexBatchDialog.tsx");
  assert.match(source, /state\.fileName/);
  assert.match(source, /state\.succeeded/);
  assert.match(source, /state\.failed/);
  assert.doesNotMatch(source, /password|totp|authorizationUrl|credentialsPath/i);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /state\.phase === "error"/);
  assert.match(source, /state\.lastError/);
  assert.match(source, /role=\{state\.phase === "error" \? "alert" : "status"\}/);
});
