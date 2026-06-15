// 只读核实: 打开 Boss 聊天页, 点开一个会话, dump 聊天输入框 / 发送按钮的真实结构,
// 并查看点"立即沟通"后我方实际发出了什么。不发送任何消息。
import { launchBrowser, getOrCreatePage, humanDelay } from "../src/browser.js";
import { URLS, SELECTORS } from "../src/boss/selectors.js";

const context = await launchBrowser();
try {
  const page = await getOrCreatePage(context);
  await page.goto(URLS.messages, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await humanDelay(3_000, 5_000);

  const conversations = page.locator(SELECTORS.inboxConversation);
  const count = await conversations.count();
  console.log("会话数:", count, "| URL:", page.url());

  if (count > 0) {
    await conversations.first().click();
    await humanDelay(2_500, 4_000);
  }

  const probe = await page.evaluate(() => {
    const clip = (s, n = 40) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
    const editors = [
      ...document.querySelectorAll("textarea, [contenteditable='true'], [contenteditable=true], div[contenteditable]"),
    ].map((e) => ({
      tag: e.tagName.toLowerCase(),
      cls: typeof e.className === "string" ? e.className : "",
      placeholder: e.getAttribute("placeholder") || "",
      role: e.getAttribute("role") || "",
    }));
    const sendButtons = [
      ...document.querySelectorAll("button, [class*='send'], [class*='btn'], [class*='Send']"),
    ]
      .filter((b) => /发送|send/i.test((b.textContent || "") + " " + (typeof b.className === "string" ? b.className : "")))
      .map((b) => ({
        tag: b.tagName.toLowerCase(),
        cls: typeof b.className === "string" ? b.className : "",
        text: clip(b.textContent, 20),
      }));
    const messages = [
      ...document.querySelectorAll("[class*='message'], [class*='msg'], [class*='chat-item'], [class*='item-content']"),
    ]
      .map((m) => clip(m.textContent, 60))
      .filter(Boolean);
    return {
      editors: editors.slice(0, 10),
      sendButtons: sendButtons.slice(0, 10),
      recentMessages: messages.slice(-8),
    };
  });

  console.log(JSON.stringify(probe, null, 2));
} catch (error) {
  console.error("核实出错:", error.message);
} finally {
  await context.close();
}
