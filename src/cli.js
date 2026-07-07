#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { config } from "./config.js";
import { openDatabase } from "./db.js";
import { CircuitBreakerError } from "./boss/greet.js";
import {
  formatStatus,
  getStatusSnapshot,
  runChat,
  runGreetQueue,
  runLogin,
  runPoll,
  runReply,
  runResumeSend,
  runResearchBackfill,
  runScan,
  runTestNotify,
  resetCircuit,
} from "./workflows.js";

export function createProgram({
  runResumeSendFn = runResumeSend,
  runReplyFn = runReply,
} = {}) {
  const program = new Command();
  program
    .name("boss-job-agent")
    .description("Local Boss Zhipin job application agent")
    .option(
      "--database <path>",
      "SQLite database path",
      config.paths.database,
    )
    .showHelpAfterError();

  program
    .command("login")
    .description("Open headed Chrome and wait for Boss QR login")
    .action(async () => runLogin());

  program
    .command("scan")
    .description("Search, screen, and prepare matching jobs")
    .option("--query <query...>", "override configured search queries")
    .action(async (options, command) => {
      await withDatabase(command, (db) =>
        runScan({
          db,
          queries: options.query ?? config.search.queries,
        }),
      );
    });

  program
    .command("greet")
    .description("Greet queued jobs; dry-run is enabled by default")
    .option("--limit <number>", "maximum queued jobs", parsePositiveInteger)
    .addOption(
      new Option("--no-dry-run", "send messages for real").default(
        config.greeting.dryRun,
      ),
    )
    .action(async (options, command) => {
      const result = await withDatabase(command, (db) =>
        runGreetQueue({
          db,
          limit: options.limit ?? Number.POSITIVE_INFINITY,
          dryRun: options.dryRun,
        }),
      );
      console.log(formatGreetResult(result, options.dryRun));
    });

  program
    .command("chat")
    .description("Read all recruiter conversations, persist messages, and notify Feishu")
    .option("--backfill", "scan all conversations and send one aggregate notification")
    .option("--max <number>", "maximum changed conversations to open", parsePositiveInteger)
    .action(async (options, command) => {
      const result = await withDatabase(command, (db) =>
        runChat({
          db,
          backfill: Boolean(options.backfill),
          maxConversations: options.max ?? config.chat.maxPerRun,
          replyConfig: config.reply,
          resumeConfig: config.resume,
        }),
      );
      console.log(formatChatResult("chat", result));
    });

  program
    .command("poll")
    .description("Poll new recruiter replies and notify Feishu (deprecated, alias of chat)")
    .action(async (_options, command) => {
      const result = await withDatabase(command, (db) => runPoll({ db }));
      console.log(formatChatResult("poll", result));
    });

  program
    .command("resume-send")
    .description("Customize and send the resume for one conversation; dry-run by default")
    .requiredOption("--conv <key>", "Boss conversation key")
    .option("--send [approval]", "send for real only when approved")
    .action(async (options, command) => {
      const approved = parseResumeSendApproval(options.send);
      const result = await withDatabase(command, (db) =>
        runResumeSendFn({
          db,
          convKey: options.conv,
          approved,
        }),
      );
      console.log(formatResumeSendResult(result));
    });

  program
    .command("reply")
    .description("Send an approved pending chat reply for one conversation; dry-run by default")
    .requiredOption("--conv <key>", "Boss conversation key")
    .option("--send [approval]", "send for real only when explicitly passed")
    .action(async (options, command) => {
      const approved = parseReplySendApproval(options.send);
      const result = await withDatabase(command, (db) =>
        runReplyFn({
          db,
          convKey: options.conv,
          approved,
        }),
      );
      console.log(formatReplyResult(result));
    });

  program
    .command("research")
    .description("Backfill company research for greeted/replied jobs (does not change status)")
    .option("--limit <number>", "maximum companies to research", parsePositiveInteger)
    .action(async (options, command) => {
      const result = await withDatabase(command, (db) =>
        runResearchBackfill({
          db,
          limit: options.limit ?? Number.POSITIVE_INFINITY,
        }),
      );
      console.log(
        `research backfill: total=${result.total} researched=${result.researched} rejected=${result.rejected} errors=${result.errors}` +
          (result.skipped ? ` skipped=${result.skipped}` : ""),
      );
    });

  program
    .command("status")
    .description("Show pipeline counts and safety status")
    .action(async (_options, command) => {
      const snapshot = await withDatabase(command, (db) =>
        getStatusSnapshot(db),
      );
      console.log(formatStatus(snapshot));
    });

  program
    .command("circuit-reset")
    .description("Clear the persisted Boss circuit breaker")
    .action(async (_options, command) => {
      await withDatabase(command, (db) => resetCircuit(db));
      console.log("circuit reset: closed");
    });

  program
    .command("test-notify")
    .description("Send a Feishu text and a DOCX file")
    .action(async () => {
      const result = await runTestNotify();
      console.log(JSON.stringify(result, null, 2));
    });

  program
    .command("run")
    .description("Run scan, greet, and poll in sequence")
    .action(async (_options, command) => {
      await withDatabase(command, async (db) => {
        const scan = await runScan({ db });
        if (scan.blocked) return;
        await runGreetQueue({ db });
        await runPoll({ db });
      });
    });

  return program;
}

export function formatGreetResult(result, dryRun) {
  const summary = `greet attempted=${result.attempted} dryRun=${dryRun}`;
  if (result.skipped) return `${summary} skipped=${result.skipped}`;
  return result.stopped ? `${summary} stopped=${result.stopped}` : summary;
}

export function formatChatResult(command, result) {
  const summary = `${command} conversations=${result.conversations} opened=${result.opened} newHrMessages=${result.newHrMessages} resumeRequests=${result.resumeRequests ?? 0} notified=${result.notified} loginOk=${result.loginOk}`;
  return result.skipped ? `${summary} skipped=${result.skipped}` : summary;
}

export function formatResumeSendResult(result) {
  return `resume-send conv=${result.conversationKey} job=${result.jobId ?? "none"} dryRun=${result.dryRun} approved=${result.approved} resume=${result.resumePath ?? "none"}`;
}

export function formatReplyResult(result) {
  return `reply conv=${result.conversationKey} dryRun=${result.dryRun} approved=${result.approved} sent=${result.sent} text=${previewText(result.text)}`;
}

async function withDatabase(command, callback) {
  const databasePath = path.resolve(command.optsWithGlobals().database);
  const db = openDatabase(databasePath);
  try {
    return await callback(db);
  } finally {
    db.close();
  }
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function parseResumeSendApproval(value) {
  if (value === undefined || value === false) {
    return false;
  }
  if (value === true || value === "approved") {
    return true;
  }
  throw new Error("Real resume sending requires --send=approved");
}

function parseReplySendApproval(value) {
  if (value === undefined || value === false) {
    return false;
  }
  if (value === true || value === "approved") {
    return true;
  }
  throw new Error("Real reply sending requires --send or --send=approved");
}

function previewText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

export async function main(argv = process.argv) {
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    console.error(error.message);
    process.exitCode =
      error instanceof CircuitBreakerError ? error.exitCode : 1;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  await main();
}
