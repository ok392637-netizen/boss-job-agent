import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

export const JOB_STATUSES = Object.freeze([
  "discovered",
  "screened_out",
  "queued",
  "greeted",
  "replied",
  "notified",
  "error",
]);

const TRANSITIONS = Object.freeze({
  discovered: new Set(["screened_out", "queued", "error"]),
  screened_out: new Set(["error"]),
  queued: new Set(["greeted", "error"]),
  greeted: new Set(["replied", "error"]),
  replied: new Set(["notified", "error"]),
  notified: new Set(["error"]),
  error: new Set(),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
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
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export function deriveJobId(job) {
  if (job.id) {
    return String(job.id);
  }

  const match = String(job.url ?? "").match(
    /(?:job_detail\/|securityId=|jobId=)([A-Za-z0-9_-]+)/,
  );
  if (match) {
    return match[1];
  }

  if (!job.url) {
    throw new Error("Job requires either id or url");
  }

  return crypto.createHash("sha1").update(job.url).digest("hex").slice(0, 12);
}

export function openDatabase(databasePath = config.paths.database) {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  if (databasePath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.exec(SCHEMA);
  return db;
}

export function upsertJob(db, job) {
  const record = {
    id: deriveJobId(job),
    url: job.url ?? null,
    title: job.title ?? null,
    company: job.company ?? null,
    salary: job.salary ?? null,
    city: job.city ?? null,
    hr_name: job.hrName ?? job.hr_name ?? null,
    jd: job.jd ?? null,
  };

  db.prepare(`
    INSERT INTO jobs (id, url, title, company, salary, city, hr_name, jd)
    VALUES (@id, @url, @title, @company, @salary, @city, @hr_name, @jd)
    ON CONFLICT(id) DO UPDATE SET
      url = COALESCE(excluded.url, jobs.url),
      title = COALESCE(excluded.title, jobs.title),
      company = COALESCE(excluded.company, jobs.company),
      salary = COALESCE(excluded.salary, jobs.salary),
      city = COALESCE(excluded.city, jobs.city),
      hr_name = COALESCE(excluded.hr_name, jobs.hr_name),
      jd = COALESCE(excluded.jd, jobs.jd)
  `).run(record);

  return getJob(db, record.id);
}

export function getJob(db, id) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) ?? null;
}

export function listJobs(db, { status, limit } = {}) {
  const conditions = [];
  const parameters = [];
  if (status) {
    conditions.push("status = ?");
    parameters.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitSql = Number.isInteger(limit) && limit > 0 ? "LIMIT ?" : "";
  if (limitSql) {
    parameters.push(limit);
  }

  return db
    .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at, id ${limitSql}`)
    .all(...parameters);
}

export function updateJobStatus(db, id, nextStatus, fields = {}) {
  if (!JOB_STATUSES.includes(nextStatus)) {
    throw new Error(`Unknown job status: ${nextStatus}`);
  }

  const current = getJob(db, id);
  if (!current) {
    throw new Error(`Job not found: ${id}`);
  }
  if (
    current.status !== nextStatus &&
    !TRANSITIONS[current.status]?.has(nextStatus)
  ) {
    throw new Error(`Invalid job transition: ${current.status} -> ${nextStatus}`);
  }

  const timestamps = {};
  if (nextStatus === "greeted") timestamps.greeted_at = localTimestamp();
  if (nextStatus === "replied") timestamps.replied_at = localTimestamp();
  if (nextStatus === "notified") timestamps.notified_at = localTimestamp();

  const allowedFields = [
    "score",
    "screen_json",
    "greet_short",
    "intro_long",
    "resume_path",
    "error",
  ];
  const updates = { status: nextStatus, ...timestamps };
  for (const key of allowedFields) {
    if (Object.hasOwn(fields, key)) {
      updates[key] = fields[key];
    }
  }

  const assignments = Object.keys(updates).map((key) => `${key} = @${key}`);
  db.prepare(`UPDATE jobs SET ${assignments.join(", ")} WHERE id = @id`).run({
    id,
    ...updates,
  });
  return getJob(db, id);
}

export function saveScreenResult(db, id, result) {
  const status =
    result.verdict === "pass" && !result.bait ? "queued" : "screened_out";
  return updateJobStatus(db, id, status, {
    score: result.score,
    screen_json: JSON.stringify(result),
  });
}

export function saveMaterials(db, id, { greetShort, introLong }) {
  db.prepare(`
    UPDATE jobs SET greet_short = ?, intro_long = ? WHERE id = ?
  `).run(greetShort, introLong, id);
  return getJob(db, id);
}

export function saveResumePath(db, id, resumePath) {
  db.prepare("UPDATE jobs SET resume_path = ? WHERE id = ?").run(resumePath, id);
  return getJob(db, id);
}

export function setJobError(db, id, error) {
  return updateJobStatus(db, id, "error", {
    error: error instanceof Error ? error.message : String(error),
  });
}

export function getMeta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
  return String(value);
}

export function deleteMeta(db, key) {
  return db.prepare("DELETE FROM meta WHERE key = ?").run(key).changes > 0;
}

export function incrementMetaCounter(db, key) {
  const transaction = db.transaction(() => {
    const next = Number.parseInt(getMeta(db, key) ?? "0", 10) + 1;
    setMeta(db, key, next);
    return next;
  });
  return transaction();
}

export function getStatusCounts(db) {
  return Object.fromEntries(
    db
      .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
      .all()
      .map(({ status, count }) => [status, count]),
  );
}

function localTimestamp() {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19).replace("T", " ");
}
