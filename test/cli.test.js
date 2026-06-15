import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { config } from "../src/config.js";
import { createProgram, formatGreetResult } from "../src/cli.js";
import { CircuitBreakerError } from "../src/boss/greet.js";
import {
  BossLoginError,
  SECURITY_CHECK_WAIT_MESSAGE,
  waitForSecurityCheckRecovery,
} from "../src/boss/login.js";
import {
  getJob,
  getMeta,
  openDatabase,
  saveMaterials,
  saveResumePath,
  saveScreenResult,
  setMeta,
  updateJobStatus,
  upsertJob,
} from "../src/db.js";
import {
  SCAN_LOGIN_MESSAGE,
  findReplyJob,
  formatStatus,
  getStatusSnapshot,
  processReplyNotifications,
  replyNotificationKey,
  runGreetQueue,
  runScan,
} from "../src/workflows.js";

test("scan login requirement sends the exact notification and exits gracefully", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const notifications = [];
  const output = [];

  const result = await runScan({
    db,
    page: {},
    queries: ["AI Agent"],
    searchFn: async () => {
      throw new BossLoginError("login required", "logged_out", [
        "https://www.zhipin.com/web/geek/jobs",
      ]);
    },
    notifyFn: async (text) => notifications.push(text),
    output: (text) => output.push(text),
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, "logged_out");
  assert.deepEqual(notifications, [SCAN_LOGIN_MESSAGE]);
  assert.match(output[0], /需要扫码登录后才能扫描岗位/);
});

test("scan stops after a detail page reports login or security loss", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const notifications = [];
  let fetchCalls = 0;

  const result = await runScan({
    db,
    page: {},
    queries: ["AI Agent"],
    searchFn: async () => [
      {
        id: "detail-login-loss",
        url: "https://www.zhipin.com/job_detail/detail-login-loss.html",
        title: "AI 应用实习生",
        company: "测试公司",
        salary: "3-5K",
      },
      {
        id: "must-not-fetch",
        url: "https://www.zhipin.com/job_detail/must-not-fetch.html",
        title: "第二个岗位",
        company: "测试公司",
        salary: "3-5K",
      },
    ],
    fetchFn: async () => {
      fetchCalls += 1;
      throw new BossLoginError("security check", "security_check", [
        "https://www.zhipin.com/web/passport/zp/security.html",
      ]);
    },
    notifyFn: async (text) => notifications.push(text),
    output: () => {},
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, "security_check");
  assert.equal(result.errors, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(getJob(db, "detail-login-loss").status, "error");
  assert.equal(getJob(db, "must-not-fetch"), null);
  assert.deepEqual(notifications, [SCAN_LOGIN_MESSAGE]);
});

test("scan reuses one page and applies job and query pacing", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const page = {
    fixture: "shared-page",
    isClosed: () => false,
  };
  let browserStarts = 0;
  let browserCloses = 0;
  const delayCalls = [];
  const fetchPages = [];
  const searchPages = [];

  const result = await runScan({
    db,
    queries: ["first", "second"],
    browserFactory: async () => {
      browserStarts += 1;
      return {
        pages: () => [page],
        close: async () => {
          browserCloses += 1;
        },
      };
    },
    searchFn: async ({ query }, options) => {
      searchPages.push(options.page);
      return query === "first"
        ? [
            fixtureJob("pace-1"),
            fixtureJob("pace-2"),
          ]
        : [fixtureJob("pace-3")];
    },
    fetchFn: async (job, options) => {
      fetchPages.push(options.page);
      return { ...job, jd: "本地 JD" };
    },
    screenFn: async () => ({
      score: 20,
      bait: false,
      verdict: "reject",
    }),
    notifyFn: async () => {},
    output: () => {},
    delayFn: async (minimum, maximum) => {
      delayCalls.push([minimum, maximum]);
      return minimum;
    },
    scanConfig: {
      jobDelaySec: [18, 50],
      queryDelaySec: [30, 90],
    },
  });

  assert.equal(result.rejected, 3);
  assert.equal(browserStarts, 1);
  assert.equal(browserCloses, 1);
  assert.deepEqual(searchPages, [page, page]);
  assert.deepEqual(fetchPages, [page, page, page]);
  assert.deepEqual(delayCalls, [
    [18_000, 50_000],
    [30_000, 90_000],
    [18_000, 50_000],
  ]);
});

test("security recovery timeout opens the circuit and alerts", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const notifications = [];
  let now = 0;
  const page = {
    url: () => "file:///safe/verify/index.html",
    waitForTimeout: async () => {},
  };

  await assert.rejects(
    () =>
      runScan({
        db,
        page,
        queries: ["AI Agent"],
        searchFn: async (_filters, { notifyFn }) => {
          await waitForSecurityCheckRecovery(page, {
            notifyFn,
            timeoutMs: 20,
            pollIntervalMs: 10,
            nowFn: () => now,
            waitFn: async (milliseconds) => {
              now += milliseconds;
            },
            getLoginStateFn: async () => ({
              status: "security_check",
              history: [page.url()],
            }),
          });
          return [];
        },
        notifyFn: async (message) => notifications.push(message),
        output: () => {},
      }),
    (error) => {
      assert.equal(error instanceof CircuitBreakerError, true);
      assert.equal(error.reason, "security_timeout");
      assert.equal(error.exitCode, 2);
      return true;
    },
  );

  assert.ok(getMeta(db, "circuit_open"));
  assert.deepEqual(notifications, [
    SECURITY_CHECK_WAIT_MESSAGE,
    "⚠️ Boss直聘触发风控/掉线, 已停止, 需人工处理",
  ]);
});

test("reply notification sends intro text and DOCX before marking notified", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const resumePath = path.join(directory, "resume.docx");
  fs.writeFileSync(resumePath, "fixture");
  const job = upsertJob(db, {
    id: "reply-job",
    url: pathToFileURL(path.join(directory, "job.html")).href,
    title: "AI 应用实习生",
    company: "测试公司",
  });
  saveScreenResult(db, job.id, {
    score: 90,
    bait: false,
    verdict: "pass",
  });
  saveMaterials(db, job.id, {
    greetShort: "招呼语",
    introLong: "完整介绍文本",
  });
  saveResumePath(db, job.id, resumePath);
  updateJobStatus(db, job.id, "greeted");
  updateJobStatus(db, job.id, "replied");

  const textMessages = [];
  const files = [];
  const results = await processReplyNotifications(
    db,
    [
      {
        jobMatchKey: job.id,
        hrName: "陈经理",
        lastMsg: "请发简历",
      },
    ],
    {
      notifyTextFn: async (text) => {
        textMessages.push(text);
        return { message_id: "text-receipt" };
      },
      notifyFileFn: async (file) => {
        files.push(file);
        return { message_id: "file-receipt" };
      },
    },
  );

  assert.equal(results.length, 1);
  assert.match(textMessages[0], /💬 测试公司\|AI 应用实习生\|HR 陈经理: 请发简历/);
  assert.match(textMessages[0], /完整介绍文本/);
  assert.deepEqual(files, [resumePath]);
  assert.equal(getJob(db, job.id).status, "notified");
  assert.equal(
    getMeta(
      db,
      replyNotificationKey({
        jobMatchKey: job.id,
        lastMsg: "请发简历",
      }),
    ),
    "1",
  );
  assert.equal(
    replyNotificationKey({
      jobMatchKey: job.id,
      lastMsg: "请发简历",
    }),
    "notified_msg_6f19e71b2d69bd10",
  );

  const duplicate = await processReplyNotifications(
    db,
    [
      {
        jobMatchKey: job.id,
        hrName: "陈经理",
        lastMsg: "请发简历",
      },
    ],
    {
      notifyTextFn: async (text) => textMessages.push(text),
      notifyFileFn: async (file) => files.push(file),
    },
  );
  assert.deepEqual(duplicate, []);
  assert.equal(textMessages.length, 1);
  assert.equal(files.length, 1);

  const followUp = await processReplyNotifications(
    db,
    [
      {
        jobMatchKey: job.id,
        hrName: "陈经理",
        lastMsg: "明天下午方便沟通吗？",
      },
    ],
    {
      notifyTextFn: async (text) => {
        textMessages.push(text);
        return { message_id: "follow-up" };
      },
      notifyFileFn: async (file) => files.push(file),
    },
  );
  assert.equal(followUp.length, 1);
  assert.equal(
    textMessages[1],
    "💬 测试公司|AI 应用实习生|HR 陈经理: 明天下午方便沟通吗？",
  );
  assert.doesNotMatch(textMessages[1], /完整介绍文本/);
  assert.equal(files.length, 1);
  assert.equal(getJob(db, job.id).status, "notified");
});

test("reply title fallback only matches a unique active job", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const first = queueJob(db, "same-title-1", "同名岗位", "甲公司");
  updateJobStatus(db, first.id, "greeted");
  assert.equal(
    findReplyJob(db, {
      jobMatchKey: "同名岗位",
      jobTitle: "同名岗位",
    }).id,
    first.id,
  );

  const second = queueJob(db, "same-title-2", "同名岗位", "乙公司");
  updateJobStatus(db, second.id, "greeted");
  assert.equal(
    findReplyJob(db, {
      jobMatchKey: "同名岗位",
      jobTitle: "同名岗位",
    }),
    null,
  );

  const notifications = [];
  const reply = {
    jobMatchKey: "同名岗位",
    jobTitle: "同名岗位",
    hrName: "王经理",
    lastMsg: "请确认具体岗位",
  };
  const firstRun = await processReplyNotifications(db, [reply], {
    notifyTextFn: async (text) => notifications.push(text),
  });
  const secondRun = await processReplyNotifications(db, [reply], {
    notifyTextFn: async (text) => notifications.push(text),
  });

  assert.equal(firstRun[0].matched, false);
  assert.match(firstRun[0].text, /未知岗位\|同名岗位\|HR 王经理/);
  assert.deepEqual(secondRun, []);
  assert.equal(notifications.length, 1);
});

test("greet queue records ordinary job errors and continues", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  queueJob(db, "greet-fail", "失败岗位", "甲公司");
  queueJob(db, "greet-next", "后续岗位", "乙公司");

  const result = await runGreetQueue({
    db,
    page: {},
    now: new Date("2026-06-13T10:00:00+08:00"),
    delayFn: async () => 0,
    greetFn: async (_page, job) => {
      if (job.id === "greet-fail") {
        throw new Error("fixture greet failed");
      }
      updateJobStatus(db, job.id, "greeted");
      return { dryRun: true, status: "greeted", sent: false };
    },
  });

  assert.equal(result.attempted, 2);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0], {
    jobId: "greet-fail",
    status: "error",
    error: "fixture greet failed",
  });
  assert.equal(getJob(db, "greet-fail").status, "error");
  assert.equal(getJob(db, "greet-next").status, "greeted");
});

test("greet queue gracefully reports circuit, hours, and daily-limit stops", async (t) => {
  const circuitDb = openDatabase(":memory:");
  const hoursDb = openDatabase(":memory:");
  const limitDb = openDatabase(":memory:");
  t.after(() => {
    circuitDb.close();
    hoursDb.close();
    limitDb.close();
  });
  queueJob(circuitDb, "circuit-job", "熔断岗位", "甲公司");
  queueJob(hoursDb, "hours-job", "时段岗位", "乙公司");
  queueJob(limitDb, "limit-job", "限额岗位", "丙公司");

  const circuit = await runGreetQueue({
    db: circuitDb,
    page: {},
    now: new Date("2026-06-13T10:00:00+08:00"),
    greetFn: async () => {
      throw new CircuitBreakerError("fixture circuit", "verification_text");
    },
  });
  assert.deepEqual(circuit, {
    attempted: 1,
    results: [],
    stopped: "verification_text",
  });

  const hours = await runGreetQueue({
    db: hoursDb,
    page: {},
    now: new Date("2026-06-13T02:00:00+08:00"),
  });
  assert.deepEqual(hours, {
    attempted: 0,
    results: [],
    stopped: "outside_active_hours",
  });

  setMeta(
    limitDb,
    "greet_count_dry_2026-06-13",
    config.greeting.dailyLimit,
  );
  const limit = await runGreetQueue({
    db: limitDb,
    page: {},
    now: new Date("2026-06-13T10:00:00+08:00"),
  });
  assert.deepEqual(limit, {
    attempted: 0,
    results: [],
    stopped: "daily_limit",
  });
  assert.equal(
    formatGreetResult(limit, true),
    "greet attempted=0 dryRun=true stopped=daily_limit",
  );
});

test("circuit-reset CLI clears circuit_open and prints confirmation", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-reset-"));
  const databasePath = path.join(directory, "reset.db");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const db = openDatabase(databasePath);
  setMeta(db, "circuit_open", "2026-06-13 10:00:00");
  db.close();

  const output = [];
  const originalLog = console.log;
  console.log = (...values) => output.push(values.join(" "));
  try {
    await createProgram().parseAsync([
      "node",
      "boss-job-agent",
      "--database",
      databasePath,
      "circuit-reset",
    ]);
  } finally {
    console.log = originalLog;
  }

  const reopened = openDatabase(databasePath);
  try {
    assert.equal(getMeta(reopened, "circuit_open"), null);
  } finally {
    reopened.close();
  }
  assert.deepEqual(output, ["circuit reset: closed"]);
});

test("status snapshot and formatting include all pipeline states", () => {
  const db = openDatabase(":memory:");
  try {
    upsertJob(db, {
      id: "status-job",
      url: "https://example.test/status-job",
    });
    const snapshot = getStatusSnapshot(db, {
      now: new Date("2026-06-13T10:00:00+08:00"),
    });
    const text = formatStatus(snapshot);
    assert.match(text, /discovered: 1/);
    assert.match(text, /notified: 0/);
    assert.match(text, /circuit: closed/);
  } finally {
    db.close();
  }
});

function queueJob(db, id, title, company) {
  const job = upsertJob(db, {
    id,
    url: `https://example.test/${id}`,
    title,
    company,
  });
  return saveScreenResult(db, job.id, {
    score: 90,
    bait: false,
    verdict: "pass",
  });
}

function fixtureJob(id) {
  return {
    id,
    url: `https://example.test/${id}`,
    title: `岗位 ${id}`,
    company: "本地公司",
    salary: "4-6K",
  };
}
