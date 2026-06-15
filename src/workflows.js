import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import {
  deleteMeta,
  getJob,
  getMeta,
  getStatusCounts,
  listJobs,
  openDatabase,
  saveMaterials,
  saveResumePath,
  saveScreenResult,
  setJobError,
  setMeta,
  updateJobStatus,
  upsertJob,
} from "./db.js";
import { getOrCreatePage, humanDelay, launchBrowser } from "./browser.js";
import {
  CIRCUIT_ALERT,
  CircuitBreakerError,
  GreetConstraintError,
  assertGreetAllowed,
  greetJob,
  greetCounterKey,
} from "./boss/greet.js";
import { pollReplies } from "./boss/inbox.js";
import { BossLoginError, ensureLoggedIn } from "./boss/login.js";
import { fetchJD, searchJobs } from "./boss/search.js";
import { notifyFile, notifyText } from "./notify.js";
import { genMaterials } from "./pipeline/materials.js";
import { genResume, renderResume } from "./pipeline/resume.js";
import { screenJob } from "./pipeline/screen.js";

export const SCAN_LOGIN_MESSAGE = "需要扫码登录后才能扫描岗位";

export async function runLogin({
  browserFactory = launchBrowser,
  ensureLoggedInFn = ensureLoggedIn,
  notifyFn = notifyText,
} = {}) {
  const context = await browserFactory();
  try {
    const page = await getOrCreatePage(context);
    await ensureLoggedInFn(page, { notifyFn });
    // 登录成功后清除熔断标志, 让因登录态过期而暂停的 poll/cron 自动恢复
    const db = openDatabase();
    try {
      resetCircuit(db);
    } finally {
      db.close();
    }
    return { loggedIn: true };
  } finally {
    await context.close();
  }
}

export async function runScan({
  db,
  page,
  queries = config.search.queries,
  browserFactory = launchBrowser,
  searchFn = searchJobs,
  fetchFn = fetchJD,
  screenFn = screenJob,
  materialsFn = genMaterials,
  resumeFn = genResume,
  notifyFn = notifyText,
  output = console.log,
  delayFn = humanDelay,
  scanConfig = config.scan,
} = {}) {
  let context;
  const summary = {
    blocked: false,
    newJobs: 0,
    passed: 0,
    rejected: 0,
    errors: 0,
    passedJobs: [],
  };
  let fetchedDetail = false;

  if (!page) {
    context = await browserFactory();
    page = await getOrCreatePage(context);
  }

  try {
    for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
      const query = queries[queryIndex];
      let candidates;
      try {
        candidates = await searchFn(
          {
            ...config.search,
            query,
          },
          { page, notifyFn },
        );
      } catch (error) {
        const handled = await handleScanAccessError(error, {
          db,
          page,
          notifyFn,
          output,
          summary,
        });
        if (handled) return summary;
        throw error;
      }

      for (const candidate of candidates) {
        const existed = Boolean(getJob(db, candidate.id));
        let job = upsertJob(db, candidate);
        if (!existed) summary.newJobs += 1;
        if (job.status !== "discovered") continue;

        try {
          if (!job.jd) {
            if (fetchedDetail) {
              await delaySeconds(delayFn, scanConfig.jobDelaySec);
            }
            fetchedDetail = true;
            job = upsertJob(
              db,
              await fetchFn(job, {
                page,
                notifyFn,
                delayFn,
              }),
            );
          }
          const screen = await screenFn(job);
          saveScreenResult(db, job.id, screen);

          if (screen.verdict !== "pass" || screen.bait) {
            summary.rejected += 1;
            continue;
          }

          const materials = await materialsFn(job);
          saveMaterials(db, job.id, materials);
          const resume = await resumeFn(job);
          saveResumePath(db, job.id, resume.resumePath);
          summary.passed += 1;
          summary.passedJobs.push(`${job.company} | ${job.title}`);
        } catch (error) {
          setJobError(db, job.id, error);
          summary.errors += 1;
          const handled = await handleScanAccessError(error, {
            db,
            page,
            notifyFn,
            output,
            summary,
          });
          if (handled) return summary;
        }
      }

      if (queryIndex < queries.length - 1) {
        await delaySeconds(delayFn, scanConfig.queryDelaySec);
      }
    }

    const message = [
      `Boss 扫描完成: 新增${summary.newJobs}, 通过${summary.passed}, 拒绝${summary.rejected}, 错误${summary.errors}`,
      ...summary.passedJobs.map((job) => `- ${job}`),
    ].join("\n");
    output(message);
    await notifyFn(message);
    return summary;
  } finally {
    if (context) await context.close();
  }
}

async function handleScanAccessError(
  error,
  { db, page, notifyFn, output, summary },
) {
  if (
    !(error instanceof BossLoginError) &&
    error.code !== "BOSS_LOGIN_REQUIRED"
  ) {
    return false;
  }

  if (error.reason === "security_timeout") {
    const openedAt = localTimestamp();
    setMeta(db, "circuit_open", openedAt);
    let notifyError;
    try {
      await notifyFn(CIRCUIT_ALERT);
    } catch (notificationFailure) {
      notifyError = notificationFailure;
    }
    const circuitError = new CircuitBreakerError(
      `Boss circuit opened after security verification timeout (${page.url()})`,
      "security_timeout",
    );
    if (notifyError) circuitError.cause = notifyError;
    throw circuitError;
  }

  summary.blocked = true;
  summary.reason = error.reason ?? "login_required";
  summary.history = error.history ?? [];
  await notifyFn(SCAN_LOGIN_MESSAGE);
  output(`${SCAN_LOGIN_MESSAGE} (${summary.reason})`);
  return true;
}

function delaySeconds(delayFn, range) {
  if (
    !Array.isArray(range) ||
    range.length !== 2 ||
    !range.every(Number.isFinite) ||
    range[0] < 0 ||
    range[1] < range[0]
  ) {
    throw new Error("Scan delay must be a [minSeconds, maxSeconds] pair");
  }
  return delayFn(range[0] * 1_000, range[1] * 1_000);
}

// 首次点"立即沟通"常因页面跳转/建会话较慢而找不到输入框; 此时会话已建立,
// 重试一次 (按钮变"继续沟通") 通常成功。熔断/时段/限额错误不重试, 直接上抛。
async function greetWithRetry(greetFn, page, job, options) {
  try {
    return await greetFn(page, job, job.greet_short, options);
  } catch (error) {
    if (isGreetStopError(error)) throw error;
    await options.delayFn(2_000, 4_000);
    return await greetFn(page, job, job.greet_short, options);
  }
}

export async function runGreetQueue({
  db,
  page,
  limit = Number.POSITIVE_INFINITY,
  dryRun = config.greeting.dryRun,
  now = new Date(),
  browserFactory = launchBrowser,
  greetFn = greetJob,
  notifyFn = notifyText,
  delayFn = humanDelay,
} = {}) {
  let context;
  const jobs = listJobs(db, { status: "queued" }).slice(0, limit);
  const results = [];
  let attempted = 0;
  try {
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      try {
        assertGreetAllowed(db, { now, dryRun });
      } catch (error) {
        if (isGreetStopError(error)) {
          return { attempted, results, stopped: error.reason };
        }
        throw error;
      }

      if (!page) {
        context = await browserFactory();
        page = await getOrCreatePage(context);
      }

      attempted += 1;
      try {
        results.push(
          await greetWithRetry(greetFn, page, job, {
            db,
            dryRun,
            notifyFn,
            delayFn,
            now,
          }),
        );
      } catch (error) {
        if (isGreetStopError(error)) {
          return { attempted, results, stopped: error.reason };
        }
        setJobError(db, job.id, error);
        results.push({
          jobId: job.id,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (index < jobs.length - 1) {
        await delayFn(
          config.greeting.minDelaySec * 1_000,
          config.greeting.maxDelaySec * 1_000,
        );
      }
    }
    return { attempted, results };
  } finally {
    if (context) await context.close();
  }
}

function isGreetStopError(error) {
  return (
    error instanceof CircuitBreakerError ||
    error instanceof GreetConstraintError
  );
}

export function resetCircuit(db) {
  return deleteMeta(db, "circuit_open");
}

export async function runPoll({
  db,
  page,
  browserFactory = launchBrowser,
  pollFn = pollReplies,
  notifyTextFn = notifyText,
  notifyFileFn = notifyFile,
} = {}) {
  // 熔断中(登录态过期未恢复)静默跳过, 避免 cron 反复触发验证 + 反复飞书打扰; runLogin 登录后会清除
  if (db && getMeta(db, "circuit_open")) {
    return [];
  }
  let context;
  if (!page) {
    context = await browserFactory();
    page = await getOrCreatePage(context);
  }

  try {
    const replies = await pollFn(page, { db, notifyFn: notifyTextFn });
    return await processReplyNotifications(db, replies, {
      notifyTextFn,
      notifyFileFn,
    });
  } finally {
    if (context) await context.close();
  }
}

export async function processReplyNotifications(
  db,
  replies,
  { notifyTextFn = notifyText, notifyFileFn = notifyFile } = {},
) {
  const results = [];
  for (const reply of replies) {
    const dedupeKey = replyNotificationKey(reply);
    if (getMeta(db, dedupeKey) !== null) {
      continue;
    }

    let job = findReplyJob(db, reply);
    if (!job) {
      const text = `💬 未知岗位|${reply.jobTitle || "职位未知"}|HR ${reply.hrName || "未知"}: ${reply.lastMsg}`;
      const textReceipt = await notifyTextFn(text);
      setMeta(db, dedupeKey, "1");
      results.push({ matched: false, text, textReceipt });
      continue;
    }

    if (reply.hrName) {
      db.prepare("UPDATE jobs SET hr_name = ? WHERE id = ?").run(
        reply.hrName,
        job.id,
      );
      job = getJob(db, job.id);
    }

    const replyText = `💬 ${job.company}|${job.title}|HR ${reply.hrName || job.hr_name || "未知"}: ${reply.lastMsg}`;
    if (job.status === "notified") {
      const textReceipt = await notifyTextFn(replyText);
      setMeta(db, dedupeKey, "1");
      results.push({
        matched: true,
        jobId: job.id,
        text: replyText,
        textReceipt,
      });
      continue;
    }

    if (job.status === "greeted") {
      job = updateJobStatus(db, job.id, "replied");
    }
    if (job.status !== "replied") {
      continue;
    }

    const text = [replyText, "", job.intro_long].join("\n");
    const textReceipt = await notifyTextFn(text);
    let fileReceipt = null;
    if (job.resume_path) {
      fileReceipt = await notifyFileFn(job.resume_path);
    }
    updateJobStatus(db, job.id, "notified");
    setMeta(db, dedupeKey, "1");
    results.push({
      matched: true,
      jobId: job.id,
      text,
      resumePath: job.resume_path,
      textReceipt,
      fileReceipt,
    });
  }
  return results;
}

export function replyNotificationKey(reply) {
  const digest = crypto
    .createHash("sha1")
    .update(`${reply.jobMatchKey ?? ""}${reply.lastMsg ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `notified_msg_${digest}`;
}

export function findReplyJob(db, reply) {
  const candidates = db
    .prepare(
      "SELECT * FROM jobs WHERE status IN ('greeted', 'replied', 'notified') ORDER BY greeted_at DESC, created_at DESC",
    )
    .all();
  const directMatch =
    candidates.find((job) => job.id === reply.jobMatchKey) ??
    candidates.find((job) =>
      job.url?.includes(reply.jobMatchKey ?? "\u0000"),
    );
  if (directMatch) {
    return directMatch;
  }

  const titleMatches = candidates.filter(
    (job) => job.title === reply.jobTitle,
  );
  return titleMatches.length === 1 ? titleMatches[0] : null;
}

export function getStatusSnapshot(db, { now = new Date() } = {}) {
  return {
    counts: getStatusCounts(db),
    greetedToday: Number.parseInt(
      getMeta(db, greetCounterKey(now, false)) ?? "0",
      10,
    ),
    dryRunGreetedToday: Number.parseInt(
      getMeta(db, greetCounterKey(now, true)) ?? "0",
      10,
    ),
    circuitOpen: getMeta(db, "circuit_open"),
  };
}

export function formatStatus(snapshot) {
  const statuses = [
    "discovered",
    "screened_out",
    "queued",
    "greeted",
    "replied",
    "notified",
    "error",
  ];
  return [
    ...statuses.map(
      (status) => `${status}: ${snapshot.counts[status] ?? 0}`,
    ),
    `greeted today: ${snapshot.greetedToday}`,
    `dry-run greeted today: ${snapshot.dryRunGreetedToday}`,
    `circuit: ${snapshot.circuitOpen ?? "closed"}`,
  ].join("\n");
}

export async function runTestNotify({
  notifyTextFn = notifyText,
  notifyFileFn = notifyFile,
} = {}) {
  const textReceipt = await notifyTextFn(
    "🤖 boss-job-agent test-notify: 文本链路 OK",
  );
  const resumePath = await ensureTestResume();
  const fileReceipt = await notifyFileFn(resumePath);
  return { textReceipt, fileReceipt, resumePath };
}

async function ensureTestResume() {
  fs.mkdirSync(config.paths.resumes, { recursive: true });
  const existing = fs
    .readdirSync(config.paths.resumes)
    .find((name) => name.toLowerCase().endsWith(".docx"));
  if (existing) {
    return path.join(config.paths.resumes, existing);
  }

  const base = JSON.parse(fs.readFileSync(config.paths.resumeBase, "utf8"));
  const outputPath = path.join(config.paths.resumes, "test-notify-resume.docx");
  await renderResume(base, outputPath);
  return outputPath;
}

function localTimestamp() {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19).replace("T", " ");
}
