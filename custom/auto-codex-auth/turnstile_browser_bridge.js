"use strict";

const { connect } = require("puppeteer-real-browser");

const READY_PREFIX = "CODEX_TURNSTILE_BRIDGE=";

function readConfig() {
  if (!process.argv[2]) {
    throw new Error("missing base64url bridge configuration");
  }
  return JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
}

async function normalizeHeadlessPage(page, config) {
  await page.goto(config.metadataUrl, {
    waitUntil: "domcontentloaded",
    timeout: 10_000,
  });
  const actual = await page.evaluate(async () => {
    if (!navigator.userAgentData) {
      throw new Error("Chromium did not expose User-Agent Client Hints");
    }
    const high = await navigator.userAgentData.getHighEntropyValues([
      "architecture",
      "bitness",
      "brands",
      "fullVersionList",
      "mobile",
      "model",
      "platform",
      "platformVersion",
      "uaFullVersion",
      "wow64",
    ]);
    return {
      userAgent: navigator.userAgent,
      high,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  });

  await page.setUserAgent(actual.userAgent.replace("HeadlessChrome/", "Chrome/"), {
    brands: actual.high.brands,
    fullVersionList: actual.high.fullVersionList,
    fullVersion: actual.high.uaFullVersion,
    platform: actual.high.platform,
    platformVersion: actual.high.platformVersion,
    architecture: actual.high.architecture,
    model: actual.high.model,
    mobile: actual.high.mobile,
    bitness: actual.high.bitness,
    wow64: actual.high.wow64,
  });

  const client = await page.target().createCDPSession();
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: actual.innerWidth,
    height: actual.innerHeight,
    screenWidth: config.screenWidth,
    screenHeight: config.screenHeight,
    deviceScaleFactor: 1,
    mobile: false,
    positionX: 0,
    positionY: 0,
  });
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
}

async function main() {
  const config = readConfig();
  const { browser, page } = await connect({
    headless: config.headless ? "new" : false,
    turnstile: true,
    disableXvfb: process.platform !== "linux" || Boolean(process.env.DISPLAY),
    args: [
      "--disable-blink-features=AutomationControlled",
      `--window-size=${config.windowWidth},${config.windowHeight}`,
    ],
    customConfig: {
      chromePath: config.chromePath,
    },
    connectOption: {
      defaultViewport: null,
    },
  });

  if (config.headless) {
    await normalizeHeadlessPage(page, config);
  }

  process.stdout.write(
    `${READY_PREFIX}${JSON.stringify({ endpoint: browser.wsEndpoint() })}\n`,
  );

  browser.once("disconnected", () => process.exit(0));
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    if (!chunk.split(/\r?\n/).includes("close")) {
      return;
    }
    try {
      await browser.close();
    } finally {
      process.exit(0);
    }
  });
}

main().catch((error) => {
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
