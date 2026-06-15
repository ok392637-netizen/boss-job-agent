import fs from "node:fs";
import path from "node:path";
import { chromium } from "patchright";
import { config } from "../src/config.js";
import { humanDelay } from "../src/browser.js";
import { detectCircuitCondition } from "../src/boss/greet.js";
import { SELECTORS, URLS } from "../src/boss/selectors.js";

const DETAIL_URL =
  "https://www.zhipin.com/job_detail/5f56501dafbcbdcd0nBz2dm9FltS.html";
const OBSERVE_MS = 8_000;
const SAMPLE_MS = 250;
const LOG_DIRECTORY = path.join(config.paths.projectRoot, "data", "logs");

fs.mkdirSync(LOG_DIRECTORY, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  engine: "patchright",
  profile: config.paths.browserProfile,
  readOnly: true,
  accessBudget: 2,
  accessesUsed: 0,
  launch: null,
  detail: null,
  messages: null,
  events: [],
};

const startedAt = Date.now();
const pageIds = new WeakMap();
const labels = new WeakMap();
const attached = new WeakSet();
let nextPageId = 1;
let context;

try {
  assertProfileAvailable();
  ({ context, launch: report.launch } = await launchPatchright());
  attachContext(context);

  const sentinel = context.pages()[0] ?? (await context.newPage());
  labels.set(sentinel, "sentinel");
  await sentinel.goto("data:text/html,<title>patchright-ab-sentinel</title>");

  let page = await context.newPage();
  labels.set(page, "primary");
  attachPage(page);

  report.detail = await visitAndObserve(
    page,
    DETAIL_URL,
    "detail",
    () => ({
      detailTitleCount: safeCount(page, SELECTORS.detailTitle),
      detailDescriptionCount: safeCount(page, SELECTORS.detailDescription),
      detailTitle: safeText(page, SELECTORS.detailTitle),
      bodyLength: safeBodyLength(page),
    }),
  );

  await humanDelay(2_000, 4_000);
  page = await ensurePage(page, "messages-primary");

  report.messages = await visitAndObserve(
    page,
    URLS.messages,
    "messages",
    () => ({
      inboxConversationCount: safeCount(
        page,
        SELECTORS.inboxConversation,
      ),
      inboxUnreadCount: safeCount(page, SELECTORS.inboxUnread),
      bodyLength: safeBodyLength(page),
    }),
  );
} catch (error) {
  report.stopped = true;
  report.stopReason = error.reason ?? error.message;
  report.stopStage = error.stage ?? null;
  report.stopEvidence = error.evidence ?? null;
  process.exitCode = error.exitCode ?? 2;
} finally {
  if (context) {
    await context.close().catch(() => {});
  }
  report.completedAt = new Date().toISOString();
  report.comparison = compareWithNative(report);
  const timestamp = report.completedAt.replace(/[:.]/g, "-");
  const logPath = path.join(
    LOG_DIRECTORY,
    `ab-patchright-${timestamp}.json`,
  );
  fs.writeFileSync(logPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  report.logPath = logPath;
  console.log(JSON.stringify(report, null, 2));
}

async function launchPatchright() {
  try {
    const browserContext = await chromium.launchPersistentContext(
      config.paths.browserProfile,
      launchOptions(),
    );
    return {
      context: browserContext,
      launch: {
        profileMode: "existing",
        userDataDir: config.paths.browserProfile,
      },
    };
  } catch (profileError) {
    const temporaryProfile = path.join(
      config.paths.projectRoot,
      "data",
      "diagnostics",
      `patchright-temp-profile-${Date.now()}`,
    );
    fs.mkdirSync(temporaryProfile, { recursive: true });
    const browserContext = await chromium.launchPersistentContext(
      temporaryProfile,
      launchOptions(),
    );
    return {
      context: browserContext,
      launch: {
        profileMode: "temporary-fallback",
        userDataDir: temporaryProfile,
        existingProfileError: profileError.message,
      },
    };
  }
}

function launchOptions() {
  return {
    headless: false,
    viewport: null,
    channel: "chrome",
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
    ],
  };
}

async function visitAndObserve(page, url, stage, sampleFields) {
  if (report.accessesUsed >= report.accessBudget) {
    throw diagnosticError(stage, "access_budget_exhausted");
  }

  const eventStart = report.events.length;
  const pageCountBefore = context.pages().length;
  const warningCountBefore = windowCloseWarnings().length;
  const visitStartedAt = Date.now();

  report.accessesUsed += 1;
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  const samples = [];
  let lastSignature = "";
  let firstBlankAtMs = null;
  let firstStableContentAtMs = null;
  const deadline = Date.now() + OBSERVE_MS;

  while (Date.now() < deadline) {
    await stopOnSecurity(stage);
    const fields = await resolveFields(sampleFields());
    const sample = {
      elapsedMs: Date.now() - visitStartedAt,
      url: page.isClosed() ? null : page.url(),
      closed: page.isClosed(),
      pageCount: context.pages().length,
      ...fields,
    };
    const signature = JSON.stringify(sample);
    if (signature !== lastSignature) {
      samples.push(sample);
      lastSignature = signature;
    }
    if (firstBlankAtMs === null && sample.url === "about:blank") {
      firstBlankAtMs = sample.elapsedMs;
    }
    if (
      firstStableContentAtMs === null &&
      (sample.detailTitleCount > 0 ||
        sample.inboxConversationCount > 0 ||
        sample.bodyLength > 100)
    ) {
      firstStableContentAtMs = sample.elapsedMs;
    }
    await sleep(SAMPLE_MS);
  }

  const warnings = windowCloseWarnings().slice(warningCountBefore);
  return {
    stage,
    requestedUrl: url,
    observationMs: Date.now() - visitStartedAt,
    pageCountBefore,
    pageCountAfter: context.pages().length,
    pageCountDelta: context.pages().length - pageCountBefore,
    finalUrl: page.isClosed() ? null : page.url(),
    pageClosed: page.isClosed(),
    becameBlank: firstBlankAtMs !== null,
    firstBlankAtMs,
    firstStableContentAtMs,
    windowCloseWarningCount: warnings.length,
    windowCloseWarnings: warnings,
    samples,
    events: report.events.slice(eventStart),
  };
}

function attachContext(browserContext) {
  record("context-attached", { pageCount: browserContext.pages().length });
  for (const page of browserContext.pages()) attachPage(page);
  browserContext.on("page", (page) => {
    record("context-new-page", {
      ...describePage(page),
      pageCount: browserContext.pages().length,
    });
    attachPage(page);
  });
  browserContext.on("close", () => record("context-closed"));
}

function attachPage(page) {
  if (attached.has(page)) return;
  attached.add(page);
  record("page-attached", describePage(page));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      record("main-frame-navigated", {
        ...describePage(page),
        navigatedUrl: frame.url(),
      });
    }
  });
  page.on("close", () => record("page-closed", describePage(page)));
  page.on("popup", (popup) =>
    record("popup", {
      sourcePageId: idFor(page),
      popupPageId: idFor(popup),
      popupUrl: popup.url(),
    }),
  );
  page.on("console", (message) => {
    if (
      message.type() === "warning" ||
      message.type() === "error" ||
      /Scripts may close|window\.close/i.test(message.text())
    ) {
      record("console", {
        ...describePage(page),
        level: message.type(),
        text: message.text().slice(0, 2_000),
      });
    }
  });
  page.on("pageerror", (error) =>
    record("page-error", {
      ...describePage(page),
      message: error.message,
    }),
  );
}

async function stopOnSecurity(stage) {
  for (const page of context.pages()) {
    if (
      page.isClosed() ||
      page.url() === "about:blank" ||
      page.url().startsWith("data:")
    ) {
      continue;
    }
    const condition = await detectCircuitCondition(page, {
      expectLoggedIn: false,
    });
    if (!condition) continue;
    throw diagnosticError(stage, condition.reason, {
      url: page.url(),
      detail: condition.detail,
    });
  }
}

async function ensurePage(page, label) {
  if (!page.isClosed()) return page;
  const replacement = await context.newPage();
  labels.set(replacement, label);
  attachPage(replacement);
  return replacement;
}

function compareWithNative(result) {
  const detail = result.detail;
  const messages = result.messages;
  if (!detail) {
    return {
      hypothesis: "UNRESOLVED",
      reason: "详情访问未完成",
    };
  }

  const detailStable =
    !detail.becameBlank &&
    !detail.pageClosed &&
    detail.samples.some(
      (sample) =>
        sample.detailTitleCount > 0 &&
        sample.detailDescriptionCount > 0,
    );
  const messagesStable =
    Boolean(messages) &&
    !messages.becameBlank &&
    !messages.pageClosed &&
    messages.samples.some((sample) => sample.bodyLength > 0);
  const noCloseWarning =
    detail.windowCloseWarningCount === 0 &&
    (messages?.windowCloseWarningCount ?? 0) === 0;

  if (detailStable && messagesStable && noCloseWarning) {
    return {
      hypothesis: "H1",
      verdict: "confirmed",
      reason:
        "Patchright 下详情和消息页均稳定 8 秒、无 about:blank、无 window.close 警告；与原生 Playwright 自毁行为形成明确对照。",
      recommendation: "将浏览器实现切换为 patchright drop-in。",
    };
  }

  return {
    hypothesis: "H3",
    verdict: "H1 rejected",
    reason:
      "Patchright 下仍出现 about:blank/window.close 警告，或消息页未能稳定读取。",
    recommendation:
      "转向 connectOverCDP 附着用户手动启动的 Chrome，并继续检查账号/会话级检测。",
  };
}

function windowCloseWarnings() {
  return report.events.filter(
    (event) =>
      event.type === "console" &&
      /Scripts may close|window\.close/i.test(event.text ?? ""),
  );
}

function record(type, detail = {}) {
  report.events.push({
    tMs: Date.now() - startedAt,
    at: new Date().toISOString(),
    type,
    ...detail,
  });
}

function idFor(page) {
  if (!pageIds.has(page)) {
    pageIds.set(page, `page-${nextPageId++}`);
  }
  return pageIds.get(page);
}

function describePage(page) {
  return {
    pageId: idFor(page),
    label: labels.get(page) ?? null,
    url: page.isClosed() ? null : page.url(),
    closed: page.isClosed(),
  };
}

async function resolveFields(fields) {
  const entries = await Promise.all(
    Object.entries(fields).map(async ([key, value]) => [key, await value]),
  );
  return Object.fromEntries(entries);
}

async function safeCount(page, selector) {
  if (page.isClosed() || page.url() === "about:blank") return 0;
  try {
    return await page.locator(selector).count();
  } catch {
    return 0;
  }
}

async function safeText(page, selector) {
  if (page.isClosed() || page.url() === "about:blank") return "";
  try {
    return (await page.locator(selector).first().innerText()).trim();
  } catch {
    return "";
  }
}

async function safeBodyLength(page) {
  if (page.isClosed() || page.url() === "about:blank") return 0;
  try {
    return (await page.locator("body").innerText()).length;
  } catch {
    return 0;
  }
}

function assertProfileAvailable() {
  const lockPath = `${config.paths.browserProfile}.lock`;
  if (fs.existsSync(lockPath)) {
    throw diagnosticError("launch", "browser_profile_locked", {
      lockPath,
    });
  }
}

function diagnosticError(stage, reason, evidence = null) {
  const error = new Error(`${stage}: ${reason}`);
  error.stage = stage;
  error.reason = reason;
  error.evidence = evidence;
  error.exitCode = 2;
  return error;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
