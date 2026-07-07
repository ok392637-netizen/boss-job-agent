import fs from "node:fs";
import path from "node:path";
import { humanDelay, launchBrowser } from "../src/browser.js";
import { PROJECT_ROOT } from "../src/config.js";
import {
  BAIDU_SEARCH_SELECTORS,
  buildBaiduReputationQueries,
  detectBaiduDegradation,
} from "../src/research/web_search.js";
import {
  TIANYANCHA_SEARCH_SELECTORS,
  detectTianyanchaDegradation,
} from "../src/research/tianyancha.js";

const MAX_HTML_LENGTH = 3_000;
const DEFAULT_COMPANY = "\u5e7f\u5dde\u4fe1\u8f90\u4f01\u4e1a\u54a8\u8be2";

const args = process.argv.slice(2);
const company = args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_COMPANY;
const headless = process.argv.includes("--headless");
const logPath = path.join(
  PROJECT_ROOT,
  "data",
  "logs",
  `verify-search-dom-${timestampForFile()}.log`,
);
fs.mkdirSync(path.dirname(logPath), { recursive: true });

const lines = [];
let context;

try {
  logSection("input", { company, headless });
  context = await launchBrowser({ headless });

  const baiduPage = await context.newPage();
  const baiduQueries = buildBaiduReputationQueries(company);
  for (const [index, query] of baiduQueries.entries()) {
    log(`\n# baidu query ${index + 1}: ${query}`);
    await baiduPage.goto(baiduUrl(query), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await humanDelay(2_000, 4_000);

    const degradedReason = await detectBaiduDegradation(baiduPage);
    logSection("baidu-page", {
      requested: baiduUrl(query),
      current: baiduPage.url(),
      title: await baiduPage.title().catch(() => ""),
      degradedReason,
    });
    if (degradedReason) {
      logSection("baidu-security-fact", {
        fact: "Baidu displayed a captcha/security page; selector dump skipped.",
        degradedReason,
        body: await bodySummary(baiduPage),
      });
      break;
    }

    logSection("baidu-selector-counts", await selectorCounts(baiduPage, BAIDU_SEARCH_SELECTORS));
    logSection(
      "baidu-result-samples",
      await candidateSamples(baiduPage, BAIDU_SEARCH_SELECTORS.result, 8),
    );
    logSection("baidu-body-summary", await bodySummary(baiduPage));

    if (index < baiduQueries.length - 1) {
      await humanDelay(8_000, 20_000);
    }
  }

  const tycPage = await context.newPage();
  log(`\n# tianyancha query: ${company}`);
  await tycPage.goto(tianyanchaUrl(company), {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await humanDelay(2_000, 4_000);
  const tycDegradedReason = await detectTianyanchaDegradation(tycPage);
  logSection("tyc-page", {
    requested: tianyanchaUrl(company),
    current: tycPage.url(),
    title: await tycPage.title().catch(() => ""),
    degradedReason: tycDegradedReason,
  });
  if (tycDegradedReason) {
    logSection("tyc-degraded-fact", {
      fact: "Tianyancha displayed a login/captcha/security page; selector dump skipped.",
      degradedReason: tycDegradedReason,
      body: await bodySummary(tycPage),
    });
  } else {
    logSection("tyc-selector-counts", await selectorCounts(tycPage, TIANYANCHA_SEARCH_SELECTORS));
    logSection(
      "tyc-result-samples",
      await candidateSamples(tycPage, TIANYANCHA_SEARCH_SELECTORS.result, 8),
    );
    logSection("tyc-body-summary", await bodySummary(tycPage));
  }
} catch (error) {
  logSection("error", {
    name: error.name,
    message: error.message,
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
}

async function selectorCounts(page, selectors) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(selectors).map(async ([name, selector]) => [
        name,
        await page.locator(selector).count().catch(() => -1),
      ]),
    ),
  );
}

async function candidateSamples(page, selector, maxItems) {
  return page
    .locator(selector)
    .evaluateAll(
      (elements, { maxItems, maxHtmlLength }) =>
        elements.slice(0, maxItems).map((element, index) => ({
          index,
          tagName: element.tagName.toLowerCase(),
          className:
            typeof element.className === "string" ? element.className : "",
          text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 500),
          href: element.href || element.getAttribute("href"),
          outerHTML: element.outerHTML.slice(0, maxHtmlLength),
        })),
      { maxItems, maxHtmlLength: MAX_HTML_LENGTH },
    )
    .catch((error) => [{ error: error.message }]);
}

async function bodySummary(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
    return {
      title: document.title,
      url: location.href,
      textLength: text.length,
      text: text.slice(0, 4_000),
    };
  });
}

function baiduUrl(query) {
  return `https://www.baidu.com/s?${new URLSearchParams({ wd: query })}`;
}

function tianyanchaUrl(company) {
  return `https://www.tianyancha.com/search?${new URLSearchParams({ key: company })}`;
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
