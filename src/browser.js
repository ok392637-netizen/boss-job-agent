import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "patchright";
import { config } from "./config.js";

const PAGE_NAVIGATION_HISTORY = new WeakMap();
export const BROWSER_LOCK_STALE_MS = 90 * 60 * 1_000;

export class BrowserBusyError extends Error {
  constructor(lockPath, lockInfo) {
    const owner = lockInfo?.pid ? ` by pid ${lockInfo.pid}` : "";
    super(`Browser profile is busy${owner}: ${lockPath}`);
    this.name = "BrowserBusyError";
    this.code = "BROWSER_BUSY";
    this.lockPath = lockPath;
    this.lockInfo = lockInfo;
  }
}

export async function launchBrowser({
  userDataDir,
  headless = false,
} = {}) {
  const testProfile = !userDataDir && isNodeTestChild();
  userDataDir = userDataDir ?? defaultUserDataDir();
  fs.mkdirSync(userDataDir, { recursive: true });
  const releaseProfileLock = acquireBrowserLock({
    lockPath: testProfile
      ? path.join(userDataDir, "agent.lock")
      : defaultBrowserLockPath(),
  });

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
  context.on("close", () => {
    releaseProfileLock();
    if (testProfile) {
      removeTemporaryBrowserProfile(userDataDir);
    }
  });
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

export function acquireBrowserLock({
  lockPath = defaultBrowserLockPath(),
  staleAfterMs = BROWSER_LOCK_STALE_MS,
  now = Date.now,
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (;;) {
    const nowMs = timestampMs(now());
    const payload = JSON.stringify(
      { pid: process.pid, createdAt: new Date(nowMs).toISOString() },
      null,
      2,
    );

    try {
      const descriptor = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(descriptor, payload);
      } finally {
        fs.closeSync(descriptor);
      }
      return releaseBrowserLock(lockPath, payload);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }

    const lockInfo = readBrowserLock(lockPath);
    if (!lockInfo) {
      continue;
    }
    if (nowMs - lockInfo.createdAtMs > staleAfterMs) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }

    throw new BrowserBusyError(lockPath, lockInfo);
  }
}

function defaultBrowserLockPath() {
  return path.join(config.paths.projectRoot, "data", "agent.lock");
}

function defaultUserDataDir() {
  if (isNodeTestChild()) {
    return fs.mkdtempSync(path.join(os.tmpdir(), "boss-job-agent-browser-"));
  }
  return config.paths.browserProfile;
}

function isNodeTestChild() {
  return process.env.NODE_TEST_CONTEXT?.startsWith("child") === true;
}

function removeTemporaryBrowserProfile(userDataDir) {
  const tempRoot = path.resolve(os.tmpdir());
  const target = path.resolve(userDataDir);
  if (!target.startsWith(`${tempRoot}${path.sep}`)) {
    return;
  }
  try {
    fs.rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch {
    // Chrome can keep profile files open briefly on Windows after close.
  }
}

function readBrowserLock(lockPath) {
  const stats = fs.statSync(lockPath, { throwIfNoEntry: false });
  if (!stats) {
    return null;
  }

  let raw = "";
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const parsedCreatedAtMs = Date.parse(parsed.createdAt);
  const createdAtMs = Number.isFinite(parsedCreatedAtMs)
    ? parsedCreatedAtMs
    : stats.mtimeMs;

  return {
    pid: parsed.pid ?? null,
    createdAt: parsed.createdAt ?? null,
    createdAtMs,
    mtimeMs: stats.mtimeMs,
    path: lockPath,
  };
}

function releaseBrowserLock(lockPath, payload) {
  let released = false;
  return () => {
    if (released) return;
    released = true;

    try {
      if (fs.readFileSync(lockPath, "utf8") === payload) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  };
}

function timestampMs(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  return Number(value);
}
