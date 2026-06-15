import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveJobId,
  getJob,
  getMeta,
  getStatusCounts,
  incrementMetaCounter,
  openDatabase,
  saveMaterials,
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
  const notified = updateJobStatus(db, job.id, "notified");

  assert.equal(notified.greet_short, "短招呼语");
  assert.equal(notified.resume_path, "data/resumes/abc123.docx");
  assert.ok(notified.greeted_at);
  assert.ok(notified.replied_at);
  assert.ok(notified.notified_at);
  assert.deepEqual(getStatusCounts(db), { notified: 1 });
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
