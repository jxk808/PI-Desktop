import {
  IPC,
  type CodexBatchFinishInput,
  type CodexBatchRunInput,
} from "@pi-desktop/shared";
import type { CodexBatchAutomation } from "../codex-batch-automation";
import type { IpcRegistrar } from "./types";

export function registerCodexBatchIpc({
  registrar,
  automation,
}: {
  registrar: IpcRegistrar;
  automation: CodexBatchAutomation;
}): void {
  registrar.handle(IPC.invoke.providersCodexBatchSelect, () => automation.select());
  registrar.handle(IPC.invoke.providersCodexBatchRun, (input: CodexBatchRunInput) =>
    automation.run(input));
  registrar.handle(IPC.invoke.providersCodexBatchCancel, (input: CodexBatchFinishInput) => {
    if (!input || typeof input.batchId !== "string") throw new Error("batchId required");
    return automation.cancelCurrent(input.batchId);
  });
  registrar.handle(IPC.invoke.providersCodexBatchFinish, (input: CodexBatchFinishInput) => {
    if (!input || typeof input.batchId !== "string") throw new Error("batchId required");
    return automation.finish(input.batchId);
  });
}
