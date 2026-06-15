import {
  getNavigationHistory,
  getOrCreatePage,
  humanDelay,
  launchBrowser,
  trackPageNavigations,
} from "../src/browser.js";
import { detectCircuitCondition } from "../src/boss/greet.js";
import { SELECTORS, URLS } from "../src/boss/selectors.js";

const DETAIL_URL =
  "https://www.zhipin.com/job_detail/5f56501dafbcbdcd0nBz2dm9FltS.html";
const OBSERVE_MS = 8_000;
const MAX_HTML_LENGTH = 30_000;

const context = await launchBrowser();
const page = await getOrCreatePage(context);
trackPageNavigations(page);

const report = {
  verifiedAt: "2026-06-13",
  mode: "patchright logged-in read-only",
  accessBudget: 2,
  accessesUsed: 0,
};

try {
  await navigateAndObserve(page, DETAIL_URL, "detail");
  report.detail = await inspectDetail(page);
  await humanDelay(2_000, 4_000);

  await navigateAndObserve(page, URLS.messages, "messages");
  report.messages = await inspectMessages(page);

  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        stopped: true,
        reason: error.reason ?? error.message,
        url: page.isClosed() ? null : page.url(),
        history: getNavigationHistory(page),
        partialReport: report,
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
} finally {
  await context.close();
}

async function navigateAndObserve(targetPage, url, stage) {
  if (report.accessesUsed >= report.accessBudget) {
    throw new Error("selector verification access budget exhausted");
  }
  report.accessesUsed += 1;
  await targetPage.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  const deadline = Date.now() + OBSERVE_MS;
  while (Date.now() < deadline) {
    const condition = await detectCircuitCondition(targetPage, {
      expectLoggedIn: true,
    });
    if (condition) {
      const error = new Error(
        `${stage} stopped by ${condition.reason}: ${condition.detail}`,
      );
      error.reason = condition.reason;
      throw error;
    }
    await targetPage.waitForTimeout(500);
  }
}

async function inspectDetail(targetPage) {
  const fields = [
    "detailTitle",
    "detailCompany",
    "detailSalary",
    "detailDescription",
    "detailHrName",
  ];
  const counts = await selectorCounts(targetPage, fields);
  const candidates = [
    ".job-banner",
    ".job-banner .name",
    ".job-banner [class*='company']",
    ".job-banner a[href*='/gongsi/']",
    ".job-primary",
    ".job-primary [class*='company']",
    ".company-info",
    ":nth-match(.company-info, 2)",
    "a[ka='job-detail-company']",
  ];

  return {
    url: targetPage.url(),
    history: getNavigationHistory(targetPage),
    counts,
    texts: await selectorTexts(targetPage, fields),
    candidates: await inspectCandidates(targetPage, candidates),
    companyInfoElements: await targetPage
      .locator(".company-info")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          text: element.textContent?.trim().replace(/\s+/g, " "),
          outerHTML: element.outerHTML.slice(0, 5_000),
          parentTagName: element.parentElement?.tagName.toLowerCase(),
          parentClassName: element.parentElement?.className,
        })),
      ),
    bannerOuterHTML: await firstOuterHTML(targetPage, [
      ".job-banner",
      ".job-primary",
      "body",
    ]),
  };
}

async function inspectMessages(targetPage) {
  const fields = [
    "inboxConversation",
    "inboxUnread",
    "inboxHrName",
    "inboxLastMessage",
    "inboxJobTitle",
    "inboxConversationLink",
  ];
  const candidateSelectors = [
    ".chat-container",
    ".chat-wrapper",
    ".chat-list",
    ".chat-list-wrap",
    ".chat-user-list",
    ".user-list",
    ".conversation-list",
    ".message-list",
    ".user-list-content > ul[role='group'] > li[role='listitem']",
    ".title-box .name-box .name-text",
    ".last-msg .last-msg-text",
    "[class*='chat-list']",
    "[class*='conversation']",
    "[class*='user-list']",
    "[class*='message-list']",
    "[class*='unread']",
    "[class*='badge']",
  ];

  const bodyText = await targetPage.locator("body").innerText();
  const relevantElements = await targetPage.locator("body").evaluate(() => {
    const matcher =
      /chat|message|conversation|contact|session|user-list|unread|badge|job|position/i;
    return [...document.querySelectorAll("body *")]
      .filter((element) => {
        const className =
          typeof element.className === "string" ? element.className : "";
        return (
          matcher.test(className) ||
          matcher.test(element.id) ||
          matcher.test(element.getAttribute("href") ?? "")
        );
      })
      .slice(0, 250)
      .map((element) => ({
        tagName: element.tagName.toLowerCase(),
        id: element.id,
        className:
          typeof element.className === "string" ? element.className : "",
        href: element.getAttribute("href"),
        data: Object.fromEntries(
          [...element.attributes]
            .filter((attribute) => attribute.name.startsWith("data-"))
            .slice(0, 8)
            .map((attribute) => [attribute.name, attribute.value]),
        ),
        text: element.textContent?.trim().replace(/\s+/g, " ").slice(0, 300),
        childCount: element.children.length,
      }));
  });
  const iframes = await targetPage.locator("iframe").evaluateAll((elements) =>
    elements.map((element) => ({
      src: element.getAttribute("src"),
      title: element.getAttribute("title"),
      className: element.className,
    })),
  );

  const result = {
    url: targetPage.url(),
    history: getNavigationHistory(targetPage),
    counts: await selectorCounts(targetPage, fields),
    texts: await selectorTexts(targetPage, fields),
    bodyLength: bodyText.length,
    bodyText: bodyText.slice(0, 5_000),
    candidateSelectors: await inspectCandidates(
      targetPage,
      candidateSelectors,
    ),
    relevantElements,
    iframes,
    listOuterHTML: await firstOuterHTML(targetPage, [
      ".chat-container",
      ".chat-wrapper",
      "[class*='chat-list']",
      "[class*='conversation']",
      "[class*='user-list']",
      "#wrap",
      "body",
    ]),
  };
  result.note =
    result.counts.inboxConversation > 0
      ? "登录态可达，存在会话；未读/岗位标题/会话链接以当前账号实际 DOM 为准"
      : "登录态可达，当前无会话或选择器未识别到会话";
  return result;
}

async function selectorCounts(targetPage, fields) {
  return Object.fromEntries(
    await Promise.all(
      fields.map(async (field) => [
        field,
        await targetPage.locator(SELECTORS[field]).count(),
      ]),
    ),
  );
}

async function selectorTexts(targetPage, fields) {
  return Object.fromEntries(
    await Promise.all(
      fields.map(async (field) => [
        field,
        await targetPage
          .locator(SELECTORS[field])
          .evaluateAll((elements) =>
            elements
              .slice(0, 5)
              .map((element) =>
                element.textContent?.trim().replace(/\s+/g, " ").slice(0, 300),
              ),
          ),
      ]),
    ),
  );
}

async function inspectCandidates(targetPage, selectors) {
  const candidates = [];
  for (const selector of selectors) {
    const locator = targetPage.locator(selector);
    candidates.push({
      selector,
      count: await locator.count(),
      texts: await locator.evaluateAll((elements) =>
        elements
          .slice(0, 5)
          .map((element) =>
            element.textContent?.trim().replace(/\s+/g, " ").slice(0, 300),
          ),
      ),
    });
  }
  return candidates;
}

async function firstOuterHTML(targetPage, selectors) {
  for (const selector of selectors) {
    const locator = targetPage.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    const html = await locator.evaluate((element) => element.outerHTML);
    return {
      selector,
      truncated: html.length > MAX_HTML_LENGTH,
      html: html.slice(0, MAX_HTML_LENGTH),
    };
  }
  return { selector: null, truncated: false, html: "" };
}
