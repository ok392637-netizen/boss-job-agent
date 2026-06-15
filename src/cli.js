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
  runGreetQueue,
  runLogin,
  runPoll,
  runScan,
  runTestNotify,
  resetCircuit,
} from "./workflows.js";

export function createProgram() {
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
    .command("poll")
    .description("Poll new recruiter replies and notify Feishu")
    .action(async (_options, command) => {
      const results = await withDatabase(command, (db) => runPoll({ db }));
      console.log(`poll notifications=${results.length}`);
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
  return result.stopped ? `${summary} stopped=${result.stopped}` : summary;
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
