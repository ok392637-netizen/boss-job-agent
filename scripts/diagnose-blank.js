import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { config } from "../src/config.js";
import { humanDelay, launchBrowser } from "../src/browser.js";
import { detectCircuitCondition } from "../src/boss/greet.js";
import { SELECTORS, URLS } from "../src/boss/selectors.js";

const SEARCH_URL = URLS.search({
  city: "101280100",
  query: "AI Agent",
});
const DETAIL_WAIT_MS = 6_000;
const MESSAGE_WAIT_MS = 15_000;
const SAMPLE_INTERVAL_MS = 250;
const PATCHRIGHT_DIRECTORY = path.join(
  config.paths.projectRoot,
  "data",
  "diagnostics",
  "patchright-runtime",
);
const LOG_DIRECTORY = path.join(config.paths.projectRoot, "data", "logs");

fs.mkdirSync(LOG_DIRECTORY, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  safety: {
    readOnly: true,
    forbiddenSelectors: [
      SELECTORS.startChatButton,
      SELECTORS.chatEditor,
      SELECTORS.sendMessageButton,
    ],
  },
  stage1: null,
  stage1Decision: null,
  stage2: null,
  conclusion: null,
};

let nativeContext;
try {
  const nativeRecorder = createRecorder("native-playwright");
  nativeContext = await launchBrowser();
  nativeRecorder.attachContext(nativeContext);
  report.stage1 = await runNativeStage(nativeContext, nativeRecorder);
  await nativeContext.close();
  nativeContext = null;

  report.stage1Decision = decideStage1(report.stage1);
  if (report.stage1Decision.runPatchright) {
    report.stage2 = await runPatchrightStage(
      report.stage1.detailUrl,
      report.stage1Decision,
    );
  } else {
    report.stage2 = {
      skipped: true,
      reason: report.stage1Decision.reason,
    };
  }
  report.conclusion = decideConclusion(
    report.stage1Decision,
    report.stage2,
  );
} catch (error) {
  report.stopped = true;
  report.stopReason = error.reason ?? error.message;
  report.stopStage = error.stage ?? null;
  report.stopEvidence = error.evidence ?? null;
  report.conclusion = {
    hypothesis: "UNRESOLVED",
    reason: "诊断因安全条件或运行错误提前停止",
  };
  process.exitCode = error.exitCode ?? 2;
} finally {
  if (nativeContext) {
    await nativeContext.close().catch(() => {});
  }
  report.completedAt = new Date().toISOString();
  const timestamp = report.completedAt.replace(/[:.]/g, "-");
  const logPath = path.join(
    LOG_DIRECTORY,
    `diagnose-blank-${timestamp}.json`,
  );
  fs.writeFileSync(logPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  report.logPath = logPath;
  console.log(JSON.stringify(report, null, 2));
}

async function runNativeStage(context, recorder) {
  const sentinel = context.pages()[0] ?? (await context.newPage());
  recorder.labelPage(sentinel, "sentinel");
  await sentinel.goto("data:text/html,<title>diagnostic-sentinel</title>");

  const page = await context.newPage();
  recorder.labelPage(page, "primary");
  const result = {
    accessCount: 0,
    baseline: null,
    detailUrl: null,
    detailGoto: null,
    detailClick: null,
    messages: null,
    events: recorder.events,
  };
  report.stage1 = result;

  await navigate(page, SEARCH_URL, "stage1.search-baseline");
  result.accessCount += 1;
  result.detailUrl = await waitForHrefOrStop(
    context,
    page,
    SELECTORS.jobCardLink,
    12_000,
    "stage1.search-baseline",
  );
  await humanDelay(1_500, 3_000);

  result.baseline = snapshotContext(context, recorder);
  if (!result.detailUrl) {
    throw diagnosticError(
      "stage1.search-baseline",
      "no_detail_url",
      result.baseline,
    );
  }
  result.detailUrl = new URL(result.detailUrl, SEARCH_URL).href;

  const directPage = await ensurePage(
    context,
    recorder,
    page,
    "detail-goto-source",
  );
  const beforeGoto = snapshotContext(context, recorder);
  await navigate(directPage, result.detailUrl, "stage1.detail-goto");
  result.accessCount += 1;
  const gotoObservation = await observePages(
    context,
    recorder,
    DETAIL_WAIT_MS,
    "stage1.detail-goto",
  );
  result.detailGoto = summarizeStep(
    "detail-goto",
    beforeGoto,
    gotoObservation,
    directPage,
    context,
    recorder,
  );
  await humanDelay(1_500, 3_000);

  const clickSource = await ensurePage(context, recorder, page, "click-source");
  await navigate(clickSource, SEARCH_URL, "stage1.search-before-click");
  result.accessCount += 1;
  await waitForHrefOrStop(
    context,
    clickSource,
    SELECTORS.jobCardLink,
    12_000,
    "stage1.search-before-click",
  );
  await humanDelay(1_500, 3_000);

  const beforeClick = snapshotContext(context, recorder);
  const newPagePromise = context
    .waitForEvent("page", { timeout: 8_000 })
    .catch(() => null);
  await clickSource.locator(SELECTORS.jobCardLink).first().click({
    noWaitAfter: true,
  });
  result.accessCount += 1;
  const clickObservationPromise = observePages(
    context,
    recorder,
    DETAIL_WAIT_MS,
    "stage1.detail-click",
  );
  const openedPage = await newPagePromise;
  if (openedPage) {
    recorder.labelPage(openedPage, "detail-popup");
  }
  const clickObservation = await clickObservationPromise;
  result.detailClick = summarizeStep(
    "detail-click",
    beforeClick,
    clickObservation,
    clickSource,
    context,
    recorder,
    openedPage,
  );
  await humanDelay(1_500, 3_000);

  const messageSource = chooseReadablePage(
    context,
    [openedPage, clickSource, page],
  );
  const beforeMessages = snapshotContext(context, recorder);
  let usedNavigation = "goto";
  let messageOpenedPage = null;

  if (messageSource) {
    const messageLink = messageSource
      .locator(
        "#header a[ka='header-message'], #header a[href*='/web/geek/chat']",
      )
      .first();
    if ((await messageLink.count()) > 0) {
      usedNavigation = "header-click";
      const messagePagePromise = context
        .waitForEvent("page", { timeout: 8_000 })
        .catch(() => null);
      await messageLink.click({ noWaitAfter: true });
      result.accessCount += 1;
      const messagesObservationPromise = observePages(
        context,
        recorder,
        MESSAGE_WAIT_MS,
        "stage1.messages",
      );
      messageOpenedPage = await messagePagePromise;
      if (messageOpenedPage) {
        recorder.labelPage(messageOpenedPage, "messages-popup");
      }
      result.messages = {
        ...summarizeStep(
          "messages",
          beforeMessages,
          await messagesObservationPromise,
          messageOpenedPage ?? messageSource,
          context,
          recorder,
          messageOpenedPage,
        ),
        usedNavigation,
      };
    }
  }

  let effectiveMessageSource = messageOpenedPage ?? messageSource;
  if (usedNavigation === "goto") {
    effectiveMessageSource = await ensurePage(
      context,
      recorder,
      effectiveMessageSource,
      "messages-source",
    );
    await navigate(
      effectiveMessageSource,
      URLS.messages,
      "stage1.messages-goto",
    );
    result.accessCount += 1;
    const messagesObservation = await observePages(
      context,
      recorder,
      MESSAGE_WAIT_MS,
      "stage1.messages",
    );
    result.messages = {
      ...summarizeStep(
        "messages",
        beforeMessages,
        messagesObservation,
        effectiveMessageSource,
        context,
        recorder,
        messageOpenedPage,
      ),
      usedNavigation,
    };
  }
  return result;
}

async function runPatchrightStage(detailUrl, stage1Decision) {
  const install = installPatchright();
  if (!install.ok) {
    return {
      triggeredBy: stage1Decision,
      install,
      skippedComparison: true,
    };
  }
  const requireFromRuntime = createRequire(
    path.join(PATCHRIGHT_DIRECTORY, "package.json"),
  );
  const { chromium } = requireFromRuntime("patchright");
  const recorder = createRecorder("patchright");

  const context = await chromium.launchPersistentContext(
    config.paths.browserProfile,
    {
      headless: false,
      viewport: null,
      channel: "chrome",
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
      ],
    },
  );
  recorder.attachContext(context);
  const sentinel = context.pages()[0] ?? (await context.newPage());
  recorder.labelPage(sentinel, "patchright-sentinel");
  await sentinel.goto("data:text/html,<title>patchright-sentinel</title>");

  const result = {
    triggeredBy: stage1Decision,
    install,
    accessCount: 0,
    detailGoto: null,
    messagesGoto: null,
    events: recorder.events,
  };

  try {
    const page = await context.newPage();
    recorder.labelPage(page, "patchright-primary");
    const beforeDetail = snapshotContext(context, recorder);
    await navigate(page, detailUrl, "stage2.detail-goto");
    result.accessCount += 1;
    const detailObservation = await observePages(
      context,
      recorder,
      DETAIL_WAIT_MS,
      "stage2.detail-goto",
    );
    result.detailGoto = summarizeStep(
      "patchright-detail-goto",
      beforeDetail,
      detailObservation,
      page,
      context,
      recorder,
    );
    await humanDelay(1_500, 3_000);

    const messagePage = await ensurePage(
      context,
      recorder,
      page,
      "patchright-messages",
    );
    const beforeMessages = snapshotContext(context, recorder);
    await navigate(messagePage, URLS.messages, "stage2.messages-goto");
    result.accessCount += 1;
    const messagesObservation = await observePages(
      context,
      recorder,
      MESSAGE_WAIT_MS,
      "stage2.messages-goto",
    );
    result.messagesGoto = summarizeStep(
      "patchright-messages-goto",
      beforeMessages,
      messagesObservation,
      messagePage,
      context,
      recorder,
    );
    return result;
  } finally {
    await context.close().catch(() => {});
  }
}

function createRecorder(engine) {
  const startedAt = Date.now();
  const events = [];
  const pageIds = new WeakMap();
  const pageLabels = new WeakMap();
  const attachedPages = new WeakSet();
  let nextPageId = 1;

  const record = (type, detail = {}) => {
    events.push({
      tMs: Date.now() - startedAt,
      at: new Date().toISOString(),
      engine,
      type,
      ...detail,
    });
  };

  const idFor = (page) => {
    if (!pageIds.has(page)) {
      pageIds.set(page, `page-${nextPageId++}`);
    }
    return pageIds.get(page);
  };

  const describePage = (page) => ({
    pageId: idFor(page),
    label: pageLabels.get(page) ?? null,
    url: page.isClosed() ? null : page.url(),
    closed: page.isClosed(),
  });

  const attachPage = (page) => {
    if (attachedPages.has(page)) return;
    attachedPages.add(page);
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
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        record("navigation-request", {
          ...describePage(page),
          method: request.method(),
          requestUrl: request.url(),
        });
      }
    });
    page.on("response", (response) => {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        record("navigation-response", {
          ...describePage(page),
          status: response.status(),
          responseUrl: response.url(),
        });
      }
    });
    page.on("requestfailed", (request) => {
      if (request.isNavigationRequest()) {
        record("navigation-request-failed", {
          ...describePage(page),
          requestUrl: request.url(),
          failure: request.failure()?.errorText ?? null,
        });
      }
    });
    page.on("pageerror", (error) =>
      record("page-error", {
        ...describePage(page),
        message: error.message,
      }),
    );
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        record("console", {
          ...describePage(page),
          level: message.type(),
          text: message.text().slice(0, 1_000),
        });
      }
    });
  };

  return {
    events,
    attachContext(context) {
      record("context-attached", { pageCount: context.pages().length });
      for (const page of context.pages()) attachPage(page);
      context.on("page", (page) => {
        record("context-new-page", {
          ...describePage(page),
          pageCount: context.pages().length,
        });
        attachPage(page);
      });
      context.on("close", () => record("context-closed"));
    },
    labelPage(page, label) {
      pageLabels.set(page, label);
      record("page-labeled", { ...describePage(page), label });
    },
    describePage,
  };
}

async function navigate(page, url, stage) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  } catch (error) {
    if (page.isClosed()) {
      throw diagnosticError(stage, "page_closed_during_navigation", {
        url,
        message: error.message,
      });
    }
    throw error;
  }
  await stopOnSecurity([page], stage);
}

async function waitForHrefOrStop(
  context,
  page,
  selector,
  timeoutMs,
  stage,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await stopOnSecurity(context.pages(), stage);
    if (!page.isClosed()) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0) {
        return locator.evaluate((element) => element.href);
      }
    }
    await sleep(250);
  }
  throw diagnosticError(stage, "selector_timeout", {
    selector,
    pageUrl: page.isClosed() ? null : page.url(),
  });
}

async function observePages(context, recorder, durationMs, stage) {
  const startedAt = Date.now();
  const snapshots = [];
  let lastSignature = "";
  let firstBlankAtMs = null;
  let firstPageIncreaseAtMs = null;
  const initialCount = externalPages(context).length;

  while (Date.now() - startedAt < durationMs) {
    const pages = context.pages();
    await stopOnSecurity(pages, stage);
    const snapshot = {
      elapsedMs: Date.now() - startedAt,
      externalPageCount: externalPages(context).length,
      pages: await Promise.all(
        pages.map(async (page) => ({
          ...recorder.describePage(page),
          detailTitleCount: page.isClosed()
            ? 0
            : await safeCount(page, SELECTORS.detailTitle),
          messageNavCount: page.isClosed()
            ? 0
            : await safeCount(
                page,
                "#header a[ka='header-message'], #header a[href*='/web/geek/chat']",
              ),
          bodyLength: page.isClosed() ? 0 : await safeBodyLength(page),
        })),
      ),
    };
    const signature = JSON.stringify(snapshot.pages);
    if (signature !== lastSignature) {
      snapshots.push(snapshot);
      lastSignature = signature;
    }
    if (
      firstBlankAtMs === null &&
      snapshot.pages.some((page) => page.url === "about:blank")
    ) {
      firstBlankAtMs = snapshot.elapsedMs;
    }
    if (
      firstPageIncreaseAtMs === null &&
      snapshot.externalPageCount > initialCount
    ) {
      firstPageIncreaseAtMs = snapshot.elapsedMs;
    }
    await sleep(SAMPLE_INTERVAL_MS);
  }

  return {
    durationMs: Date.now() - startedAt,
    firstBlankAtMs,
    firstPageIncreaseAtMs,
    snapshots,
    final: snapshotContext(context, recorder),
  };
}

async function stopOnSecurity(pages, stage) {
  for (const page of pages) {
    if (page.isClosed() || page.url().startsWith("data:")) continue;
    const condition = await detectCircuitCondition(page, {
      expectLoggedIn: true,
    });
    if (!condition) continue;
    throw diagnosticError(stage, condition.reason, {
      pageUrl: page.url(),
      detail: condition.detail,
    });
  }
}

function snapshotContext(context, recorder) {
  return {
    totalPageCount: context.pages().length,
    externalPageCount: externalPages(context).length,
    pages: context.pages().map(recorder.describePage),
  };
}

function summarizeStep(
  name,
  before,
  observation,
  sourcePage,
  context,
  recorder,
  openedPage = null,
) {
  const final = snapshotContext(context, recorder);
  return {
    name,
    before,
    after: final,
    pageCountDelta: final.externalPageCount - before.externalPageCount,
    sourcePage: sourcePage
      ? recorder.describePage(sourcePage)
      : null,
    openedPage: openedPage
      ? recorder.describePage(openedPage)
      : null,
    sourceBecameBlank:
      Boolean(sourcePage) &&
      !sourcePage.isClosed() &&
      sourcePage.url() === "about:blank",
    sourceClosed: Boolean(sourcePage?.isClosed()),
    openedPageHasDetail:
      Boolean(openedPage) &&
      !openedPage.isClosed() &&
      observation.snapshots.some((snapshot) =>
        snapshot.pages.some(
          (page) =>
            page.pageId === recorder.describePage(openedPage).pageId &&
            page.detailTitleCount > 0,
        ),
      ),
    anyPageHasDetail: observation.snapshots.some((snapshot) =>
      snapshot.pages.some((page) => page.detailTitleCount > 0),
    ),
    firstBlankAtMs: observation.firstBlankAtMs,
    firstPageIncreaseAtMs: observation.firstPageIncreaseAtMs,
    timeline: observation.snapshots,
  };
}

function decideStage1(stage1) {
  const click = stage1.detailClick;
  const direct = stage1.detailGoto;
  const messages = stage1.messages;
  const functionalPopup =
    click.pageCountDelta > 0 &&
    click.openedPage &&
    click.openedPageHasDetail;

  if (functionalPopup) {
    return {
      hypothesis: "H2",
      runPatchright: false,
      reason:
        "点击详情创建了可读取详情内容的新 page；应捕获 context page/popup，而不是继续盯旧 page。",
      evidence: {
        detailClickPageCountDelta: click.pageCountDelta,
        openedPage: click.openedPage,
        sourceBecameBlank: click.sourceBecameBlank,
      },
    };
  }

  const currentRedirected =
    direct.sourceBecameBlank ||
    click.sourceBecameBlank ||
    messages.sourceBecameBlank;
  if (currentRedirected) {
    return {
      hypothesis: "H1_OR_H3",
      runPatchright: true,
      reason:
        "未观察到可用详情新标签，且当前 page 自身导航到 about:blank；需要 patchright 对照区分 CDP 泄露与站点/会话逻辑。",
      evidence: {
        direct,
        click,
        messages,
      },
    };
  }

  return {
    hypothesis: "H3",
    runPatchright: false,
    reason:
      "没有可用新标签，也没有明确的当前页 about:blank 导航；更像页面关闭、上下文退出或其他站点行为。",
    evidence: {
      direct,
      click,
      messages,
    },
  };
}

function decideConclusion(stage1Decision, stage2) {
  if (stage1Decision.hypothesis === "H2") {
    return {
      hypothesis: "H2",
      evidence: stage1Decision.evidence,
      recommendation:
        "保留原生 Playwright，业务层通过 context.on('page') / page.waitForEvent('popup') 捕获并切换到新标签。",
    };
  }

  if (!stage1Decision.runPatchright) {
    return {
      hypothesis: stage1Decision.hypothesis,
      evidence: stage1Decision.evidence,
      recommendation:
        "根据事件日志进一步检查 page close/context close/站点路由，不应直接归因于 CDP。",
    };
  }

  if (stage2?.install?.ok !== true) {
    return {
      hypothesis: "H1_OR_H3",
      evidence: {
        stage1: stage1Decision.evidence,
        patchrightInstall: stage2?.install ?? null,
      },
      recommendation:
        "patchright 未能完成本地准备，CDP 泄露与站点逻辑仍未区分。",
    };
  }

  const nativeBlank =
    stage1Decision.evidence.direct.sourceBecameBlank ||
    stage1Decision.evidence.messages.sourceBecameBlank;
  const patchrightDetailWorks =
    stage2.detailGoto?.anyPageHasDetail &&
    !stage2.detailGoto?.sourceBecameBlank;
  const patchrightMessagesStable =
    !stage2.messagesGoto?.sourceBecameBlank &&
    !stage2.messagesGoto?.sourceClosed;

  if (nativeBlank && patchrightDetailWorks && patchrightMessagesStable) {
    return {
      hypothesis: "H1",
      evidence: {
        native: stage1Decision.evidence,
        patchright: {
          detailGoto: stage2.detailGoto,
          messagesGoto: stage2.messagesGoto,
        },
      },
      recommendation:
        "patchright 消除了原生 Playwright 下的 blank，建议将浏览器实现切换为 patchright drop-in。",
    };
  }

  return {
    hypothesis: "H3",
    evidence: {
      native: stage1Decision.evidence,
      patchright: {
        detailGoto: stage2.detailGoto,
        messagesGoto: stage2.messagesGoto,
      },
    },
    recommendation:
      "patchright 下仍出现 blank 或消息页异常，不能归因于 Runtime.enable/CDP 泄露；应按站点路由、账号会话或页面脚本行为继续排查。",
  };
}

function installPatchright() {
  fs.mkdirSync(PATCHRIGHT_DIRECTORY, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const commands = [
    {
      command: npm,
      args: [
        "install",
        "--prefix",
        PATCHRIGHT_DIRECTORY,
        "--no-save",
        "patchright",
      ],
    },
    {
      command: npx,
      args: [
        "--prefix",
        PATCHRIGHT_DIRECTORY,
        "patchright",
        "install",
        "chrome",
      ],
    },
  ];
  const output = [];
  try {
    for (const entry of commands) {
      output.push(
        execFileSync(entry.command, entry.args, {
          cwd: config.paths.projectRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10 * 60_000,
        }),
      );
    }
    return { ok: true, commands, output };
  } catch (error) {
    return {
      ok: false,
      commands,
      output,
      error: error.message,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

async function ensurePage(context, recorder, preferred, label) {
  if (preferred && !preferred.isClosed()) return preferred;
  const candidate = externalPages(context).find((page) => !page.isClosed());
  if (candidate) return candidate;
  const page = await context.newPage();
  recorder.labelPage(page, label);
  return page;
}

function chooseReadablePage(context, preferredPages) {
  for (const page of preferredPages) {
    if (
      page &&
      !page.isClosed() &&
      page.url() !== "about:blank" &&
      !page.url().startsWith("data:")
    ) {
      return page;
    }
  }
  return externalPages(context).find(
    (page) =>
      !page.isClosed() &&
      page.url() !== "about:blank",
  ) ?? null;
}

function externalPages(context) {
  return context.pages().filter((page) => !page.url().startsWith("data:"));
}

async function safeCount(page, selector) {
  try {
    return await page.locator(selector).count();
  } catch {
    return 0;
  }
}

async function safeBodyLength(page) {
  if (page.url() === "about:blank") return 0;
  try {
    return (await page.locator("body").innerText({ timeout: 500 })).length;
  } catch {
    return 0;
  }
}

function diagnosticError(stage, reason, evidence) {
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
