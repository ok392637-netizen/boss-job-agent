import crypto from "node:crypto";
import { humanDelay } from "../browser.js";
import { SELECTORS } from "./selectors.js";

export async function listAllConversations(page) {
  await page
    .locator(SELECTORS.chatConversationItem)
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .catch(() => {});

  const raw = await page
    .locator(SELECTORS.chatConversationItem)
    .evaluateAll((elements, selectors) =>
      elements.map((element, index) => {
        const normalizeText = (value) =>
          (value ?? "").replace(/\s+/g, " ").trim();
        const queryText = (root, selector) =>
          root.querySelector(selector)?.textContent ?? "";
        const text = (selector) => normalizeText(queryText(element, selector));
        const link = element.querySelector(selectors.inboxConversationLink);
        const avatar = element.querySelector("img.image-circle, img");
        const nameBoxSpans = [
          ...element.querySelectorAll(".title-box .name-box span"),
        ].map((span) => normalizeText(span.textContent));
        const company = nameBoxSpans.find(
          (value) => value && value !== text(selectors.chatConvHrName),
        );

        return {
          index,
          dataId:
            element.getAttribute("data-id") ??
            element.getAttribute("data-conversation-id") ??
            element.dataset?.id ??
            null,
          href: link?.getAttribute("href") ?? null,
          hrName: text(selectors.chatConvHrName),
          company: company ?? "",
          jobTitle: text(selectors.chatConvJobTitle),
          lastMsgText: text(selectors.chatConvLastMsg),
          lastMsgTimeLabel: text(selectors.chatConvLastMsgTime),
          hasUnread: Boolean(element.querySelector(selectors.chatConvUnread)),
          avatarSrc: avatar?.getAttribute("src") ?? "",
        };
      }),
      SELECTORS,
    );

  return raw.map((conversation) => ({
    bossConvKey: conversationKey(conversation),
    hrName: conversation.hrName,
    company: conversation.company,
    jobTitle: conversation.jobTitle,
    lastMsgText: conversation.lastMsgText,
    lastMsgTimeLabel: conversation.lastMsgTimeLabel,
    hasUnread: conversation.hasUnread,
  }));
}

export async function readConversationMessages(
  page,
  bossConvKey,
  {
    scrollRounds = 0,
    delayFn = humanDelay,
    openDelayMs = [4_000, 10_000],
    includeConversation = false,
  } = {},
) {
  const conversations = await listAllConversations(page);
  const index = conversations.findIndex(
    (conversation) => conversation.bossConvKey === bossConvKey,
  );
  if (index === -1) {
    throw new Error(`Conversation not found: ${bossConvKey}`);
  }

  await page.locator(SELECTORS.chatConversationItem).nth(index).click();
  await delayFn(openDelayMs[0], openDelayMs[1]);
  await randomScroll(page);
  await scrollMessageHistory(page, scrollRounds, delayFn);

  await page
    .locator(SELECTORS.chatMsgItem)
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .catch(() => {});

  const messages = await page
    .locator(SELECTORS.chatMsgItem)
    .evaluateAll(
      (elements, selectors) => {
        const normalizeText = (value) =>
          (value ?? "").replace(/\s+/g, " ").trim();
        const queryText = (root, selector) =>
          root.querySelector(selector)?.textContent ?? "";
        const extractMessageText = (element) => {
          const direct =
            queryText(element, ".text-content") ||
            queryText(element, ".hyper-link");
          if (direct) return normalizeText(direct);

          const cardTitle = queryText(element, ".message-card-top-title");
          if (cardTitle) return normalizeText(cardTitle);

          return normalizeText(queryText(element, selectors.chatMsgText));
        };
        const messageRole = (element) => {
          if (element.matches(selectors.chatMsgSystem)) return "system";
          if (element.matches(selectors.chatMsgMine)) return "me";
          return "hr";
        };

        return elements
          .map((element) => {
            const text = extractMessageText(element);
            if (!text) return null;
            return {
              role: messageRole(element),
              text,
              sentLabel:
                element.getAttribute("data-mid") ??
                normalizeText(queryText(element, selectors.chatMsgTimeLabel)) ??
                "",
            };
          })
          .filter(Boolean);
      },
      SELECTORS,
    );

  if (!includeConversation) {
    return messages;
  }

  return {
    conversation: {
      bossConvKey,
      ...(await readOpenConversationMetadata(page)),
    },
    messages,
  };
}

function conversationKey(conversation) {
  const explicit = conversation.dataId || conversation.href;
  const source =
    explicit ||
    [
      conversation.hrName,
      conversation.company,
      conversation.avatarSrc,
    ]
      .filter(Boolean)
      .join("|") ||
    String(conversation.index);

  return `boss-chat-${crypto
    .createHash("sha1")
    .update(source)
    .digest("hex")
    .slice(0, 16)}`;
}

async function readOpenConversationMetadata(page) {
  const url = page.url();
  const metadata = await page.evaluate((selectors) => {
    const normalizeText = (value) =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const queryText = (root, selector) =>
      root?.querySelector(selector)?.textContent ?? "";
    const selected = [
      ...document.querySelectorAll(
        ".user-list-content > ul[role='group'] > li[role='listitem']",
      ),
    ].find(
      (element) =>
        element.classList.contains("selected") ||
        element.querySelector(".friend-content.selected, .friend-content-warp.selected"),
    );
    const nameBoxSpans = [
      ...(selected?.querySelectorAll(".title-box .name-box span") ?? []),
    ].map((span) => normalizeText(span.textContent));
    const hrName = normalizeText(queryText(selected, selectors.chatConvHrName));
    const company =
      nameBoxSpans.find((value) => value && value !== hrName) ?? "";

    return {
      hrName,
      company,
      jobTitle: normalizeText(
        queryText(document, selectors.chatOpenJobTitle) ||
          queryText(selected, selectors.chatConvJobTitle),
      ),
    };
  }, SELECTORS);

  return {
    ...metadata,
    jobId: extractJobIdFromUrl(url),
    openUrl: url,
  };
}

function extractJobIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    const preferredKeys = [
      "jobId",
      "jobid",
      "job_id",
      "jid",
      "securityId",
      "security_id",
      "lid",
      "uid",
    ];
    for (const key of preferredKeys) {
      const value = parsed.searchParams.get(key);
      if (value) return value;
    }
  } catch {
    return null;
  }
  return null;
}

async function scrollMessageHistory(page, scrollRounds, delayFn) {
  for (let index = 0; index < scrollRounds; index += 1) {
    await page.evaluate(() => {
      const container =
        document.querySelector(".chat-message") ??
        document.querySelector(".chat-record") ??
        document.querySelector("[class*='message-list']") ??
        document.scrollingElement;
      if (container) {
        container.scrollTop = 0;
      }
    });
    await delayFn(1_000, 3_000);
  }
}

async function randomScroll(page) {
  const distance = Math.floor(120 + Math.random() * 480);
  await page.mouse.wheel(0, distance).catch(() => {});
}
