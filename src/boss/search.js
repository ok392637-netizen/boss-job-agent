import {
  getOrCreatePage,
  humanDelay,
  launchBrowser,
  trackPageNavigations,
} from "../browser.js";
import { deriveJobId, normalizeHrFields } from "../db.js";
import { notifyText } from "../notify.js";
import {
  BossLoginError,
  getLoginState,
  waitForSecurityCheckRecovery,
} from "./login.js";
import { SELECTORS, URLS } from "./selectors.js";

export const JOB_READING_DELAY_MS = Object.freeze([4_000, 10_000]);
export const JOB_SCROLL_DELAY_MS = Object.freeze([600, 1_600]);

export async function searchJobs(
  filters,
  {
    page,
    browserFactory = launchBrowser,
    outcomeTimeoutMs = 12_000,
    notifyFn = notifyText,
    securityRecoveryFn = waitForSecurityCheckRecovery,
    securityRecoveryOptions = {},
  } = {},
) {
  let context;
  if (!page) {
    context = await browserFactory();
    page = await getOrCreatePage(context);
  }

  const history = trackPageNavigations(page);
  const startIndex = history.length;
  try {
    await page.goto(URLS.search(filters), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitForSearchOutcome(page, history, startIndex, outcomeTimeoutMs, {
      notifyFn,
      securityRecoveryFn,
      securityRecoveryOptions,
    });

    const cards = await parseSearchCards(page);
    const limit = filters.maxJobsPerScan ?? cards.length;
    return cards.slice(0, limit);
  } finally {
    if (context) {
      await context.close();
    }
  }
}

export async function fetchJD(
  job,
  {
    page,
    browserFactory = launchBrowser,
    notifyFn = notifyText,
    securityRecoveryFn = waitForSecurityCheckRecovery,
    securityRecoveryOptions = {},
    delayFn = humanDelay,
    randomFn = Math.random,
    scrollFn,
  } = {},
) {
  let context;
  if (!page) {
    context = await browserFactory();
    page = await getOrCreatePage(context);
  }

  try {
    await page.goto(job.url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    let state = await getLoginState(page);
    if (state.status === "security_check") {
      await securityRecoveryFn(page, {
        notifyFn,
        ...securityRecoveryOptions,
      });
      state = await getLoginState(page);
    }
    if (state.status !== "logged_in" && state.status !== "unknown") {
      throw new BossLoginError(
        `Boss job detail requires access: ${state.status}`,
        state.status,
        state.history,
      );
    }

    await simulateJobReading(page, {
      delayFn,
      randomFn,
      scrollFn,
    });

    const jd = await firstText(page, SELECTORS.detailDescription);
    if (!jd) {
      throw new Error(`Unable to extract JD from ${job.url}`);
    }
    return {
      ...job,
      title: (await firstText(page, SELECTORS.detailTitle)) || job.title,
      company: (await firstText(page, SELECTORS.detailCompany)) || job.company,
      salary: (await firstText(page, SELECTORS.detailSalary)) || job.salary,
      hrName: (await firstText(page, SELECTORS.detailHrName)) || job.hrName,
      jd,
    };
  } finally {
    if (context) {
      await context.close();
    }
  }
}

export async function simulateJobReading(
  page,
  {
    delayFn = humanDelay,
    randomFn = Math.random,
    scrollFn = scrollPage,
  } = {},
) {
  await delayFn(...JOB_READING_DELAY_MS);
  const scrollCount = 2 + Math.floor(randomFn() * 3);
  for (let index = 0; index < scrollCount; index += 1) {
    const deltaY = 180 + Math.floor(randomFn() * 341);
    await scrollFn(page, deltaY);
    if (index < scrollCount - 1) {
      await delayFn(...JOB_SCROLL_DELAY_MS);
    }
  }
  return scrollCount;
}

export async function parseSearchCards(page) {
  return page.locator(SELECTORS.jobCard).evaluateAll((cards, selectors) => {
    const text = (root, selector) =>
      root.querySelector(selector)?.textContent?.trim() ?? "";
    return cards.map((card) => {
      const link = card.querySelector(selectors.jobCardLink);
      const url = link?.href ?? "";
      return {
        url,
        title: text(card, selectors.jobTitle),
        company: text(card, selectors.companyName),
        salary: text(card, selectors.salary),
        city: text(card, selectors.jobArea),
        hrName: text(card, selectors.hrName),
      };
    });
  }, SELECTORS).then((jobs) =>
    jobs
      .filter((job) => job.url && job.title && job.company && job.salary)
      .map((job) => {
        const hr = normalizeHrFields({ hrName: job.hrName });
        return {
          ...job,
          hrName: hr.hr_name ?? "",
          hrActive: hr.hr_active ?? "",
          id: deriveJobId(job),
        };
      }),
  );
}

async function waitForSearchOutcome(
  page,
  history,
  startIndex,
  timeoutMilliseconds,
  {
    notifyFn,
    securityRecoveryFn,
    securityRecoveryOptions,
  },
) {
  let deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const attemptHistory = history.slice(startIndex);
    if (page.isClosed()) {
      throw new BossLoginError(
        "Boss search page closed before results loaded",
        "access_required",
        attemptHistory,
      );
    }
    if (page.url() === "about:blank" && attemptHistory.length > 0) {
      throw new BossLoginError(
        "Boss search blanked the page before results loaded",
        "access_required",
        attemptHistory,
      );
    }
    if ((await page.locator(SELECTORS.jobCard).count()) > 0) {
      return;
    }

    const state = await getLoginState(page);
    if (state.status === "security_check") {
      await securityRecoveryFn(page, {
        notifyFn,
        ...securityRecoveryOptions,
      });
      deadline = Date.now() + timeoutMilliseconds;
      continue;
    }
    if (state.status === "logged_out") {
      throw new BossLoginError(
        "Boss search requires login",
        "logged_out",
        attemptHistory,
      );
    }
    await page.waitForTimeout(250);
  }

  throw new Error(`Boss search did not reach a known state within ${timeoutMilliseconds}ms`);
}

async function firstText(page, selector) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) return "";
  return (await locator.innerText()).trim();
}

async function scrollPage(page, deltaY) {
  if (page.mouse?.wheel) {
    await page.mouse.wheel(0, deltaY);
    return;
  }
  await page.evaluate((amount) => window.scrollBy(0, amount), deltaY);
}
