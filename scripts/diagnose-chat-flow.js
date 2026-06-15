// 验证完整发送链路 (不发送): 点继续沟通 -> 等跳转聊天页 -> 找输入框 -> 输入文本 -> 检查发送按钮是否激活 -> 清空。
import { launchBrowser, getOrCreatePage, humanDelay } from "../src/browser.js";
import { SELECTORS } from "../src/boss/selectors.js";

const DETAIL_URL = "https://www.zhipin.com/job_detail/10f207cae14f19640nB62t-5EFBR.html";
const context = await launchBrowser();
try {
  const page = await getOrCreatePage(context);
  await page.goto(DETAIL_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await humanDelay(2_000, 3_000);

  const startChat = page.locator(SELECTORS.startChatButton);
  console.log("startChat count:", await startChat.count());
  await startChat.first().click();

  await page
    .waitForURL(/\/web\/geek\/chat/, { timeout: 15_000 })
    .catch((e) => console.log("waitForURL 失败:", e.message));
  console.log("跳转后 URL:", page.url());
  await humanDelay(2_000, 3_000);

  const editor = page.locator(SELECTORS.chatEditor).first();
  await editor
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch((e) => console.log("editor waitFor 失败:", e.message));
  const editorVisible = await editor.isVisible().catch(() => false);
  console.log("输入框可见:", editorVisible);

  if (editorVisible) {
    await editor.click();
    await humanDelay(300, 600);
    await page.keyboard.type("测试输入请勿发送", { delay: 20 });
    await humanDelay(900, 1_500);
    const sendAny = await page.locator("button.btn-send").count();
    const sendEnabled = await page.locator("button.btn-send:not(.disabled)").count();
    console.log("发送按钮(任意):", sendAny, "| 已激活:", sendEnabled);
    // 清空输入, 不发送
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await humanDelay(300, 600);
    console.log("链路验证完成 (未发送, 已清空)");
  }
} catch (error) {
  console.error("出错:", error.message);
} finally {
  await context.close();
}
