import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { CODEX_PORTABLE_COMPONENTS, resolveCodexAutomationRoots } from "./codex-batch-runtime";
import type {
  CodexBatchRunInput,
  CodexBatchSelection,
} from "@pi-desktop/shared";

const MAX_OUTPUT_BYTES = 64 * 1024;
const VALIDATE_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 7 * 60_000;
const MAX_ACCOUNTS = 1_000;
const OPENAI_AUTHORIZE_ORIGIN = "https://auth.openai.com";
const OPENAI_AUTHORIZE_PATH = "/oauth/authorize";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";

type ChildLike = {
  stdout: { on: (event: "data", listener: (chunk: unknown) => void) => unknown };
  stderr: { on: (event: "data", listener: (chunk: unknown) => void) => unknown };
  once: (event: string, listener: (...args: any[]) => void) => unknown;
  kill: () => unknown;
  pid?: number;
};
type SpawnHelper = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean },
) => ChildLike;

type BatchRecord = {
  id: string;
  credentialsPath: string;
  projectRoot: string;
  pythonPath: string;
  scriptPath: string;
  total: number;
  child: ChildLike | null;
};

export type CodexBatchAutomationDependencies = {
  pickCredentialsFile: () => Promise<string | null>;
  spawnHelper?: SpawnHelper;
  pathExists?: (path: string) => Promise<void>;
  newId?: () => string;
  platform?: NodeJS.Platform;
  /** Trusted project roots; the selected account file may live elsewhere. */
  helperRoots?: string[];
  terminateChild?: (child: ChildLike) => void;
};

export function validateCodexAuthorizationUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    throw new Error("invalid OpenAI authorization URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid OpenAI authorization URL");
  }
  if (
    url.origin !== OPENAI_AUTHORIZE_ORIGIN ||
    url.pathname !== OPENAI_AUTHORIZE_PATH ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("authorization URL is not an OpenAI OAuth URL");
  }
  const required = new Map([
    ["client_id", OPENAI_CLIENT_ID],
    ["redirect_uri", OPENAI_REDIRECT_URI],
    ["response_type", "code"],
    ["code_challenge_method", "S256"],
  ]);
  for (const [key, expected] of required) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== expected) {
      throw new Error(`authorization URL has an invalid ${key}`);
    }
  }
  for (const key of ["state", "code_challenge"]) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || !values[0]?.trim()) {
      throw new Error(`authorization URL is missing ${key}`);
    }
  }
  return url.toString();
}

function jsonEvent(output: string, eventName: string): Record<string, unknown> | undefined {
  for (const line of output.split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.event === eventName) return parsed;
    } catch {
      // Human-readable helper output is intentionally ignored.
    }
  }
  return undefined;
}

export class CodexBatchAutomation {
  private readonly batches = new Map<string, BatchRecord>();
  private readonly helperRoots: string[];
  private readonly deps: Required<
    Pick<CodexBatchAutomationDependencies,
      "pickCredentialsFile" | "spawnHelper" | "pathExists" | "newId" | "platform" | "terminateChild">
  >;

  constructor(deps: CodexBatchAutomationDependencies) {
    this.helperRoots = resolveCodexAutomationRoots({
      resourcesPath: process.resourcesPath,
      overrideRoot: process.env.PI_CODEX_AUTOMATION_ROOT,
    });
    this.helperRoots = [...new Set([...this.helperRoots, ...(deps.helperRoots ?? [])].filter(Boolean))];
    this.deps = {
      pickCredentialsFile: deps.pickCredentialsFile,
      spawnHelper: deps.spawnHelper ?? ((executable, args, options) =>
        spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })),
      pathExists: deps.pathExists ?? access,
      newId: deps.newId ?? randomUUID,
      platform: deps.platform ?? process.platform,
      terminateChild: deps.terminateChild ?? (deps.spawnHelper
        ? (child) => { child.kill(); }
        : (child) => {
            if ((deps.platform ?? process.platform) === "win32" && child.pid) {
              spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
                stdio: "ignore",
                windowsHide: true,
              });
            } else {
              child.kill();
            }
          }),
    };
  }

  async select(): Promise<CodexBatchSelection | null> {
    const credentialsPath = await this.deps.pickCredentialsFile();
    if (!credentialsPath) return null;
    const candidates = this.helperRoots;
    let projectRoot = "";
    let pythonPath = "";
    let scriptPath = "";
    for (const candidate of candidates) {
      const candidatePython = join(candidate, ".python-runtime", "python.exe");
      const candidateScript = join(candidate, "codex_oauth.py");
      const required = CODEX_PORTABLE_COMPONENTS.map((component) => join(candidate, component));
      try {
        for (const path of required) await this.deps.pathExists(path);
      } catch {
        continue;
      }
      projectRoot = candidate;
      pythonPath = candidatePython;
      scriptPath = candidateScript;
      break;
    }
    if (!projectRoot) {
      throw new Error(
        "Codex automation runtime is missing or incomplete. Reinstall resources/codex-automation or explicitly set PI_CODEX_AUTOMATION_ROOT to a complete portable runtime.",
      );
    }

    const result = await this.runHelper(
      { projectRoot, pythonPath },
      [
        scriptPath,
        "--credentials-file",
        credentialsPath,
        "--validate-only",
        "--json-events",
      ],
      VALIDATE_TIMEOUT_MS,
    );
    const validated = jsonEvent(result.stdout, "validated");
    const total = validated?.count;
    if (!Number.isSafeInteger(total) || Number(total) < 1 || Number(total) > MAX_ACCOUNTS) {
      throw new Error("Codex credentials validation returned an invalid account count");
    }

    const id = this.deps.newId();
    this.batches.set(id, {
      id,
      credentialsPath,
      projectRoot,
      pythonPath,
      scriptPath,
      total: Number(total),
      child: null,
    });
    return { batchId: id, total: Number(total), fileName: basename(credentialsPath) };
  }

  async run(input: CodexBatchRunInput): Promise<{ ok: true }> {
    const batch = this.requireBatch(input.batchId);
    if (!Number.isSafeInteger(input.index) || input.index < 1 || input.index > batch.total) {
      throw new Error("account index is outside the selected batch");
    }
    if (batch.child) throw new Error("a Codex account login is already running");
    const authorizationUrl = validateCodexAuthorizationUrl(input.authorizationUrl);
    const args = [
      batch.scriptPath,
      "--credentials-file",
      batch.credentialsPath,
      "--account-index",
      String(input.index),
      "--authorization-url",
      authorizationUrl,
      input.headed ? "--headed" : "--headless",
      "--json-events",
    ];
    const result = await this.runHelper(batch, args, LOGIN_TIMEOUT_MS);
    const completed = jsonEvent(result.stdout, "completed");
    if (completed?.index !== input.index || completed?.total !== batch.total) {
      throw new Error("Codex automation did not report account completion");
    }
    return { ok: true };
  }

  async cancelCurrent(batchId: string): Promise<{ ok: true }> {
    const batch = this.requireBatch(batchId);
    if (batch.child) {
      this.deps.terminateChild(batch.child);
      const deadline = Date.now() + 5_000;
      while (batch.child && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (batch.child) throw new Error("Codex automation did not stop");
    }
    return { ok: true };
  }

  async finish(batchId: string): Promise<{ ok: true }> {
    const batch = this.batches.get(batchId);
    if (!batch) return { ok: true };
    if (batch.child) this.deps.terminateChild(batch.child);
    this.batches.delete(batchId);
    return { ok: true };
  }

  private requireBatch(batchId: string): BatchRecord {
    if (typeof batchId !== "string" || !batchId) throw new Error("batchId required");
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error("Codex batch is missing or expired");
    return batch;
  }

  private runHelper(
    batch: Pick<BatchRecord, "projectRoot" | "pythonPath"> & Partial<Pick<BatchRecord, "child">>,
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = this.deps.spawnHelper(batch.pythonPath, args, {
        cwd: batch.projectRoot,
        env: {
          ...process.env,
          NO_PROXY: "127.0.0.1,localhost",
          PYTHONUTF8: "1",
          PYTHONNOUSERSITE: "1",
          PYTHONDONTWRITEBYTECODE: "1",
          PLAYWRIGHT_BROWSERS_PATH: join(batch.projectRoot, ".playwright-browsers"),
        },
        windowsHide: true,
      });
      if ("child" in batch) batch.child = child;
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if ("child" in batch) batch.child = null;
        if (error) reject(error);
        else resolve({ stdout, stderr });
      };
      const append = (target: "stdout" | "stderr", chunk: unknown) => {
        const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        outputBytes += Buffer.byteLength(value, "utf8");
        if (outputBytes > MAX_OUTPUT_BYTES) {
          this.deps.terminateChild(child);
          finish(new Error("Codex automation output exceeded the safety limit"));
          return;
        }
        if (target === "stdout") stdout += value;
        else stderr += value;
      };
      child.stdout.on("data", (chunk) => append("stdout", chunk));
      child.stderr.on("data", (chunk) => append("stderr", chunk));
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => {
        if (code === 0) finish();
        else {
          const failed = jsonEvent(stdout, "failed");
          const detail = typeof failed?.message === "string" ? failed.message : "Codex automation failed";
          finish(new Error(detail));
        }
      });
      const timer = setTimeout(() => {
        this.deps.terminateChild(child);
        finish(new Error("Codex automation timed out"));
      }, timeoutMs);
      timer.unref?.();
    });
  }
}
