import type {
  CodexBatchRunInput,
  CodexBatchSelection,
  OAuthLoginEvent,
} from "@pi-desktop/shared";
import {
  beginOAuthLogin,
  type OAuthLoginApi,
  type OAuthLoginSession,
} from "./oauth-login-session";

export type CodexBatchPhase =
  | "idle"
  | "preparing"
  | "logging-in"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "error";

export type CodexBatchState = {
  phase: CodexBatchPhase;
  fileName: string;
  total: number;
  current: number;
  succeeded: number;
  failed: number;
  message: string;
  lastError: string;
};

export type CodexBatchApi = OAuthLoginApi & {
  selectCodexBatch: () => Promise<CodexBatchSelection | null>;
  runCodexBatchAccount: (input: CodexBatchRunInput) => Promise<{ ok: true }>;
  cancelCodexBatchAccount: (batchId: string) => Promise<{ ok: true }>;
  finishCodexBatch: (batchId: string) => Promise<{ ok: true }>;
};

const INITIAL_STATE: CodexBatchState = {
  phase: "idle",
  fileName: "",
  total: 0,
  current: 0,
  succeeded: 0,
  failed: 0,
  message: "",
  lastError: "",
};

export class CodexBatchController {
  private state: CodexBatchState = INITIAL_STATE;
  private readonly listeners = new Set<(state: CodexBatchState) => void>();
  private readonly api: CodexBatchApi;
  private readonly onComplete?: () => Promise<void> | void;
  private selection: CodexBatchSelection | null = null;
  private session: OAuthLoginSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private automation: Promise<{ ok: true }> | null = null;
  private accountSettled = false;
  private stopping = false;

  constructor({ api, onComplete }: { api: CodexBatchApi; onComplete?: () => Promise<void> | void }) {
    this.api = api;
    this.onComplete = onComplete;
  }

  snapshot(): CodexBatchState {
    return this.state;
  }

  subscribe(listener: (state: CodexBatchState) => void): () => void {
    listener(this.state);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<boolean> {
    if (this.state.phase !== "idle") return false;
    this.update({ phase: "preparing", message: "selecting" });
    try {
      const selection = await this.api.selectCodexBatch();
      if (!selection) {
        this.update(INITIAL_STATE);
        return false;
      }
      if (this.stopping) {
        await this.api.finishCodexBatch(selection.batchId).catch(() => undefined);
        this.update({ phase: "cancelled", message: "cancelled" });
        return false;
      }
      this.selection = selection;
      this.update({
        phase: "logging-in",
        fileName: selection.fileName,
        total: selection.total,
        current: 1,
        succeeded: 0,
        failed: 0,
        message: "starting",
        lastError: "",
      });
      this.startCurrent();
      return true;
    } catch (error) {
      this.update({
        ...INITIAL_STATE,
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async cancel(): Promise<void> {
    if (this.stopping || ["completed", "cancelled", "error"].includes(this.state.phase)) return;
    if (!this.selection) {
      if (this.state.phase === "preparing") {
        this.stopping = true;
        this.update({ phase: "cancelling", message: "cancelling" });
      }
      return;
    }
    this.stopping = true;
    this.update({ phase: "cancelling", message: "cancelling" });
    const batchId = this.selection.batchId;
    const session = this.session;
    this.accountSettled = true;
    await Promise.allSettled([
      session?.cancel() ?? Promise.resolve(false),
      this.api.cancelCodexBatchAccount(batchId),
      this.api.finishCodexBatch(batchId),
    ]);
    this.disposeSession();
    this.selection = null;
    this.update({ phase: "cancelled", message: "cancelled" });
  }

  async close(): Promise<void> {
    if (this.selection) await this.api.finishCodexBatch(this.selection.batchId).catch(() => undefined);
    this.disposeSession();
    this.selection = null;
    this.listeners.clear();
  }

  private update(patch: Partial<CodexBatchState> | CodexBatchState): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener(this.state);
  }

  private startCurrent(): void {
    if (!this.selection || this.stopping) return;
    this.accountSettled = false;
    this.automation = null;
    const session = beginOAuthLogin({
      api: this.api,
      vendorId: "openai-codex",
      openExternal: false,
    });
    this.session = session;
    this.unsubscribe = session.subscribe((event) => {
      void this.handleEvent(event, session);
    });
  }

  private async handleEvent(event: OAuthLoginEvent, session: OAuthLoginSession): Promise<void> {
    if (session !== this.session || this.accountSettled || !this.selection) return;
    if (event.kind === "info" || event.kind === "progress") {
      this.update({ message: event.message });
      return;
    }
    if (event.kind === "prompt") {
      if (event.request.type === "select" && event.request.options?.some((option) => option.id === "browser")) {
        this.update({ message: "browser" });
        await session.respond(event.request.promptId, "browser").catch((error) =>
          this.settleCurrent(false, error instanceof Error ? error.message : String(error)));
      } else if (event.request.type === "manual_code") {
        // OpenAI raises this as a fallback while the loopback callback is active.
        // The automated browser will hit that callback; answering or rejecting
        // this prompt would cancel an otherwise healthy login.
        this.update({ message: "waiting_callback" });
      } else {
        await this.settleCurrent(false, "unsupported_prompt");
      }
      return;
    }
    if (event.kind === "authUrl") {
      if (this.automation) return;
      this.update({ message: "automating" });
      const input: CodexBatchRunInput = {
        batchId: this.selection.batchId,
        index: this.state.current,
        authorizationUrl: event.url,
        headed: false,
      };
      this.automation = this.api.runCodexBatchAccount(input);
      this.automation.catch((error) => {
        void this.settleCurrent(false, error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (event.kind === "done") {
      await this.settleCurrent(true, "signed_in");
      return;
    }
    if (event.kind === "error") {
      await this.settleCurrent(false, event.message || "oauth_failed");
      return;
    }
    if (event.kind === "cancelled") {
      await this.settleCurrent(false, "oauth_cancelled");
    }
  }

  private async settleCurrent(success: boolean, message: string): Promise<void> {
    if (this.accountSettled || !this.selection || this.stopping) return;
    this.accountSettled = true;
    const batchId = this.selection.batchId;
    if (success && this.automation) {
      try {
        await this.automation;
      } catch {
        // The host already completed OAuth and stored the credential. That is authoritative.
      }
    }
    if (!success) {
      await Promise.allSettled([
        this.session?.cancel() ?? Promise.resolve(false),
        this.api.cancelCodexBatchAccount(batchId),
      ]);
    }
    this.disposeSession();
    const succeeded = this.state.succeeded + (success ? 1 : 0);
    const failed = this.state.failed + (success ? 0 : 1);
    if (this.state.current >= this.selection.total) {
      await this.api.finishCodexBatch(batchId).catch(() => undefined);
      this.selection = null;
      this.update({
        phase: "completed",
        succeeded,
        failed,
        message,
        ...(success ? {} : { lastError: message }),
      });
      await this.onComplete?.();
      return;
    }
    this.update({
      current: this.state.current + 1,
      succeeded,
      failed,
      message: "starting",
      ...(success ? {} : { lastError: message }),
    });
    this.startCurrent();
  }

  private disposeSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session?.dispose();
    this.session = null;
    this.automation = null;
  }
}
