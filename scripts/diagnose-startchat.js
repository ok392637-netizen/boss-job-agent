// 诊断: 详情页点"立即沟通"后到底发生什么 —— 是否新标签页打开聊天、输入框在哪个 page。
// 用已建会话的北京全质岗位 (再点只是进入已有会话)。
import { launchBrowser, getOrCreatePage, humanDelay } from "../src/browser.js";
import { SELECTORS } from "../src/boss/selectors.js";

const DETAIL_URL = "https://www.zhipin.com/job_detail/10f207cae14f19640nB62t-5EFBR.html";
const context = await launchBrowser();
try {
  const page = await getOrCreatePage(context);
  await page.goto(DETAIL_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await humanDelay(2_000, 3_000);

  const btnInfo = await page.evaluate((sel) => {
    const b = document.querySelector(sel);
    if (!b) return { found: false };
    return {
      found: true,
      html: b.outerHTML.slice(0, 300),
      tag: b.tagName,
      href: b.getAttribute("href"),
      target: b.getAttribute("target"),
      text: (b.textContent || "").trim().slice(0, 20),
    };
  }, SELECTORS.startChatButton);
  console.log("立即沟通按钮:", JSON.stringify(btnInfo, null, 2));

  const pagesBefore = context.pages().length;
  const popupPromise = context
    .waitForEvent("page", { timeout: 8_000 })
    .catch(() => null);

  const startChat = page.locator(SELECTORS.startChatButton);
  if ((await startChat.count()) > 0) {
    await startChat.first().click();
  }
  const popup = await popupPromise;
  await humanDelay(3_500, 5_000);

  console.log("点击前 pages:", pagesBefore, "| 点击后 pages:", context.pages().length);
  console.log("popup(新标签):", popup ? popup.url() : "无");

  for (const p of context.pages()) {
    try {
      const probe = await p.evaluate(() => {
        const clip = (s, n = 40) => (typeof s === "string" ? s : "").slice(0, n);
        const editors = [
          ...document.querySelectorAll("textarea, [contenteditable], div[contenteditable]"),
        ].map((e) => ({
          tag: e.tagName.toLowerCase(),
          cls: clip(e.className, 60),
          ce: e.getAttribute("contenteditable"),
        }));
        const sendBtns = [...document.querySelectorAll("[class*='btn-send'], button")]
          .filter((b) => /发送|send/i.test((b.textContent || "") + (typeof b.className === "string" ? b.className : "")))
          .map((b) => ({ tag: b.tagName.toLowerCase(), cls: clip(b.className, 60), disabled: b.disabled ?? null }));
        return {
          url: location.href,
          editors: editors.slice(0, 6),
          sendButtons: sendBtns.slice(0, 6),
          iframes: [...document.querySelectorAll("iframe")].map((f) => f.src).slice(0, 4),
        };
      });
      console.log("---PAGE---");
      console.log(JSON.stringify(probe, null, 2));
    } catch (error) {
      console.log("page eval 出错:", p.url(), error.message);
    }
  }
} catch (error) {
  console.error("诊断出错:", error.message);
} finally {
  await context.close();
}
