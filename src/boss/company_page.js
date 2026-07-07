import {
  getOrCreatePage,
  humanDelay,
  launchBrowser,
} from "../browser.js";
import { notifyText } from "../notify.js";
import { assertPageSafe } from "./greet.js";
import { SELECTORS } from "./selectors.js";

const COMPANY_PAGE_DELAY_MS = Object.freeze([3_000, 5_000]);
const COMPANY_PAGE_TURN_DELAY_MS = Object.freeze([2_000, 4_000]);
const DEFAULT_MAX_JOB_PAGES = 2;

const FUNDING_KEYWORDS = Object.freeze([
  "未融资",
  "天使轮",
  "A轮",
  "B轮",
  "C轮",
  "D轮",
  "E轮",
  "已上市",
  "不需要融资",
]);

export async function fetchCompanyIntel(
  page,
  {
    companyUrl,
    jobUrl,
    browserFactory = launchBrowser,
    db,
    notifyFn = notifyText,
    delayFn = humanDelay,
    maxJobPages = DEFAULT_MAX_JOB_PAGES,
    selectors = SELECTORS,
  } = {},
) {
  if (!companyUrl && !jobUrl) {
    throw new Error("fetchCompanyIntel requires companyUrl or jobUrl");
  }

  let context;
  if (!page) {
    context = await browserFactory();
    page = await getOrCreatePage(context);
  }

  try {
    if (jobUrl) {
      await navigateCompanyPage(page, jobUrl, { db, notifyFn, delayFn });
      companyUrl = await firstAbsoluteHref(page, selectors.detailCompanyLink);
      if (!companyUrl) {
        throw new Error(`Unable to find Boss company URL from ${jobUrl}`);
      }
      await delayFn(...COMPANY_PAGE_TURN_DELAY_MS);
    }

    await navigateCompanyPage(page, companyUrl, { db, notifyFn, delayFn });
    const meta = await readCompanyMeta(page, selectors);
    const jobsUrl = await firstAbsoluteHref(page, selectors.companyJobsLink);
    const jobsPosted = [];

    if (jobsUrl && page.url() !== jobsUrl) {
      await delayFn(...COMPANY_PAGE_TURN_DELAY_MS);
      await navigateCompanyPage(page, jobsUrl, { db, notifyFn, delayFn });
    }

    for (let pageIndex = 0; pageIndex < maxJobPages; pageIndex += 1) {
      jobsPosted.push(...(await readCompanyJobs(page, selectors)));
      if (pageIndex >= maxJobPages - 1) {
        break;
      }
      const nextUrl = await firstAbsoluteHref(page, selectors.companyNextPage);
      if (!nextUrl || nextUrl === page.url()) {
        break;
      }
      await delayFn(...COMPANY_PAGE_TURN_DELAY_MS);
      await navigateCompanyPage(page, nextUrl, { db, notifyFn, delayFn });
    }

    return {
      jobsPosted: dedupeJobs(jobsPosted),
      jobCount: meta.jobCount ?? jobsPosted.length,
      scale: meta.scale,
      funding: meta.funding,
      industry: meta.industry,
      hrActiveHint: meta.hrActiveHint,
    };
  } finally {
    if (context) {
      await context.close();
    }
  }
}

async function navigateCompanyPage(page, url, { db, notifyFn, delayFn }) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await assertPageSafe(page, {
    db,
    notifyFn,
    expectLoggedIn: true,
  });
  await delayFn(...COMPANY_PAGE_DELAY_MS);
}

async function readCompanyMeta(page, selectors) {
  const bannerText = await firstText(page, selectors.companyBanner);
  const bannerMeta = await firstText(page, selectors.companyBannerMeta);
  const statText = await firstText(page, selectors.companyStat);
  const jobCountText =
    (await firstText(page, selectors.companyJobCount)) ||
    (await firstText(page, selectors.companyJobsLink)) ||
    statText;
  const industryText = await firstText(page, selectors.companyIndustry);
  const businessText = await firstText(page, selectors.companyBusinessDetail);
  const combined = compactText([bannerMeta, bannerText, businessText].join(" "));

  return {
    jobCount: parseJobCount(jobCountText),
    scale: parseScale(combined),
    funding: parseFunding(combined),
    industry: industryText || parseIndustryFallback(bannerMeta),
    hrActiveHint: parseHrActiveHint(combined),
  };
}

async function readCompanyJobs(page, selectors) {
  const cardJobs = await page
    .locator(selectors.companyJobCard)
    .evaluateAll((cards, selectors) => {
      const compact = (value) => (value ?? "").replace(/\s+/g, " ").trim();
      const text = (root, selector) =>
        compact(root.querySelector(selector)?.textContent);
      return cards.map((card) => ({
        title: text(card, selectors.companyJobTitle),
        salary: text(card, selectors.companyJobSalary),
      }));
    }, selectors)
    .catch(() => []);
  const jobs = cardJobs.filter((job) => job.title && job.salary);
  if (jobs.length > 0) {
    return jobs;
  }

  return page
    .locator(selectors.companyJobTitle)
    .evaluateAll((titles, selectors) => {
      const compact = (value) => (value ?? "").replace(/\s+/g, " ").trim();
      const salaries = [
        ...document.querySelectorAll(selectors.companyJobSalary),
      ].map((element) => compact(element.textContent));
      return titles
        .map((title, index) => ({
          title: compact(title.textContent),
          salary: salaries[index] ?? "",
        }))
        .filter((job) => job.title && job.salary);
    }, selectors)
    .catch(() => []);
}

async function firstText(page, selector) {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) {
    return "";
  }
  return compactText(await locator.innerText().catch(() => ""));
}

async function firstAbsoluteHref(page, selector) {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) {
    return "";
  }
  const href = await locator.getAttribute("href").catch(() => "");
  if (!href || href.startsWith("javascript:")) {
    return "";
  }
  try {
    return new URL(href, page.url()).href;
  } catch {
    return href;
  }
}

function dedupeJobs(jobs) {
  const seen = new Set();
  const result = [];
  for (const job of jobs) {
    const key = `${job.title}\n${job.salary}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(job);
  }
  return result;
}

function parseJobCount(text) {
  const normalized = compactText(text);
  const precise =
    normalized.match(/招聘职位\((\d+)\)/) ??
    normalized.match(/(\d+)\s*在招职位/) ??
    normalized.match(/职位\((\d+)\)/);
  if (precise) {
    return Number.parseInt(precise[1], 10);
  }
  const firstNumber = normalized.match(/\d+/)?.[0];
  return firstNumber ? Number.parseInt(firstNumber, 10) : null;
}

function parseScale(text) {
  return (
    compactText(text).match(
      /(\d+\s*-\s*\d+\s*人|少于\s*\d+\s*人|\d+\s*人(?:以上|以下)?)/,
    )?.[0] ?? ""
  ).replace(/\s+/g, "");
}

function parseFunding(text) {
  const normalized = compactText(text);
  return FUNDING_KEYWORDS.find((keyword) => normalized.includes(keyword)) ?? "";
}

function parseIndustryFallback(text) {
  const normalized = compactText(text);
  let result = normalized;
  for (const keyword of FUNDING_KEYWORDS) {
    result = result.replace(keyword, "");
  }
  result = result.replace(parseScale(result), "");
  return compactText(result).slice(0, 40);
}

function parseHrActiveHint(text) {
  return (
    compactText(text).match(
      /(刚刚活跃|今日活跃|本周活跃|2周内活跃|本月活跃|半年内活跃|在线)/,
    )?.[0] ?? ""
  );
}

function compactText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}
