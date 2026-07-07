import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import {
  createPendingAction,
  deleteMeta,
  getConversationByKey,
  getConversationMessages,
  getCompanyIntel,
  getJob,
  getMeta,
  getStatusCounts,
  insertMessage,
  isInactiveHrActive,
  lastLoginEvent,
  listPendingActions,
  listJobs,
  openDatabase,
  recordLoginEvent,
  resolvePendingAction,
  saveMaterials,
  saveResumePath,
  saveJobResearch,
  saveScreenResult,
  saveCompanyIntel,
  setJobError,
  setMeta,
  updateJobStatus,
  upsertConversation,
  upsertJob,
} from "./db.js";
import {
  BrowserBusyError,
  getOrCreatePage,
  humanDelay,
  launchBrowser,
} from "./browser.js";
import {
  CIRCUIT_ALERT,
  CircuitBreakerError,
  GreetConstraintError,
  assertGreetAllowed,
  assertPageSafe,
  greetJob,
  greetCounterKey,
} from "./boss/greet.js";
import {
  listAllConversations,
  readConversationMessages,
} from "./boss/chat_reader.js";
import { uploadAttachment } from "./boss/attachment_library.js";
import { fetchRecentUserBotMessages } from "./boss/lark_inbox.js";
import { BossLoginError, ensureLoggedIn } from "./boss/login.js";
import {
  pushPendingToLark,
  reconcilePendingFromLark,
} from "./boss/pending_actions.js";
import { fetchJD, searchJobs } from "./boss/search.js";
import { fetchCompanyIntel } from "./boss/company_page.js";
import { URLS } from "./boss/selectors.js";
import { notifyFile, notifyText } from "./notify.js";
import { readProjectFacts } from "./modules/memory_facts.js";
import { sendReply, sendResumeFromLibrary } from "./modules/resume_sender.js";
import { customizeResume } from "./pipeline/customize_resume.js";
import { classifyAndDraft } from "./pipeline/reply_pipeline.js";
import { genMaterials } from "./pipeline/materials.js";
import { genResume, renderResume } from "./pipeline/resume.js";
import { screenJob } from "./pipeline/screen.js";
import { evaluateCompany } from "./research/evaluate.js";
import { searchReputation } from "./research/web_search.js";
import { fetchTianyanchaBestEffort } from "./research/tianyancha.js";

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
  researchFn = researchCompany,
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
    try {
      context = await browserFactory();
      page = await getOrCreatePage(context);
    } catch (error) {
      if (isBrowserBusyError(error)) {
        return { ...summary, skipped: "browser_busy" };
      }
      throw error;
    }
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
          if (isInactiveHrActive(job.hr_active)) {
            rejectDiscoveredJob(db, job.id, {
              score: 0,
              screen: {
                score: 0,
                bait: false,
                verdict: "reject",
                concerns: ["HR不活跃"],
                reason: "HR不活跃",
              },
            });
            summary.rejected += 1;
            continue;
          }

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

          if (screen.verdict !== "pass" || screen.bait) {
            saveScreenResult(db, job.id, screen);
            summary.rejected += 1;
            continue;
          }

          const research = await researchFn(db, page, job, {
            notifyFn,
            delayFn,
          });
          if (isCompanyRejected(research)) {
            rejectDiscoveredJob(db, job.id, {
              score: screen.score,
              screen,
              research,
              companyScore: research.company_score,
            });
            summary.rejected += 1;
            continue;
          }

          job = queueResearchedJob(db, job.id, {
            screen,
            research,
            companyScore: research.company_score,
          });
          const materialJob = {
            ...job,
            styleHint: research.style_hint,
            research,
          };
          const materials = await materialsFn(materialJob);
          saveMaterials(db, job.id, materials);
          const resume = await resumeFn(materialJob);
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

export async function runResearchBackfill({
  db,
  page,
  browserFactory = launchBrowser,
  researchFn = researchCompany,
  output = console.log,
  delayFn = humanDelay,
  limit = Number.POSITIVE_INFINITY,
  statuses = ["greeted", "replied"],
  now = new Date(),
  scanConfig = config.scan,
} = {}) {
  const summary = { total: 0, researched: 0, rejected: 0, errors: 0, skipped: null };

  if (isRecentCircuitOpen(getMeta(db, "circuit_open"), now)) {
    return { ...summary, skipped: "circuit_open" };
  }

  const placeholders = statuses.map(() => "?").join(", ");
  const jobs = db
    .prepare(
      `SELECT * FROM jobs WHERE status IN (${placeholders}) AND company IS NOT NULL ORDER BY created_at`,
    )
    .all(...statuses)
    .filter((job, index, all) =>
      // 同公司只背调一次 (researchCompany 内部有缓存, 这里再去重省浏览器往返)
      all.findIndex((other) => other.company === job.company) === index,
    )
    .slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);

  summary.total = jobs.length;

  let context;
  if (!page) {
    try {
      context = await browserFactory();
      page = await getOrCreatePage(context);
    } catch (error) {
      if (isBrowserBusyError(error)) return { ...summary, skipped: "browser_busy" };
      throw error;
    }
  }

  try {
    let fetched = false;
    for (const job of jobs) {
      try {
        if (fetched) await delaySeconds(delayFn, scanConfig.jobDelaySec);
        fetched = true;
        const research = await researchFn(db, page, job, { now });
        // 回填该公司所有 greeted/replied 岗位, 不改状态
        const companyJobs = db
          .prepare(
            `SELECT id FROM jobs WHERE company = ? AND status IN (${placeholders})`,
          )
          .all(job.company, ...statuses);
        for (const { id } of companyJobs) {
          saveJobResearch(db, id, {
            companyScore: research.company_score,
            research,
          });
        }
        summary.researched += 1;
        if (isCompanyRejected(research)) {
          summary.rejected += 1;
          output(
            `⚠ ${job.company}: score=${research.company_score}` +
              (research.bait_and_switch?.value ? ` 挂羊头(${research.bait_and_switch.reason})` : "") +
              (research.red_flags?.length
                ? ` 红旗:${research.red_flags
                    .map((flag) =>
                      typeof flag === "string" ? flag : flag?.reason ?? flag?.type ?? "",
                    )
                    .filter(Boolean)
                    .join(" / ")}`
                : ""),
          );
        } else {
          output(`✓ ${job.company}: score=${research.company_score}`);
        }
      } catch (error) {
        summary.errors += 1;
        output(`✖ ${job.company}: ${error.message}`);
      }
    }
    return summary;
  } finally {
    if (context) await context.close();
  }
}

export async function researchCompany(
  db,
  page,
  job,
  {
    fetchBossFn = fetchCompanyIntel,
    searchFn = searchReputation,
    tycFn = fetchTianyanchaBestEffort,
    evaluateFn = evaluateCompany,
    notifyFn = notifyText,
    delayFn = humanDelay,
    now = new Date(),
    cacheTtlDays = 30,
  } = {},
) {
  const cached = getCompanyIntel(db, job.company);
  if (isFreshCompanyIntel(cached, { now, cacheTtlDays }) && cached.evalJson) {
    return cached.evalJson;
  }

  const degraded = [];
  const bossData = await fetchBossFn(page, {
    jobUrl: job.url,
    db,
    notifyFn,
    delayFn,
  });

  const searchResult = await withIndependentPage(page, (researchPage) =>
    searchFn(job.company, { page: researchPage, delayFn }),
  );
  if (searchResult?.degraded) degraded.push("search");

  const tycResult = await withIndependentPage(page, (researchPage) =>
    tycFn(job.company, { page: researchPage }),
  );
  if (tycResult?.degraded) degraded.push("tyc");

  const intel = {
    boss: { data: bossData, degraded: false },
    search: searchResult ?? { data: [], degraded: true, reason: "missing" },
    tyc: tycResult ?? { data: null, degraded: true, reason: "missing" },
    degraded,
  };
  const evaluation = await evaluateFn(intel, job);
  saveCompanyIntel(db, job.company, {
    bossJson: bossData,
    searchJson: searchResult?.data,
    tycJson: tycResult?.data,
    degraded: degraded.join(","),
    evalJson: evaluation,
  });
  return evaluation;
}

export function isFreshCompanyIntel(row, { now = new Date(), cacheTtlDays = 30 } = {}) {
  if (!row?.fetched_at) {
    return false;
  }
  const fetchedAt = parseLocalTimestamp(row.fetched_at);
  if (!fetchedAt) {
    return false;
  }
  const ageMs = now.getTime() - fetchedAt.getTime();
  return ageMs >= 0 && ageMs < cacheTtlDays * 24 * 60 * 60 * 1_000;
}

function isCompanyRejected(research) {
  return (
    research.company_score < config.screening.companyPassScore ||
    research.bait_and_switch?.value === true
  );
}

function rejectDiscoveredJob(
  db,
  id,
  { score, screen, research = null, companyScore = null },
) {
  return updateJobStatus(db, id, "screened_out", {
    score,
    screen_json: JSON.stringify(screen),
    company_score: companyScore,
    research_json: research ? JSON.stringify(research) : null,
  });
}

function queueResearchedJob(db, id, { screen, research, companyScore }) {
  return updateJobStatus(db, id, "queued", {
    score: screen.score,
    screen_json: JSON.stringify(screen),
    company_score: companyScore,
    research_json: JSON.stringify(research),
  });
}

async function withIndependentPage(page, fn) {
  const context = page?.context?.();
  if (!context?.newPage) {
    return fn(undefined);
  }
  const researchPage = await context.newPage();
  try {
    return await fn(researchPage);
  } finally {
    if (!researchPage.isClosed?.()) {
      await researchPage.close?.().catch(() => {});
    }
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
        try {
          context = await browserFactory();
          page = await getOrCreatePage(context);
        } catch (error) {
          if (isBrowserBusyError(error)) {
            return { attempted, results, skipped: "browser_busy" };
          }
          throw error;
        }
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

function isBrowserBusyError(error) {
  return error instanceof BrowserBusyError || error?.code === "BROWSER_BUSY";
}

export function resetCircuit(db) {
  return deleteMeta(db, "circuit_open");
}

export async function runChat({
  db,
  page,
  now = new Date(),
  browserFactory = launchBrowser,
  notifyTextFn = notifyText,
  notifyFileFn = notifyFile,
  customizeFn = customizeResume,
  uploadFn = uploadAttachment,
  sendResumeFn = sendResumeFromLibrary,
  sendReplyFn = sendReply,
  classifyAndDraftFn = classifyAndDraft,
  pushPendingToLarkFn = pushPendingToLark,
  reconcilePendingFromLarkFn = reconcilePendingFromLark,
  larkFetchFn = fetchRecentUserBotMessages,
  readProjectFactsFn = readProjectFacts,
  resumeBase,
  profileText,
  // 默认安全(影子/不自动发); CLI/cron 显式传入 config.reply / config.resume 才启用真发
  replyConfig = { shadowMode: true, autoRoutine: false, maxAutoPerRun: 3, replyDelaySec: [30, 120] },
  resumeConfig = { autoSend: false },
  // 发送门交给 replyConfig(shadowMode/autoRoutine)判断; 此处默认真发, 测试注入 fake sendReplyFn 兜底
  replyDryRun = false,
  backfill = false,
  maxConversations = config.chat?.maxPerRun ?? 10,
  listFn = listAllConversations,
  readFn = readConversationMessages,
  assertPageSafeFn = assertPageSafe,
  delayFn = humanDelay,
} = {}) {
  let context;
  const summary = {
    conversations: 0,
    opened: 0,
    newHrMessages: 0,
    resumeRequests: 0,
    notified: 0,
    loginOk: false,
    pendingReplies: 0,
    autoReplies: 0,
    noiseReplies: 0,
    reconciledApproved: 0,
  };

  if (isRecentCircuitOpen(getMeta(db, "circuit_open"), now)) {
    return { ...summary, skipped: "circuit_open" };
  }

  if (!page) {
    try {
      context = await browserFactory();
      page = await getOrCreatePage(context);
    } catch (error) {
      if (isBrowserBusyError(error)) {
        return { ...summary, skipped: "browser_busy" };
      }
      throw error;
    }
  }

  try {
    try {
      await reconcilePendingFromLarkFn({
        db,
        larkFetchFn,
        notifyFn: notifyTextFn,
        now,
      });
      summary.reconciledApproved = await sendApprovedPendingReplies(db, {
        page,
        sendReplyFn,
        replyDryRun,
        replyConfig,
      });

      await page.goto(URLS.recommend, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await assertPageSafeFn(page, {
        db,
        notifyFn: notifyTextFn,
        expectLoggedIn: true,
      });
      recordLoginEvent(db, "ok");
      summary.loginOk = true;
      await delayFn(500, 1_500);

      await page.goto(URLS.messages, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await assertPageSafeFn(page, {
        db,
        notifyFn: notifyTextFn,
        expectLoggedIn: true,
      });
      await delayFn(500, 1_500);

      const conversations = await listFn(page);
      summary.conversations = conversations.length;
      const candidates = conversations
        .map((conversation) => {
          const previous = getConversationByKey(db, conversation.bossConvKey);
          const row = linkConversationToJob(db, upsertConversation(db, {
            bossConvKey: conversation.bossConvKey,
            hrName: conversation.hrName,
            company: conversation.company,
            jobTitle: conversation.jobTitle,
            lastMsgText: conversation.lastMsgText,
            lastMsgAt: conversation.lastMsgTimeLabel,
          }));
          const changed =
            !previous ||
            previous.last_msg_text !== (conversation.lastMsgText ?? null) ||
            previous.last_msg_at !== (conversation.lastMsgTimeLabel ?? null);
          return { conversation, row, changed };
        })
        .filter(({ changed }) => backfill || changed);

      const toOpen = backfill
        ? candidates
        : candidates.slice(0, maxConversations);
      const newHrMessages = [];

      for (const { conversation, row } of toOpen) {
        const readResult = normalizeConversationReadResult(
          await readFn(page, conversation.bossConvKey, {
          scrollRounds: backfill ? config.chat?.backfillScrollRounds ?? 5 : 0,
          delayFn,
          includeConversation: true,
          }),
        );
        const openedConversation = {
          ...conversation,
          ...readResult.conversation,
          bossConvKey: conversation.bossConvKey,
        };
        const currentRow = linkConversationToJob(db, {
          ...upsertConversation(db, {
            bossConvKey: openedConversation.bossConvKey,
            hrName: openedConversation.hrName,
            company: openedConversation.company,
            jobTitle: openedConversation.jobTitle,
            lastMsgText: openedConversation.lastMsgText,
            lastMsgAt: openedConversation.lastMsgTimeLabel,
          }),
          source_job_id: openedConversation.jobId,
        });
        summary.opened += 1;

        for (const message of readResult.messages) {
          const result = insertMessage(db, currentRow.id, message);
          if (result.inserted && message.role === "hr") {
            newHrMessages.push({
              conversation: openedConversation,
              row: currentRow,
              message: result.row,
            });
          }
        }
      }

      const pendingHrReplies = pendingHrMessageReplies(db);
      const pendingHrMessages = replyGroupsToMessageItems(pendingHrReplies);
      summary.newHrMessages = pendingHrMessages.length;
      if (backfill) {
        if (pendingHrMessages.length > 0) {
          await notifyTextFn(formatBackfillSummary(summary, pendingHrMessages));
          markReplyMessages(db, pendingHrReplies, "backfilled");
          summary.notified = 1;
        }
      } else {
        const resumeRequests = await processResumeRequests(
          db,
          pendingResumeRequestMessages(db),
          {
            page,
            notifyTextFn,
            notifyFileFn,
            customizeFn,
            uploadFn,
            sendResumeFn,
            readProjectFactsFn,
            resumeBase,
            profileText,
            dryRun: !resumeConfig?.autoSend,
            approved: Boolean(resumeConfig?.autoSend),
          },
        );
        summary.resumeRequests = resumeRequests.length;

        // 只对"还没被我方回复过"的会话自动回复 (最后一条HR消息之后无我方消息), 防重复打扰
        const remainingHrReplies = withoutAlreadyRepliedGroups(
          db,
          pendingHrMessageReplies(db),
        );
        const dispatched = await processTieredReplyDispatch(db, remainingHrReplies, {
          page,
          now,
          notifyTextFn,
          sendReplyFn,
          classifyAndDraftFn,
          pushPendingToLarkFn,
          readProjectFactsFn,
          profileText,
          replyConfig,
          replyDryRun,
        });
        summary.pendingReplies = dispatched.pendingReplies;
        summary.autoReplies = dispatched.autoReplies;
        summary.noiseReplies = dispatched.noiseReplies;
        summary.notified = resumeRequests.length + dispatched.pendingReplies;
      }

      return summary;
    } catch (error) {
      if (!isLoginExpiredError(error)) {
        throw error;
      }
      recordLoginEvent(db, "expired");
      summary.loginOk = false;
      return summary;
    }
  } finally {
    if (context) await context.close();
  }
}

export async function runPoll({
  db,
  page,
  browserFactory = launchBrowser,
  notifyTextFn = notifyText,
  notifyFileFn = notifyFile,
} = {}) {
  return runChat({
    db,
    page,
    browserFactory,
    notifyTextFn,
    notifyFileFn,
    // cron 走 poll 别名, 显式传 live config 才启用自动发送/回复
    replyConfig: config.reply,
    resumeConfig: config.resume,
  });
}

export async function runResumeSend({
  db,
  convKey,
  page,
  browserFactory = launchBrowser,
  notifyTextFn = notifyText,
  notifyFileFn = notifyFile,
  customizeFn = customizeResume,
  uploadFn = uploadAttachment,
  sendResumeFn = sendResumeFromLibrary,
  readProjectFactsFn = readProjectFacts,
  resumeBase,
  profileText,
  approved = false,
} = {}) {
  if (!convKey) {
    throw new Error("resume-send requires --conv");
  }

  const row = getConversationByKey(db, convKey);
  if (!row) {
    throw new Error(`Conversation not found: ${convKey}`);
  }

  let context;
  if (!page) {
    context = await browserFactory();
    page = await getOrCreatePage(context);
  }

  try {
    const [result] = await processResumeRequests(
      db,
      [manualResumeRequestForConversation(row)],
      {
        page,
        notifyTextFn,
        notifyFileFn,
        customizeFn,
        uploadFn,
        sendResumeFn,
        readProjectFactsFn,
        resumeBase,
        profileText,
        dryRun: !approved,
        approved,
        force: true,
      },
    );
    return result;
  } finally {
    if (context) await context.close();
  }
}

export async function runReply({
  db,
  convKey,
  page,
  browserFactory = launchBrowser,
  sendReplyFn = sendReply,
  approved = false,
  replyDelaySec = config.reply?.replyDelaySec ?? [30, 120],
} = {}) {
  if (!convKey) {
    throw new Error("reply requires --conv");
  }

  const row = getConversationByKey(db, convKey);
  if (!row) {
    throw new Error(`Conversation not found: ${convKey}`);
  }
  const pending = latestApprovedReplyPending(db, row.id);
  if (!pending) {
    throw new Error(`No approved reply pending action found for conversation: ${convKey}`);
  }
  const text = pendingReplyText(pending);
  if (!text) {
    throw new Error(`Approved pending action ${pending.id} has no reply text`);
  }

  let context;
  if (!page) {
    context = await browserFactory();
    page = await getOrCreatePage(context);
  }

  try {
    const result = await sendReplyFn(page, {
      conversation: conversationFromRow(row),
      text,
      dryRun: !approved,
      approved,
      replyDelaySec,
    });
    if (approved) {
      resolvePendingAction(db, pending.id, {
        status: "approved",
        payloadPatch: {
          replySendResult: result,
          replySentAt: localTimestamp(),
        },
      });
    }
    return {
      conversationKey: convKey,
      pendingActionId: pending.id,
      dryRun: result.dryRun,
      approved,
      sent: result.sent,
      text,
      plan: result.plannedSteps ?? [],
      result,
    };
  } finally {
    if (context) await context.close();
  }
}

export async function processTieredReplyDispatch(
  db,
  replies,
  {
    page,
    now,
    notifyTextFn,
    sendReplyFn,
    classifyAndDraftFn,
    pushPendingToLarkFn,
    readProjectFactsFn,
    profileText,
    replyConfig,
    replyDryRun,
  },
) {
  const settings = normalizeReplyConfig(replyConfig);
  const summary = { pendingReplies: 0, autoReplies: 0, noiseReplies: 0 };
  if (replies.length === 0) {
    return summary;
  }

  const memoryFacts = readProjectFactsFn();
  const profile = profileText ?? loadProfileText();
  let autoThisRun = 0;

  for (const reply of replies) {
    const job = ensureReplyJob(db, reply);
    const conversationHistory = getConversationMessages(db, reply.convId, {
      limit: 20,
    });
    const result = await classifyAndDraftFn(job, {
      reply: reply.lastMsg,
      conversationHistory,
      profileText: profile,
      memoryFacts,
      shadowMode: settings.shadowMode,
    });
    const draftText = replyDraftText(result);

    if (result.tier === "noise") {
      markReplyMessages(db, [reply], "reply_noise");
      summary.noiseReplies += 1;
      continue;
    }

    if (
      result.tier === "routine" &&
      !settings.shadowMode &&
      settings.autoRoutine &&
      canAutoReply(db, { now, settings, autoThisRun })
    ) {
      const sendResult = await sendReplyFn(page, {
        conversation: reply.conversation,
        text: draftText,
        dryRun: replyDryRun,
        approved: !replyDryRun,
        replyDelaySec: settings.replyDelaySec,
      });
      // 只在真发出去了才计数+标记, 避免 dry-run/失败被误标为已回
      if (sendResult?.sent) {
        incrementReplyAutoCount(db, now);
        autoThisRun += 1;
        markReplyMessages(db, [reply], "auto_replied");
        summary.autoReplies += 1;
        continue;
      }
      // dry-run 或未发出: 落 pending 草稿, 不标记已回
    }

    const pending =
      findExistingPendingForReply(db, reply) ??
      createPendingAction(db, {
        convId: reply.convId,
        type: result.tier === "interview" ? "interview" : "reply_draft",
        payload: buildPendingReplyPayload(reply, job, result, draftText, {
          settings,
          autoLimitReached:
            result.tier === "routine" &&
            !settings.shadowMode &&
            settings.autoRoutine,
        }),
      });
    await pushPendingToLarkFn(pending, { notifyFn: notifyTextFn });
    markReplyMessages(db, [reply], "reply_pending");
    summary.pendingReplies += 1;
  }

  return summary;
}

async function sendApprovedPendingReplies(
  db,
  { page, sendReplyFn, replyDryRun, replyConfig },
) {
  const settings = normalizeReplyConfig(replyConfig);
  let sent = 0;
  for (const pending of listPendingActions(db, { status: "approved" })) {
    if (!["reply_draft", "interview"].includes(pending.type)) {
      continue;
    }
    if (pending.payload?.replySendResult) {
      continue;
    }
    const text = pendingReplyText(pending);
    if (!text) {
      continue;
    }
    const result = await sendReplyFn(page, {
      conversation: pending.payload.conversation,
      text,
      dryRun: replyDryRun,
      approved: !replyDryRun,
      replyDelaySec: settings.replyDelaySec,
    });
    resolvePendingAction(db, pending.id, {
      status: "approved",
      payloadPatch: {
        replySendResult: result,
        replySentAt: localTimestamp(),
      },
    });
    sent += 1;
  }
  return sent;
}

export async function processResumeRequests(
  db,
  requests,
  {
    page,
    notifyTextFn = notifyText,
    notifyFileFn = notifyFile,
    customizeFn = customizeResume,
    uploadFn = uploadAttachment,
    sendResumeFn = sendResumeFromLibrary,
    readProjectFactsFn = readProjectFacts,
    resumeBase,
    profileText,
    dryRun = true,
    approved = false,
    force = false,
  } = {},
) {
  const results = [];
  for (const request of requests) {
    if (!force && !isResumeRequestGroup(request)) {
      continue;
    }

    if (!request.jobId) {
      const text = formatUnlinkedResumeRequest(request, "未关联岗位");
      const textReceipt = await notifyTextFn(text);
      markReplyMessages(db, [request], "resume_requested");
      results.push({
        matched: false,
        reason: "unlinked_job",
        text,
        textReceipt,
      });
      continue;
    }

    let job = getJob(db, request.jobId);
    if (!job) {
      const text = formatUnlinkedResumeRequest(request, "关联岗位不存在");
      const textReceipt = await notifyTextFn(text);
      markReplyMessages(db, [request], "resume_requested");
      results.push({
        matched: false,
        reason: "missing_job",
        text,
        textReceipt,
      });
      continue;
    }

    if (request.hrName) {
      db.prepare("UPDATE jobs SET hr_name = ? WHERE id = ?").run(
        request.hrName,
        job.id,
      );
      job = getJob(db, job.id);
    }

    if (job.status === "greeted") {
      job = updateJobStatus(db, job.id, "replied");
    }

    const memoryFacts = readProjectFactsFn();
    const customized = await customizeFn(job, {
      research: parseJobResearch(job.research_json),
      resumeBase: resumeBase ?? loadResumeBase(),
      profileText: profileText ?? loadProfileText(),
      memoryFacts,
    });
    const resumePath = customized.resumePath;
    if (!resumePath) {
      throw new Error("customizeResume did not return resumePath");
    }
    const attachmentName = path.basename(resumePath);
    const uploadResult = await uploadFn(page, resumePath, {
      dryRun,
      approved,
    });
    const sendResult = await sendResumeFn(page, {
      conversation: request.conversation,
      attachmentName,
      message: "",
      dryRun,
      approved,
    });
    const text = formatResumeRequestNotification({
      job,
      customized,
      uploadResult,
      sendResult,
      dryRun,
      approved,
    });
    const textReceipt = await notifyTextFn(text);
    const fileReceipt = await notifyFileFn(
      resumePath,
      `定制简历副本: ${job.company || "未知公司"} | ${job.title || "未知岗位"}`,
    );

    if (job.status === "replied") {
      job = updateJobStatus(db, job.id, "resume_sent", {
        resume_path: resumePath,
      });
    } else {
      saveResumePath(db, job.id, resumePath);
      job = getJob(db, job.id);
    }
    markReplyMessages(db, [request], "resume_requested");
    results.push({
      matched: true,
      jobId: job.id,
      conversationKey: request.conversation.bossConvKey,
      resumePath,
      dryRun,
      approved,
      plan: {
        upload: uploadResult.plannedSteps ?? [],
        send: sendResult.plannedSteps ?? [],
      },
      text,
      textReceipt,
      fileReceipt,
    });
  }
  return results;
}

export function isResumeRequestMessage(message) {
  const text = compactRequestText(
    typeof message === "string" ? message : message?.text,
  );
  if (!text) {
    return false;
  }
  if (
    SYSTEM_RESUME_REQUEST_TRIGGERS.some((trigger) =>
      text.includes(compactRequestText(trigger)),
    )
  ) {
    return true;
  }
  return HR_RESUME_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

function isResumeRequestGroup(group) {
  return group.messages?.some(isResumeRequestMessage) ?? false;
}

function manualResumeRequestForConversation(row) {
  return {
    messageIds: [],
    messages: [{ role: "system", text: "manual resume-send" }],
    conversation: {
      bossConvKey: row.boss_conv_key,
      jobId: row.job_id,
      hrName: row.hr_name,
      company: row.company,
      jobTitle: row.job_title,
    },
    jobId: row.job_id,
    jobMatchKey: row.job_id ?? row.boss_conv_key,
    jobTitle: row.job_title,
    hrName: row.hr_name,
    company: row.company,
    lastMsg: "manual resume-send",
  };
}

function latestApprovedReplyPending(db, convId) {
  return listPendingActions(db, { status: "approved", convId })
    .filter((pending) => ["reply_draft", "interview"].includes(pending.type))
    .filter((pending) => !pending.payload?.replySendResult)
    .at(-1) ?? null;
}

function normalizeReplyConfig(value = {}) {
  return {
    shadowMode: value.shadowMode !== false,
    autoRoutine: value.autoRoutine === true,
    maxAutoPerRun: normalizePositiveInteger(value.maxAutoPerRun, 3),
    replyDelaySec: normalizeDelayPair(value.replyDelaySec, [30, 120]),
  };
}

function ensureReplyJob(db, reply) {
  let job = reply.jobId ? getJob(db, reply.jobId) : null;
  if (!job) {
    job = findReplyJob(db, reply);
  }
  if (job?.status === "greeted") {
    job = updateJobStatus(db, job.id, "replied");
  }
  return job ?? {
    id: reply.jobMatchKey ?? reply.conversation?.bossConvKey,
    title: reply.jobTitle ?? reply.conversation?.jobTitle ?? "",
    company: reply.company ?? reply.conversation?.company ?? "",
    hr_name: reply.hrName ?? reply.conversation?.hrName ?? "",
  };
}

function pendingReplyText(pending) {
  const payload = pending?.payload ?? {};
  return String(
    payload.approvedText ??
      payload.draftText ??
      payload.draft?.proposedReply ??
      payload.proposedReply ??
      "",
  ).trim();
}

function replyDraftText(result) {
  return String(
    result?.draft?.proposedReply ??
      result?.draft?.proposed_reply ??
      result?.draftText ??
      "",
  ).trim();
}

function buildPendingReplyPayload(reply, job, result, draftText, { settings, autoLimitReached }) {
  return {
    tier: result.tier,
    draft: result.draft,
    draftText,
    replyText: reply.lastMsg,
    messageIds: reply.messageIds ?? [],
    conversation: reply.conversation,
    job: {
      id: job.id ?? null,
      title: job.title ?? job.job_title ?? null,
      company: job.company ?? null,
      hrName: job.hr_name ?? reply.hrName ?? null,
    },
    requiresConfirm: result.requiresConfirm,
    dispatch: {
      shadowMode: settings.shadowMode,
      autoRoutine: settings.autoRoutine,
      autoLimitReached: Boolean(autoLimitReached),
    },
  };
}

function findExistingPendingForReply(db, reply) {
  const messageIds = reply.messageIds ?? [];
  if (messageIds.length === 0) {
    return null;
  }
  return (
    listPendingActions(db, { status: "pending", convId: reply.convId })
      .find((pending) => sameIdSet(pending.payload?.messageIds ?? [], messageIds)) ??
    null
  );
}

function sameIdSet(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  const rightIds = new Set(right.map(String));
  return left.every((id) => rightIds.has(String(id)));
}

function canAutoReply(db, { now, settings, autoThisRun }) {
  return (
    autoThisRun < settings.maxAutoPerRun &&
    getReplyAutoCount(db, now) < settings.maxAutoPerRun
  );
}

function getReplyAutoCount(db, now) {
  return Number.parseInt(getMeta(db, replyAutoCounterKey(now)) ?? "0", 10);
}

function incrementReplyAutoCount(db, now) {
  const next = getReplyAutoCount(db, now) + 1;
  setMeta(db, replyAutoCounterKey(now), next);
  return next;
}

function replyAutoCounterKey(now) {
  return `reply_auto_count_${localDateKey(now)}`;
}

function localDateKey(now) {
  const date = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 10);
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.isInteger(value) ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDelayPair(value, fallback) {
  if (!Array.isArray(value) || value.length !== 2) {
    return fallback;
  }
  const [minimum, maximum] = value;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum) {
    return fallback;
  }
  return [minimum, maximum];
}

function conversationFromRow(row) {
  return {
    bossConvKey: row.boss_conv_key,
    jobId: row.job_id,
    hrName: row.hr_name,
    company: row.company,
    jobTitle: row.job_title,
  };
}

function formatUnlinkedResumeRequest(request, reason) {
  return [
    `简历请求无法定制: ${reason}`,
    `公司: ${request.company || "未知公司"}`,
    `岗位: ${request.jobTitle || "未知岗位"}`,
    `HR: ${request.hrName || "未知"}`,
    `会话: ${request.conversation?.bossConvKey || "未知"}`,
    `消息: ${request.lastMsg || ""}`,
  ].join("\n");
}

function formatResumeRequestNotification({
  job,
  customized,
  uploadResult,
  sendResult,
  dryRun,
  approved,
}) {
  return [
    dryRun ? "简历请求 dry-run 计划" : "简历请求已手动发送",
    `岗位: ${job.title || "未知岗位"}`,
    `公司: ${job.company || "未知公司"}`,
    `模式: ${dryRun ? "dry-run, 未真实上传/发送" : `approved=${approved}`}`,
    `简历: ${customized.resumePath}`,
    "",
    "定制简历要点:",
    ...formatStrategyHighlights(customized.strategy),
    "",
    "计划:",
    ...formatPlanSteps("上传附件库", uploadResult),
    ...formatPlanSteps("聊天选发", sendResult),
  ].join("\n");
}

function formatStrategyHighlights(strategy = {}) {
  const lines = [];
  if (strategy.positioning) {
    lines.push(`- 定位: ${strategy.positioning}`);
  }
  if (strategy.selectedProjects?.length) {
    lines.push(`- 项目: ${strategy.selectedProjects.join(", ")}`);
  }
  if (strategy.jdKeywords?.length) {
    lines.push(`- JD关键词: ${strategy.jdKeywords.join(", ")}`);
  }
  if (strategy.companyStyleNotes?.length) {
    lines.push(`- 公司风格: ${strategy.companyStyleNotes.join("; ")}`);
  }
  if (strategy.riskNotes?.length) {
    lines.push(`- 风险: ${strategy.riskNotes.join("; ")}`);
  }
  return lines.length > 0 ? lines : ["- 未返回策略摘要"];
}

function formatPlanSteps(label, result = {}) {
  const steps = result.plannedSteps ?? [];
  if (steps.length === 0) {
    return [`- ${label}: 无计划步骤返回`];
  }
  return steps.map((step) => `- ${label}: ${step}`);
}

function parseJobResearch(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function loadResumeBase() {
  return JSON.parse(fs.readFileSync(config.paths.resumeBase, "utf8"));
}

function loadProfileText() {
  return fs.readFileSync(config.paths.profile, "utf8");
}

function compactRequestText(value) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

const SYSTEM_RESUME_REQUEST_TRIGGERS = Object.freeze([
  "我想要一份您的附件简历",
  "对方请你发送附件简历",
  "请求附件简历",
]);

const HR_RESUME_REQUEST_PATTERNS = Object.freeze([
  /发我(?:一份|份|个)?(?:你|你的|您|您的)?(?:附件)?简历/u,
  /看看(?:你|你的|您|您的)?(?:附件)?简历/u,
  /发份(?:附件)?简历/u,
  /发个(?:附件)?简历/u,
]);

export async function processReplyNotifications(
  db,
  replies,
  { notifyTextFn = notifyText, notifyFileFn = notifyFile } = {},
) {
  const results = [];
  for (const reply of replies) {
    const dedupeKey = replyNotificationKey(reply);
    if (getMeta(db, dedupeKey) !== null) {
      markReplyMessages(db, [reply], "notified");
      continue;
    }

    let job = reply.jobId ? getJob(db, reply.jobId) : null;
    if (!job) {
      job = findReplyJob(db, reply);
    }
    if (!job) {
      const unknownParts = [
        "💬 未知岗位",
        reply.company,
        reply.jobTitle || "职位未知",
        `HR ${reply.hrName || "未知"}: ${reply.lastMsg}`,
      ].filter(Boolean);
      const text = unknownParts.join("|");
      const textReceipt = await notifyTextFn(text);
      setMeta(db, dedupeKey, "1");
      markReplyMessages(db, [reply], "notified");
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
    if (job.status === "notified" || job.status === "resume_sent") {
      const textReceipt = await notifyTextFn(replyText);
      setMeta(db, dedupeKey, "1");
      markReplyMessages(db, [reply], "notified");
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
    markReplyMessages(db, [reply], "notified");
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

export function linkConversationToJob(db, convRow) {
  if (!convRow || convRow.job_id) {
    return convRow;
  }

  const directId = convRow.source_job_id ?? convRow.jobId ?? null;
  let job = directId ? getJob(db, directId) : null;
  if (!job) {
    job = findJobByConversationCompany(db, convRow);
  }
  if (!job) {
    return convRow;
  }

  db.prepare(
    "UPDATE conversations SET job_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND job_id IS NULL",
  ).run(job.id, convRow.id);
  return db
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .get(convRow.id);
}

function findJobByConversationCompany(db, convRow) {
  const company = normalizeMatchText(convRow.company);
  if (!company) {
    return null;
  }

  const candidates = db
    .prepare(
      "SELECT * FROM jobs WHERE status IN ('greeted', 'replied', 'resume_sent', 'notified') ORDER BY greeted_at DESC, created_at DESC",
    )
    .all()
    .filter((job) => companyMatches(company, normalizeMatchText(job.company)));
  if (candidates.length === 0) {
    return null;
  }

  const title = normalizeMatchText(convRow.job_title ?? convRow.jobTitle);
  const titleMatches = title
    ? candidates.filter((job) =>
        companyMatches(title, normalizeMatchText(job.title)),
      )
    : [];
  const matches = titleMatches.length > 0 ? titleMatches : candidates;
  return matches.length === 1 ? matches[0] : null;
}

function normalizeMatchText(value) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

function companyMatches(left, right) {
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function normalizeConversationReadResult(result) {
  if (Array.isArray(result)) {
    return { conversation: {}, messages: result };
  }
  return {
    conversation: result?.conversation ?? {},
    messages: result?.messages ?? [],
  };
}

function pendingHrMessageReplies(db) {
  return pendingConversationMessageGroups(db, ["hr"]);
}

// 过滤掉"最后一条HR消息之后已有我方消息"的会话组 (已回过, 不再自动回复, 防重复打扰)
export function withoutAlreadyRepliedGroups(db, groups) {
  const laterMeStmt = db.prepare(
    "SELECT 1 FROM messages WHERE conv_id = ? AND role = 'me' AND id > ? LIMIT 1",
  );
  return groups.filter((group) => {
    const ids = group.messageIds ?? [];
    if (ids.length === 0) return true;
    const maxId = Math.max(...ids);
    return !laterMeStmt.get(group.convId ?? group.conversation?.convId, maxId);
  });
}

function pendingResumeRequestMessages(db) {
  return pendingConversationMessageGroups(db, ["hr", "system"]);
}

function pendingConversationMessageGroups(db, roles) {
  const placeholders = roles.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT
        m.id AS message_id,
        m.role,
        m.text,
        c.id AS conv_id,
        c.boss_conv_key,
        c.job_id,
        c.hr_name,
        c.company,
        c.job_title
      FROM messages m
      JOIN conversations c ON c.id = m.conv_id
      WHERE m.role IN (${placeholders}) AND m.action_taken IS NULL
      ORDER BY c.id, m.id`,
    )
    .all(...roles);
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.conv_id)) {
      grouped.set(row.conv_id, {
        convId: row.conv_id,
        messageIds: [],
        messages: [],
        conversation: {
          bossConvKey: row.boss_conv_key,
          jobId: row.job_id,
          hrName: row.hr_name,
          company: row.company,
          jobTitle: row.job_title,
        },
        jobId: row.job_id,
        jobMatchKey: row.job_id ?? row.boss_conv_key,
        jobTitle: row.job_title,
        hrName: row.hr_name,
        company: row.company,
      });
    }
    const group = grouped.get(row.conv_id);
    group.messageIds.push(row.message_id);
    group.messages.push({ id: row.message_id, role: row.role, text: row.text });
  }

  return [...grouped.values()].map((group) => ({
    ...group,
    lastMsg: group.messages.map((message) => message.text).join("\n"),
  }));
}

function replyGroupsToMessageItems(replies) {
  return replies.flatMap((reply) =>
    reply.messages.map((message) => ({
      conversation: reply.conversation,
      message,
    })),
  );
}

function markReplyMessages(db, replies, action) {
  const ids = replies.flatMap((reply) => reply.messageIds ?? []);
  if (ids.length === 0) {
    return 0;
  }
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(`UPDATE messages SET action_taken = ? WHERE id IN (${placeholders})`)
    .run(action, ...ids).changes;
}

function repliesFromNewMessages(newHrMessages) {
  const grouped = new Map();
  for (const item of newHrMessages) {
    const key = item.conversation.bossConvKey;
    if (!grouped.has(key)) {
      grouped.set(key, {
        conversation: item.conversation,
        messages: [],
      });
    }
    grouped.get(key).messages.push(item.message);
  }

  return [...grouped.values()].map(({ conversation, messages }) => ({
    jobMatchKey: conversation.jobId ?? conversation.bossConvKey,
    jobTitle: conversation.jobTitle,
    hrName: conversation.hrName,
    company: conversation.company,
    lastMsg: messages.map((message) => message.text).join("\n"),
  }));
}

function formatBackfillSummary(summary, newHrMessages) {
  const grouped = new Map();
  for (const item of newHrMessages) {
    const key = item.conversation.bossConvKey;
    if (!grouped.has(key)) {
      grouped.set(key, {
        conversation: item.conversation,
        count: 0,
      });
    }
    grouped.get(key).count += 1;
  }

  return [
    `Backfill complete: conversations=${summary.conversations}, opened=${summary.opened}, newHrMessages=${summary.newHrMessages}`,
    ...[...grouped.values()].map(({ conversation, count }) =>
      `- ${conversation.company || "未知公司"} | HR ${conversation.hrName || "未知"} | ${count} 条`,
    ),
  ].join("\n");
}

function isLoginExpiredError(error) {
  return (
    error instanceof CircuitBreakerError ||
    error.code === "BOSS_CIRCUIT_OPEN" ||
    error.code === "BOSS_LOGIN_REQUIRED"
  );
}

function isRecentCircuitOpen(openedAt, now) {
  if (!openedAt) {
    return false;
  }
  const opened = parseLocalTimestamp(openedAt);
  if (!opened) {
    return false;
  }
  const ageMs = now.getTime() - opened.getTime();
  return ageMs >= 0 && ageMs < 2 * 60 * 60 * 1_000;
}

function parseLocalTimestamp(value) {
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
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
      "SELECT * FROM jobs WHERE status IN ('greeted', 'replied', 'resume_sent', 'notified') ORDER BY greeted_at DESC, created_at DESC",
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

  if (reply.company) {
    const companyHrMatches = candidates.filter(
      (job) =>
        job.company === reply.company &&
        (!reply.hrName || !job.hr_name || job.hr_name === reply.hrName),
    );
    if (companyHrMatches.length === 1) {
      return companyHrMatches[0];
    }
  }

  const titleMatches = candidates.filter(
    (job) => job.title === reply.jobTitle,
  );
  return titleMatches.length === 1 ? titleMatches[0] : null;
}

export function getStatusSnapshot(db, { now = new Date() } = {}) {
  return {
    counts: getStatusCounts(db),
    conversations: countTableRows(db, "conversations"),
    messages: countTableRows(db, "messages"),
    lastLoginEvent: lastLoginEvent(db),
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
    "resume_sent",
    "notified",
    "error",
  ];
  return [
    ...statuses.map(
      (status) => `${status}: ${snapshot.counts[status] ?? 0}`,
    ),
    `conversations: ${snapshot.conversations}`,
    `messages: ${snapshot.messages}`,
    `last login: ${formatLastLogin(snapshot.lastLoginEvent)}`,
    `greeted today: ${snapshot.greetedToday}`,
    `dry-run greeted today: ${snapshot.dryRunGreetedToday}`,
    `circuit: ${snapshot.circuitOpen ?? "closed"}`,
  ].join("\n");
}

function countTableRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function formatLastLogin(event) {
  return event ? `${event.event} at ${event.at}` : "none";
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
