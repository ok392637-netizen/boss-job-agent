import { config } from "../config.js";
import {
  getMeta,
  incrementMetaCounter,
  openDatabase,
  setMeta,
  updateJobStatus,
} from "../db.js";
import { humanDelay } from "../browser.js";
import { notifyText } from "../notify.js";
import { SELECTORS } from "./selectors.js";

export const CIRCUIT_ALERT =
  "⚠️ Boss直聘触发风控/掉线, 已停止, 需人工处理";

export class CircuitBreakerError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "CircuitBreakerError";
    this.code = "BOSS_CIRCUIT_OPEN";
    this.exitCode = 2;
    this.reason = reason;
  }
}

export class GreetConstraintError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "GreetConstraintError";
    this.code = "BOSS_GREET_CONSTRAINT";
    this.reason = reason;
  }
}

export async function greetJob(
  page,
  job,
  text,
  {
    db,
    dryRun = config.greeting.dryRun,
    notifyFn = notifyText,
    delayFn = humanDelay,
    now = new Date(),
  } = {},
) {
  let ownedDatabase;
  if (!db) {
    ownedDatabase = openDatabase();
    db = ownedDatabase;
  }

  try {
    assertGreetAllowed(db, { now, dryRun });
    await page.goto(job.url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await assertPageSafe(page, { db, notifyFn, expectLoggedIn: true });
    await delayFn(500, 1_500);

    const startChat = await firstVisible(page, SELECTORS.startChatButton);
    if (!startChat) {
      throw new Error(`Unable to find start-chat button for ${job.url}`);
    }

    if (dryRun) {
      console.log(
        `[DRY-RUN] would click 立即沟通 and greet ${job.company} ${job.title}: ${text}`,
      );
      updateJobStatus(db, job.id, "greeted");
      incrementMetaCounter(db, greetCounterKey(now, true));
      return { dryRun: true, status: "greeted", sent: false };
    }

    await startChat.click();
    // "立即沟通/继续沟通" 是同页 JS 跳转到 /web/geek/chat, 必须等跳转完成再找输入框
    await page
      .waitForURL(/\/web\/geek\/chat/, { timeout: 15_000 })
      .catch(() => {});
    await delayFn(1_500, 3_000);
    await assertPageSafe(page, { db, notifyFn, expectLoggedIn: true });

    const editor = await waitForVisible(page, SELECTORS.chatEditor, 15_000);
    if (!editor) {
      throw new Error(`Unable to find chat editor for ${job.url}`);
    }
    await editor.click();
    await delayFn(150, 400);
    // .chat-input 是 contenteditable div, 用键盘逐字输入以触发 Boss 的发送按钮激活逻辑
    await page.keyboard.type(text, { delay: 18 });
    await delayFn(400, 900);

    const sendButton = await waitForVisible(
      page,
      SELECTORS.sendMessageButton,
      3_000,
    );
    if (!sendButton) {
      throw new Error(`Unable to find send button for ${job.url}`);
    }

    await sendButton.click();

    updateJobStatus(db, job.id, "greeted");
    incrementMetaCounter(db, greetCounterKey(now, false));
    return { dryRun: false, status: "greeted", sent: true };
  } finally {
    ownedDatabase?.close();
  }
}

export function assertGreetAllowed(
  db,
  { now = new Date(), dryRun = config.greeting.dryRun } = {},
) {
  const circuitOpen = getMeta(db, "circuit_open");
  if (circuitOpen) {
    throw new CircuitBreakerError(
      `Boss circuit is already open since ${circuitOpen}`,
      "circuit_open",
    );
  }

  const [startHour, endHour] = config.greeting.activeHours;
  const hour = now.getHours();
  if (hour < startHour || hour >= endHour) {
    throw new GreetConstraintError(
      `Greeting is only allowed during ${startHour}:00-${endHour}:00`,
      "outside_active_hours",
    );
  }

  const count = Number.parseInt(
    getMeta(db, greetCounterKey(now, dryRun)) ?? "0",
    10,
  );
  if (count >= config.greeting.dailyLimit) {
    throw new GreetConstraintError(
      `Daily greeting limit reached: ${count}/${config.greeting.dailyLimit}`,
      "daily_limit",
    );
  }
  return true;
}

export async function detectCircuitCondition(
  page,
  { expectLoggedIn = true } = {},
) {
  const url = page.url();
  if (
    url.includes("/safe/verify") ||
    url.includes("/web/passport/zp/security.html") ||
    url.includes("_security_check=")
  ) {
    return { reason: "verification_url", detail: url };
  }

  if (await anyVisible(page, SELECTORS.securityIframe)) {
    return { reason: "verification_iframe", detail: url };
  }

  const bodyText = await safeBodyText(page);
  const verificationText = bodyText.match(
    /安全验证|验证码|拖动.{0,8}滑块|请完成验证/,
  );
  if (verificationText) {
    return {
      reason: "verification_text",
      detail: verificationText[0],
    };
  }

  if (
    expectLoggedIn &&
    (await anyVisible(page, SELECTORS.loggedOutHeader))
  ) {
    return { reason: "login_lost", detail: url };
  }
  return null;
}

export async function assertPageSafe(
  page,
  { db, notifyFn = notifyText, expectLoggedIn = true } = {},
) {
  const condition = await detectCircuitCondition(page, { expectLoggedIn });
  if (!condition) {
    return true;
  }

  const openedAt = localTimestamp();
  if (db) {
    setMeta(db, "circuit_open", openedAt);
  }
  let notifyError;
  try {
    await notifyFn(CIRCUIT_ALERT);
  } catch (error) {
    notifyError = error;
  }
  const circuitError = new CircuitBreakerError(
    `Boss circuit opened: ${condition.reason} (${condition.detail})`,
    condition.reason,
  );
  if (notifyError) {
    circuitError.cause = notifyError;
  }
  throw circuitError;
}

export function greetCounterKey(now, dryRun) {
  const date = localDate(now);
  return dryRun ? `greet_count_dry_${date}` : `greet_count_${date}`;
}

async function waitForVisible(page, selector, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const locator = await firstVisible(page, selector);
    if (locator) return locator;
    await page.waitForTimeout(100);
  }
  return null;
}

async function firstVisible(page, selector) {
  const locators = page.locator(selector);
  for (let index = 0; index < (await locators.count()); index += 1) {
    const locator = locators.nth(index);
    if (await locator.isVisible()) {
      return locator;
    }
  }
  return null;
}

async function anyVisible(page, selector) {
  return Boolean(await firstVisible(page, selector));
}

async function safeBodyText(page) {
  if (page.isClosed()) return "";
  try {
    return await page.locator("body").innerText({ timeout: 1_000 });
  } catch {
    return "";
  }
}

function localDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function localTimestamp() {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19).replace("T", " ");
}
