import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  deriveJobId,
  getCompanyIntel,
  getJob,
  getMeta,
  getStatusCounts,
  incrementMetaCounter,
  openDatabase,
  saveMaterials,
  saveCompanyIntel,
  saveResumePath,
  saveScreenResult,
  setJobError,
  setMeta,
  updateJobStatus,
  upsertJob,
} from "../src/db.js";

test("database initializes schema and runs the happy-path state machine", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const job = upsertJob(db, {
    url: "https://www.zhipin.com/job_detail/abc123.html",
    title: "AI 应用实习生",
    company: "测试公司",
    salary: "3-5K",
    city: "广州",
    jd: "LLM API 和 n8n",
  });
  assert.equal(job.id, "abc123");
  assert.equal(job.status, "discovered");

  const screened = saveScreenResult(db, job.id, {
    score: 82,
    bait: false,
    verdict: "pass",
  });
  assert.equal(screened.status, "queued");
  assert.equal(screened.score, 82);

  saveMaterials(db, job.id, {
    greetShort: "短招呼语",
    introLong: "长版介绍",
  });
  saveResumePath(db, job.id, "data/resumes/abc123.docx");
  updateJobStatus(db, job.id, "greeted");
  updateJobStatus(db, job.id, "replied");
  const sent = updateJobStatus(db, job.id, "resume_sent");

  assert.equal(sent.greet_short, "短招呼语");
  assert.equal(sent.resume_path, "data/resumes/abc123.docx");
  assert.ok(sent.greeted_at);
  assert.ok(sent.replied_at);
  assert.ok(sent.resume_sent_at);
  assert.deepEqual(getStatusCounts(db), { resume_sent: 1 });
});

test("database rejects invalid transitions and supports errors from active states", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const job = upsertJob(db, {
    id: "manual-id",
    url: "https://example.test/job",
  });
  assert.throws(
    () => updateJobStatus(db, job.id, "notified"),
    /Invalid job transition/,
  );

  const failed = setJobError(db, job.id, new Error("screen failed"));
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "screen failed");
});

test("database upsert preserves state and meta counters are atomic", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const first = upsertJob(db, {
    url: "https://example.test/jobs/without-id",
    title: "Old title",
  });
  saveScreenResult(db, first.id, {
    score: 20,
    bait: false,
    verdict: "reject",
  });
  const updated = upsertJob(db, {
    url: "https://example.test/jobs/without-id",
    title: "New title",
  });

  assert.equal(updated.id, deriveJobId(updated));
  assert.equal(updated.title, "New title");
  assert.equal(updated.status, "screened_out");

  setMeta(db, "circuit_open", "2026-06-13 01:00:00");
  assert.equal(getMeta(db, "circuit_open"), "2026-06-13 01:00:00");
  assert.equal(incrementMetaCounter(db, "greet_count_2026-06-13"), 1);
  assert.equal(incrementMetaCounter(db, "greet_count_2026-06-13"), 2);
  assert.equal(getMeta(db, "greet_count_2026-06-13"), "2");
  assert.equal(getJob(db, "missing"), null);
});

test("company intel cache merges non-empty patches", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const first = saveCompanyIntel(db, "测试公司", {
    bossJson: { jobCount: 3, scale: "100-499人" },
    degraded: "boss",
  });
  assert.deepEqual(first.bossJson, { jobCount: 3, scale: "100-499人" });
  assert.equal(first.searchJson, null);

  const second = saveCompanyIntel(db, "测试公司", {
    bossJson: null,
    searchJson: [{ query: "测试公司 骗局", title: "无负面" }],
    degraded: "search",
  });
  assert.deepEqual(second.bossJson, { jobCount: 3, scale: "100-499人" });
  assert.deepEqual(second.searchJson, [
    { query: "测试公司 骗局", title: "无负面" },
  ]);
  assert.equal(second.degraded, "search");
  assert.deepEqual(getCompanyIntel(db, "测试公司").bossJson, {
    jobCount: 3,
    scale: "100-499人",
  });
});

test("database migration preserves legacy jobs and adds research columns", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-db-migration-"));
  let db;
  t.after(() => {
    if (db?.open) {
      db.close();
    }
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });
  const databasePath = path.join(directory, "agent.db");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      url TEXT, title TEXT, company TEXT, salary TEXT, city TEXT,
      hr_name TEXT, jd TEXT,
      status TEXT NOT NULL DEFAULT 'discovered',
      score INTEGER, screen_json TEXT,
      greet_short TEXT, intro_long TEXT, resume_path TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      greeted_at TEXT, replied_at TEXT, notified_at TEXT
    );
    INSERT INTO jobs (id, url, title, company, status)
    VALUES ('legacy-1', 'https://example.test/job', 'Legacy job', 'Legacy co', 'queued');
  `);
  legacy.close();

  db = openDatabase(databasePath);
  const columns = db.prepare("PRAGMA table_info(jobs)").all().map((row) => row.name);

  assert.equal(getJob(db, "legacy-1").title, "Legacy job");
  assert.equal(getJob(db, "legacy-1").status, "queued");
  assert.ok(columns.includes("company_score"));
  assert.ok(columns.includes("hr_active"));
  assert.ok(columns.includes("research_json"));
  assert.ok(columns.includes("resume_sent_at"));
});

test("database migration cleans legacy HR activity suffixes", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-db-hr-clean-"));
  let db;
  t.after(() => {
    if (db?.open) {
      db.close();
    }
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });
  const databasePath = path.join(directory, "agent.db");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      url TEXT, title TEXT, company TEXT, salary TEXT, city TEXT,
      hr_name TEXT, jd TEXT,
      status TEXT NOT NULL DEFAULT 'discovered',
      score INTEGER, screen_json TEXT,
      greet_short TEXT, intro_long TEXT, resume_path TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      greeted_at TEXT, replied_at TEXT, notified_at TEXT
    );
    INSERT INTO jobs (id, url, title, company, hr_name, status)
    VALUES ('legacy-hr', 'https://example.test/job', 'Legacy job', 'Legacy co', '鞠峰
1年前活跃', 'discovered');
  `);
  legacy.close();

  db = openDatabase(databasePath);
  const job = getJob(db, "legacy-hr");
  assert.equal(job.hr_name, "鞠峰");
  assert.equal(job.hr_active, "1年前活跃");
});
