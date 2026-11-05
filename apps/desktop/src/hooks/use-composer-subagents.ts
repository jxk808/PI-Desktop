import { useEffect, useState } from "react";
import type { SubagentDefinition } from "@pi-desktop/shared";
import { api } from "../lib/api";

const EMPTY: SubagentDefinition[] = [];
const normalizePath = (path: string | null) => (path ?? "").replace(/\\/g, "/").replace(/\/$/, "");

/** One catalog read per opened mention/context, never one per query character. */
export function useComposerSubagents(active: boolean, scope: string, workspace: string, remote: boolean) {
  const [answer, setAnswer] = useState<{ scope: string; agents: SubagentDefinition[] } | null>(null);
  useEffect(() => {
    // The existing catalog endpoint is local-project scoped, not remote-session scoped.
    if (!active || remote) return;
    let current = true;
    setAnswer(null);
    void api.subagentCatalog().then((catalog) => {
      if (!current) return;
      setAnswer({
        scope,
        agents: normalizePath(catalog.projectPath) === normalizePath(workspace) ? catalog.subagents : EMPTY,
      });
    }).catch((error: unknown) => {
      if (!current) return;
      console.warn("Composer subagent catalog unavailable", error);
      setAnswer({ scope, agents: EMPTY });
    });
    return () => { current = false; };
  }, [active, scope, workspace, remote]);
  return !remote && active && answer?.scope === scope ? answer.agents : EMPTY;
}
