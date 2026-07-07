import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getOrCreatePage, launchBrowser } from "../src/browser.js";
import {
  buildReputationQueries,
  searchReputation,
} from "../src/research/web_search.js";
import { fetchTianyanchaBestEffort } from "../src/research/tianyancha.js";

const FIXTURE_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pages",
);
const COMPANY = "\u5e7f\u5dde\u4fe1\u8f90\u4f01\u4e1a\u54a8\u8be2";

test("Sogou reputation search runs three queries and keeps company/reputation results", async (t) => {
  const context = await launchBrowser();
  t.after(async () => context.close());
  const page = await getOrCreatePage(context);
  await routeFixture(page, "https://www.sogou.com/**", "sogou-results.html");
  const delays = [];

  const result = await searchReputation(COMPANY, {
    page,
    delayFn: async (minimum, maximum) => {
      delays.push([minimum, maximum]);
      return minimum;
    },
  });

  assert.deepEqual(buildReputationQueries(COMPANY), [
    `${COMPANY} \u9a97\u5c40`,
    `${COMPANY} \u57f9\u8bad\u8d37 \u62bc\u91d1`,
    `${COMPANY} \u5de5\u4f5c \u600e\u4e48\u6837`,
  ]);
  assert.equal(result.degraded, false);
  assert.equal(result.engine, "sogou");
  // 3 query x 3 \u771f\u5b9e\u7ed3\u679c\u5361 (\u6392\u9664"\u5927\u5bb6\u8fd8\u5728\u641c"\u6846)
  assert.equal(result.data.length, 9);
  // \u5173\u952e: \u542b"\u5e02/\u7ba1\u7406/\u6709\u9650\u516c\u53f8"\u7684\u516c\u53f8\u540d\u53d8\u4f53\u6ca1\u88ab\u8fc7\u6ee4\u6389 (\u6a21\u7cca\u6838\u5fc3\u8bcd\u5339\u914d)
  assert.ok(
    result.data.some((item) => item.title.includes("\u5929\u773c\u67e5")),
    "should keep the tianyancha company result",
  );
  assert.ok(
    result.data.some((item) => /\u8bc8\u9a97|\u9ed1\u4e2d\u4ecb/.test(item.title + item.snippet)),
    "should keep the fraud-warning news result",
  );
  assert.ok(result.data.every((item) => item.query.includes(COMPANY)));
});

test("reputation search falls back to baidu when sogou degrades, else reports degraded", async (t) => {
  const context = await launchBrowser();
  t.after(async () => context.close());
  const page = await getOrCreatePage(context);
  // \u4e24\u4e2a\u5f15\u64ce\u90fd\u8fd4\u56de\u9a8c\u8bc1\u7801 -> \u6700\u7ec8 degraded
  await routeFixture(page, "https://www.sogou.com/**", "baidu-captcha.html");
  await routeFixture(page, "https://www.baidu.com/**", "baidu-captcha.html");

  const result = await searchReputation(COMPANY, {
    page,
    delayFn: async () => 0,
  });

  assert.equal(result.degraded, true);
  assert.equal(result.data.length, 0);
  assert.match(result.reason, /security_or_captcha/);
});

test("Tianyancha best-effort search reads first matching company card", async (t) => {
  const context = await launchBrowser();
  t.after(async () => context.close());
  const page = await getOrCreatePage(context);
  await routeFixture(
    page,
    "https://www.tianyancha.com/**",
    "tyc-results.html",
  );

  const result = await fetchTianyanchaBestEffort(COMPANY, {
    page,
    now: new Date("2026-07-04T00:00:00Z"),
  });

  assert.equal(result.degraded, false);
  assert.equal(result.data.name, `${COMPANY}\u6709\u9650\u516c\u53f8`);
  assert.equal(result.data.establishedDate, "2018-05-10");
  assert.equal(result.data.establishedYears, 8);
  assert.equal(result.data.registeredCapital, "100\u4e07\u4eba\u6c11\u5e01");
  assert.equal(result.data.ownRiskCount, 7);
  assert.match(result.data.url, /tianyancha\.com\/company\/123456/);
});

test("Tianyancha best-effort search silently degrades on login wall", async (t) => {
  const context = await launchBrowser();
  t.after(async () => context.close());
  const page = await getOrCreatePage(context);
  await routeFixture(page, "https://www.tianyancha.com/**", "tyc-login.html");

  const result = await fetchTianyanchaBestEffort(COMPANY, { page });

  assert.deepEqual(result, {
    data: null,
    degraded: true,
    reason: "tyc_login_or_captcha",
  });
});

async function routeFixture(page, url, fixtureName) {
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: fs.readFileSync(path.join(FIXTURE_DIRECTORY, fixtureName), "utf8"),
    }),
  );
}
