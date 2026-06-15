import { getNavigationHistory } from "../browser.js";
import { notifyText } from "../notify.js";
import { SELECTORS, URLS } from "./selectors.js";

export const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
export const SECURITY_CHECK_WAIT_MESSAGE =
  "⚠️ Boss 触发安全验证, 请在打开的浏览器窗口完成验证 (滑块/短信), 我会等最多 10 分钟";
export const SECURITY_CHECK_PASSED_MESSAGE = "Boss 安全验证已通过, 继续";

export async function getLoginState(page) {
  const history = getNavigationHistory(page);
  if (isSecurityUrl(page.url())) {
    return { status: "security_check", history };
  }

  if (page.url() === "about:blank" && history.length > 0) {
    return { status: "access_required", history };
  }

  const body = await safeBodyText(page);
  if (await anyVisible(page, SELECTORS.loggedOutHeader)) {
    return { status: "logged_out", history };
  }
  if (
    page.url().includes("/web/user/") ||
    (await anyVisible(page, SELECTORS.loginContainer)) ||
    (await anyVisible(page, SELECTORS.qrCode))
  ) {
    return { status: "logged_out", history };
  }
  if (await anyVisible(page, SELECTORS.loggedInHeader)) {
    return { status: "logged_in", history };
  }
  if (/登录\/注册|扫码登录|请扫码/.test(body)) {
    return { status: "logged_out", history };
  }

  return { status: "unknown", history };
}

export async function ensureLoggedIn(
  page,
  {
    notifyFn = notifyText,
    timeoutMs = LOGIN_TIMEOUT_MS,
    pollIntervalMs = 2_000,
  } = {},
) {
  const initial = await getLoginState(page);
  if (initial.status === "logged_in") {
    return true;
  }

  await page.goto(URLS.login, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await notifyFn("请扫码登录 Boss直聘，等待时间 10 分钟。");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getLoginState(page);
    if (state.status === "logged_in") {
      await notifyFn("Boss直聘登录成功。");
      return true;
    }
    if (state.status === "security_check" || state.status === "access_required") {
      throw new BossLoginError(
        `Boss login blocked by ${state.status}`,
        state.status,
        state.history,
      );
    }
    await page.waitForTimeout(pollIntervalMs);
  }

  throw new BossLoginError("Boss login timed out after 10 minutes", "timeout");
}

export async function waitForSecurityCheckRecovery(
  page,
  {
    notifyFn = notifyText,
    timeoutMs = LOGIN_TIMEOUT_MS,
    pollIntervalMs = 2_000,
    getLoginStateFn = getLoginState,
    waitFn = (milliseconds) => page.waitForTimeout(milliseconds),
    nowFn = Date.now,
  } = {},
) {
  let state = await getLoginStateFn(page);
  if (
    state.status !== "security_check" &&
    !isSecurityUrl(page.url())
  ) {
    return false;
  }

  await notifyFn(SECURITY_CHECK_WAIT_MESSAGE);
  const deadline = nowFn() + timeoutMs;

  while (nowFn() < deadline) {
    state = await getLoginStateFn(page);
    if (
      !isSecurityUrl(page.url()) &&
      state.status === "logged_in"
    ) {
      await notifyFn(SECURITY_CHECK_PASSED_MESSAGE);
      return true;
    }
    await waitFn(pollIntervalMs);
  }

  throw new BossLoginError(
    "Boss security verification timed out after 10 minutes",
    "security_timeout",
    state.history ?? getNavigationHistory(page),
  );
}

export class BossLoginError extends Error {
  constructor(message, reason, history = []) {
    super(message);
    this.name = "BossLoginError";
    this.code = "BOSS_LOGIN_REQUIRED";
    this.reason = reason;
    this.history = history;
  }
}

export function isSecurityUrl(url) {
  return (
    url.includes("/web/passport/zp/security.html") ||
    url.includes("/safe/verify") ||
    url.includes("_security_check=")
  );
}

async function safeBodyText(page) {
  if (page.isClosed()) return "";
  try {
    return await page.locator("body").innerText({ timeout: 1_000 });
  } catch {
    return "";
  }
}

async function anyVisible(page, selector) {
  const locator = page.locator(selector);
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible()) {
      return true;
    }
  }
  return false;
}
