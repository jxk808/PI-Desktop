"use strict";

/**
 * 订阅额度 — PI-Desktop 插件主进程
 *
 * 插件 id: io.github.czp0312.subscription-quota
 * 视图:    contributes.views[0] → views/quota.html（右侧工作面板）
 * 面板:    ui.panel → views/quota.html（命令 quota.open 打开）
 *
 * 目标：把订阅账号的 5 小时 / 每周 / 每月额度统一成「窗口（window）」列表交给界面，
 * 由界面渲染进度条（绿=剩余、灰=已用）、剩余百分比与重置倒计时。
 *
 * ── 只显示已登录的 ──────────────────────────────────────────────────────────
 * 每个服务商的 collect() 返回 null 就表示「本机找不到这个账号的可用凭据 = 没登录」，
 * 这类账号不会出现在界面上；只有真正拿到凭据的账号才会渲染。
 *
 * ── 凭据来源 ────────────────────────────────────────────────────────────────
 * PI-Desktop 宿主账号、插件 OAuth 多账号与手工令牌分别展示；CLI 仅在无前三者时回退。
 * 宿主通过 models.usage 返回标准化额度，插件不读取或解密宿主 SecretStore。
 * ChatGPT / Claude / Copilot 可在面板「管理账号」单独授权，无需安装 CLI。
 * 插件凭据仅保存在自己的数据目录中，界面仅接收非敏感登录状态。
 *
 * ── 服务商注册表 ────────────────────────────────────────────────────────────
 * id 与 PI-Desktop 的厂商 id 对齐：anthropic / openai-codex / github-copilot /
 * kimi-coding / meta / openrouter / radius / xai。
 * 其中 anthropic、openai-codex、github-copilot、openrouter 有内置适配器；
 * 其余四家没有公开的额度接口，走通用适配器（settings.sources 里配置 url + 字段映射），
 * 没配置就不会显示——绝不用猜测的接口地址去显示可能错误的数字。
 *
 * ── 通道 ────────────────────────────────────────────────────────────────────
 * 视图 window.pluginBridge.invoke("quota.*") → onPanelInvoke。
 * 宿主对自定义通道的转发超时是 30s；刷新令牌 + 两个额度端点各限时 8s。
 */

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createAuth } = require("./lib/oauth");
const { recommendAccounts } = require("./lib/recommendations");
const { createOpenAiReset } = require("./lib/openai-reset");

/** 上游请求超时；宿主面板通道整体约 30s，留足余量。 */
const REQUEST_TIMEOUT_MS = 8_000;
/** 快照缓存时间，避免面板轮询时反复打上游。 */
const CACHE_TTL_MS = 60_000;
/** 读凭据文件的体积上限，防御性保护。 */
const MAX_CREDENTIAL_BYTES = 256 * 1024;
const MIN_REFRESH_SECONDS = 30;
const MAX_REFRESH_SECONDS = 3600;

/** 缓存：只存额度快照，不存凭据。 */
let cache = null; // { at: number, snapshot: object }
let cacheEpoch = 0;
let auth;
function invalidateCache() { cache = null; cacheEpoch += 1; }
function getAuth() {
  if (!auth) auth = createAuth({
    plugin: { getDataPath: () => pi.plugin.getDataPath() },
    net: { fetch: (input) => pi.net.fetch(input) },
    shell: { openExternal: (url) => pi.shell.openExternal(url) },
  }, { onChange: invalidateCache });
  return auth;
}

let resetService;
function getResetService() {
  if (!resetService) resetService = createOpenAiReset({
    getDataPath: () => pi.plugin.getDataPath(),
    isOffline: async () => (await getSettings()).demoMode,
    listAccounts: () => getAuth().listAccounts(),
    credential: (id) => getAuth().credential(id),
    accountLabel: (credential) => {
      const who = openAiProfile(credential.token);
      const identity = who.name ?? credential.email ?? who.email;
      return identity ? `OpenAI · ${identity}` : "OpenAI";
    },
    getCapabilities: () => pi.net.getCapabilities(),
    fetch: (input) => pi.net.fetch(input),
    onChange: invalidateCache,
  });
  return resetService;
}

async function resolveCredential(settings, vendor, cli) {
  const supplied = settingsToken(settings, vendor);
  if (supplied) {
    const entry = settings.credentials?.[vendor];
    const accountId = typeof entry?.accountId === "string" ? entry.accountId : null;
    return { token: supplied, accountId, source: "settings" };
  }
  return settings.autoDetect ? await cli() : null;
}

// ── 设置 ────────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  autoDetect: true,
  demoMode: false,
  refreshSeconds: 300,
  credentials: {},
  sources: [],
  accounts: [],
};

function parseJsonSetting(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function getSettings() {
  let raw = {};
  try {
    raw = (await pi.plugin.getSettings()) ?? {};
  } catch {
    raw = {};
  }
  const seconds = Number(raw.refreshSeconds);
  const refreshSeconds =
    Number.isFinite(seconds) && seconds >= MIN_REFRESH_SECONDS && seconds <= MAX_REFRESH_SECONDS
      ? Math.round(seconds)
      : DEFAULT_SETTINGS.refreshSeconds;
  const credentials = parseJsonSetting(raw.credentials, {});
  const sources = parseJsonSetting(raw.sources, []);
  const accounts = parseJsonSetting(raw.accounts, []);
  return {
    autoDetect: raw.autoDetect !== false,
    demoMode: raw.demoMode === true,
    refreshSeconds,
    credentials: credentials && typeof credentials === "object" ? credentials : {},
    sources: Array.isArray(sources) ? sources : [],
    accounts: Array.isArray(accounts) ? accounts : [],
  };
}

/** 用户在设置里为某个厂商填的令牌（字符串，或 { token } 对象）。 */
function settingsToken(settings, vendorId) {
  const entry = settings.credentials?.[vendorId];
  if (typeof entry === "string" && entry.trim()) return entry.trim();
  if (entry && typeof entry === "object") {
    const t = entry.token ?? entry.apiKey ?? entry.accessToken;
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  return null;
}

// ── 通用工具 ────────────────────────────────────────────────────────────────

function num(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(value) {
  const n = num(value);
  if (n === null) return null;
  return Math.min(100, Math.max(0, n));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function isoOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    // 秒级时间戳与毫秒级时间戳都能接受。
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function readJsonFile(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) return null;
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function hasFetch() {
  return typeof pi?.net?.fetch === "function";
}

/** 走宿主的 net.fetch（受 manifest.net.domains 约束）。只有额度数字进缓存。 */
async function httpJson(url, headers) {
  if (!hasFetch()) {
    const error = new Error("宿主未提供 net.fetch");
    error.code = "UNSUPPORTED";
    throw error;
  }
  let response;
  try {
    response = await pi.net.fetch({ url, method: "GET", headers, timeoutMs: REQUEST_TIMEOUT_MS });
  } catch {
    throw Object.assign(new Error("额度网络请求失败，请检查网络及插件权限后重试"), { code: "NETWORK" });
  }
  let data = null;
  try {
    data = JSON.parse(response.bodyText);
  } catch {
    data = null;
  }
  return { status: response.status, data, bodyText: response.bodyText ?? "" };
}

function friendlyHttpError(label, status, bodyText) {
  if (status === 401 || status === 403) return `${label}: 凭据已失效或无权访问（HTTP ${status}），请重新登录该服务`;
  if (status === 404) return `${label}: 额度接口不存在（HTTP 404）`;
  if (status === 429) return `${label}: 请求过于频繁（HTTP 429），稍后重试`;
  if (status >= 500) return `${label}: 服务端错误（HTTP ${status}）`;
  // Never surface upstream bodies: they may echo an Authorization header.
  return `${label}: 请求失败（HTTP ${status}）`;
}

function errorMessage(error) {
  if (!error) return "未知错误";
  const code = error.code ? `[${error.code}] ` : "";
  const text = typeof error.message === "string" ? error.message : String(error);
  return `${code}${text}`;
}

function httpError(label, response) {
  return Object.assign(new Error(friendlyHttpError(label, response.status, response.bodyText)), {
    code: "HTTP_ERROR",
  });
}

// ── 周期与窗口模型 ──────────────────────────────────────────────────────────
//
// period 是机器可读的周期档位（session/day/week/month/credit/other），
// 由界面本地化成「5 小时额度 / 周额度 / 月额度 / 额度余额」。

function periodFromMinutes(minutes) {
  const m = num(minutes);
  if (m === null || m <= 0) return "other";
  if (m <= 360) return "session"; // ≤6 小时：5 小时窗口
  if (m <= 1440) return "day";
  if (m <= 11_000) return "week"; // 7 天
  return "month";
}

const PERIOD_LABEL_KEY = {
  session: "window.session",
  day: "window.day",
  week: "window.week",
  month: "window.month",
  credit: "window.credit",
  other: "window.other",
};

function windowFrom({ period, labelKey, windowMinutes, usedPercent, resetsAt, used, limit, unit }) {
  const usedPct = clampPercent(usedPercent);
  if (usedPct === null) return null;
  const shape = {
    period,
    labelKey: labelKey ?? PERIOD_LABEL_KEY[period] ?? PERIOD_LABEL_KEY.other,
    windowMinutes: num(windowMinutes),
    usedPercent: round1(usedPct),
    remainingPercent: round1(100 - usedPct),
    resetsAt: isoOrNull(resetsAt),
  };
  const usedNum = num(used);
  const limitNum = num(limit);
  if (usedNum !== null && limitNum !== null && limitNum > 0) {
    shape.used = round1(usedNum);
    shape.limit = round1(limitNum);
    shape.unit = typeof unit === "string" && unit ? unit : null;
  }
  return shape;
}

// ── 各家响应 → 窗口列表 ─────────────────────────────────────────────────────

/** Anthropic（Claude Pro/Max）oauth/usage：five_hour / seven_day* / monthly。 */
const ANTHROPIC_WINDOW_FIELDS = [
  ["five_hour", "session", "window.session", 300],
  ["seven_day", "week", "window.week", 10080],
  ["seven_day_sonnet", "week", "window.week.sonnet", 10080],
  ["seven_day_opus", "week", "window.week.opus", 10080],
  ["seven_day_oauth_apps", "week", "window.week.oauth", 10080],
  ["monthly", "month", "window.month", 43200],
];

function anthropicWindows(data) {
  if (!data || typeof data !== "object") return [];
  const out = [];
  for (const [field, period, labelKey, minutes] of ANTHROPIC_WINDOW_FIELDS) {
    const entry = data[field];
    if (!entry || typeof entry !== "object") continue;
    const built = windowFrom({
      period,
      labelKey,
      windowMinutes: minutes,
      usedPercent: entry.utilization ?? entry.used_percent,
      resetsAt: entry.resets_at ?? entry.resetsAt,
    });
    if (built) {
      built.key = field;
      out.push(built);
    }
  }
  return out;
}

/**
 * OpenAI（ChatGPT Plus/Pro）backend-api/wham/usage。
 * 真实形状（已实测）：
 *   rate_limit.primary_window / secondary_window =
 *   { used_percent, limit_window_seconds, reset_after_seconds, reset_at }
 * 18000s = 5 小时，604800s = 7 天；reset_at 是 epoch 秒。
 */
function openAiWindows(data) {
  if (!data || typeof data !== "object") return [];
  const container = data.rate_limit ?? data.rate_limits ?? data.rateLimit ?? data;
  const out = [];
  const push = (raw, fallbackPeriod) => {
    if (!raw || typeof raw !== "object") return;
    const minutes = minutesFrom(raw);
    const period = minutes !== null ? periodFromMinutes(minutes) : fallbackPeriod;
    const resetAtRaw = raw.resets_at ?? raw.resetsAt ?? raw.reset_at ?? raw.resetAt ?? null;
    const afterSeconds = num(
      raw.resets_in_seconds ?? raw.reset_after_seconds ?? raw.reset_in_seconds,
    );
    const resetsAt =
      resetAtRaw === null || resetAtRaw === undefined
        ? afterSeconds !== null
          ? resetRelativeToNow(afterSeconds)
          : null
        : resetAtRaw;
    const built = windowFrom({
      period,
      labelKey: PERIOD_LABEL_KEY[period],
      windowMinutes: minutes,
      usedPercent: raw.used_percent ?? raw.usedPercent ?? raw.utilization,
      resetsAt,
      used: raw.used ?? null,
      limit: raw.limit ?? null,
      unit: raw.unit ?? null,
    });
    if (built) {
      built.key = `${period}-${minutes ?? "x"}`;
      out.push(built);
    }
  };

  push(container.primary_window ?? container.primaryWindow, "session");
  push(container.secondary_window ?? container.secondaryWindow, "week");
  return dedupeWindows(out);
}

function resetRelativeToNow(seconds) {
  return Date.now() + num(seconds) * 1000;
}

function dedupeWindows(windows) {
  const seen = new Set();
  return windows.filter((w) => (seen.has(w.key) ? false : (seen.add(w.key), true)));
}

/** GitHub Copilot：copilot_internal/user 的 quota_snapshots。 */
const COPILOT_WINDOW_META = [
  ["premium_interactions", "高级请求", "window.month"],
  ["chat", "聊天", "window.month"],
  ["completions", "代码补全", "window.month"],
];

function copilotWindows(data) {
  if (!data || typeof data !== "object") return [];
  const snapshots = data.quota_snapshots ?? data.quotaSnapshots ?? null;
  if (!snapshots || typeof snapshots !== "object") return [];
  const resetAt = data.quota_reset_date_utc ?? data.quota_reset_date ?? null;
  const out = [];
  for (const [field, label, labelKey] of COPILOT_WINDOW_META) {
    const snap = snapshots[field];
    if (!snap || typeof snap !== "object") continue;
    const remainingPercent = num(snap.percent_remaining ?? snap.percentRemaining);
    const entitlement = num(snap.entitlement);
    const remaining = num(snap.remaining);
    const usedPercent =
      remainingPercent !== null
        ? 100 - remainingPercent
        : entitlement !== null && entitlement > 0 && remaining !== null
          ? ((entitlement - remaining) / entitlement) * 100
          : null;
    if (usedPercent === null) continue;
    const built = windowFrom({
      period: "month",
      labelKey,
      windowMinutes: 43200,
      usedPercent,
      resetsAt: resetAt,
      used: entitlement !== null && remaining !== null ? entitlement - remaining : null,
      limit: entitlement,
      unit: null,
    });
    if (built) {
      built.key = `copilot-${field}`;
      built.customLabel = label;
      out.push(built);
    }
  }
  return out;
}

/** OpenRouter：/api/v1/key 的额度余额。 */
function openRouterWindows(data) {
  const info = data?.data ?? data;
  if (!info || typeof info !== "object") return [];
  const usage = num(info.usage);
  const limit = num(info.limit);
  const limitRemaining = num(info.limit_remaining ?? info.limitRemaining);
  if (limit === null || limit <= 0) {
    // 没有设额度上限：给不出「剩余比例」，由调用方给出说明，不编造数字。
    return [];
  }
  const usedPercent = usage !== null ? (usage / limit) * 100 : null;
  const built = windowFrom({
    period: "credit",
    labelKey: "window.credit",
    usedPercent,
    used: usage,
    limit,
    unit: "USD",
  });
  if (!built) return [];
  built.key = "openrouter-credit";
  if (limitRemaining !== null) built.remainingValue = round1(limitRemaining);
  return [built];
}

// ── 通用适配器（用户自定义来源）────────────────────────────────────────────

const USED_FIELDS = ["used_percent", "usedPercent", "utilization", "percent_used", "used_pct"];
const REMAINING_FIELDS = ["percent_remaining", "percentRemaining", "remaining_percent"];
/**
 * 从窗口对象里取出「窗口时长（分钟）」。
 * 实测的两家写法：openai-codex 用 limit_window_seconds（秒），其余常见 window_minutes。
 * 给了 field 就只按该字段取（用于用户自定义映射）。
 */
function minutesFrom(source, field) {
  if (field) return num(source[field]);
  const minutes = num(source.window_minutes ?? source.windowMinutes);
  if (minutes !== null) return minutes;
  const seconds = num(source.limit_window_seconds ?? source.window_seconds);
  return seconds !== null ? seconds / 60 : null;
}
const RESET_FIELDS = [
  "resets_at",
  "resetsAt",
  "reset_at",
  "resetAt",
  "reset_after_seconds",
  "resets_in_seconds",
  "quota_reset_date_utc",
];

function pickPath(root, dotted) {
  if (!dotted) return root;
  let node = root;
  for (const part of String(dotted).split(".")) {
    if (node == null || typeof node !== "object") return null;
    node = node[part];
  }
  return node ?? null;
}

function firstNumber(source, fields) {
  for (const field of fields) {
    const value = num(source[field]);
    if (value !== null) return value;
  }
  return null;
}

function firstValue(source, fields) {
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null) return source[field];
  }
  return null;
}

/** 从包含窗口的键名推测周期：five_hour → session，seven_day → week… */
function periodFromKey(key) {
  const k = String(key ?? "").toLowerCase();
  if (/five|5h|session|primary/.test(k)) return "session";
  if (/seven|7d|week|secondary/.test(k)) return "week";
  if (/month|30d/.test(k)) return "month";
  if (/day|24h/.test(k)) return "day";
  return null;
}

/** 在任意 JSON 里递归找出「看起来像额度窗口」的对象。 */
function autoWindows(data, options = {}) {
  const out = [];
  const cap = options.cap ?? 12;
  const walk = (node, keyPath, depth) => {
    if (depth > 4 || out.length >= cap || node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${keyPath}.${index}`, depth + 1));
      return;
    }
    const used = firstNumber(node, USED_FIELDS);
    const remaining = firstNumber(node, REMAINING_FIELDS);
    if (used !== null || remaining !== null) {
      const minutes = minutesFrom(node);
      const period =
        (minutes !== null ? periodFromMinutes(minutes) : null) ??
        periodFromKey(keyPath) ??
        periodFromKey(node.type ?? node.name ?? node.id) ??
        "other";
      const resetRaw = firstValue(node, RESET_FIELDS);
      const resetsAt =
        typeof resetRaw === "number" && /seconds|_in_|_after_/.test(
          RESET_FIELDS.find((f) => node[f] === resetRaw) ?? "",
        )
          ? resetRelativeToNow(resetRaw)
          : resetRaw;
      const built = windowFrom({
        period,
        labelKey: PERIOD_LABEL_KEY[period],
        windowMinutes: minutes,
        usedPercent: used !== null ? used : remaining !== null ? 100 - remaining : null,
        resetsAt,
        used: node.used ?? node.usage ?? null,
        limit: node.limit ?? node.entitlement ?? null,
        unit: node.unit ?? null,
      });
      if (built) {
        built.key = keyPath || `${period}-${out.length}`;
        out.push(built);
        return;
      }
    }
    for (const [childKey, child] of Object.entries(node)) {
      walk(child, keyPath ? `${keyPath}.${childKey}` : childKey, depth + 1);
    }
  };
  walk(data, "", 0);
  return dedupeWindows(out);
}

/** 按用户给的字段映射取窗口。 */
function mappedWindows(data, specs) {
  const out = [];
  for (const spec of specs) {
    if (!spec || typeof spec !== "object") continue;
    const node = pickPath(data, spec.path);
    if (node == null) continue;
    const items = Array.isArray(node) ? node : [node];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const minutes = minutesFrom(item, spec.minutesField);
      const period =
        (typeof spec.period === "string" && PERIOD_LABEL_KEY[spec.period] ? spec.period : null) ??
        (minutes !== null ? periodFromMinutes(minutes) : "other");
      const resetField = spec.resetField ?? "reset_at";
      const resetRaw = item[resetField];
      const resetsAt = /seconds|_in_|_after_/.test(resetField) ? resetRelativeToNow(resetRaw) : resetRaw;
      const built = windowFrom({
        period,
        labelKey: PERIOD_LABEL_KEY[period],
        windowMinutes: minutes,
        usedPercent: item[spec.usedField ?? "used_percent"],
        resetsAt,
        used: item[spec.usedCountField ?? "used"] ?? null,
        limit: item[spec.limitField ?? "limit"] ?? null,
        unit: spec.unit ?? null,
      });
      if (built) {
        built.key = `${spec.path || "root"}-${out.length}`;
        if (typeof spec.label === "string" && spec.label.trim()) built.customLabel = spec.label.trim();
        out.push(built);
      }
    }
  }
  return dedupeWindows(out);
}

function genericSourceFor(settings, vendorId) {
  return (
    settings.sources.find(
      (s) => s && typeof s === "object" && s.vendor === vendorId && typeof s.url === "string" && s.url,
    ) ?? null
  );
}

async function collectGeneric(settings, vendor) {
  const source = genericSourceFor(settings, vendor.id);
  // 没有配置来源 = 插件无法确认这个账号已登录 → 返回 null，界面不显示。
  if (!source) return null;
  const headers = { accept: "application/json", ...(source.headers ?? {}) };
  const token = (typeof source.token === "string" && source.token) || settingsToken(settings, vendor.id);
  if (token) headers.authorization = `${source.authScheme ?? "Bearer"} ${token}`;
  const response = await httpJson(source.url, headers);
  if (response.status < 200 || response.status >= 300) {
    throw httpError(source.label || vendor.name, response);
  }
  const windows =
    Array.isArray(source.windows) && source.windows.length
      ? mappedWindows(response.data, source.windows)
      : autoWindows(response.data);
  const planValue = source.planPath ? pickPath(response.data, source.planPath) : null;
  return {
    id: vendor.id,
    provider: vendor.id,
    label: typeof source.label === "string" && source.label ? source.label : vendor.name,
    plan: typeof planValue === "string" ? planValue : null,
    status: windows.length ? "ok" : "empty",
    windows,
    hint: windows.length
      ? null
      : "接口有响应，但没有识别到额度窗口；可在设置的 sources 里补充字段映射",
  };
}

// ── 本机凭据发现 ────────────────────────────────────────────────────────────

function homePath(...parts) {
  const home = os.homedir();
  return home ? path.join(home, ...parts) : null;
}

function envPath(envName, ...parts) {
  const base = process.env[envName];
  return base ? path.join(base, ...parts) : null;
}

/** Claude Code：~/.claude/.credentials.json（或 $CLAUDE_CONFIG_DIR 下的同名文件）。 */
async function claudeCliCredentials() {
  const files = [
    envPath("CLAUDE_CONFIG_DIR", ".credentials.json"),
    homePath(".claude", ".credentials.json"),
  ].filter(Boolean);
  for (const file of files) {
    const data = await readJsonFile(file);
    if (!data) continue;
    const oauth = data.claudeAiOauth ?? data.claudeAiOauthTokens ?? null;
    const token =
      typeof oauth?.accessToken === "string"
        ? oauth.accessToken
        : typeof oauth?.access_token === "string"
          ? oauth.access_token
          : null;
    if (!token) continue;
    const expiresAt = num(oauth?.expiresAt);
    return {
      token,
      plan:
        (typeof oauth?.subscriptionType === "string" && oauth.subscriptionType) ||
        (typeof oauth?.rateLimitTier === "string" && oauth.rateLimitTier) ||
        null,
      expired: expiresAt !== null && expiresAt > 0 && expiresAt < Date.now(),
      // 可选：新版 Claude Code 凭据里带 emailAddress；没有就交给 /api/oauth/profile。
      email: typeof oauth?.emailAddress === "string" ? oauth.emailAddress : null,
      source: file,
    };
  }
  return null;
}

/** Codex CLI：~/.codex/auth.json 的 tokens.access_token / tokens.account_id。 */
async function codexCliCredentials() {
  const file = homePath(".codex", "auth.json");
  if (!file) return null;
  const data = await readJsonFile(file);
  if (!data) return null;
  const tokens = data.tokens ?? {};
  const token =
    (typeof tokens.access_token === "string" && tokens.access_token) ||
    (typeof data.access_token === "string" && data.access_token) ||
    null;
  if (!token) return null;
  const profile = openAiProfile(tokens.id_token);
  return {
    token,
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : null,
    email: profile.email,
    name: profile.name,
    source: file,
  };
}

/**
 * GitHub Copilot：编辑器插件留下的 hosts.json / apps.json。
 * 形状是「按主机名或 host:user 索引的对象，值里有 oauth_token」。
 */
async function copilotCliCredentials() {
  const files = [
    homePath(".config", "github-copilot", "hosts.json"),
    homePath(".config", "github-copilot", "apps.json"),
    envPath("APPDATA", "github-copilot", "hosts.json"),
    envPath("LOCALAPPDATA", "github-copilot", "hosts.json"),
    envPath("APPDATA", "Code", "User", "globalStorage", "github.copilot", "hosts.json"),
  ].filter(Boolean);
  for (const file of files) {
    const data = await readJsonFile(file);
    if (!data || typeof data !== "object") continue;
    for (const value of Object.values(data)) {
      if (!value || typeof value !== "object") continue;
      const token = value.oauth_token ?? value.oauthToken ?? value.token;
      if (typeof token === "string" && token) {
        return {
          token,
          user: typeof value.user === "string" ? value.user : null,
          source: file,
        };
      }
    }
  }
  return null;
}

// ── 账号身份 ────────────────────────────────────────────────────────────────
// 界面要显示「这是哪个账号」。这里尽量拿到真实身份：ChatGPT 的 id_token 与 access
// token 的 profile claim 带 name（昵称）与 email；Claude 的 /api/oauth/profile 返回
// account.email；Copilot 的额度接口返回 GitHub 登录名。只做本地 JWT 解析或调用同源
// 服务商接口，不写日志，也不改变凭据存储。

/** 解析 JWT payload；失败或形状不对返回 null。 */
function jwtClaims(token) {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const data = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

/**
 * ChatGPT 的 profile claim（id_token 与 access token 都带）：`name` 是账号昵称，
 * `email` 是登录邮箱。昵称更接近「这是谁」，所以界面优先显示它。
 */
function openAiProfile(token) {
  const claims = jwtClaims(token);
  const profile = claims?.["https://api.openai.com/profile"];
  const pick = (value) => (typeof value === "string" && value.trim() && [...value.trim()].length <= 80 ? value.trim() : null);
  return {
    name: pick(profile?.name) ?? pick(claims?.name),
    email: pick(profile?.email) ?? pick(claims?.email),
  };
}

/** Claude 邮箱：GET /api/oauth/profile（与额度接口同源）。任何失败都返回 null。 */
async function anthropicEmail(token) {
  try {
    const response = await httpJson("https://api.anthropic.com/api/oauth/profile", {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "cache-control": "no-cache",
      "user-agent": "claude-cli/2.1.251",
    });
    if (response.status < 200 || response.status >= 300) return null;
    const account = response.data?.account ?? {};
    const raw = typeof account.email === "string" ? account.email : account.email_address;
    const email = typeof raw === "string" ? raw.trim() : "";
    return email && [...email].length <= 80 ? email : null;
  } catch { return null; }
}

/**
 * 插件账号展示：标题用身份（昵称 / 登录名 / 邮箱），邮箱单独带出去。
 * 两者都有时界面把邮箱放在卡片 chip 里，避免长邮箱把标题挤成省略号。
 */
function pluginAccountDisplay(vendor, identity, email) {
  const identityText = typeof identity === "string" ? identity.trim() : "";
  const emailText = typeof email === "string" ? email.trim() : "";
  return {
    identity: identityText || null,
    email: emailText || null,
    vendorName: vendor.name,
    label: identityText ? `${vendor.name} · ${identityText}` : vendor.name,
  };
}

// ── 服务商 ──────────────────────────────────────────────────────────────────
//
// collect(settings) → 账号对象；返回 null 表示「没登录」，界面不显示。

async function collectAnthropic(settings, _vendor, provided) {
  const vendor = "anthropic";
  const name = "Anthropic (Claude Pro/Max)";
  const credential = provided ?? await resolveCredential(settings, vendor, claudeCliCredentials);
  if (!credential) return null;
  const response = await httpJson("https://api.anthropic.com/api/oauth/usage", {
    accept: "application/json",
    authorization: `Bearer ${credential.token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": "claude-cli/2.1.251",
  });
  if (response.status < 200 || response.status >= 300) throw httpError(name, response);
  const windows = anthropicWindows(response.data ?? {});
  const identity = credential.email ?? await anthropicEmail(credential.token);
  // Claude 的响应里没有用户昵称，邮箱就是唯一身份；chip 会因与身份相同而不重复显示。
  const email = identity;
  return {
    id: vendor,
    provider: vendor,
    source: credential.source === "plugin" ? "plugin" : credential.source === "settings" ? "settings" : "cli",
    label: identity ? `${name} · ${identity}` : name,
    identity,
    email,
    plan: credential.plan ?? null,
    status: windows.length ? "ok" : "empty",
    windows,
    note: credential.expired ? "本机凭据显示已过期，若数值异常请重新登录" : null,
    hint: windows.length ? null : "该账号未返回任何额度窗口",
  };
}

async function collectOpenAiCodex(settings, _vendor, provided) {
  const vendor = "openai-codex";
  const name = "OpenAI (ChatGPT Plus/Pro)";
  const credential = provided ?? await resolveCredential(settings, vendor, codexCliCredentials);
  if (!credential) return null;

  const headers = {
    accept: "application/json",
    authorization: `Bearer ${credential.token}`,
    "user-agent": "pi-desktop-subscription-quota/0.1.0",
  };
  if (credential.accountId) headers["chatgpt-account-id"] = credential.accountId;

  let firstError = null;
  for (const url of [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/codex/usage",
  ]) {
    try {
      const response = await httpJson(url, headers);
      if (response.status < 200 || response.status >= 300) {
        if (response.status !== 404) throw httpError(name, response);
        if (!firstError) firstError = httpError(name, response);
        continue;
      }
      const windows = openAiWindows(response.data ?? {});
      const plan = response.data?.plan_type ?? credential.plan ?? null;
      const who = openAiProfile(credential.token);
      const identity = who.name ?? credential.email ?? who.email;
      return {
        id: vendor,
        provider: vendor,
        source: credential.source === "plugin" ? "plugin" : credential.source === "settings" ? "settings" : "cli",
        label: identity ? `${name} · ${identity}` : name,
        identity,
        email: who.email ?? credential.email ?? null,
        plan: typeof plan === "string" ? plan : null,
        status: windows.length ? "ok" : "empty",
        windows,
        hint: windows.length ? null : "该账号未返回任何额度窗口",
      };
    } catch (error) {
      throw error;
    }
  }
  throw firstError ?? Object.assign(new Error(`${name}: 额度接口不可达`), { code: "NETWORK" });
}

async function collectCopilot(settings, _vendor, provided) {
  const vendor = "github-copilot";
  const name = "GitHub Copilot";
  const credential = provided ?? await resolveCredential(settings, vendor, copilotCliCredentials);
  if (!credential) return null;
  const response = await httpJson("https://api.github.com/copilot_internal/user", {
    accept: "application/json",
    authorization: `token ${credential.token}`,
    "editor-version": "vscode/1.104.0",
    "editor-plugin-version": "copilot-chat/0.26.0",
    "x-github-api-version": "2026-06-01",
    "user-agent": "GitHubCopilotChat/0.26.0",
  });
  if (response.status < 200 || response.status >= 300) throw httpError(name, response);
  const windows = copilotWindows(response.data ?? {});
  const plan = response.data?.copilot_plan ?? response.data?.copilotPlan ?? null;
  return {
    id: vendor,
    provider: vendor,
    source: credential.source === "plugin" ? "plugin" : credential.source === "settings" ? "settings" : "cli",
    label: typeof response.data?.login === "string" ? `${name} · ${response.data.login}` : name,
    identity: typeof response.data?.login === "string" ? response.data.login : null,
    plan: typeof plan === "string" ? plan : null,
    status: windows.length ? "ok" : "empty",
    windows,
    hint: windows.length ? null : "该账号未返回任何额度快照",
  };
}

async function collectOpenRouter(settings) {
  const vendor = "openrouter";
  const name = "OpenRouter";
  const token = settingsToken(settings, vendor);
  // OpenRouter 没有可发现的本地凭据文件：只在用户填了 Key 时才显示。
  if (!token) return null;
  const response = await httpJson("https://openrouter.ai/api/v1/key", {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  });
  if (response.status < 200 || response.status >= 300) throw httpError(name, response);
  const info = response.data?.data ?? response.data ?? {};
  const windows = openRouterWindows(response.data ?? {});
  const label = typeof info.label === "string" && info.label ? `${name} · ${info.label}` : name;
  return {
    id: vendor,
    provider: vendor,
    label,
    plan: info.is_free_tier === true ? "free" : null,
    status: windows.length ? "ok" : "empty",
    windows,
    hint: windows.length
      ? null
      : "该密钥没有设置额度上限（OpenRouter 只对设了 limit 的密钥给出剩余比例）",
  };
}

const VENDORS = [
  {
    id: "anthropic",
    name: "Anthropic (Claude Pro/Max)",
    collect: collectAnthropic,
  },
  {
    id: "openai-codex",
    name: "OpenAI (ChatGPT Plus/Pro)",
    collect: collectOpenAiCodex,
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    collect: collectCopilot,
  },
  {
    id: "kimi-coding",
    name: "Kimi Code (subscription)",
    collect: (settings, vendor) => collectGeneric(settings, vendor),
  },
  {
    id: "meta",
    name: "Meta (Muse subscription)",
    collect: (settings, vendor) => collectGeneric(settings, vendor),
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    collect: collectOpenRouter,
  },
  {
    id: "radius",
    name: "Radius",
    collect: (settings, vendor) => collectGeneric(settings, vendor),
  },
  {
    id: "xai",
    name: "xAI (Grok/X subscription)",
    collect: (settings, vendor) => collectGeneric(settings, vendor),
  },
];

// ── 手动账号（不联网）──────────────────────────────────────────────────────

function manualAccounts(rawAccounts) {
  const out = [];
  const list = Array.isArray(rawAccounts) ? rawAccounts : [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    if (!entry || typeof entry !== "object" || entry.enabled === false) continue;
    const windows = [];
    const rawWindows = Array.isArray(entry.windows) ? entry.windows : [];
    for (const item of rawWindows) {
      if (!item || typeof item !== "object") continue;
      const period =
        typeof item.period === "string" && PERIOD_LABEL_KEY[item.period]
          ? item.period
          : periodFromMinutes(item.windowMinutes ?? num(item.minutes));
      let usedPercent = item.usedPercent ?? item.used_percent ?? null;
      const usedNum = num(item.used);
      const limitNum = num(item.limit);
      if (usedPercent === null && usedNum !== null && limitNum !== null && limitNum > 0) {
        usedPercent = (usedNum / limitNum) * 100;
      }
      const built = windowFrom({
        period,
        labelKey: typeof item.label === "string" && item.label.trim() ? null : PERIOD_LABEL_KEY[period],
        windowMinutes: item.windowMinutes ?? item.minutes,
        usedPercent,
        resetsAt: item.resetsAt ?? item.resets_at,
        used: item.used,
        limit: item.limit,
        unit: item.unit,
      });
      if (built) {
        built.key = typeof item.key === "string" ? item.key : `${period}-${windows.length}`;
        if (typeof item.label === "string" && item.label.trim()) built.customLabel = item.label.trim();
        windows.push(built);
      }
    }
    out.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : `manual-${index + 1}`,
      provider: typeof entry.provider === "string" ? entry.provider : "manual",
      label: typeof entry.label === "string" && entry.label ? entry.label : `手动账号 ${index + 1}`,
      plan: typeof entry.plan === "string" ? entry.plan : null,
      status: windows.length ? "ok" : "empty",
      windows,
      manual: true,
      hint: windows.length ? null : "该手动账号没有可用的窗口（需要 period + usedPercent，或 used + limit）",
    });
  }
  return out;
}

// ── 演示数据 ────────────────────────────────────────────────────────────────

function demoSample() {
  const now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  const hour = 3_600_000;
  const day = 86_400_000;
  return [
    {
      id: "demo-anthropic",
      provider: "anthropic",
      label: "Anthropic (Claude Pro/Max)",
      plan: "max",
      status: "ok",
      demo: true,
      windows: [
        { key: "five_hour", period: "session", labelKey: "window.session", windowMinutes: 300, usedPercent: 23.5, remainingPercent: 76.5, resetsAt: at(2.4 * hour) },
        { key: "seven_day", period: "week", labelKey: "window.week", windowMinutes: 10080, usedPercent: 58.1, remainingPercent: 41.9, resetsAt: at(3.4 * day) },
        { key: "seven_day_sonnet", period: "week", labelKey: "window.week.sonnet", windowMinutes: 10080, usedPercent: 88.6, remainingPercent: 11.4, resetsAt: at(3.4 * day) },
      ],
    },
    {
      id: "demo-openai",
      provider: "openai-codex",
      label: "OpenAI (ChatGPT Plus/Pro)",
      plan: "plus",
      status: "ok",
      demo: true,
      windows: [
        { key: "session-300", period: "session", labelKey: "window.session", windowMinutes: 300, usedPercent: 12, remainingPercent: 88, resetsAt: at(4.1 * hour) },
        { key: "week-10080", period: "week", labelKey: "window.week", windowMinutes: 10080, usedPercent: 41.7, remainingPercent: 58.3, resetsAt: at(5.2 * day) },
      ],
    },
    {
      id: "demo-copilot",
      provider: "github-copilot",
      label: "GitHub Copilot",
      plan: "business",
      status: "ok",
      demo: true,
      windows: [
        { key: "copilot-premium", period: "month", labelKey: "window.month", customLabel: "高级请求", windowMinutes: 43200, usedPercent: 32, remainingPercent: 68, resetsAt: at(12 * day) },
        { key: "copilot-chat", period: "month", labelKey: "window.month", customLabel: "聊天", windowMinutes: 43200, usedPercent: 7.5, remainingPercent: 92.5, resetsAt: at(12 * day) },
      ],
    },
    {
      id: "demo-openrouter",
      provider: "openrouter",
      label: "OpenRouter",
      status: "ok",
      demo: true,
      windows: [
        { key: "openrouter-credit", period: "credit", labelKey: "window.credit", usedPercent: 27.4, remainingPercent: 72.6, used: 2.74, limit: 10, unit: "USD" },
      ],
    },
  ];
}

// ── 快照 ────────────────────────────────────────────────────────────────────

function errorAccount(vendor, error) {
  return {
    id: vendor.id,
    provider: vendor.id,
    label: vendor.name,
    status: "error",
    windows: [],
    error: errorMessage(error),
  };
}

function hostUsageRow(vendor, account, priority) {
  const identity = typeof account.accountLabel === "string" ? account.accountLabel.trim() : "";
  const email = identity.includes("@") ? identity : null;
  const windows = Array.isArray(account.windows) ? account.windows : [];
  const status = ["ok", "empty", "error"].includes(account.status) ? account.status : "error";
  return {
    id: `host:${account.providerId}`,
    provider: vendor.id,
    source: "host",
    priority,
    label: identity ? `${vendor.name} · ${identity}` : vendor.name,
    identity: identity || null,
    email,
    vendorName: vendor.name,
    plan: typeof account.plan === "string" ? account.plan : null,
    status,
    windows,
    error: status === "error" && typeof account.error === "string" ? account.error : null,
    hint: status === "empty" ? "该账号未返回任何额度窗口" : null,
  };
}

async function hostSubscriptionUsage() {
  if (typeof pi?.models?.subscriptionUsage !== "function") return [];
  try {
    const accounts = await pi.models.subscriptionUsage();
    return Array.isArray(accounts) ? accounts : [];
  } catch {
    // Older hosts or an unapproved permission retain the existing plugin/CLI behavior.
    return [];
  }
}

async function buildSnapshot({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) {
    return { ...cache.snapshot, accounts: recommendAccounts(cache.snapshot.accounts, now), cached: true };
  }

  const snapshotEpoch = cacheEpoch;
  const settings = await getSettings();
  const accounts = [];

  if (settings.demoMode) {
    for (const account of demoSample()) accounts.push(account);
  } else {
    let saved = [], authError = null;
    try { saved = await getAuth().listAccounts(); } catch (error) { authError = error; }
    const hostUsage = await hostSubscriptionUsage();
    const collected = await Promise.all(VENDORS.map(async (vendor) => {
      const pluginAccounts = saved.filter((account) => account.vendor === vendor.id)
        .sort((a, b) => a.priority - b.priority);
      const rows = await Promise.all(pluginAccounts.map(async (account) => {
        let row;
        try {
          const credential = await getAuth().credential(account.id);
          if (!credential) throw Object.assign(new Error("账号已删除，请刷新"), { code: "AUTH_CHANGED" });
          row = await vendor.collect(settings, vendor, credential);
        } catch (error) { row = errorAccount(vendor, error); }
        const display = pluginAccountDisplay(vendor, row?.identity, row?.email);
        return { ...row, id: `plugin:${account.id}`, source: "plugin", priority: account.priority,
          ...(vendor.id === "openai-codex" ? { resetAccountId: account.id } : {}),
          identity: display.identity, email: display.email, vendorName: display.vendorName, label: display.label };
      }));
      const hostAccounts = hostUsage
        .filter((account) => account?.vendorId === vendor.id && typeof account?.providerId === "string")
        .map((account, index) => hostUsageRow(vendor, account, index + 1));
      rows.push(...hostAccounts);
      const oauthVendor = ["anthropic", "openai-codex", "github-copilot"].includes(vendor.id);
      if (authError && oauthVendor) rows.push({ ...errorAccount(vendor, authError), id: `auth:${vendor.id}` });
      // Explicit manual credentials remain visible; CLI is only a fallback.
      if ((!pluginAccounts.length && !hostAccounts.length) || settingsToken(settings, vendor.id)) {
        try {
          const external = await vendor.collect(settings, vendor);
          if (external) rows.push(external);
        } catch (error) { rows.push(errorAccount(vendor, error)); }
      }
      return rows;
    }));
    accounts.push(...collected.flat());
    for (const account of manualAccounts(settings.accounts)) accounts.push(account);
  }

  const snapshot = {
    ok: true,
    generatedAt: new Date().toISOString(),
    demo: settings.demoMode,
    autoDetect: settings.autoDetect,
    refreshSeconds: settings.refreshSeconds,
    accounts: recommendAccounts(accounts),
  };
  if (snapshotEpoch !== cacheEpoch) {
    // Refresh/login/logout occurred while fetching: never cache another epoch.
    throw Object.assign(new Error("账号授权已更新，请刷新额度"), { code: "AUTH_CHANGED" });
  }
  cache = { at: now, snapshot };
  return snapshot;
}

// ── 通道路由 ────────────────────────────────────────────────────────────────

const CHANNELS = {
  "quota.auth.status": () => getAuth().status(),
  "quota.auth.start": async (payload) => {
    if ((await getSettings()).demoMode) return { ok: false, code: "DEMO_MODE", message: "请先关闭演示模式再登录" };
    return getAuth().start(payload.vendor, { accountId: payload.accountId, label: payload.label });
  },
  "quota.auth.open": (payload) => getAuth().open(payload.id),
  "quota.auth.submit": (payload) => getAuth().submit(payload.id, payload.input),
  "quota.auth.cancel": (payload) => getAuth().cancel(payload.id),
  "quota.auth.logout": (payload) => getAuth().logout(payload.accountId),
  "quota.auth.move": (payload) => getAuth().move(payload.accountId, payload.direction),
  "quota.openaiReset.list": (payload) => getResetService().list(payload.accountId),
  "quota.openaiReset.prepare": (payload) => getResetService().prepare(payload.accountId, payload.creditId),
  "quota.openaiReset.consume": (payload) => getResetService().consume(payload.operationId, payload.confirmed),
  "quota.openaiReset.cancel": (payload) => getResetService().cancel(payload.operationId),
  "quota.snapshot": (payload) => buildSnapshot({ force: payload?.force === true }),
  "quota.refresh": () => buildSnapshot({ force: true }),
  "quota.setDemo": async (payload) => {
    const enabled = payload?.enabled === true;
    if (enabled && auth) {
      const current = await auth.status();
      if (current.login) await auth.cancel(current.login.id);
    }
    try {
      await pi.plugin.setSettings({ demoMode: enabled });
    } catch {
      /* 设置写入失败不阻塞渲染 */
    }
    invalidateCache();
    return buildSnapshot({ force: true });
  },
};

async function onPanelInvoke(channel, payload) {
  const handler = CHANNELS[channel];
  if (!handler) return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
  try {
    return await handler(payload ?? {});
  } catch (error) {
    return { ok: false, code: error?.code ?? "ERROR", message: errorMessage(error) };
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

async function onLoad() {
  try {
    await pi.commands.register({
      id: "quota.open",
      title: "Subscription Quotas: Open Panel",
      keywords: ["quota", "usage", "额度", "剩余"],
      run: async () => {
        await pi.ui.openPanel({ title: "订阅额度" });
      },
    });
  } catch {
    /* 命令注册失败不影响视图渲染 */
  }
  // 预热缓存：不阻塞加载，失败也由界面按需重试。
  void buildSnapshot({ force: true }).catch(() => {});
}

async function onUnload() {
  invalidateCache();
  if (resetService) await resetService.stop();
  resetService = null;
  if (auth) await auth.stop();
  auth = null;
  try {
    await pi.commands.unregister("quota.open");
  } catch {
    /* 尽力而为 */
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
