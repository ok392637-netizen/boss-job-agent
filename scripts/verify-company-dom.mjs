import fs from "node:fs";
import path from "node:path";
import {
  getNavigationHistory,
  getOrCreatePage,
  humanDelay,
  launchBrowser,
  trackPageNavigations,
} from "../src/browser.js";
import { PROJECT_ROOT } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { assertPageSafe } from "../src/boss/greet.js";
import { notifyText } from "../src/notify.js";

const MAX_HTML_LENGTH = 3_000;
const JOB_LIMIT = 3;

const COMPANY_LINK_SELECTORS = [
  "a[ka='job-detail-company']",
  ".job-company-info a[href*='/gongsi/']",
  ".job-banner a[href*='/gongsi/']",
  ".company-info a[href*='/gongsi/']",
  "a[href*='/gongsi/']",
  "a[href*='/company/']",
];

const COMPANY_FIELD_SELECTORS = [
  ".company-banner",
  ".company-info",
  ".company-info-box",
  ".company-base",
  ".business-detail",
  ".sider-company",
  ".company-stat",
  ".company-tags",
  "[class*='industry']",
  "[class*='financ']",
  "[class*='scale']",
  "[class*='stage']",
  "[class*='size']",
];

const COMPANY_JOB_SELECTORS = [
  "li.job-card-box",
  ".job-card-box",
  ".job-card",
  ".job-primary",
  ".job-item",
  ".job-name",
  ".job-salary",
  ".job-list li",
  ".job-list-box",
  ".job-list-box li",
  ".company-job-list li",
  ".company-tab a[href*='/gongsi/job/']",
  "[class*='job-card']",
  "[class*='job-list'] li",
];

const logPath = path.join(
  PROJECT_ROOT,
  "data",
  "logs",
  `verify-company-dom-${timestampForFile()}.log`,
);
fs.mkdirSync(path.dirname(logPath), { recursive: true });

const db = openDatabase();
const lines = [];
let context;

try {
  const jobs = db
    .prepare(
      `SELECT id, title, company, url
       FROM jobs
       WHERE url IS NOT NULL AND url LIKE '%/job_detail/%'
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(JOB_LIMIT);

  logSection("jobs", jobs);
  if (jobs.length === 0) {
    throw new Error("No real Boss job URLs found in jobs table");
  }

  context = await launchBrowser({ headless: false });
  const page = await getOrCreatePage(context);
  trackPageNavigations(page);

  for (const [index, job] of jobs.entries()) {
    log(`\n# job ${index + 1}: ${job.id} ${job.company} ${job.title}`);
    await page.goto(job.url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await assertPageSafe(page, {
      db,
      notifyFn: notifyText,
      expectLoggedIn: true,
    });
    await humanDelay(3_000, 5_000);

    const detailDump = await dumpJobDetailCompanyEntrypoint(page);
    logSection("detail-company-entry", detailDump);

    const companyUrl = detailDump.firstCompanyUrl;
    if (!companyUrl) {
      log("no company URL found; skipping company page dump");
      continue;
    }

    await humanDelay(2_000, 4_000);
    await page.goto(companyUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await assertPageSafe(page, {
      db,
      notifyFn: notifyText,
      expectLoggedIn: true,
    });
    await humanDelay(3_000, 5_000);
    await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
    await humanDelay(800, 1_500);

    logSection("company-page-url", {
      requested: companyUrl,
      current: page.url(),
      history: getNavigationHistory(page),
    });
    logSection("company-field-counts", await selectorCounts(page, COMPANY_FIELD_SELECTORS));
    logSection(
      "company-field-samples",
      await candidateSamples(page, COMPANY_FIELD_SELECTORS, 5),
    );
    logSection("company-job-counts", await selectorCounts(page, COMPANY_JOB_SELECTORS));
    logSection("company-job-samples", await candidateSamples(page, COMPANY_JOB_SELECTORS, 8));
    logSection("company-body-summary", await bodySummary(page));

    const companyJobsUrl = await firstCompanyJobsUrl(page);
    logSection("company-jobs-url", { companyJobsUrl });
    if (companyJobsUrl) {
      await humanDelay(2_000, 4_000);
      await page.goto(companyJobsUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await assertPageSafe(page, {
        db,
        notifyFn: notifyText,
        expectLoggedIn: true,
      });
      await humanDelay(3_000, 5_000);
      await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
      await humanDelay(800, 1_500);
      logSection("company-jobs-page-url", {
        requested: companyJobsUrl,
        current: page.url(),
        history: getNavigationHistory(page),
      });
      logSection(
        "company-jobs-page-counts",
        await selectorCounts(page, COMPANY_JOB_SELECTORS),
      );
      logSection(
        "company-jobs-page-samples",
        await candidateSamples(page, COMPANY_JOB_SELECTORS, 12),
      );
      logSection("company-jobs-body-summary", await bodySummary(page));
    }

    if (index < jobs.length - 1) {
      await humanDelay(5_000, 9_000);
    }
  }
} catch (error) {
  logSection("error", {
    name: error.name,
    message: error.message,
    reason: error.reason,
    code: error.code,
    stack: error.stack,
  });
  process.exitCode = error.code === "BROWSER_BUSY" ? 75 : 1;
} finally {
  fs.writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  console.log(logPath);
  if (context) {
    await context.close();
  }
  db.close();
}

async function dumpJobDetailCompanyEntrypoint(page) {
  const links = await page.evaluate((selectors) => {
    const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
    return selectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)].slice(0, 5).map((element) => ({
        selector,
        tagName: element.tagName.toLowerCase(),
        className:
          typeof element.className === "string" ? element.className : "",
        text: normalize(element.textContent).slice(0, 200),
        href: element.href || element.getAttribute("href") || "",
        outerHTML: element.outerHTML.slice(0, 1_500),
      })),
    );
  }, COMPANY_LINK_SELECTORS);
  return {
    url: page.url(),
    counts: await selectorCounts(page, COMPANY_LINK_SELECTORS),
    links,
    firstCompanyUrl: links.find((link) => link.href)?.href ?? "",
  };
}

async function selectorCounts(page, selectors) {
  const counts = {};
  for (const selector of selectors) {
    counts[selector] = await page.locator(selector).count().catch(() => -1);
  }
  return counts;
}

async function candidateSamples(page, selectors, maxItems) {
  const samples = {};
  for (const selector of selectors) {
    samples[selector] = await page
      .locator(selector)
      .evaluateAll(
        (elements, { maxItems, maxHtmlLength }) =>
          elements.slice(0, maxItems).map((element, index) => ({
            index,
            tagName: element.tagName.toLowerCase(),
            className:
              typeof element.className === "string" ? element.className : "",
            text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 300),
            href: element.href || element.getAttribute("href"),
            outerHTML: element.outerHTML.slice(0, maxHtmlLength),
          })),
        { maxItems, maxHtmlLength: MAX_HTML_LENGTH },
      )
      .catch((error) => [{ error: error.message }]);
  }
  return samples;
}

async function bodySummary(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
    return {
      title: document.title,
      url: location.href,
      textLength: text.length,
      text: text.slice(0, 4_000),
      links: [...document.querySelectorAll("a[href]")]
        .slice(0, 80)
        .map((element) => ({
          text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 120),
          href: element.href,
          className:
            typeof element.className === "string" ? element.className : "",
        })),
    };
  });
}

async function firstCompanyJobsUrl(page) {
  return page.evaluate(() => {
    const link = [...document.querySelectorAll("a[href*='/gongsi/job/']")]
      .find((element) => element.href);
    return link?.href ?? "";
  });
}

function log(line) {
  lines.push(line);
}

function logSection(title, value) {
  lines.push(`\n## ${title}`);
  lines.push(JSON.stringify(value, null, 2));
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
