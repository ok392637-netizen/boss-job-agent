import fs from "node:fs";
import { chromium } from "patchright";
import { config } from "./config.js";

const PAGE_NAVIGATION_HISTORY = new WeakMap();

export async function launchBrowser({
  userDataDir = config.paths.browserProfile,
  headless = false,
} = {}) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const releaseProfileLock = await acquireProfileLock(userDataDir);

  const options = {
    headless,
    viewport: null,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
    ],
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      ...options,
      channel: "chrome",
    });
  } catch (chromeError) {
    try {
      context = await chromium.launchPersistentContext(userDataDir, options);
    } catch (chromiumError) {
      releaseProfileLock();
      throw new AggregateError(
        [chromeError, chromiumError],
        "Unable to launch Chrome or bundled Chromium",
      );
    }
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      configurable: true,
      get: () => undefined,
    });
  });

  for (const page of context.pages()) {
    trackPageNavigations(page);
  }
  context.on("page", trackPageNavigations);
  context.on("close", releaseProfileLock);
  return context;
}

export function getOrCreatePage(context) {
  const page = context.pages().find((candidate) => !candidate.isClosed());
  return page ?? context.newPage();
}

export function trackPageNavigations(page) {
  if (PAGE_NAVIGATION_HISTORY.has(page)) {
    return PAGE_NAVIGATION_HISTORY.get(page);
  }

  const history = [];
  PAGE_NAVIGATION_HISTORY.set(page, history);
  if (page.url() !== "about:blank") {
    history.push(page.url());
  }
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      history.push(frame.url());
    }
  });
  return history;
}

export function getNavigationHistory(page) {
  return [...trackPageNavigations(page)];
}

export async function humanDelay(minMilliseconds, maxMilliseconds) {
  if (
    !Number.isFinite(minMilliseconds) ||
    !Number.isFinite(maxMilliseconds) ||
    minMilliseconds < 0 ||
    maxMilliseconds < minMilliseconds
  ) {
    throw new Error("Invalid human delay range");
  }

  const duration = Math.floor(
    minMilliseconds + Math.random() * (maxMilliseconds - minMilliseconds + 1),
  );
  await new Promise((resolve) => setTimeout(resolve, duration));
  return duration;
}

async function acquireProfileLock(userDataDir) {
  const lockPath = `${userDataDir}.lock`;
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(
        descriptor,
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      );
      fs.closeSync(descriptor);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.rmSync(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      const stats = fs.statSync(lockPath, { throwIfNoEntry: false });
      if (stats && Date.now() - stats.mtimeMs > 5 * 60_000) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw new Error(`Timed out waiting for browser profile lock: ${lockPath}`);
}
