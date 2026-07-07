import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getOrCreatePage, launchBrowser } from "../src/browser.js";
import {
  listAllConversations,
  readConversationMessages,
} from "../src/boss/chat_reader.js";

const FIXTURE_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pages",
);

function fixtureUrl(name) {
  return pathToFileURL(path.join(FIXTURE_DIRECTORY, name)).href;
}

test("chat reader lists all conversations without unread filtering", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("chat.html"));

    const conversations = await listAllConversations(page);

    assert.equal(conversations.length, 2);
    assert.equal(conversations[0].hrName, "陈经理");
    assert.equal(conversations[0].company, "测试公司");
    assert.equal(conversations[0].jobTitle, "");
    assert.equal(conversations[0].lastMsgText, "可以聊聊你的项目吗？");
    assert.equal(conversations[0].lastMsgTimeLabel, "11:03");
    assert.equal(conversations[0].hasUnread, true);
    assert.equal(conversations[1].hasUnread, false);
    assert.match(conversations[0].bossConvKey, /^boss-chat-/);
    assert.notEqual(conversations[0].bossConvKey, conversations[1].bossConvKey);
  } finally {
    await context.close();
  }
});

test("chat reader clicks by conversation key and extracts message roles", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("chat.html"));
    const [conversation] = await listAllConversations(page);

    const messages = await readConversationMessages(
      page,
      conversation.bossConvKey,
      { scrollRounds: 0, delayFn: async () => 0 },
    );

    assert.deepEqual(messages, [
      {
        role: "hr",
        text: "可以聊聊你的项目吗？",
        sentLabel: "m-1",
      },
      {
        role: "me",
        text: "可以，我做过 n8n 自动化。",
        sentLabel: "m-2",
      },
      {
        role: "system",
        text: "附件简历请求已发送",
        sentLabel: "m-3",
      },
      {
        role: "system",
        text: "你与该职位竞争者PK情况",
        sentLabel: "m-4",
      },
    ]);
  } finally {
    await context.close();
  }
});

test("chat reader can include opened conversation URL and header metadata", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("chat.html"));
    const [conversation] = await listAllConversations(page);

    const result = await readConversationMessages(
      page,
      conversation.bossConvKey,
      { scrollRounds: 0, delayFn: async () => 0, includeConversation: true },
    );

    assert.equal(result.conversation.jobId, "job-chat");
    assert.equal(result.conversation.jobTitle, "AI Agent Intern");
    assert.equal(result.conversation.company, conversation.company);
    assert.equal(result.messages.length, 4);
  } finally {
    await context.close();
  }
});
