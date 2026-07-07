import { launchBrowser } from "../browser.js";

export const TIANYANCHA_SEARCH_SELECTORS = Object.freeze({
  result:
    ".search-item, .result-list .result-item, .search-result-single, [class*='search-item'], [class*='searchItem'], [class*='Search_item']",
  title:
    "a[href*='/company/'], a[href*='/brand/'], .name a, [class*='name'] a, [class*='Name'] a",
});

export async function fetchTianyanchaBestEffort(
  company,
  {
    page,
    context,
    browserFactory = launchBrowser,
    selectors = TIANYANCHA_SEARCH_SELECTORS,
    timeoutMs = 60_000,
    now = new Date(),
  } = {},
) {
  const name = normalizeCompany(company);
  if (!name) {
    throw new Error("Tianyancha search requires company");
  }

  let ownContext;
  let ownPage;
  try {
    if (!page) {
      if (!context) {
        ownContext = await browserFactory();
        context = ownContext;
      }
      page = await context.newPage();
      ownPage = page;
    }

    await page.goto(tianyanchaSearchUrl(name), {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    const blockedReason = await detectTianyanchaDegradation(page);
    if (blockedReason) {
      return { data: null, degraded: true, reason: blockedReason };
    }

    const data = await extractTianyanchaFirstResult(page, {
      company: name,
      selectors,
      now,
    });
    if (!data) {
      return { data: null, degraded: true, reason: "tyc_structure_changed" };
    }

    return { data, degraded: false };
  } catch (error) {
    return {
      data: null,
      degraded: true,
      reason: `tyc_error:${error.message}`,
    };
  } finally {
    if (ownPage && !ownPage.isClosed()) {
      await ownPage.close().catch(() => {});
    }
    if (ownContext) {
      await ownContext.close();
    }
  }
}

export async function extractTianyanchaFirstResult(
  page,
  {
    company,
    selectors = TIANYANCHA_SEARCH_SELECTORS,
    now = new Date(),
  } = {},
) {
  const name = normalizeCompany(company);
  const cards = await page
    .locator(selectors.result)
    .evaluateAll(
      (cards, selectors) =>
        cards.map((card) => {
          const compact = (value) =>
            (value ?? "").replace(/\s+/g, " ").trim();
          const titleElement = card.querySelector(selectors.title);
          return {
            name: compact(titleElement?.innerText ?? titleElement?.textContent),
            text: compact(card.innerText ?? card.textContent),
            url: titleElement?.href ?? titleElement?.getAttribute("href") ?? "",
          };
        }),
      selectors,
    )
    .catch(() => []);

  const match = cards.find(
    (card) =>
      includesCompany(card.name, name) || includesCompany(card.text, name),
  );
  if (!match) {
    return null;
  }

  const parsed = parseTianyanchaText(match, { company: name, now });
  if (
    parsed.establishedYears === null &&
    !parsed.registeredCapital &&
    parsed.ownRiskCount === null
  ) {
    return null;
  }
  return parsed;
}

export async function detectTianyanchaDegradation(page) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 1_000 })
    .catch(() => "");
  const text = `${url}\n${title}\n${bodyText.slice(0, 2_000)}`;

  if (
    /captcha|verify|antirobot|security/i.test(text) ||
    /\u8bf7\u767b\u5f55|\u767b\u5f55\u540e|\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u8bf7\u5b8c\u6210\u9a8c\u8bc1|\u8bbf\u95ee\u5f02\u5e38|\u64cd\u4f5c\u5b58\u5728\u5f02\u5e38|\u6682\u505c\u60a8\u7684\u8bbf\u95ee/.test(
      text,
    )
  ) {
    return "tyc_login_or_captcha";
  }

  return "";
}

export function parseTianyanchaText(
  { name, text, url },
  { company, now = new Date() } = {},
) {
  const normalizedText = compactText(text);
  const establishedDate = extractFirst(
    normalizedText,
    /(?:\u6210\u7acb\u65e5\u671f|\u6210\u7acb\u65f6\u95f4)[:\uff1a\s]*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}\u5e74\d{1,2}\u6708\d{1,2}\u65e5)/,
  );
  const directYears = extractFirst(
    normalizedText,
    /\u6210\u7acb\u5e74\u9650[:\uff1a\s]*(\d+)\s*\u5e74/,
  );
  const registeredCapital = extractFirst(
    normalizedText,
    /\u6ce8\u518c\u8d44\u672c[:\uff1a\s]*([0-9,.]+(?:\s*(?:\u4e07|\u4ebf))?\s*(?:\u4eba\u6c11\u5e01|\u7f8e\u5143|\u6e2f\u5143|\u5143)?)/,
  );
  const ownRisk = extractFirst(
    normalizedText,
    /\u81ea\u8eab\u98ce\u9669[:\uff1a\s]*(\d+)/,
  );

  return {
    company: normalizeCompany(company),
    name: compactText(name),
    establishedDate: establishedDate || "",
    establishedYears: directYears
      ? Number.parseInt(directYears, 10)
      : yearsSince(establishedDate, now),
    registeredCapital: compactText(registeredCapital),
    ownRiskCount: ownRisk ? Number.parseInt(ownRisk, 10) : null,
    url: url || "",
    snippet: normalizedText.slice(0, 500),
  };
}

function tianyanchaSearchUrl(company) {
  const parameters = new URLSearchParams({ key: company });
  return `https://www.tianyancha.com/search?${parameters}`;
}

function yearsSince(dateText, now) {
  if (!dateText) {
    return null;
  }
  const normalized = dateText
    .replace(/\u5e74|\u6708/g, "-")
    .replace(/\u65e5/g, "")
    .replace(/\//g, "-")
    .replace(/\./g, "-");
  const [year, month = "1", day = "1"] = normalized
    .split("-")
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(year) || year < 1800) {
    return null;
  }
  const established = new Date(Date.UTC(year, month - 1, day));
  const reference =
    now instanceof Date ? now : new Date(now ?? Date.now());
  let years = reference.getUTCFullYear() - established.getUTCFullYear();
  const beforeAnniversary =
    reference.getUTCMonth() < established.getUTCMonth() ||
    (reference.getUTCMonth() === established.getUTCMonth() &&
      reference.getUTCDate() < established.getUTCDate());
  if (beforeAnniversary) {
    years -= 1;
  }
  return years >= 0 ? years : null;
}

function extractFirst(text, pattern) {
  return compactText(text.match(pattern)?.[1] ?? "");
}

function includesCompany(value, company) {
  return normalizeForMatch(value).includes(normalizeForMatch(company));
}

function normalizeCompany(company) {
  return String(company ?? "").trim();
}

function normalizeForMatch(value) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

function compactText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}
