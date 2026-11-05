import { fuzzyMatchCommand, type FuzzyMatch, type SubagentDefinition } from "@pi-desktop/shared";

// Search metadata only: these names never create catalog definitions.
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  "domestic-growth-partner": ["国内运营增长合伙人", "国内运营", "运营合伙人", "运营", "增长合伙人"],
  "product-partner": ["产品合伙人", "产品"],
  "project-manager": ["项目管理者", "项目经理", "项目管理"],
  "web-intelligence": ["全网情报员", "全网情报", "全网", "情报员", "情报"],
  explorer: ["代码探索", "探索者"],
  fixer: ["代码修复", "修复者"],
  "code-reviewer": ["代码审查", "代码评审"],
  "test-runner": ["测试执行", "测试员"],
  "ui-designer": ["界面设计师", "界面设计", "UI设计师"],
};

export type SubagentCompletion = {
  kind: "subagent";
  subagent: SubagentDefinition;
  label: string;
  match: FuzzyMatch;
};

export function subagentAliases(agent: SubagentDefinition): readonly string[] {
  const known = ALIASES[agent.name];
  if (known) return known;
  // A short Chinese title before a colon is useful; arbitrary prose is not a name.
  const prefix = agent.description.match(/^([^:：\r\n]{1,24})[:：]/)?.[1]?.trim();
  return prefix && /\p{Script=Han}/u.test(prefix) ? [prefix] : [];
}

export function filterSubagents(agents: readonly SubagentDefinition[], query: string): SubagentCompletion[] {
  const rows: SubagentCompletion[] = [];
  for (const subagent of agents) {
    const aliases = subagentAliases(subagent);
    const matches = [subagent.name, ...aliases]
      .map((name) => fuzzyMatchCommand(query, name))
      .filter((match): match is FuzzyMatch => match !== null);
    if (!matches.length) continue;
    rows.push({
      kind: "subagent",
      subagent,
      label: aliases[0] ?? subagent.name,
      // The displayed name and matching alias can differ; do not mis-highlight.
      match: { score: Math.max(...matches.map((match) => match.score)), ranges: [] },
    });
  }
  return rows.sort((a, b) => b.match.score - a.match.score || a.subagent.name.localeCompare(b.subagent.name));
}
