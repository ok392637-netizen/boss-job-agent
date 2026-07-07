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

const MAX_HTML_LENGTH = 4_000;
const logPath = path.join(
  PROJECT_ROOT,
  "data",
  "logs",
  `verify-chat-resume-dom-${timestampForFile()}.log`,
);

fs.mkdirSync(path.dirname(logPath), { recursive: true });

const lines = [];
const db = openDatabase();
let context;

try {
  context = await launchBrowser({ headless: false });
  const page = await getOrCreatePage(context);

  log(`startedAt=${new Date().toISOString()}`);
  log("safety=readonly");
  log("safety_detail=no 同意/确认发送/发送 click; no file selected; opened panels are closed/cancelled only");
  const requestedConversationIndex = parseOptionalInteger(
    process.env.CHAT_RESUME_CONVERSATION_INDEX,
  );
  const dumpOnly = process.env.CHAT_RESUME_DUMP_ONLY === "1";
  log(`target=${URLS.messages}`);
  log(`options=${JSON.stringify({ requestedConversationIndex, dumpOnly })}`);

  await page.goto(URLS.messages, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await assertSafeOrRecover(page);
  await humanDelay(3_000, 5_000);
  await waitForConversationRender(page);

  const conversations = await dumpConversations(page);
  logSection("conversation-selector-counts", conversations.counts);
  logSection("conversation-candidates", conversations.items);

  const chosen = chooseConversation(conversations.items, requestedConversationIndex);
  logSection("chosen-conversation", chosen ?? { found: false });
  if (!chosen) {
    throw new Error("No chat conversations found");
  }

  await page.locator(conversations.itemSelector).nth(chosen.index).click();
  await humanDelay(3_000, 5_000);
  await assertSafeOrRecover(page);
  await humanDelay(1_000, 2_000);

  log(`afterClickUrl=${page.url()}`);
  logSection("open-chat-url-parts", parseUrlParts(page.url()));
  logSection("selected-conversation", await dumpSelectedConversation(page));
  logSection("resume-request-cards", await dumpResumeRequestCards(page));
  logSection("chat-toolbar-summary", await dumpToolbar(page));
  logSection("chat-toolbar-selector-counts", await selectorCounts(page, toolbarSelectors()));
  logSection(
    "chat-toolbar-samples",
    await candidateSamples(page, toolbarSelectors(), 10, MAX_HTML_LENGTH),
  );

  if (dumpOnly) {
    logSection("resume-panel-open-skipped", {
      reason: "CHAT_RESUME_DUMP_ONLY=1",
    });
  } else {
    await runOptionalDump("resume-panel", () => dumpResumePanelByOpeningCandidate(page));
  }
} catch (error) {
  logSection("error", serializeError(error));
  process.exitCode = error.code === "BROWSER_BUSY" ? 75 : 1;
} finally {
  fs.writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  console.log(logPath);
  if (context) {
    await context.close();
  }
  db.close();
}

async function dumpResumePanelByOpeningCandidate(page) {
  const before = await dumpResumePanelCandidates(page);
  logSection("resume-panel-before-click", before);

  const candidate = before.clickableCandidates[0];
  if (!candidate) {
    logSection("resume-panel-open", {
      opened: false,
      reason: "no safe toolbar candidate matched 简历/附件/resume/annex/file",
    });
    return;
  }

  const locator = page.locator(candidate.selector).nth(candidate.nth);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.hover().catch(() => {});
  await humanDelay(800, 1_500);

  let fileChooserSeen = false;
  const fileChooserPromise = page
    .waitForEvent("filechooser", { timeout: 2_500 })
    .then(() => {
      fileChooserSeen = true;
    })
    .catch(() => {});

  await locator.click({ timeout: 3_000 }).catch((error) => {
    logSection("resume-panel-click-error", {
      target: candidate,
      ...serializeError(error),
    });
  });
  await fileChooserPromise;
  await humanDelay(1_500, 2_500);

  logSection("resume-panel-open", {
    opened: true,
    clicked: candidate,
    fileChooserSeen,
    fileChooserAction: "ignored; no file selected",
  });
  logSection("resume-panel-selector-counts", await selectorCounts(page, resumePanelSelectors()));
  logSection(
    "resume-panel-samples",
    await candidateSamples(page, resumePanelSelectors(), 12, MAX_HTML_LENGTH),
  );
  logSection("resume-panel-body-delta", await dumpPotentialResumePanels(page));

  await closePanelOnly(page);
}

async function dumpResumePanelCandidates(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    const classNameOf = (node) =>
      typeof node.className === "string" ? node.className : "";
    const selectorOf = (element) => {
      if (element.id) {
        return `#${CSS.escape(element.id)}`;
      }
      const tag = element.tagName.toLowerCase();
      const cls = classNameOf(element)
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .map((value) => `.${CSS.escape(value)}`)
        .join("");
      return `${tag}${cls}`;
    };
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const centerDistanceToEditor = (element) => {
      const editor =
        document.querySelector("div.chat-input, .chat-input[contenteditable], textarea.chat-input, [contenteditable='true'][role='textbox']") ??
        document.querySelector(".chat-editor, .chat-input-area, .chat-footer, .chat-bottom");
      if (!editor) return Number.MAX_SAFE_INTEGER;
      const left = element.getBoundingClientRect();
      const right = editor.getBoundingClientRect();
      const leftCenter = {
        x: left.left + left.width / 2,
        y: left.top + left.height / 2,
      };
      const rightCenter = {
        x: right.left + right.width / 2,
        y: right.top + right.height / 2,
      };
      return Math.round(
        Math.hypot(leftCenter.x - rightCenter.x, leftCenter.y - rightCenter.y),
      );
    };
    const candidates = [
      ...document.querySelectorAll(
        "button, a, [role='button'], i, svg, span, div[class*='icon'], div[class*='tool'], div[class*='operate']",
      ),
    ]
      .map((element, rawIndex) => {
        const text = normalize(element.textContent);
        const label = normalize(
          [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("alt"),
            element.getAttribute("ka"),
            element.getAttribute("data-ka"),
            element.getAttribute("class"),
            text,
          ]
            .filter(Boolean)
            .join(" "),
        );
        const rect = element.getBoundingClientRect();
        const inMessage = Boolean(element.closest("li.message-item, .message-item, [class*='message-card']"));
        const inChat = Boolean(
          element.closest(
            ".chat-container, .chat-panel, .chat-content, .chat-editor, .chat-input-area, .chat-footer, .chat-bottom",
          ),
        );
        const keyword = /(简历|附件|resume|annex|attach|file|upload|paperclip)/iu.test(label);
        const dangerousCardAction =
          inMessage && /(同意|确认|发送|接受|立即|发给|send|agree|confirm)/iu.test(label);
        const plainSend = /^(发送|send)$/iu.test(text);
        return {
          rawIndex,
          tagName: element.tagName.toLowerCase(),
          selector: selectorOf(element),
          nth: 0,
          className: classNameOf(element),
          text: text.slice(0, 120),
          label: label.slice(0, 240),
          inChat,
          inMessage,
          keyword,
          dangerousCardAction,
          plainSend,
          visible: isVisible(element),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          distanceToEditor: centerDistanceToEditor(element),
          outerHTML: element.outerHTML.slice(0, 1_200),
        };
      })
      .filter((item) => item.visible && item.keyword);

    const selectorCounts = new Map();
    for (const item of candidates) {
      const current = selectorCounts.get(item.selector) ?? 0;
      item.nth = current;
      selectorCounts.set(item.selector, current + 1);
    }

    const clickableCandidates = candidates
      .filter(
        (item) =>
          item.inChat &&
          !item.inMessage &&
          !item.dangerousCardAction &&
          !item.plainSend,
      )
      .sort((left, right) => left.distanceToEditor - right.distanceToEditor)
      .slice(0, 8);

    return {
      allCandidates: candidates.slice(0, 30),
      clickableCandidates,
    };
  });
}

async function dumpPotentialResumePanels(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    const classNameOf = (node) =>
      typeof node.className === "string" ? node.className : "";
    const elements = [
      ...document.querySelectorAll(
        "[role='dialog'], .dialog, .modal, .popover, .dropdown, [class*='dialog'], [class*='modal'], [class*='popover'], [class*='dropdown'], [class*='resume'], [class*='attachment'], [class*='annex'], [class*='file']",
      ),
    ];
    return elements
      .filter((element) => /(简历|附件|文件|发送|选择|resume|attachment|annex|file)/iu.test(normalize(element.textContent) + " " + classNameOf(element)))
      .slice(0, 20)
      .map((element, index) => ({
        index,
        tagName: element.tagName.toLowerCase(),
        className: classNameOf(element),
        text: normalize(element.textContent).slice(0, 500),
        outerHTML: element.outerHTML.slice(0, 2_500),
      }));
  });
}

async function closePanelOnly(page) {
  const closeSelectors = [
    "button:has-text('取消')",
    "a:has-text('取消')",
    "[role='button']:has-text('取消')",
    "button:has-text('关闭')",
    "a:has-text('关闭')",
    "[aria-label='关闭']",
    "[ka='dialog_close']",
    ".dialog-header .close",
    ".modal-close",
    ".close",
  ];
  for (const selector of closeSelectors) {
    const locator = await firstVisible(page, selector, 600);
    if (!locator) continue;
    const text = await locator.innerText().catch(() => "");
    if (/确认|发送|同意|确定/u.test(text)) continue;
    await locator.click({ timeout: 1_500 }).catch(() => {});
    await humanDelay(500, 1_000);
    logSection("resume-panel-closed", { via: selector, text });
    return;
  }
  await page.keyboard.press("Escape").catch(() => {});
  await humanDelay(500, 1_000);
  logSection("resume-panel-closed", { via: "Escape" });
}

function chooseConversation(items, requestedIndex) {
  if (Number.isInteger(requestedIndex)) {
    return items.find((item) => item.index === requestedIndex) ?? null;
  }
  return (
    items.find((item) => /(附件简历|附件|简历|发.*简历|请求)/u.test(item.text)) ??
    items[0] ??
    null
  );
}

function parseOptionalInteger(value) {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

async function dumpConversations(page) {
  const candidateSelectors = [
    SELECTORS.chatConversationItem,
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
    items: itemSelector
      ? await page
          .locator(itemSelector)
          .evaluateAll((elements, selectors) =>
            elements.slice(0, 12).map((element, index) => {
              const normalize = (value) =>
                (value ?? "").replace(/\s+/g, " ").trim();
              const queryText = (selector) =>
                normalize(element.querySelector(selector)?.textContent);
              return {
                index,
                className:
                  typeof element.className === "string" ? element.className : "",
                dataset: { ...element.dataset },
                hrName: queryText(selectors.chatConvHrName),
                jobTitle: queryText(selectors.chatConvJobTitle),
                lastMsg: queryText(selectors.chatConvLastMsg),
                text: normalize(element.textContent).slice(0, 500),
                outerHTML: element.outerHTML.slice(0, 1_800),
              };
            }),
            SELECTORS,
          )
      : [],
  };
}

async function dumpSelectedConversation(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    return [
      ...document.querySelectorAll(
        ".user-list-content > ul[role='group'] > li[role='listitem']",
      ),
    ]
      .filter(
        (element) =>
          element.classList.contains("selected") ||
          element.querySelector(".friend-content-warp.selected, .friend-content.selected"),
      )
      .slice(0, 3)
      .map((element, index) => ({
        index,
        className: typeof element.className === "string" ? element.className : "",
        dataset: { ...element.dataset },
        text: normalize(element.textContent).slice(0, 500),
        outerHTML: element.outerHTML.slice(0, 2_000),
      }));
  });
}

async function dumpResumeRequestCards(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    const classNameOf = (node) =>
      typeof node.className === "string" ? node.className : "";
    const elements = [
      ...document.querySelectorAll(
        "li.message-item, .message-item, .message-card-wrap, .articles-center, [class*='card'], [class*='message']",
      ),
    ];
    return elements
      .filter((element) => /(附件简历|简历|发送附件|请求|同意|我想要)/u.test(normalize(element.textContent)))
      .slice(0, 20)
      .map((element, index) => ({
        index,
        tagName: element.tagName.toLowerCase(),
        className: classNameOf(element),
        text: normalize(element.textContent).slice(0, 500),
        buttons: [...element.querySelectorAll("button, a, [role='button']")].map(
          (button, buttonIndex) => ({
            buttonIndex,
            tagName: button.tagName.toLowerCase(),
            className: classNameOf(button),
            text: normalize(button.textContent),
            ariaLabel: button.getAttribute("aria-label"),
            title: button.getAttribute("title"),
            outerHTML: button.outerHTML.slice(0, 1_000),
          }),
        ),
        outerHTML: element.outerHTML.slice(0, 3_000),
      }));
  });
}

async function dumpToolbar(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    const classNameOf = (node) =>
      typeof node.className === "string" ? node.className : "";
    const roots = [
      ...document.querySelectorAll(
        ".chat-editor, .chat-input-area, .chat-footer, .chat-bottom, .chat-operation, .chat-operate, .chat-tools, .input-area, .chat-container",
      ),
    ];
    return roots.slice(0, 20).map((root, index) => ({
      index,
      tagName: root.tagName.toLowerCase(),
      className: classNameOf(root),
      text: normalize(root.textContent).slice(0, 500),
      controls: [...root.querySelectorAll("button, a, [role='button'], i, svg, span")]
        .slice(0, 80)
        .map((element, controlIndex) => ({
          controlIndex,
          tagName: element.tagName.toLowerCase(),
          className: classNameOf(element),
          text: normalize(element.textContent).slice(0, 120),
          ariaLabel: element.getAttribute("aria-label"),
          title: element.getAttribute("title"),
          ka: element.getAttribute("ka") || element.getAttribute("data-ka"),
          outerHTML: element.outerHTML.slice(0, 1_000),
        })),
      outerHTML: root.outerHTML.slice(0, 3_000),
    }));
  });
}

function toolbarSelectors() {
  return [
    "div.chat-input",
    ".chat-input[contenteditable]",
    ".chat-editor",
    ".chat-input-area",
    ".chat-footer",
    ".chat-bottom",
    ".chat-operation",
    ".chat-operate",
    ".chat-tools",
    "button:has-text('简历')",
    "button:has-text('附件')",
    "a:has-text('简历')",
    "a:has-text('附件')",
    "[title*='简历']",
    "[title*='附件']",
    "[aria-label*='简历']",
    "[aria-label*='附件']",
    "[class*='resume']",
    "[class*='annex']",
    "[class*='attach']",
    "[class*='file']",
  ];
}

function resumePanelSelectors() {
  return [
    "[role='dialog']",
    ".dialog",
    ".modal",
    ".popover",
    ".dropdown",
    "[class*='dialog']",
    "[class*='modal']",
    "[class*='popover']",
    "[class*='dropdown']",
    "button:has-text('发送')",
    "button:has-text('确定')",
    "button:has-text('取消')",
    "button:has-text('同意')",
    "a:has-text('发送')",
    "a:has-text('取消')",
    "[class*='resume']",
    "[class*='annex']",
    "[class*='attachment']",
    "[class*='file']",
    "text=附件简历",
    "text=选择",
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
    .locator(SELECTORS.chatConversationItem)
    .first()
    .waitFor({ state: "visible", timeout: 12_000 })
    .catch(() => {});
}

async function selectorCounts(page, selectors) {
  const counts = {};
  for (const selector of selectors) {
    counts[selector] = await page.locator(selector).count().catch(() => -1);
  }
  return counts;
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
            text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 300),
            ariaLabel: element.getAttribute("aria-label"),
            title: element.getAttribute("title"),
            ka: element.getAttribute("ka") || element.getAttribute("data-ka"),
            outerHTML: element.outerHTML.slice(0, maxHtmlLength),
          })),
        { maxItems, maxHtmlLength },
      )
      .catch((error) => [{ error: error.message }]);
  }
  return samples;
}

async function firstSelectorWithItems(page, selectors) {
  for (const selector of selectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) return selector;
  }
  return null;
}

async function firstVisible(page, selector, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const group = page.locator(selector);
    const count = await group.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const locator = group.nth(index);
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    await page.waitForTimeout(100);
  }
  return null;
}

async function runOptionalDump(title, fn) {
  try {
    await fn();
  } catch (error) {
    logSection(`${title}-error`, {
      optional: true,
      ...serializeError(error),
    });
  }
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

function serializeError(error) {
  return {
    name: error?.name,
    message: error?.message ?? String(error),
    reason: error?.reason,
    code: error?.code,
    stack: error?.stack,
  };
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
