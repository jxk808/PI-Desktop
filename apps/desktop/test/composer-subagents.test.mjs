import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { filterSubagents, subagentAliases } = await import("../src/hooks/composer-subagents.ts");
const agent = (name, description = "") => ({ name, description, tools: ["Read"], prompt: "Test", source: "builtin" });

test("Chinese aliases and stable English IDs retrieve only supplied enabled definitions", () => {
  const groups = {
    "domestic-growth-partner": ["国内运营增长合伙人", "国内运营", "运营合伙人", "运营", "增长合伙人"],
    "product-partner": ["产品合伙人", "产品"],
    "project-manager": ["项目管理者", "项目经理", "项目管理"],
    "web-intelligence": ["全网情报员", "全网情报", "全网", "情报员", "情报"],
    explorer: ["代码探索", "探索者"], fixer: ["代码修复", "修复者"],
    "code-reviewer": ["代码审查", "代码评审"], "test-runner": ["测试执行", "测试员"],
    "ui-designer": ["界面设计师", "界面设计", "UI设计师"],
  };
  for (const [name, aliases] of Object.entries(groups)) {
    for (const query of [name.toUpperCase(), ...aliases]) {
      const rows = filterSubagents([agent(name)], query);
      assert.equal(rows[0]?.subagent.name, name, query);
      assert.equal(rows[0].label, aliases[0]);
    }
  }
  assert.deepEqual(filterSubagents([], "产品"), []);
  assert.deepEqual(filterSubagents([agent("fixer")], "产品"), []);
});

test("custom Chinese prefixes are bounded; unknown English names remain usable", () => {
  assert.deepEqual(subagentAliases(agent("custom", "数据分析师：分析数据")), ["数据分析师"]);
  assert.deepEqual(subagentAliases(agent("custom", "中文".repeat(15) + ": long")), []);
  assert.deepEqual(subagentAliases(agent("custom", "English: prose")), []);
  assert.deepEqual(subagentAliases(agent("custom", "中文\n标题: prose")), []);
  const rows = filterSubagents([agent("custom", "English only")], "custom");
  assert.equal(rows[0].label, "custom");
  assert.equal(filterSubagents([agent("custom", "数据分析师：分析数据")], "数据")[0].label, "数据分析师");
});
