import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getOrCreatePage, launchBrowser } from "../src/browser.js";
import {
  getJob,
  getMeta,
  openDatabase,
  saveScreenResult,
  setMeta,
  upsertJob,
} from "../src/db.js";
import {
  CIRCUIT_ALERT,
  CircuitBreakerError,
  assertGreetAllowed,
  assertPageSafe,
  detectCircuitCondition,
  greetJob,
} from "../src/boss/greet.js";
import { pollReplies } from "../src/boss/inbox.js";
import { getLoginState } from "../src/boss/login.js";

const FIXTURE_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pages",
);

function fixtureUrl(...parts) {
  return pathToFileURL(path.join(FIXTURE_DIRECTORY, ...parts)).href;
}

test("local HTML fixtures detect URL, text, and iframe circuit conditions", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);

    await page.goto(fixtureUrl("safe", "verify", "index.html"));
    assert.equal(
      (await detectCircuitCondition(page, { expectLoggedIn: false })).reason,
      "verification_url",
    );

    await page.goto(fixtureUrl("verification-text.html"));
    assert.equal(
      (await detectCircuitCondition(page, { expectLoggedIn: false })).reason,
      "verification_text",
    );

    await page.goto(fixtureUrl("verification-iframe.html"));
    assert.equal(
      (await detectCircuitCondition(page, { expectLoggedIn: false })).reason,
      "verification_iframe",
    );

    await page.goto(fixtureUrl("login-lost.html"));
    assert.equal(
      (await detectCircuitCondition(page, { expectLoggedIn: true })).reason,
      "login_lost",
    );
  } finally {
    await context.close();
  }
});

test("opening the circuit persists meta, sends the exact alert, and exits with code 2", async () => {
  const context = await launchBrowser();
  const db = openDatabase(":memory:");
  const notifications = [];
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("verification-text.html"));

    await assert.rejects(
      () =>
        assertPageSafe(page, {
          db,
          notifyFn: async (message) => notifications.push(message),
          expectLoggedIn: false,
        }),
      (error) => {
        assert.equal(error instanceof CircuitBreakerError, true);
        assert.equal(error.exitCode, 2);
        assert.equal(error.reason, "verification_text");
        return true;
      },
    );
    assert.ok(getMeta(db, "circuit_open"));
    assert.deepEqual(notifications, [CIRCUIT_ALERT]);
  } finally {
    db.close();
    await context.close();
  }
});

test("greeting constraints enforce active hours, limits, and an open circuit", () => {
  const db = openDatabase(":memory:");
  try {
    const allowedTime = new Date("2026-06-13T10:00:00+08:00");
    assert.equal(assertGreetAllowed(db, { now: allowedTime, dryRun: true }), true);

    assert.throws(
      () =>
        assertGreetAllowed(db, {
          now: new Date("2026-06-13T02:00:00+08:00"),
          dryRun: true,
        }),
      /only allowed/,
    );

    setMeta(db, "greet_count_dry_2026-06-13", "30");
    assert.throws(
      () => assertGreetAllowed(db, { now: allowedTime, dryRun: true }),
      /Daily greeting limit reached/,
    );

    setMeta(db, "greet_count_dry_2026-06-13", "0");
    setMeta(db, "circuit_open", "2026-06-13 10:01:00");
    assert.throws(
      () => assertGreetAllowed(db, { now: allowedTime, dryRun: true }),
      CircuitBreakerError,
    );
  } finally {
    db.close();
  }
});

test("dry-run stops before clicking start chat or touching the editor", async () => {
  const context = await launchBrowser();
  const db = openDatabase(":memory:");
  try {
    const page = await getOrCreatePage(context);
    const job = upsertJob(db, {
      id: "dry-run-fixture",
      url: fixtureUrl("greet-editor.html"),
      title: "AI 应用实习生",
      company: "本地测试公司",
    });
    saveScreenResult(db, job.id, {
      score: 90,
      bait: false,
      verdict: "pass",
    });

    const result = await greetJob(page, getJob(db, job.id), "测试招呼语", {
      db,
      dryRun: true,
      notifyFn: async () => {},
      delayFn: async () => 0,
      now: new Date("2026-06-13T10:00:00+08:00"),
    });

    assert.deepEqual(result, {
      dryRun: true,
      status: "greeted",
      sent: false,
    });
    assert.equal(
      Boolean(await page.evaluate(() => window.__startChatClicked)),
      false,
    );
    assert.equal(await page.locator("textarea").inputValue(), "");
    assert.equal(Boolean(await page.evaluate(() => window.__sent)), false);
    assert.equal(getJob(db, job.id).status, "greeted");
    assert.equal(getMeta(db, "greet_count_dry_2026-06-13"), "1");
    assert.equal(getMeta(db, "greet_count_2026-06-13"), null);
  } finally {
    db.close();
    await context.close();
  }
});

test("login-lost detail dry-run trips before any communication click", async () => {
  const context = await launchBrowser();
  const db = openDatabase(":memory:");
  try {
    const page = await getOrCreatePage(context);
    const job = upsertJob(db, {
      id: "login-lost-dry-run",
      url: fixtureUrl("login-lost.html"),
      title: "本地岗位",
      company: "本地公司",
    });
    saveScreenResult(db, job.id, {
      score: 80,
      bait: false,
      verdict: "pass",
    });

    await page.goto(job.url);
    const accessState = await getLoginState(page);
    assert.equal(accessState.status, "logged_out");

    await assert.rejects(
      () =>
        greetJob(page, getJob(db, job.id), "绝不发送的测试文本", {
          db,
          dryRun: true,
          notifyFn: async () => {},
          delayFn: async () => 0,
          now: new Date("2026-06-13T10:00:00+08:00"),
        }),
      (error) => {
        assert.equal(error instanceof CircuitBreakerError, true);
        assert.equal(error.exitCode, 2);
        return true;
      },
    );
    assert.equal(getJob(db, job.id).status, "queued");
    assert.equal(getMeta(db, "greet_count_dry_2026-06-13"), null);
  } finally {
    db.close();
    await context.close();
  }
});

test("inbox parser returns only unread conversations from a local fixture", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("inbox.html"));
    assert.deepEqual(
      await pollReplies(page, {
        navigate: false,
        notifyFn: async () => {},
      }),
      [
        {
          jobMatchKey: "job-123",
          hrName: "陈经理",
          lastMsg: "可以聊聊你的 n8n 项目吗？",
          jobTitle: "AI 应用实习生",
        },
      ],
    );
  } finally {
    await context.close();
  }
});
