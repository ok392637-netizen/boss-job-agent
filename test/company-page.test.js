import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getOrCreatePage, launchBrowser } from "../src/browser.js";
import { openDatabase } from "../src/db.js";
import { fetchCompanyIntel } from "../src/boss/company_page.js";

const FIXTURE_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pages",
);

test("fetchCompanyIntel follows a job detail company link and reads posted jobs", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const context = await launchBrowser();
  t.after(async () => context.close());
  const page = await getOrCreatePage(context);
  await routeFixture(page, "https://www.zhipin.com/job_detail/fixture.html", "company-job-detail.html");
  await routeFixture(page, "https://www.zhipin.com/gongsi/test-company.html", "company-intro.html");
  await routeFixture(page, "https://www.zhipin.com/gongsi/job/test-company.html", "company-jobs.html");

  const result = await fetchCompanyIntel(page, {
    jobUrl: "https://www.zhipin.com/job_detail/fixture.html",
    db,
    notifyFn: async () => {},
    delayFn: async () => 0,
  });

  assert.equal(result.jobCount, 3);
  assert.equal(result.scale, "100-499人");
  assert.equal(result.funding, "B轮");
  assert.equal(result.industry, "人工智能");
  assert.equal(result.hrActiveHint, "");
  assert.deepEqual(result.jobsPosted, [
    { title: "AI工程师", salary: "10-15K" },
    { title: "销售顾问", salary: "8-12K" },
    { title: "地推专员", salary: "6-9K" },
  ]);
});

async function routeFixture(page, url, fixtureName) {
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: fs.readFileSync(path.join(FIXTURE_DIRECTORY, fixtureName), "utf8"),
    }),
  );
}
