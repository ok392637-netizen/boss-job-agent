import { assertPageSafe } from "./greet.js";
import { SELECTORS, URLS } from "./selectors.js";

export async function pollReplies(
  page,
  { db, notifyFn, navigate = true } = {},
) {
  if (navigate) {
    await page.goto(URLS.messages, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  }
  await assertPageSafe(page, {
    db,
    notifyFn,
    expectLoggedIn: true,
  });

  // 等会话列表 SPA 渲染 (最多 8s); 真无会话则超时后继续返回空, 避免读太快漏掉回复
  await page
    .locator(SELECTORS.inboxConversation)
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .catch(() => {});

  return page
    .locator(SELECTORS.inboxConversation)
    .evaluateAll((conversations, selectors) => {
      const text = (root, selector) =>
        root.querySelector(selector)?.textContent?.trim() ?? "";
      return conversations
        .filter((conversation) =>
          Boolean(conversation.querySelector(selectors.inboxUnread)),
        )
        .map((conversation) => {
          const link = conversation.querySelector(
            selectors.inboxConversationLink,
          );
          const jobTitle = text(conversation, selectors.inboxJobTitle);
          return {
            jobMatchKey:
              conversation.dataset.jobId ||
              link?.getAttribute("href") ||
              jobTitle ||
              null,
            hrName: text(conversation, selectors.inboxHrName),
            lastMsg: text(conversation, selectors.inboxLastMessage),
            jobTitle,
          };
        });
    }, SELECTORS);
}
