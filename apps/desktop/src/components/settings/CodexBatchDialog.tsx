import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { CodexBatchState } from "../../lib/codex-batch-controller";
import { Button, portalOverlay } from "../ui";

export function CodexBatchDialog({
  state,
  onCancel,
  onClose,
}: {
  state: CodexBatchState;
  onCancel: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const terminal = state.phase === "completed" || state.phase === "cancelled" || state.phase === "error";
  const processed = state.succeeded + state.failed;
  const percent = state.total > 0 ? Math.round((processed / state.total) * 100) : 0;

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (terminal) onClose();
      else onCancel();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel, onClose, terminal]);

  const status = state.phase === "error"
    ? state.message
    : state.phase === "preparing"
      ? t("settings.codexBatchPreparing")
    : state.phase === "cancelling"
      ? t("settings.codexBatchCancelling")
      : state.phase === "cancelled"
        ? t("settings.codexBatchCancelled")
        : state.phase === "completed"
          ? t("settings.codexBatchCompleted")
          : state.message === "automating"
            ? t("settings.codexBatchAutomating")
            : t("settings.codexBatchSigningIn", { current: state.current, total: state.total });

  return portalOverlay(
    <div className="overlay provider-dialog-overlay" role="presentation">
      <div
        className="dialog oauth-dialog codex-batch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-batch-title"
      >
        <h3 id="codex-batch-title" className="provider-dialog-title">
          {t("settings.codexBatchTitle")}
        </h3>
        <p className="codex-batch-description">{t("settings.codexBatchDescription")}</p>
        {state.fileName ? (
          <div className="codex-batch-file">
            <span>{t("settings.codexBatchFile")}</span>
            <strong>{state.fileName}</strong>
          </div>
        ) : null}
        <div
          className={state.phase === "error" ? "oauth-error" : "oauth-status"}
          role={state.phase === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {status}
        </div>
        {state.phase === "completed" && state.failed > 0 && state.lastError ? (
          <div className="oauth-error" role="alert">
            {t("settings.codexBatchLastError", { error: state.lastError })}
          </div>
        ) : null}
        <div
          className="codex-batch-progress"
          role="progressbar"
          aria-label={t("settings.codexBatchProgress")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="codex-batch-counts">
          <span>{t("settings.codexBatchSucceeded", { count: state.succeeded })}</span>
          <span>{t("settings.codexBatchFailed", { count: state.failed })}</span>
          <span>{t("settings.codexBatchProcessed", { processed, total: state.total })}</span>
        </div>
        <div className="provider-dialog-actions">
          {terminal ? (
            <Button variant="primary" onClick={onClose}>{t("settings.close")}</Button>
          ) : (
            <Button
              variant="ghost"
              disabled={state.phase === "cancelling"}
              onClick={onCancel}
            >
              {t("settings.cancel")}
            </Button>
          )}
        </div>
      </div>
    </div>,
  );
}
