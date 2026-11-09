import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { serializeComposerFileReferences } from "@pi-desktop/shared";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";
import { useComposerCompletions } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerCompletions";
import { ComposerInput } from "../../apps/desktop/src/features/chat/composer/ComposerInput";
import { ComposerAutocomplete } from "../../apps/desktop/src/components/ComposerAutocomplete";
await i18n.use(initReactI18next).init({ lng: "zh-CN", keySeparator: false,
  resources: Object.fromEntries(["en", "zh-CN"].map(lng => [lng, { translation: flattenCatalog(catalogs[lng]) }])),
  interpolation: { escapeValue: false } });
window.piDesktop = { platform: "win32", on() { return () => {}; }, invoke() { throw new Error("Unexpected IPC"); } };
useAppStore.setState({ ready: false, activeSessionId: "s1", workspace: { path: "/a" }, sessions: [{ id: "s1" }] });
const agent = (name, description = "") => ({ name, description, tools: ["Read"], prompt: "test", source: "builtin" });
const product = agent("product-partner");
let reads = 0;
let catalog = () => Promise.resolve({ projectPath: "/a", subagents: [product, agent("custom", "数据分析师：分析数据"), agent("english-only")],
  builtins: [{ ...agent("fixer"), enabled: false }], diagnostics: [] });
api.subagentCatalog = () => { reads++; return catalog(); };
api.fsIndex = async () => ({ entries: [{ path: "src/file.ts", kind: "file" }, { path: "src", kind: "dir" }], truncated: false });
let view;
let submitted = 0;
function Surface() {
  const [value, setValue] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const [composing, setComposing] = React.useState(false);
  const [agentsEnabled, setAgentsEnabled] = React.useState(false);
  const editor = React.useRef(null);
  const anchor = React.useRef(null);
  const references = React.useRef([]);
  const completions = useComposerCompletions({ value, cursor, composing, enabled: true, agentsEnabled, referenceSessionId: "s1",
    fileReferencesRef: references,
    applyEditorDraft(text, refs, caret) { references.current = refs; setValue(text); setCursor(caret); },
    handleInput(text, caret) { setValue(text); setCursor(caret); return text; },
    invalidateComposerTransforms() {} });
  React.useLayoutEffect(() => { if (editor.current.textContent !== value) editor.current.textContent = value; }, [value]);
  view = { value, cursor, reads, refs: references.current, ac: completions.ac, setAgentsEnabled };
  return <div ref={anchor} style={{ marginTop: 400, width: 800 }}>
    <ComposerInput inputRef={editor} value={value} placeholderText="test" placeholderKey="test"
      inputBlocked={false} pasting={false} enterToSend={true} runActive={false} composerAc={completions.ac}
      onAcceptCompletion={completions.acceptCompletion} onInput={completions.handleInput}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onSettledInput={() => setComposing(false)} onSubmit={() => submitted++} onInsertNewline={() => {}}
      onPaste={() => {}} onHistoryNavigate={() => false} onFocus={() => {}} onBlur={() => {}} />
    <ComposerAutocomplete anchorRef={anchor} ac={completions.ac} onAccept={completions.acceptCompletion} />
  </div>;
}
const tree = createRoot(document.getElementById("root"));
flushSync(() => tree.render(<Surface />));
const frame = () => new Promise(requestAnimationFrame);
const settle = async () => { await frame(); await frame(); };
const check = (ok, message) => { if (!ok) throw new Error(message); };
const input = () => document.querySelector('[role="textbox"]');
const options = () => [...document.querySelectorAll('[role="option"]')];
async function type(text, composing = false) {
  const el = input(); el.focus(); el.textContent = text;
  const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
  getSelection().removeAllRanges(); getSelection().addRange(range);
  flushSync(() => el.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: composing })));
  await settle();
}
async function key(key, extra = {}) {
  flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...extra })));
  await settle();
}
const select = async (name) => {
  const row = options().find(row => row.textContent.includes(name)); check(row, "missing row " + name);
  flushSync(() => row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
  await settle();
};
window.mentionProbe = async () => {
  await type("@产品");
  check(options()[0]?.textContent.includes("产品合伙人") && options()[0].textContent.includes("product-partner"), "Chinese + stable ID not displayed: " + JSON.stringify(view) + document.body.innerHTML);
  check(document.querySelector('[role="listbox"]').getAttribute("aria-label") === i18n.t("chat.mentionMenu"), "localized menu label");
  const initialReads = reads;
  await type("@产品合伙"); check(reads === initialReads, "catalog read on keystroke");
  await key("Enter", { isComposing: true }); check(view.value === "@产品合伙" && submitted === 0, "IME Enter accepted/sent");
  flushSync(() => input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await type("@情报", true);
  check(options()[0]?.textContent.includes("product-partner"), "IME list did not freeze");
  flushSync(() => input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await settle(); check(options().length === 0, "fabricated missing intelligence agent");
  await type("@修复"); check(options().length === 0, "disabled builtin leaked from catalog.builtins");
  await type("@产品"); await key("Enter");
  check(view.value === "请调用子智能体 product-partner（产品合伙人）处理：", "wrong localized instruction: " + view.value);
  check(view.refs.length === 0 && !view.value.includes("@"), "agent became a file reference");
  check(serializeComposerFileReferences(view.value, view.refs) === view.value && submitted === 0, "selection executed or serialized as file");
  await type("@数据"); await select("custom"); check(view.value.includes("custom（数据分析师）"), "custom Chinese alias selection");
  await i18n.changeLanguage("en");
  await type("@english-only"); await key("Tab");
  check(view.value === "Please ask subagent english-only (english-only) to handle:", "English fallback instruction");
  await type("@product-partner"); await key("Escape"); check(!view.ac.open, "Escape not dismissed");
  await type("@product"); check(!view.ac.open, "dismissal reopened inside same token");
  await type(""); await type("@product"); check(options().length === 1, "English ID query failed after new token");
  await type("@src/file"); await key("Enter");
  check(view.refs.length === 1 && view.refs[0].path === "src/file.ts", "file acceptance regressed");
  check(serializeComposerFileReferences(view.value, view.refs) === "@src/file.ts", "file serialization regressed");
  await type("@src"); await select("src/"); check(view.value === "@src/", "directory completion regressed");
  // Both completion contracts coexist when upstream's native agent chips are enabled.
  await type("");
  flushSync(() => view.setAgentsEnabled(true));
  await type("@产品"); await key("Enter");
  check(view.value === "Please ask subagent product-partner (产品合伙人) to handle:", "native agents displaced Chinese alias instruction");
  await type("@product-partner");
  check(view.ac.items.some(item => item.kind === "agent") && view.ac.items.some(item => item.kind === "subagent"), "missing either completion contract");
  await select("@product-partner");
  check(view.refs.some(ref => ref.kind === "agent" && ref.path === "product-partner"), "native agent did not become an agent chip");
  await type("");
  flushSync(() => view.setAgentsEnabled(false));
  await settle();
  // In-flight old-context replies must never appear in the new workspace/session.
  await type(""); let resolveOld;
  catalog = () => new Promise(resolve => { resolveOld = resolve; });
  await type("@产品");
  let resolveNew;
  catalog = () => new Promise(resolve => { resolveNew = resolve; });
  flushSync(() => useAppStore.setState({ activeSessionId: "s2", workspace: { path: "/b" }, sessions: [{ id: "s2" }] }));
  check(!view.ac.items.some(item => item.kind === "subagent"), "old workspace rows visible synchronously");
  await settle();
  resolveOld({ projectPath: "/a", subagents: [product] }); await settle();
  check(!view.ac.items.some(item => item.kind === "subagent"), "late old workspace reply leaked");
  resolveNew({ projectPath: "/b", subagents: [] }); await settle();
  check(options().length === 0, "empty catalog fabricated aliases");
  await type("");
  catalog = async () => ({ projectPath: "/a", subagents: [product] });
  await type("@产品"); check(options().length === 0, "mismatched project catalog leaked");
  await type("");
  catalog = async () => ({ projectPath: "/b", subagents: [product] });
  await type("@产品"); check(options().length === 1, "new project catalog missing");
  flushSync(() => useAppStore.setState({ sessions: [{ id: "s2", remoteWorkspace: { hostId: "r1", path: "/remote" } }] }));
  check(!view.ac.items.some(item => item.kind === "subagent"), "local catalog leaked into remote workspace");
  await settle();
  const remoteReads = reads;
  flushSync(() => useAppStore.setState({ sessions: [{ id: "s2", remoteWorkspace: { hostId: "r2", path: "/other" } }] }));
  await settle(); check(reads === remoteReads && !view.ac.items.some(item => item.kind === "subagent"), "remote scope leaked local catalog");
  flushSync(() => tree.unmount());
  return { passed: true };
};
`;

test("real composer Chinese mentions, IME, selection, file references and stale contexts", {
  skip: !process.env.PI_TEST_JSDOM_PACKAGE && process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? process.env.TEMP, "mention-ui-"));
  try {
    await build({ stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      // Use current sources even when workspace packages have not been built.
      alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src"), "@pi-desktop/shared": join(root, "packages/shared/src"),
        "@pi-desktop/plugin-sdk": join(root, "packages/plugin-sdk/src"),
        react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"), "react-i18next": join(root, "apps/desktop/node_modules/react-i18next") },
      nodePaths: [join(root, "apps/desktop/node_modules")] });
    // Optional provisioned DOM runner for hosts without the Electron distribution.
    if (process.env.PI_TEST_JSDOM_PACKAGE) {
      const { JSDOM } = createRequire(process.env.PI_TEST_JSDOM_PACKAGE)("jsdom");
      const dom = new JSDOM('<div id="root"></div>', { url: "https://local.invalid", pretendToBeVisual: true, runScripts: "outside-only" });
      Object.assign(dom.window, { TextEncoder, TextDecoder });
      dom.window.HTMLElement.prototype.scrollIntoView = function () {};
      // JSDOM has no layout; give AnchoredMenu a visible editor anchor instead
      // of its default zero rectangle, which correctly means offscreen in production.
      dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
        return new dom.window.DOMRect(20, 400, 800, 60);
      };
      try {
        await dom.window.eval("(async () => {" + await readFile(join(temp, "renderer.js"), "utf8") + "})()");
        assert.deepEqual(JSON.parse(JSON.stringify(await dom.window.mentionProbe())), { passed: true });
      } finally { dom.window.close(); }
      return;
    }
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
app.setPath("userData", require("node:path").join(__dirname, "profile"));
app.whenReady().then(async () => {
  // A visible isolated window is required for requestAnimationFrame on Windows.
  const win = new BrowserWindow({ show: true, width: 1100, height: 850,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, _level, message) => console.log(message));
  try { await win.loadFile(require("node:path").join(__dirname, "index.html"));
    console.log("MENTION_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.mentionProbe()"))); app.exit(0);
  } catch(error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.env.PI_TEST_ELECTRON_BINARY ?? resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", chunk => { output += chunk; }); }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-7000));
    assert.match(output, /MENTION_PROBE \{"passed":true\}/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
