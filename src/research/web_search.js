import { humanDelay, launchBrowser } from "../browser.js";

// 反爬结论 (2026-07-04 实测 scripts/probe-search-engines.mjs):
// 搜狗最耐受且首屏就带天眼查工商数据+口碑新闻, 百度次之作兜底; 二者 patchright 下均无验证码。
// 关键坑: 早期版本用精确公司名子串过滤, 会滤掉"广州市信辉企业管理咨询有限公司"这类含 市/管理/有限公司 的真实结果 → 改核心词模糊匹配。

export const REPUTATION_QUERY_SUFFIXES = Object.freeze([
  "骗局",
  "培训贷 押金",
  "工作 怎么样",
]);

const REPUTATION_KEYWORDS =
  /骗局|诈骗|培训贷|押金|黑中介|投诉|求职陷阱|维权|欠薪|拖欠|怎么样|天眼查|工商|风险|裁员/;

export const SEARCH_ENGINES = Object.freeze({
  sogou: {
    name: "sogou",
    url: (query) =>
      `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
    card: ".results .vrwrap, .results .rb",
    title: "h3",
    snippet: ".fz-mid, .text-layout, .space-txt, .star-wiki, .content-box, p",
    degradeRe: /passport\.sogou|验证码|安全验证|请完成验证|访问异常|antispider/i,
  },
  baidu: {
    name: "baidu",
    url: (query) =>
      `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
    card: "#content_left .result, #content_left .c-container, #content_left [tpl]",
    title: "h3, .t, a.c-title",
    snippet:
      ".c-abstract, .c-row, .c-span-last, .content-right_8Zs40, [class*='abstract']",
    degradeRe: /wappass\.baidu\.com|安全验证|验证码|请完成验证|访问异常/i,
  },
});

export function buildReputationQueries(company) {
  const name = normalizeCompany(company);
  if (!name) throw new Error("reputation search requires company");
  return REPUTATION_QUERY_SUFFIXES.map((suffix) => `${name} ${suffix}`);
}

// 主入口: 搜狗优先, 降级则百度兜底; 任一引擎拿到非空结果即返回。
export async function searchReputation(
  company,
  {
    page,
    context,
    browserFactory = launchBrowser,
    delayFn = humanDelay,
    engines = ["sogou", "baidu"],
    maxResultsPerQuery = 5,
    timeoutMs = 60_000,
  } = {},
) {
  const name = normalizeCompany(company);
  if (!name) throw new Error("reputation search requires company");

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

    let lastReason = "no_engine";
    for (const engineKey of engines) {
      const engine = SEARCH_ENGINES[engineKey];
      if (!engine) continue;
      const result = await searchOneEngine(page, name, {
        engine,
        delayFn,
        maxResultsPerQuery,
        timeoutMs,
      });
      if (!result.degraded && result.data.length > 0) {
        return { data: result.data, degraded: false, engine: engine.name };
      }
      lastReason = result.reason ?? `${engine.name}_empty`;
      // 换引擎前歇一下, 避免连撞
      await delayFn(3_000, 6_000);
    }
    return { data: [], degraded: true, reason: lastReason };
  } catch (error) {
    return { data: [], degraded: true, reason: `search_error:${error.message}` };
  } finally {
    if (ownPage && !ownPage.isClosed()) await ownPage.close().catch(() => {});
    if (ownContext) await ownContext.close();
  }
}

async function searchOneEngine(
  page,
  name,
  { engine, delayFn, maxResultsPerQuery, timeoutMs },
) {
  const queries = REPUTATION_QUERY_SUFFIXES.map((s) => `${name} ${s}`);
  const data = [];
  for (const [index, query] of queries.entries()) {
    await page.goto(engine.url(query), {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    const reason = await detectDegradation(page, engine);
    if (reason) return { data: [], degraded: true, reason };
    data.push(
      ...(await extractResults(page, { engine, company: name, query, maxResults: maxResultsPerQuery })),
    );
    if (index < queries.length - 1) await delayFn(8_000, 20_000);
  }
  return { data: dedupeSearchResults(data), degraded: false };
}

export async function extractResults(
  page,
  { engine, company, query, maxResults = 5 },
) {
  const name = normalizeCompany(company);
  const raw = await page
    .locator(engine.card)
    .evaluateAll(
      (cards, sel) =>
        cards.map((card) => {
          const compact = (v) => (v ?? "").replace(/\s+/g, " ").trim();
          const titleEl = card.querySelector(sel.title);
          const title = compact(titleEl?.innerText ?? titleEl?.textContent);
          const linkEl = card.querySelector("h3 a, a");
          const snippets = [...card.querySelectorAll(sel.snippet)]
            .map((el) => compact(el.innerText ?? el.textContent))
            .filter(Boolean)
            .filter((t) => t !== title);
          const fallback = compact(card.innerText ?? card.textContent)
            .replace(title, "")
            .trim();
          return {
            title,
            snippet: snippets[0] ?? fallback,
            url: linkEl?.href ?? linkEl?.getAttribute?.("href") ?? "",
          };
        }),
      { title: engine.title, snippet: engine.snippet },
    )
    .catch(() => []);

  const core = companyCore(name);
  return raw
    .filter((item) => item.title && !isNonResultBox(item.title))
    .filter((item) => looksRelevant(item, { name, core }))
    .slice(0, maxResults)
    .map((item) => ({ query, title: item.title, snippet: item.snippet, url: item.url }));
}

async function detectDegradation(page, engine) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const body = await page
    .locator("body")
    .innerText({ timeout: 1_000 })
    .catch(() => "");
  const text = `${url}\n${title}\n${body.slice(0, 2_000)}`;
  return engine.degradeRe.test(text) ? `${engine.name}_security_or_captcha` : "";
}

// 相关: 结果的标题/摘要含公司核心词, 或含口碑/工商关键词 (搜索已按公司名 scope, 客户端只需去噪)
function looksRelevant(item, { name, core }) {
  const hay = normalizeForMatch(`${item.title} ${item.snippet}`);
  if (hay.includes(normalizeForMatch(name))) return true;
  if (core.length >= 2 && hay.includes(normalizeForMatch(core))) return true;
  return REPUTATION_KEYWORDS.test(item.title + item.snippet);
}

// 去掉城市前缀与公司形式后缀, 留下辨识核心 ("广州信辉企业咨询" -> "信辉")
function companyCore(company) {
  return String(company ?? "")
    .replace(/^(北京|上海|广州|深圳|杭州|成都|武汉|南京|天津|重庆|苏州|东莞|佛山)市?/, "")
    .replace(/(有限|责任|股份|实业|集团)*(公司)$/, "")
    .replace(/(企业管理|管理|企业|咨询|科技|网络|信息|技术|服务|文化|传媒)+$/, "")
    .trim();
}

function isNonResultBox(title) {
  return /^(大家还在搜|相关搜索|广告)$/.test(title.trim());
}

function dedupeSearchResults(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = `${r.query}\n${r.url || r.title}\n${r.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function normalizeCompany(company) {
  return String(company ?? "").trim();
}

function normalizeForMatch(value) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

// 向后兼容: 旧调用点/测试仍可用 searchBaiduReputation 名字, 走同一编排 (百度优先)
export async function searchBaiduReputation(company, options = {}) {
  return searchReputation(company, { ...options, engines: options.engines ?? ["baidu", "sogou"] });
}
