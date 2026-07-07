import fs from "node:fs";
import path from "node:path";
import { getOrCreatePage, humanDelay, launchBrowser } from "../src/browser.js";
import { PROJECT_ROOT } from "../src/config.js";
import { deleteMeta, openDatabase } from "../src/db.js";
import { assertPageSafe } from "../src/boss/greet.js";
import {
  ensureLoggedIn,
  waitForSecurityCheckRecovery,
} from "../src/boss/login.js";
import { SELECTORS, URLS } from "../src/boss/selectors.js";
import { notifyText } from "../src/notify.js";

const logPath = path.join(
  PROJECT_ROOT,
  "data",
  "logs",
  `verify-chat-dom-${timestampForFile()}.log`,
);
fs.mkdirSync(path.dirname(logPath), { recursive: true });

const lines = [];
const db = openDatabase();
const context = await launchBrowser({ headless: false });

try {
  const page = await getOrCreatePage(context);
  log(`startedAt=${new Date().toISOString()}`);
  log(`target=${URLS.messages}`);

  await page.goto(URLS.messages, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await assertSafeOrRecover(page);
  await humanDelay(3_000, 5_000);
  await waitForConversationRender(page);

  const conversationDump = await dumpConversations(page);
  logSection("conversation-selector-counts", conversationDump.counts);
  logSection("conversation-candidate-samples", conversationDump.candidateSamples);
  logSection("conversation-items", conversationDump.items);

  if (conversationDump.items.length > 0) {
    await page.locator(conversationDump.itemSelector).first().click();
    await humanDelay(2_500, 4_500);
    await assertSafeOrRecover(page);
    await humanDelay(1_000, 2_000);
    log(`afterClickUrl=${page.url()}`);
    logSection("open-chat-url-parts", parseUrlParts(page.url()));
    logSection("chat-header-selector-counts", await selectorCounts(page, chatHeaderSelectors()));
    logSection(
      "chat-header-candidate-samples",
      await candidateSamples(page, chatHeaderSelectors(), 5, 1_200),
    );
    logSection("selected-conversation", await dumpSelectedConversation(page));
    const messages = await dumpMessages(page);
    logSection("message-selector-counts", messages.counts);
    logSection("message-candidates", messages.items);
  } else {
    log("no conversations detected by existing inbox selector");
  }
} catch (error) {
  logSection("error", {
    name: error.name,
    message: error.message,
    reason: error.reason,
    code: error.code,
    stack: error.stack,
  });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  console.log(logPath);
  await context.close();
  db.close();
}

function parseUrlParts(url) {
  try {
    const parsed = new URL(url);
    return {
      href: parsed.href,
      pathname: parsed.pathname,
      searchParams: Object.fromEntries(parsed.searchParams.entries()),
    };
  } catch {
    return { href: url };
  }
}

function chatHeaderSelectors() {
  return [
    ".chat-container .title",
    ".chat-container .chat-title",
    ".chat-container .boss-name",
    ".chat-container .job-name",
    ".chat-container .source-job",
    ".chat-container .position-name",
    ".chat-panel .title",
    ".chat-panel .chat-title",
    ".chat-panel .boss-name",
    ".chat-panel .job-name",
    ".chat-panel .source-job",
    ".chat-panel .position-name",
    ".chat-content .title",
    ".chat-content .chat-title",
    ".chat-content .boss-name",
    ".chat-content .job-name",
    ".chat-content .source-job",
    ".chat-content .position-name",
    "[class*='chat'] [class*='title']",
    "[class*='chat'] [class*='job']",
    "[class*='chat'] [class*='company']",
    "[class*='chat'] [class*='boss']",
    "[class*='chat'] [class*='position']",
  ];
}

async function assertSafeOrRecover(page) {
  try {
    await assertPageSafe(page, {
      db,
      notifyFn: notifyText,
      expectLoggedIn: true,
    });
    return;
  } catch (error) {
    if (error.reason === "login_lost") {
      await ensureLoggedIn(page, { notifyFn: notifyText });
      deleteMeta(db, "circuit_open");
    } else if (
      error.reason === "verification_url" ||
      error.reason === "verification_iframe" ||
      error.reason === "verification_text"
    ) {
      await waitForSecurityCheckRecovery(page, { notifyFn: notifyText });
      deleteMeta(db, "circuit_open");
    } else {
      throw error;
    }

    await page.goto(URLS.messages, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await assertPageSafe(page, {
      db,
      notifyFn: notifyText,
      expectLoggedIn: true,
    });
  }
}

async function waitForConversationRender(page) {
  await page
    .locator(SELECTORS.inboxConversation)
    .first()
    .waitFor({ state: "visible", timeout: 12_000 })
    .catch(() => {});
}

async function dumpConversations(page) {
  const candidateSelectors = [
    SELECTORS.inboxConversation,
    ".user-list-content li[role='listitem']",
    ".user-list-content li",
    "[class*='user-list'] li",
    "[class*='chat'] li",
    "[class*='conversation']",
    "[class*='friend']",
  ];
  const itemSelector = await firstSelectorWithItems(page, candidateSelectors);
  return {
    counts: await selectorCounts(page, candidateSelectors),
    itemSelector,
    candidateSamples: await candidateSamples(page, candidateSelectors, 5, 500),
    items: itemSelector
      ? await page
      .locator(itemSelector)
      .evaluateAll((elements, selectors) =>
        elements.slice(0, 3).map((element, index) => {
          const classNameOf = (node) =>
            typeof node.className === "string" ? node.className : "";
          const text = (selector) =>
            element.querySelector(selector)?.textContent?.trim() ?? "";
          const link = element.querySelector(selectors.inboxConversationLink);
          return {
            index,
            tagName: element.tagName.toLowerCase(),
            className: classNameOf(element),
            dataset: { ...element.dataset },
            href: link?.getAttribute("href") ?? null,
            hrName: text(selectors.inboxHrName),
            jobTitle: text(selectors.inboxJobTitle),
            lastMsg: text(selectors.inboxLastMessage),
            hasUnread: Boolean(element.querySelector(selectors.inboxUnread)),
            outerHTML: element.outerHTML.slice(0, 2_000),
          };
        }),
        SELECTORS,
      )
      : [],
  };
}

async function dumpMessages(page) {
  const candidateSelectors = [
    "li.message-item",
    ".chat-message",
    ".message-content",
    ".message-item",
    ".item-content",
    ".chat-message-item",
    ".message-list [class*='item']",
    "[class*='message']",
    "[class*='chat-record']",
    "[class*='bubble']",
    "[class*='system']",
  ];
  return {
    counts: await selectorCounts(page, candidateSelectors),
    items: await page.evaluate((selectors) => {
      const classNameOf = (node) =>
        typeof node.className === "string" ? node.className : "";
      const normalizeText = (value) => (value ?? "").replace(/\s+/g, " ").trim();
      const candidates = [
        ...document.querySelectorAll(
          "li.message-item, .chat-message, .message-content, .message-item, .item-content, .chat-message-item, .message-list [class*='item'], [class*='message'], [class*='chat-record'], [class*='bubble'], [class*='system']",
        ),
      ];
      const useful = candidates
        .filter((element) => element.textContent?.trim())
        .slice(-20)
        .map((element, index) => ({
          index,
          tagName: element.tagName.toLowerCase(),
          className: classNameOf(element),
          mineByClass:
            /mine|self|right|me|geek|sender|from-me/i.test(classNameOf(element)) ||
            Boolean(element.closest(selectors.chatMsgMine ?? "__missing__")),
          systemByClass:
            /system|notice|card|tip/i.test(classNameOf(element)) ||
            Boolean(element.closest(selectors.chatMsgSystem ?? "__missing__")),
          mid: element.getAttribute("data-mid"),
          text: normalizeText(element.textContent).slice(0, 160),
          outerHTML: element.outerHTML.slice(0, 1_200),
        }));
      return useful;
    }, SELECTORS),
  };
}

async function dumpSelectedConversation(page) {
  return page.evaluate(() => {
    const selected = [
      ...document.querySelectorAll(
        ".user-list-content > ul[role='group'] > li[role='listitem']",
      ),
    ].filter(
      (element) =>
        element.classList.contains("selected") ||
        element.querySelector(".friend-content-warp.selected, .friend-content.selected"),
    );
    return selected.slice(0, 3).map((element, index) => ({
      index,
      className: typeof element.className === "string" ? element.className : "",
      dataset: { ...element.dataset },
      text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 300),
      outerHTML: element.outerHTML.slice(0, 2_000),
    }));
  });
}

async function selectorCounts(page, selectors) {
  const counts = {};
  for (const selector of selectors) {
    counts[selector] = await page.locator(selector).count().catch(() => -1);
  }
  return counts;
}

async function firstSelectorWithItems(page, selectors) {
  for (const selector of selectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) return selector;
  }
  return null;
}

async function candidateSamples(page, selectors, maxItems, maxHtmlLength) {
  const samples = {};
  for (const selector of selectors) {
    samples[selector] = await page
      .locator(selector)
      .evaluateAll(
        (elements, { maxItems, maxHtmlLength }) =>
          elements.slice(0, maxItems).map((element, index) => ({
            index,
            tagName: element.tagName.toLowerCase(),
            className:
              typeof element.className === "string" ? element.className : "",
            text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 200),
            outerHTML: element.outerHTML.slice(0, maxHtmlLength),
          })),
        { maxItems, maxHtmlLength },
      )
      .catch((error) => [{ error: error.message }]);
  }
  return samples;
}

function log(line) {
  lines.push(line);
}

function logSection(title, value) {
  lines.push(`\n## ${title}`);
  lines.push(JSON.stringify(value, null, 2));
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
