import fs from "node:fs";
import path from "node:path";
import { humanDelay } from "../browser.js";
import { listAllConversations } from "../boss/chat_reader.js";
import { SELECTORS, URLS } from "../boss/selectors.js";

export const RESUME_SEND_PATH = Object.freeze({
  requestCard: "request-card",
  toolbarRequest: "toolbar-request",
  libraryPanel: "library-panel",
});

export async function sendResumeFromLibrary(
  page,
  {
    conversation = null,
    attachmentName = "",
    message = "",
    dryRun = true,
    approved = false,
    selectors = SELECTORS,
    delayFn = humanDelay,
    navigate = true,
    waitTimeoutMs = 20_000,
    conversationSearchFn = typeConversationSearch,
  } = {},
) {
  const plannedSteps = buildResumeSendPlan({
    conversation,
    attachmentName,
    message,
    navigate,
  });

  if (dryRun) {
    return {
      dryRun: true,
      approved: false,
      sent: false,
      requestSent: false,
      attachmentName,
      conversation: summarizeConversation(conversation),
      plannedSteps,
      observedPaths: ["request-card", "toolbar-request"],
    };
  }
  if (!approved) {
    throw new Error("Real resume sending requires approved=true");
  }
  assertPage(page);

  await openConversation(page, conversation, {
    selectors,
    delayFn,
    navigate,
    conversationSearchFn,
  });
  if (message) {
    await sendOptionalMessage(page, message, { selectors, delayFn });
  }

  const beforeOutcome = await readResumeOutcome(page, { attachmentName });
  const action = await findResumeAction(page, { selectors });
  if (!action) {
    const disabled = await firstVisible(
      page,
      selectors.chatResumeToolbarButtonAny,
      1_000,
    );
    const disabledText = disabled ? await safeText(disabled) : "";
    throw new Error(
      disabled
        ? `Resume send entry is not available: ${disabledText || "disabled toolbar"}`
        : "Unable to find Boss resume request card or active 发简历 toolbar entry",
    );
  }

  await action.locator.scrollIntoViewIfNeeded().catch(() => {});
  await action.locator.click();
  await delayFn(1_000, 2_000);

  const panelResult = await handleResumePanelIfOpened(page, {
    attachmentName,
    selectors,
    delayFn,
  });
  const outcome = await waitForResumeOutcome(page, {
    attachmentName,
    beforeOutcome,
    timeoutMilliseconds: waitTimeoutMs,
  });

  if (!outcome.sent && !outcome.requestSent) {
    throw new Error("Resume action clicked but no resume request/send receipt appeared");
  }

  return {
    dryRun: false,
    approved: true,
    sent: outcome.sent,
    requestSent: outcome.requestSent,
    path: panelResult?.path ?? action.path,
    attachmentName,
    conversation: summarizeConversation(conversation),
    outcome,
  };
}

export async function sendResumeToConversation(
  page,
  {
    job = null,
    resumePath = "",
    message = "",
    dryRun = true,
    approved = false,
    checkFile = true,
    navigate = true,
    selectors = SELECTORS,
    delayFn = humanDelay,
  } = {},
) {
  if (!resumePath || typeof resumePath !== "string") {
    throw new Error("sendResumeToConversation requires resumePath");
  }
  if (checkFile && !fs.existsSync(resumePath)) {
    throw new Error(`Resume file does not exist: ${resumePath}`);
  }

  return sendResumeFromLibrary(page, {
    conversation: job?.conversationUrl
      ? { ...job, conversationUrl: job.conversationUrl }
      : job,
    attachmentName: path.basename(resumePath),
    message,
    dryRun,
    approved,
    selectors,
    delayFn,
    navigate,
  });
}

export async function sendReply(
  page,
  {
    conversation = null,
    text = "",
    dryRun = true,
    approved = false,
    selectors = SELECTORS,
    delayFn = humanDelay,
    navigate = true,
    conversationSearchFn = typeConversationSearch,
    replyDelaySec = [30, 120],
  } = {},
) {
  const replyText = String(text ?? "").trim();
  if (!replyText) {
    throw new Error("sendReply requires text");
  }

  const plannedSteps = buildReplySendPlan({
    conversation,
    text: replyText,
    navigate,
  });

  if (dryRun) {
    return {
      dryRun: true,
      approved: false,
      sent: false,
      text: replyText,
      conversation: summarizeConversation(conversation),
      plannedSteps,
    };
  }
  if (!approved) {
    throw new Error("Real chat reply sending requires approved=true");
  }
  assertPage(page, "sendReply requires a Playwright page");

  await openConversation(page, conversation, {
    selectors,
    delayFn,
    navigate,
    conversationSearchFn,
  });
  await delayReply(delayFn, replyDelaySec);
  await sendOptionalMessage(page, replyText, { selectors, delayFn });

  return {
    dryRun: false,
    approved: true,
    sent: true,
    text: replyText,
    conversation: summarizeConversation(conversation),
  };
}

export function buildResumeSendPlan({
  conversation = null,
  attachmentName = "",
  resumePath = "",
  message = "",
  navigate = true,
} = {}) {
  const attachmentLabel =
    attachmentName || (resumePath ? path.basename(resumePath) : "<current Boss attachment resume>");
  return [
    navigate ? `open Boss chat conversation: ${conversationLabel(conversation)}` : "use current open Boss chat conversation",
    message ? "send approved intro message before resume request" : null,
    `use Boss attachment-library resume/default attachment: ${attachmentLabel}`,
    "prefer HR resume-request card when present",
    "otherwise click active chat toolbar entry [d-c='62009'] 发简历",
    "do not use direct chat file upload input",
    "wait for 附件简历请求已发送 or 附件简历已发送 receipt",
  ].filter(Boolean);
}

export function buildReplySendPlan({
  conversation = null,
  text = "",
  navigate = true,
} = {}) {
  if (!String(text ?? "").trim()) {
    throw new Error("buildReplySendPlan requires text");
  }
  return [
    navigate ? `open Boss chat conversation: ${conversationLabel(conversation)}` : "use current open Boss chat conversation",
    "wait human reply delay before sending text",
    "type approved reply into Boss chat editor",
    "click Boss chat send button",
    "do not upload files or send resume attachments",
  ];
}

async function openConversation(
  page,
  conversation,
  { selectors, delayFn, navigate, conversationSearchFn },
) {
  if (!navigate) {
    return;
  }

  const url = conversation?.conversationUrl ?? conversation?.openUrl ?? null;
  if (url) {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await delayFn(1_000, 2_000);
    return;
  }

  if (!page.url?.().includes("/web/geek/chat")) {
    await page.goto(URLS.messages, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await delayFn(1_000, 2_000);
  }

  const target = await resolveConversationIndex(page, conversation, {
    selectors,
    delayFn,
    conversationSearchFn,
  });
  if (target == null) {
    return;
  }

  try {
    await page
      .locator(target.selector ?? selectors.chatConversationItem)
      .nth(target.index)
      .click();
    await delayFn(2_000, 4_000);
  } finally {
    await target.clearSearch?.();
  }
}

async function resolveConversationIndex(
  page,
  conversation,
  { selectors, delayFn, conversationSearchFn },
) {
  if (!conversation) {
    return null;
  }
  if (Number.isInteger(conversation.index)) {
    return { index: conversation.index };
  }

  await page
    .locator(selectors.chatConversationItem)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {});

  const conversations = await readConversationItems(page, selectors);
  const visibleIndex = findConversationIndex(conversations, conversation);
  if (visibleIndex !== -1) return { index: visibleIndex };
  let sameNameCompanyMismatch =
    hasSameHrNameWithDifferentCompany(conversations, conversation);

  if (conversation.bossConvKey) {
    const keyedConversations = await listAllConversations(page);
    const keyedIndex = findBossConvKeyIndex(
      keyedConversations,
      conversation.bossConvKey,
    );
    if (keyedIndex !== -1) return { index: keyedIndex };
  }

  const searchInput = await firstVisible(
    page,
    selectors.chatConversationSearchInput,
    3_000,
  );
  const queries = conversationSearchQueries(conversation);
  if (!searchInput || queries.length === 0) {
    if (sameNameCompanyMismatch) {
      throw sameNameCompanyMismatchError(conversation);
    }
    throw conversationNotFoundError(conversation);
  }

  const clearSearch = () => clearConversationSearch(page, selectors);
  let sawSearchResults = false;
  try {
    for (const query of queries) {
      await conversationSearchFn({
        page,
        searchInput,
        query,
        delayFn,
      });
      const searchResult = await waitForConversationSearchResult(
        page,
        conversation,
        { selectors, timeoutMilliseconds: 5_000 },
      );
      sameNameCompanyMismatch ||= searchResult.sameNameCompanyMismatch;
      sawSearchResults ||= searchResult.resultCount > 0;
      if (searchResult.index !== -1) {
        return {
          index: searchResult.index,
          selector: selectors.chatSearchResultItem,
          clearSearch,
        };
      }
    }
  } catch (error) {
    await clearSearch();
    throw error;
  }

  await clearSearch();
  if (sameNameCompanyMismatch) {
    throw sameNameCompanyMismatchError(conversation);
  }
  throw conversationSearchResultNotFoundError(conversation, sawSearchResults);
}

function findConversationIndex(conversations, conversation) {
  const hrName = normalizeComparableText(conversation?.hrName);
  const company = normalizeComparableText(conversation?.company);
  const lastMsgText = normalizeComparableText(conversation?.lastMsgText);
  const bossConvKey = normalizeComparableText(conversation?.bossConvKey);

  const findIndex = (predicate) => {
    const arrayIndex = conversations.findIndex(predicate);
    if (arrayIndex === -1) return -1;
    return Number.isInteger(conversations[arrayIndex].index)
      ? conversations[arrayIndex].index
      : arrayIndex;
  };

  if (bossConvKey) {
    const index = findBossConvKeyIndex(conversations, bossConvKey);
    if (index !== -1) return index;
  }
  if (hrName && company) {
    const index = findIndex(
      (item) => hrNameMatches(item, hrName) && companyMatches(item, company),
    );
    return index;
  }
  if (hrName) {
    const index = findIndex((item) => hrNameMatches(item, hrName));
    if (index !== -1) return index;
  }
  if (company) {
    const index = findIndex((item) => companyMatches(item, company));
    if (index !== -1) return index;
  }
  if (lastMsgText) {
    const index = findIndex((item) =>
      normalizeComparableText(item.lastMsgText).includes(lastMsgText),
    );
    if (index !== -1) return index;
  }
  return -1;
}

function findBossConvKeyIndex(conversations, bossConvKey) {
  const expectedBossConvKey = normalizeComparableText(bossConvKey);
  if (!expectedBossConvKey) return -1;
  const arrayIndex = conversations.findIndex(
    (item) => normalizeComparableText(item.bossConvKey) === expectedBossConvKey,
  );
  if (arrayIndex === -1) return -1;
  return Number.isInteger(conversations[arrayIndex].index)
    ? conversations[arrayIndex].index
    : arrayIndex;
}

function hasSameHrNameWithDifferentCompany(conversations, conversation) {
  const hrName = normalizeComparableText(conversation?.hrName);
  const company = normalizeComparableText(conversation?.company);
  if (!hrName || !company) {
    return false;
  }
  return conversations.some(
    (item) => hrNameMatches(item, hrName) && !companyMatches(item, company),
  );
}

function hrNameMatches(item, expectedHrName) {
  return normalizeComparableText(item.hrName) === expectedHrName;
}

function companyMatches(item, expectedCompany) {
  const company = normalizeComparableText(item.company);
  return (
    company !== "" &&
    (company.includes(expectedCompany) || expectedCompany.includes(company))
  );
}

function conversationSearchQueries(conversation) {
  return uniqueSearchQueries([
    conversation?.hrName,
    companySearchKeyword(conversation?.company),
  ]);
}

function companySearchKeyword(company) {
  const compactCompany = String(company ?? "").replace(/\s+/g, "").trim();
  if (!compactCompany) {
    return "";
  }
  return [...compactCompany].slice(0, 4).join("");
}

async function typeConversationSearch({ page, searchInput, query, delayFn }) {
  await clearConversationSearchInput(page, searchInput);
  await searchInput.click().catch(() => {});
  if (page.keyboard?.type) {
    await page.keyboard.type(query, { delay: 100 });
  } else if (typeof searchInput.type === "function") {
    await searchInput.type(query, { delay: 100 });
  } else {
    throw new Error("Unable to type Boss chat search query");
  }
  if (page.keyboard?.press) {
    await page.keyboard.press("Enter");
  } else {
    await searchInput.press?.("Enter");
  }
  await delayFn?.(1_800, 2_400);
}

async function clearConversationSearchInput(page, searchInput) {
  await searchInput.click().catch(() => {});
  if (typeof searchInput.fill === "function") {
    const cleared = await searchInput
      .fill("")
      .then(() => true)
      .catch(() => false);
    if (cleared) {
      await searchInput.click().catch(() => {});
      return;
    }
  }
  if (page.keyboard?.press) {
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Delete").catch(async () => {
      await page.keyboard.press("Backspace").catch(() => {});
    });
  } else {
    await searchInput.press?.("Control+A").catch(() => {});
    await searchInput.press?.("Delete").catch(async () => {
      await searchInput.press?.("Backspace").catch(() => {});
    });
  }
  await searchInput.click().catch(() => {});
}

async function clearConversationSearch(page, selectors) {
  const searchInput = await firstVisible(
    page,
    selectors.chatConversationSearchInput,
    1_000,
  );
  if (!searchInput) return;
  await clearConversationSearchInput(page, searchInput);
  await page.waitForTimeout?.(200);
}

async function waitForConversationSearchResult(
  page,
  conversation,
  { selectors, timeoutMilliseconds },
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let sameNameCompanyMismatch = false;
  let resultCount = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout?.(250);
    const conversations = await readConversationSearchResultItems(
      page,
      selectors,
      conversation,
    );
    resultCount = Math.max(resultCount, conversations.length);
    sameNameCompanyMismatch ||=
      hasSameHrNameWithDifferentCompany(conversations, conversation);
    const index = findConversationIndex(conversations, conversation);
    if (index !== -1) {
      return { index, sameNameCompanyMismatch, resultCount };
    }
  }
  return { index: -1, sameNameCompanyMismatch, resultCount };
}

async function readConversationItems(page, selectors) {
  return page.locator(selectors.chatConversationItem).evaluateAll(
    (elements, selectors) => {
      const normalizeText = (value) => (value ?? "").replace(/\s+/g, " ").trim();
      const queryText = (root, selector) =>
        root.querySelector(selector)?.textContent ?? "";
      const isVisible = (element) => {
        if (!element || element.closest("[hidden], [aria-hidden='true']")) {
          return false;
        }
        const style = window.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 &&
          element.getClientRects().length > 0
        );
      };

      return elements
        .map((element, index) => {
          if (!isVisible(element)) return null;
          const nameBoxSpans = [
            ...element.querySelectorAll(".title-box .name-box span"),
          ].map((span) => normalizeText(span.textContent));
          const hrName = normalizeText(queryText(element, selectors.chatConvHrName));
          const company =
            nameBoxSpans.find((value) => value && value !== hrName) ?? "";

          return {
            index,
            hrName,
            company,
            jobTitle: normalizeText(queryText(element, selectors.chatConvJobTitle)),
            lastMsgText: normalizeText(queryText(element, selectors.chatConvLastMsg)),
          };
        })
        .filter(Boolean);
    },
    selectors,
  );
}

async function readConversationSearchResultItems(page, selectors, conversation) {
  const rawItems = await page.locator(selectors.chatSearchResultItem).evaluateAll(
    (elements, selectors) => {
      const normalizeText = (value) => (value ?? "").replace(/\s+/g, " ").trim();
      const queryText = (root, selector) =>
        root.querySelector(selector)?.textContent ?? "";
      const isVisible = (element) => {
        if (!element || element.closest("[hidden], [aria-hidden='true']")) {
          return false;
        }
        const style = window.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 &&
          element.getClientRects().length > 0
        );
      };

      return elements
        .map((element, index) => {
          if (!isVisible(element)) return null;
          return {
            index,
            hrName: normalizeText(queryText(element, selectors.chatSearchResultName)),
            allSpans: [...element.querySelectorAll("span")]
              .map((span) => normalizeText(span.textContent))
              .filter(Boolean),
            text: normalizeText(element.textContent),
          };
        })
        .filter(Boolean);
    },
    selectors,
  );

  return rawItems.map((item) => ({
    index: item.index,
    hrName: item.hrName,
    company: searchResultCompany(item, conversation),
    jobTitle: searchResultJobTitle(item),
    lastMsgText: item.text,
  }));
}

function searchResultCompany(item, conversation) {
  const expectedCompany = normalizeComparableText(conversation?.company);
  const expectedHrName = normalizeComparableText(item.hrName);
  const candidates = item.allSpans
    .filter((span) => {
      const normalized = normalizeComparableText(span);
      return (
        normalized &&
        normalized !== expectedHrName &&
        normalized !== "招聘者" &&
        normalized !== "hr" &&
        !normalized.startsWith("职位:")
      );
    })
    .map((span) => span.trim());

  if (expectedCompany) {
    const matched = candidates.find((company) =>
      companyMatches({ company }, expectedCompany),
    );
    if (matched) return matched;
  }
  return candidates[0] ?? "";
}

function searchResultJobTitle(item) {
  return (
    item.allSpans
      .find((span) => normalizeComparableText(span).startsWith("职位:"))
      ?.replace(/^职位[:：]\s*/u, "")
      .trim() ?? ""
  );
}

function uniqueSearchQueries(values) {
  const seen = new Set();
  return values
    .map((value) => String(value ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = normalizeComparableText(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeComparableText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function conversationNotFoundError(conversation) {
  const hrName = conversation?.hrName || "unknown";
  const company = conversation?.company || "unknown";
  return new Error(
    `Conversation not found: HR=${hrName} company=${company}; 不在30天内联系人或列表未加载`,
  );
}

function conversationSearchResultNotFoundError(conversation, sawSearchResults) {
  const hrName = conversation?.hrName || "unknown";
  const company = conversation?.company || "unknown";
  const reason = sawSearchResults
    ? "search results had no HR/company double match"
    : "search returned no result items";
  return new Error(
    `Conversation not found: HR=${hrName} company=${company}; ${reason}`,
  );
}

function sameNameCompanyMismatchError(conversation) {
  const hrName = conversation?.hrName || "unknown";
  const company = conversation?.company || "unknown";
  return new Error(`同名HR但公司不匹配: HR=${hrName} company=${company}`);
}

async function sendOptionalMessage(page, message, { selectors, delayFn }) {
  const editor = await firstVisible(page, selectors.chatEditor, 8_000);
  if (!editor) {
    throw new Error("Unable to find chat editor before sending resume message");
  }
  await editor.click();
  await delayFn(150, 400);
  if (page.keyboard?.type) {
    await page.keyboard.type(message, { delay: 18 });
  } else if (editor.fill) {
    await editor.fill(message);
  }
  await delayFn(400, 900);

  const sendButton = await firstVisible(
    page,
    selectors.sendMessageButton,
    5_000,
  );
  if (!sendButton) {
    throw new Error("Unable to find chat send button for resume message");
  }
  await sendButton.click();
  await delayFn(800, 1_500);
}

async function findResumeAction(page, { selectors }) {
  const requestCard = await latestVisible(page, selectors.chatResumeRequestCard, 1_000);
  if (requestCard) {
    // 请求卡的同意按钮 disabled 时(请求已处理/过期)必须跳过, 回退到工具栏发简历
    const action = await firstVisibleIn(
      requestCard,
      "a.link-agree:has-text('附件简历'):not(.disabled)",
      1_000,
    ) ?? await firstVisibleIn(
      requestCard,
      ".card-btn:has-text('同意'):not(.disabled), button:has-text('同意'):not(.disabled):not([disabled])",
      1_000,
    );
    if (action) {
      return { path: RESUME_SEND_PATH.requestCard, locator: action };
    }
  }

  const toolbar = await firstVisible(
    page,
    selectors.chatResumeToolbarButton,
    2_000,
  );
  if (toolbar) {
    return { path: RESUME_SEND_PATH.toolbarRequest, locator: toolbar };
  }
  return null;
}

async function handleResumePanelIfOpened(
  page,
  { attachmentName, selectors, delayFn },
) {
  const uploadSelect = await firstVisible(
    page,
    selectors.chatResumeUploadSelectDialog,
    1_200,
  );
  if (uploadSelect) {
    await closeResumeDialog(page, { selectors, delayFn });
    throw new Error(
      "Boss opened upload/online-resume dialog instead of an attachment-library selector; refusing to select 上传简历/发送在线简历 automatically",
    );
  }

  if (!attachmentName) {
    return null;
  }

  const option = await findResumePanelItem(page, {
    selectors,
    attachmentName,
    timeoutMilliseconds: 1_200,
  });
  if (!option) {
    return null;
  }
  await option.click();
  await delayFn(500, 900);
  const confirm = await firstVisible(
    page,
    selectors.chatResumeConfirmSendButton,
    8_000,
  );
  if (!confirm) {
    throw new Error(`attachment selection did not enable send button: ${attachmentName}`);
  }
  await confirm.click();
  await delayFn(1_000, 2_000);
  return { path: RESUME_SEND_PATH.libraryPanel };
}

async function findResumePanelItem(
  page,
  { selectors, attachmentName, timeoutMilliseconds },
) {
  const deadline = Date.now() + timeoutMilliseconds;
  const expectedName = normalizePanelAttachmentName(attachmentName);
  let sawPanelItems = false;

  while (Date.now() < deadline) {
    const group = page.locator(selectors.chatResumePanelItem);
    const count = await group.count().catch(() => 0);
    let containsMatch = null;

    for (let index = 0; index < count; index += 1) {
      const item = group.nth(index);
      if (!(await item.isVisible().catch(() => false))) {
        continue;
      }
      sawPanelItems = true;

      const name = await item
        .locator(selectors.chatResumePanelItemName)
        .first()
        .innerText()
        .catch(() => "");
      const normalizedName = normalizePanelAttachmentName(name);
      if (!normalizedName) {
        continue;
      }
      if (normalizedName === expectedName) {
        return item;
      }
      if (!containsMatch && normalizedName.includes(expectedName)) {
        containsMatch = item;
      }
    }

    if (containsMatch) {
      return containsMatch;
    }
    await page.waitForTimeout?.(100);
  }

  if (sawPanelItems) {
    throw new Error(`attachment not found in resume panel: ${attachmentName}`);
  }
  return null;
}

function normalizePanelAttachmentName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function closeResumeDialog(page, { selectors, delayFn }) {
  const close = await firstVisible(
    page,
    selectors.chatResumeDialogCloseButton,
    1_000,
  );
  if (close) {
    await close.click().catch(() => {});
  } else {
    await page.keyboard?.press?.("Escape").catch(() => {});
  }
  await delayFn(500, 1_000);
}

async function waitForResumeOutcome(
  page,
  { attachmentName, beforeOutcome, timeoutMilliseconds },
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let latest = beforeOutcome;
  while (Date.now() < deadline) {
    latest = await readResumeOutcome(page, { attachmentName });
    if (
      latest.sentCount > beforeOutcome.sentCount ||
      latest.requestSentCount > beforeOutcome.requestSentCount
    ) {
      return {
        ...latest,
        sent: latest.sentCount > beforeOutcome.sentCount,
        requestSent: latest.requestSentCount > beforeOutcome.requestSentCount,
      };
    }
    await page.waitForTimeout?.(250);
  }
  return {
    ...latest,
    sent: false,
    requestSent: false,
  };
}

async function readResumeOutcome(page, { attachmentName = "" } = {}) {
  return page.evaluate((attachmentName) => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    const messages = [
      ...document.querySelectorAll("li.message-item, .message-item"),
    ].map((element) => normalize(element.textContent));
    const sentTexts = messages.filter(
      (text) =>
        /您的附件简历已发送给对方|您的附件简历.*已发送给Boss|已发送给Boss.*附件简历/u.test(
          text,
        ) ||
        (/点击预览附件简历/u.test(text) &&
          (!attachmentName || text.includes(attachmentName))),
    );
    const requestSentTexts = messages.filter((text) =>
      /附件简历请求已发送/u.test(text),
    );
    return {
      sentCount: sentTexts.length,
      requestSentCount: requestSentTexts.length,
      latestSentText: sentTexts.at(-1) ?? "",
      latestRequestText: requestSentTexts.at(-1) ?? "",
    };
  }, attachmentName);
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
    await page.waitForTimeout?.(100);
  }
  return null;
}

async function latestVisible(page, selector, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const group = page.locator(selector);
    const count = await group.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const locator = group.nth(index);
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    await page.waitForTimeout?.(100);
  }
  return null;
}

async function firstVisibleIn(locator, selector, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const group = locator.locator(selector);
    const count = await group.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const child = group.nth(index);
      if (await child.isVisible().catch(() => false)) {
        return child;
      }
    }
    await locator.page().waitForTimeout?.(100);
  }
  return null;
}

async function safeText(locator) {
  return (await locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
}

function conversationLabel(conversation) {
  if (!conversation) return "current/first open conversation";
  if (typeof conversation === "string") return conversation;
  return (
    conversation.bossConvKey ??
    conversation.conversationUrl ??
    conversation.openUrl ??
    [conversation.hrName, conversation.company, conversation.jobTitle]
      .filter(Boolean)
      .join(" / ") ??
    "current conversation"
  );
}

function summarizeConversation(conversation) {
  if (!conversation || typeof conversation === "string") {
    return conversation;
  }
  return {
    bossConvKey: conversation.bossConvKey ?? null,
    conversationUrl: conversation.conversationUrl ?? conversation.openUrl ?? null,
    index: Number.isInteger(conversation.index) ? conversation.index : null,
    hrName: conversation.hrName ?? null,
    company: conversation.company ?? null,
    jobTitle: conversation.jobTitle ?? conversation.title ?? null,
  };
}

function assertPage(page, message = "sendResumeFromLibrary requires a Playwright page") {
  if (!page || typeof page.locator !== "function") {
    throw new Error(message);
  }
}

async function delayReply(delayFn, replyDelaySec) {
  const [minimumSeconds, maximumSeconds] = Array.isArray(replyDelaySec)
    ? replyDelaySec
    : [30, 120];
  const minimum = Number.isFinite(minimumSeconds) ? minimumSeconds : 30;
  const maximum = Number.isFinite(maximumSeconds) ? maximumSeconds : 120;
  await delayFn(
    Math.max(0, minimum) * 1_000,
    Math.max(Math.max(0, minimum), maximum) * 1_000,
  );
}
