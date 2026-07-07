import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  getOrCreatePage,
  humanDelay,
  launchBrowser,
} from "../src/browser.js";
import {
  BossLoginError,
  SECURITY_CHECK_PASSED_MESSAGE,
  SECURITY_CHECK_WAIT_MESSAGE,
  getLoginState,
  waitForSecurityCheckRecovery,
} from "../src/boss/login.js";
import {
  JOB_READING_DELAY_MS,
  JOB_SCROLL_DELAY_MS,
  fetchJD,
  parseSearchCards,
  searchJobs,
} from "../src/boss/search.js";

const FIXTURE_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pages",
);

function fixtureUrl(...parts) {
  return pathToFileURL(path.join(FIXTURE_DIRECTORY, ...parts)).href;
}

test("humanDelay validates ranges", async () => {
  assert.equal(await humanDelay(0, 0), 0);
  await assert.rejects(() => humanDelay(5, 4), /Invalid human delay range/);
});

test("headed browser hides navigator.webdriver", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto("data:text/html,<title>browser-fixture</title>");
    assert.notEqual(await page.evaluate(() => navigator.webdriver), true);
    const userAgent = await page.evaluate(() => navigator.userAgent);
    assert.match(userAgent, /Chrome\//);
    assert.doesNotMatch(userAgent, /HeadlessChrome/);
  } finally {
    await context.close();
  }
});

test("search card selectors extract complete job fields", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.setContent(`
      <ul>
        <li class="job-card-box">
          <div class="job-info">
            <a class="job-name" href="https://www.zhipin.com/job_detail/card123.html">
              AI 应用实习生
            </a>
            <span class="job-salary">3-5K</span>
          </div>
          <div class="job-card-footer">
            <a class="boss-info" href="/gongsi/test.html">
              <span class="boss-name">测试公司</span>
            </a>
            <span class="company-location">广州·天河区</span>
            <div class="info-public"><span class="name">陈经理
2周内活跃</span></div>
          </div>
        </li>
      </ul>
    `);

    assert.deepEqual(await parseSearchCards(page), [
      {
        id: "card123",
        url: "https://www.zhipin.com/job_detail/card123.html",
        title: "AI 应用实习生",
        company: "测试公司",
        salary: "3-5K",
        city: "广州·天河区",
        hrName: "陈经理",
        hrActive: "2周内活跃",
      },
    ]);
  } finally {
    await context.close();
  }
});

test("login state ignores hidden logged-out controls on a logged-in page", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.setContent(`
      <a class="header-login-btn" href="/web/user/" hidden>登录</a>
      <nav class="user-nav">个人中心</nav>
    `);

    assert.equal((await getLoginState(page)).status, "logged_in");
  } finally {
    await context.close();
  }
});

test("search detects a logged-out response without using the live site", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.route("https://www.zhipin.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<a class="header-login-btn" href="/web/user/">登录</a>`,
      }),
    );
    await assert.rejects(
      () =>
        searchJobs(
          {
            city: "101280100",
            query: "AI Agent",
            maxJobsPerScan: 60,
          },
          { page },
        ),
      (error) => {
        assert.equal(error instanceof BossLoginError, true);
        assert.equal(error.code, "BOSS_LOGIN_REQUIRED");
        assert.ok(
          ["logged_out", "security_check", "access_required"].includes(
            error.reason,
          ),
        );
        return true;
      },
    );
  } finally {
    await context.close();
  }
});

test("search waits for a local security fixture and continues after verification", async () => {
  const context = await launchBrowser();
  const notifications = [];
  try {
    const page = await getOrCreatePage(context);
    await page.route("https://www.zhipin.com/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/web/geek/job")) {
        await route.fulfill({
          status: 302,
          headers: {
            location:
              "https://www.zhipin.com/web/passport/zp/security.html",
          },
        });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: "<h1>安全验证</h1>",
      });
    });

    const jobs = await searchJobs(
      {
        city: "101280100",
        query: "AI Agent",
        maxJobsPerScan: 8,
      },
      {
        page,
        notifyFn: async (message) => notifications.push(message),
        securityRecoveryOptions: {
          pollIntervalMs: 1,
          waitFn: async () => {
            await page.goto(
              `data:text/html,${encodeURIComponent(`
                <nav class="user-nav">个人中心</nav>
                <li class="job-card-box">
                  <a class="job-name" href="https://example.test/job_detail/recovered">
                    Recovered Job
                  </a>
                  <span class="job-salary">4-6K</span>
                  <div class="job-card-footer">
                    <span class="boss-name">Local Company</span>
                    <span class="company-location">Guangzhou</span>
                  </div>
                </li>
              `)}`,
            );
          },
        },
      },
    );

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, "Recovered Job");
    assert.deepEqual(notifications, [
      SECURITY_CHECK_WAIT_MESSAGE,
      SECURITY_CHECK_PASSED_MESSAGE,
    ]);
  } finally {
    await context.close();
  }
});

test("fetchJD recovers from a local security fixture then reads and scrolls", async () => {
  const context = await launchBrowser();
  const notifications = [];
  const delays = [];
  const scrolls = [];
  try {
    const page = await getOrCreatePage(context);
    const result = await fetchJD(
      {
        id: "local-detail",
        url: fixtureUrl("safe", "verify", "index.html"),
        title: "原岗位",
        company: "原公司",
        salary: "待定",
      },
      {
        page,
        notifyFn: async (message) => notifications.push(message),
        securityRecoveryOptions: {
          pollIntervalMs: 1,
          waitFn: async () => page.goto(fixtureUrl("job-detail.html")),
        },
        delayFn: async (minimum, maximum) => {
          delays.push([minimum, maximum]);
          return minimum;
        },
        randomFn: () => 0,
        scrollFn: async (_page, deltaY) => scrolls.push(deltaY),
      },
    );

    assert.equal(result.title, "AI Agent 实习生");
    assert.equal(result.company, "本地测试公司");
    assert.equal(result.hrName, "陈经理");
    assert.match(result.jd, /Agent 工作流/);
    assert.deepEqual(notifications, [
      SECURITY_CHECK_WAIT_MESSAGE,
      SECURITY_CHECK_PASSED_MESSAGE,
    ]);
    assert.deepEqual(delays, [
      [...JOB_READING_DELAY_MS],
      [...JOB_SCROLL_DELAY_MS],
    ]);
    assert.deepEqual(scrolls, [180, 180]);
  } finally {
    await context.close();
  }
});

test("security recovery times out deterministically on a local fixture", async () => {
  const context = await launchBrowser();
  const notifications = [];
  let now = 0;
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("safe", "verify", "index.html"));

    await assert.rejects(
      () =>
        waitForSecurityCheckRecovery(page, {
          notifyFn: async (message) => notifications.push(message),
          timeoutMs: 20,
          pollIntervalMs: 10,
          nowFn: () => now,
          waitFn: async (milliseconds) => {
            now += milliseconds;
          },
        }),
      (error) => {
        assert.equal(error instanceof BossLoginError, true);
        assert.equal(error.reason, "security_timeout");
        return true;
      },
    );
    assert.deepEqual(notifications, [SECURITY_CHECK_WAIT_MESSAGE]);
  } finally {
    await context.close();
  }
});
