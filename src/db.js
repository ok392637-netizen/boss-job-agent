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
  "resume_sent",
  "notified",
  "error",
]);

const TRANSITIONS = Object.freeze({
  discovered: new Set(["screened_out", "queued", "error"]),
  screened_out: new Set(["error"]),
  queued: new Set(["greeted", "error"]),
  greeted: new Set(["replied", "error"]),
  replied: new Set(["resume_sent", "notified", "error"]),
  resume_sent: new Set(["error"]),
  notified: new Set(["error"]),
  error: new Set(),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  url TEXT, title TEXT, company TEXT, salary TEXT, city TEXT,
  hr_name TEXT, hr_active TEXT, jd TEXT,
  status TEXT NOT NULL DEFAULT 'discovered',
  score INTEGER, screen_json TEXT,
  company_score INTEGER, research_json TEXT,
  greet_short TEXT, intro_long TEXT, resume_path TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  greeted_at TEXT, replied_at TEXT, resume_sent_at TEXT, notified_at TEXT
);
CREATE TABLE IF NOT EXISTS company_intel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL UNIQUE,
  boss_json TEXT,
  search_json TEXT,
  tyc_json TEXT,
  degraded TEXT,
  eval_json TEXT,
  fetched_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  boss_conv_key TEXT NOT NULL UNIQUE,
  job_id TEXT,
  hr_name TEXT, company TEXT, job_title TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  last_msg_text TEXT, last_msg_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('hr','me','system')),
  text TEXT NOT NULL,
  msg_hash TEXT NOT NULL,
  sent_label TEXT,
  seen_at TEXT DEFAULT (datetime('now','localtime')),
  action_taken TEXT,
  UNIQUE (conv_id, msg_hash)
);
CREATE TABLE IF NOT EXISTS pending_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER REFERENCES conversations(id),
  type TEXT NOT NULL CHECK (type IN ('reply_draft','interview','resume_send')),
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  created_at TEXT DEFAULT (datetime('now','localtime')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS login_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL CHECK (event IN ('ok','expired','recovered')),
  at TEXT DEFAULT (datetime('now','localtime'))
);
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
  migrateDatabase(db);
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
    ...normalizeHrFields({
      hrName: job.hrName ?? job.hr_name ?? null,
      hrActive: job.hrActive ?? job.hr_active ?? null,
    }),
    jd: job.jd ?? null,
  };

  db.prepare(`
    INSERT INTO jobs (id, url, title, company, salary, city, hr_name, hr_active, jd)
    VALUES (@id, @url, @title, @company, @salary, @city, @hr_name, @hr_active, @jd)
    ON CONFLICT(id) DO UPDATE SET
      url = COALESCE(excluded.url, jobs.url),
      title = COALESCE(excluded.title, jobs.title),
      company = COALESCE(excluded.company, jobs.company),
      salary = COALESCE(excluded.salary, jobs.salary),
      city = COALESCE(excluded.city, jobs.city),
      hr_name = COALESCE(excluded.hr_name, jobs.hr_name),
      hr_active = COALESCE(excluded.hr_active, jobs.hr_active),
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
  if (nextStatus === "resume_sent") timestamps.resume_sent_at = localTimestamp();
  if (nextStatus === "notified") timestamps.notified_at = localTimestamp();

  const allowedFields = [
    "score",
    "screen_json",
    "company_score",
    "research_json",
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

export function saveJobResearch(db, id, { companyScore = null, research = null }) {
  db.prepare(
    "UPDATE jobs SET company_score = ?, research_json = ? WHERE id = ?",
  ).run(
    companyScore,
    research == null ? null : JSON.stringify(research),
    id,
  );
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

export function upsertConversation(db, conversation) {
  const record = {
    boss_conv_key: conversation.bossConvKey,
    job_id: conversation.jobId ?? null,
    hr_name: conversation.hrName ?? null,
    company: conversation.company ?? null,
    job_title: conversation.jobTitle ?? null,
    last_msg_text: conversation.lastMsgText ?? null,
    last_msg_at: conversation.lastMsgAt ?? null,
  };

  if (!record.boss_conv_key) {
    throw new Error("Conversation requires bossConvKey");
  }

  db.prepare(`
    INSERT INTO conversations (
      boss_conv_key, job_id, hr_name, company, job_title, last_msg_text, last_msg_at
    )
    VALUES (
      @boss_conv_key, @job_id, @hr_name, @company, @job_title, @last_msg_text, @last_msg_at
    )
    ON CONFLICT(boss_conv_key) DO UPDATE SET
      job_id = COALESCE(excluded.job_id, conversations.job_id),
      hr_name = COALESCE(excluded.hr_name, conversations.hr_name),
      company = COALESCE(excluded.company, conversations.company),
      job_title = COALESCE(excluded.job_title, conversations.job_title),
      last_msg_text = COALESCE(excluded.last_msg_text, conversations.last_msg_text),
      last_msg_at = COALESCE(excluded.last_msg_at, conversations.last_msg_at),
      updated_at = datetime('now','localtime')
  `).run(record);

  return getConversationByKey(db, record.boss_conv_key);
}

export function getConversationByKey(db, key) {
  return (
    db
      .prepare("SELECT * FROM conversations WHERE boss_conv_key = ?")
      .get(key) ?? null
  );
}

export function listConversations(db, { state } = {}) {
  if (state) {
    return db
      .prepare("SELECT * FROM conversations WHERE state = ? ORDER BY id")
      .all(state);
  }
  return db.prepare("SELECT * FROM conversations ORDER BY id").all();
}

export function insertMessage(db, convId, message) {
  const record = {
    conv_id: convId,
    role: message.role,
    text: message.text,
    sent_label: message.sentLabel ?? null,
    msg_hash: messageHash(convId, message),
  };

  const result = db.prepare(`
    INSERT OR IGNORE INTO messages (conv_id, role, text, msg_hash, sent_label)
    VALUES (@conv_id, @role, @text, @msg_hash, @sent_label)
  `).run(record);
  const row = db
    .prepare("SELECT * FROM messages WHERE conv_id = ? AND msg_hash = ?")
    .get(convId, record.msg_hash);

  return { inserted: result.changes === 1, row };
}

export function listMessages(db, convId) {
  return db
    .prepare("SELECT * FROM messages WHERE conv_id = ? ORDER BY id")
    .all(convId);
}

export function getConversationMessages(db, convId, { limit = 20 } = {}) {
  const safeLimit = normalizePositiveInteger(limit, 20);
  return db
    .prepare(
      `SELECT * FROM (
        SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id`,
    )
    .all(convId, safeLimit);
}

export function createPendingAction(db, { convId = null, type, payload = {} } = {}) {
  assertPendingActionType(type);
  const result = db
    .prepare(
      `INSERT INTO pending_actions (conv_id, type, payload)
       VALUES (?, ?, ?)`,
    )
    .run(convId, type, JSON.stringify(payload ?? null));
  return getPendingAction(db, result.lastInsertRowid);
}

export function getPendingAction(db, id) {
  return normalizePendingActionRow(
    db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id) ?? null,
  );
}

export function listPendingActions(
  db,
  { status = null, type = null, convId = null, limit = null } = {},
) {
  const conditions = [];
  const parameters = [];
  if (status) {
    assertPendingActionStatus(status);
    conditions.push("status = ?");
    parameters.push(status);
  }
  if (type) {
    assertPendingActionType(type);
    conditions.push("type = ?");
    parameters.push(type);
  }
  if (convId !== null && convId !== undefined) {
    conditions.push("conv_id = ?");
    parameters.push(convId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitSql = limit === null ? "" : "LIMIT ?";
  if (limitSql) {
    parameters.push(normalizePositiveInteger(limit, 50));
  }
  return db
    .prepare(`SELECT * FROM pending_actions ${where} ORDER BY id ${limitSql}`)
    .all(...parameters)
    .map(normalizePendingActionRow);
}

export function resolvePendingAction(
  db,
  id,
  { status, payloadPatch = null } = {},
) {
  assertPendingActionStatus(status);
  if (status === "pending") {
    throw new Error("resolvePendingAction requires a terminal status");
  }
  const current = getPendingAction(db, id);
  if (!current) {
    return null;
  }
  const payload = payloadPatch
    ? { ...objectPayload(current.payload), ...payloadPatch }
    : current.payload;
  db.prepare(
    `UPDATE pending_actions
     SET status = ?, payload = ?, resolved_at = datetime('now','localtime')
     WHERE id = ?`,
  ).run(status, JSON.stringify(payload ?? null), id);
  return getPendingAction(db, id);
}

export function recordLoginEvent(db, event) {
  const result = db
    .prepare("INSERT INTO login_events (event) VALUES (?)")
    .run(event);
  return db
    .prepare("SELECT * FROM login_events WHERE id = ?")
    .get(result.lastInsertRowid);
}

export function lastLoginEvent(db) {
  return (
    db
      .prepare("SELECT * FROM login_events ORDER BY id DESC LIMIT 1")
      .get() ?? null
  );
}

export function getStatusCounts(db) {
  return Object.fromEntries(
    db
      .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
      .all()
      .map(({ status, count }) => [status, count]),
  );
}

export function getCompanyIntel(db, company) {
  const row =
    db
      .prepare("SELECT * FROM company_intel WHERE company = ?")
      .get(company) ?? null;
  if (!row) {
    return null;
  }
  return {
    ...row,
    bossJson: parseJsonColumn(row.boss_json),
    searchJson: parseJsonColumn(row.search_json),
    tycJson: parseJsonColumn(row.tyc_json),
    evalJson: parseJsonColumn(row.eval_json),
  };
}

export function saveCompanyIntel(db, company, patch = {}) {
  if (!company || !String(company).trim()) {
    throw new Error("company_intel requires company");
  }

  const current =
    db
      .prepare("SELECT * FROM company_intel WHERE company = ?")
      .get(company) ?? {};
  const record = {
    company: String(company).trim(),
    boss_json: current.boss_json ?? null,
    search_json: current.search_json ?? null,
    tyc_json: current.tyc_json ?? null,
    degraded: current.degraded ?? null,
    eval_json: current.eval_json ?? null,
  };

  for (const [key, value] of Object.entries(patch)) {
    const column = COMPANY_INTEL_PATCH_COLUMNS[key];
    if (!column || !hasPatchValue(value)) {
      continue;
    }
    record[column] = JSON_COLUMNS.has(column) ? JSON.stringify(value) : String(value);
  }

  db.prepare(`
    INSERT INTO company_intel (
      company, boss_json, search_json, tyc_json, degraded, eval_json, fetched_at
    )
    VALUES (
      @company, @boss_json, @search_json, @tyc_json, @degraded, @eval_json,
      datetime('now','localtime')
    )
    ON CONFLICT(company) DO UPDATE SET
      boss_json = excluded.boss_json,
      search_json = excluded.search_json,
      tyc_json = excluded.tyc_json,
      degraded = excluded.degraded,
      eval_json = excluded.eval_json,
      fetched_at = datetime('now','localtime')
  `).run(record);

  return getCompanyIntel(db, record.company);
}

function messageHash(convId, { role, text, sentLabel }) {
  return crypto
    .createHash("sha1")
    .update(`${convId}|${role}|${text}|${sentLabel ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

function migrateDatabase(db) {
  ensureColumn(
    db,
    "jobs",
    "company_score",
    "ALTER TABLE jobs ADD COLUMN company_score INTEGER",
  );
  ensureColumn(
    db,
    "jobs",
    "hr_active",
    "ALTER TABLE jobs ADD COLUMN hr_active TEXT",
  );
  ensureColumn(
    db,
    "jobs",
    "research_json",
    "ALTER TABLE jobs ADD COLUMN research_json TEXT",
  );
  ensureColumn(
    db,
    "jobs",
    "resume_sent_at",
    "ALTER TABLE jobs ADD COLUMN resume_sent_at TEXT",
  );
  cleanLegacyHrActivity(db);
}

function ensureColumn(db, table, column, statement) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) {
    return;
  }
  db.exec(statement);
}

export function normalizeHrFields({ hrName, hrActive } = {}) {
  const activeFromName = extractHrActive(hrName);
  const active = compactText(hrActive) || activeFromName;
  return {
    hr_name: cleanHrName(hrName),
    hr_active: active || null,
  };
}

export function isInactiveHrActive(value) {
  return /半年前|半年|年前|年内|[一二三四五六七八九十\d]+\s*年/.test(
    compactText(value),
  );
}

function cleanLegacyHrActivity(db) {
  const rows = db
    .prepare("SELECT id, hr_name, hr_active FROM jobs WHERE hr_name IS NOT NULL")
    .all();
  const update = db.prepare(
    "UPDATE jobs SET hr_name = ?, hr_active = COALESCE(?, hr_active) WHERE id = ?",
  );
  for (const row of rows) {
    const normalized = normalizeHrFields({
      hrName: row.hr_name,
      hrActive: row.hr_active,
    });
    if (
      normalized.hr_name !== row.hr_name ||
      (normalized.hr_active && normalized.hr_active !== row.hr_active)
    ) {
      update.run(normalized.hr_name, normalized.hr_active, row.id);
    }
  }
}

function extractHrActive(value) {
  return compactText(value).match(HR_ACTIVE_PATTERN)?.[0] ?? "";
}

function cleanHrName(value) {
  return (
    compactText(value)
      .replace(HR_ACTIVE_PATTERN, "")
      .replace(/[|｜·\-—:：]+$/u, "")
      .trim() || null
  );
}

const HR_ACTIVE_PATTERN =
  /(刚刚活跃|今日活跃|今天活跃|本周活跃|2周内活跃|两周内活跃|本月活跃|近半年活跃|半年内活跃|半年前活跃|[一二三四五六七八九十\d]+\s*年前活跃|[一二三四五六七八九十\d]+\s*年内活跃|年前活跃|年内活跃)/u;

function compactText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

const JSON_COLUMNS = new Set([
  "boss_json",
  "search_json",
  "tyc_json",
  "eval_json",
]);

const COMPANY_INTEL_PATCH_COLUMNS = Object.freeze({
  boss_json: "boss_json",
  bossJson: "boss_json",
  search_json: "search_json",
  searchJson: "search_json",
  tyc_json: "tyc_json",
  tycJson: "tyc_json",
  degraded: "degraded",
  eval_json: "eval_json",
  evalJson: "eval_json",
});

function hasPatchValue(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function parseJsonColumn(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizePendingActionRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    payload: parseJsonColumn(row.payload) ?? {},
  };
}

function objectPayload(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function assertPendingActionType(type) {
  if (!["reply_draft", "interview", "resume_send"].includes(type)) {
    throw new Error(`Unknown pending action type: ${type}`);
  }
}

function assertPendingActionStatus(status) {
  if (!["pending", "approved", "rejected", "expired"].includes(status)) {
    throw new Error(`Unknown pending action status: ${status}`);
  }
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.isInteger(value) ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function localTimestamp() {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19).replace("T", " ");
}
