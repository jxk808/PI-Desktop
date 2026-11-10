import { join } from "node:path";

/** Only application-owned roots or an explicit operator override may supply executable code. */
export function resolveCodexAutomationRoots(options: {
  resourcesPath?: string;
  overrideRoot?: string;
  developmentRoot?: string;
}): string[] {
  return [...new Set([
    options.resourcesPath ? join(options.resourcesPath, "codex-automation") : undefined,
    options.overrideRoot,
    options.developmentRoot,
  ].filter((root): root is string => Boolean(root)))];
}

export const CODEX_PORTABLE_COMPONENTS = [
  ".python-runtime/python.exe",
  ".python-runtime/python312.dll",
  ".python-runtime/python312.zip",
  ".python-runtime/python312._pth",
  ".python-runtime/Lib/site-packages/playwright/driver/package/browsers.json",
  "codex_oauth.py",
  "turnstile_browser_bridge.js",
  ".node-runtime/node-v24.22.2-win-x64/node.exe",
  ".node-runtime/node-v24.22.2-win-x64/LICENSE",
  ".playwright-browsers/chromium-1243/chrome-win64/chrome.exe",
  "node_modules/puppeteer-real-browser/package.json",
] as const;

export const CODEX_MACOS_PORTABLE_COMPONENTS = [
  ".python-runtime/bin/python3",
  ".python-runtime/lib/python3.12/os.py",
  ".python-runtime/lib/python3.12/site-packages/playwright/driver/package/browsers.json",
  "codex_oauth.py",
  "turnstile_browser_bridge.js",
  ".node-runtime/node-v24.22.2-darwin-arm64/bin/node",
  ".node-runtime/node-v24.22.2-darwin-arm64/LICENSE",
  ".playwright-browsers/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "node_modules/puppeteer-real-browser/package.json",
] as const;

export function codexPortableRuntime(platform: NodeJS.Platform) {
  if (platform === "darwin") {
    return { python: CODEX_MACOS_PORTABLE_COMPONENTS[0], components: CODEX_MACOS_PORTABLE_COMPONENTS };
  }
  return { python: CODEX_PORTABLE_COMPONENTS[0], components: CODEX_PORTABLE_COMPONENTS };
}
