import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { config } from "../src/config.js";
import {
  getJob,
  listJobs,
  openDatabase,
  updateJobStatus,
} from "../src/db.js";
import { getOrCreatePage, launchBrowser } from "../src/browser.js";
import {
  formatStatus,
  getStatusSnapshot,
  runGreetQueue,
  runPoll,
  runScan,
} from "../src/workflows.js";
import { countMaterialCharacters } from "../src/pipeline/materials.js";

const databasePath = path.join(config.paths.projectRoot, "data", "acceptance.db");
const logDirectory = path.join(config.paths.projectRoot, "data", "logs");
const fixtureDirectory = path.join(
  config.paths.projectRoot,
  "test",
  "fixtures",
  "jds",
);
const greetFixture = pathToFileURL(
  path.join(
    config.paths.projectRoot,
    "test",
    "fixtures",
    "pages",
    "greet-editor.html",
  ),
).href;

fs.rmSync(databasePath, { force: true });
fs.rmSync(`${databasePath}-shm`, { force: true });
fs.rmSync(`${databasePath}-wal`, { force: true });
fs.mkdirSync(logDirectory, { recursive: true });

const fixtures = ["good-match", "mismatch", "bait"].map((name) => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(fixtureDirectory, `${name}.json`), "utf8"),
  );
  return {
    ...fixture,
    url: greetFixture,
  };
});

const db = openDatabase(databasePath);
const context = await launchBrowser();
const page = await getOrCreatePage(context);
const startedAt = new Date();
const report = {
  startedAt: startedAt.toISOString(),
  databasePath,
  fixtureIds: fixtures.map((fixture) => fixture.id),
};

try {
  report.scan = await runScan({
    db,
    page,
    queries: ["fixture-driven"],
    searchFn: async () => fixtures,
  });
  report.afterScan = listJobs(db).map(pickJob);

  report.greet = await runGreetQueue({
    db,
    page,
    limit: 2,
    dryRun: true,
    now: new Date("2026-06-13T10:00:00+08:00"),
    delayFn: async () => 0,
  });
  report.afterGreet = listJobs(db).map(pickJob);

  const greeted = listJobs(db, { status: "greeted" })[0];
  if (!greeted) {
    throw new Error("Acceptance expected at least one greeted fixture job");
  }
  updateJobStatus(db, greeted.id, "replied");
  report.simulatedReply = {
    jobId: greeted.id,
    hrName: "验收招聘经理",
    lastMsg: "你好，已看到你的项目经历，请把定制简历发我。",
  };

  report.poll = await runPoll({
    db,
    page,
    pollFn: async () => [
      {
        jobMatchKey: greeted.id,
        hrName: report.simulatedReply.hrName,
        lastMsg: report.simulatedReply.lastMsg,
        jobTitle: greeted.title,
      },
    ],
  });
  report.finalJobs = listJobs(db).map(pickJob);
  report.status = getStatusSnapshot(db, {
    now: new Date("2026-06-13T10:00:00+08:00"),
  });
  report.statusText = formatStatus(report.status);
  report.completedAt = new Date().toISOString();
  assertAcceptance(report);

  const timestamp = report.completedAt.replace(/[:.]/g, "-");
  const logPath = path.join(logDirectory, `acceptance-${timestamp}.json`);
  fs.writeFileSync(logPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  report.logPath = logPath;

  console.log(JSON.stringify(report, null, 2));
  console.log(report.statusText);
} finally {
  db.close();
  await context.close();
}

function pickJob(job) {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    status: job.status,
    score: job.score,
    bait: job.screen_json ? JSON.parse(job.screen_json).bait : null,
    greetShortLength: job.greet_short?.length ?? 0,
    greetShortCharacters: job.greet_short
      ? countMaterialCharacters(job.greet_short)
      : 0,
    introLongLength: job.intro_long?.length ?? 0,
    introLongCharacters: job.intro_long
      ? countMaterialCharacters(job.intro_long)
      : 0,
    resumePath: job.resume_path,
    resumeExists: job.resume_path ? fs.existsSync(job.resume_path) : false,
  };
}

function assertAcceptance(result) {
  assert.equal(result.scan.blocked, false);
  assert.equal(result.scan.newJobs, 3);
  assert.equal(result.scan.passed, 1);
  assert.equal(result.scan.rejected, 2);
  assert.equal(result.scan.errors, 0);

  const good = result.finalJobs.find(
    (job) => job.id === "fixture-good-match",
  );
  const mismatch = result.finalJobs.find(
    (job) => job.id === "fixture-mismatch",
  );
  const bait = result.finalJobs.find((job) => job.id === "fixture-bait");
  assert.equal(good.status, "notified");
  assert.equal(good.resumeExists, true);
  assert.ok(
    good.greetShortCharacters >= 100 && good.greetShortCharacters <= 150,
  );
  assert.ok(
    good.introLongCharacters >= 500 && good.introLongCharacters <= 700,
  );
  assert.equal(mismatch.status, "screened_out");
  assert.ok(mismatch.score < 60);
  assert.equal(bait.status, "screened_out");
  assert.equal(bait.bait, true);

  assert.equal(result.greet.attempted, 1);
  assert.equal(result.greet.results[0].dryRun, true);
  assert.equal(result.greet.results[0].sent, false);
  assert.equal(result.poll.length, 1);
  assert.equal(result.poll[0].matched, true);
  assert.equal(result.status.counts.notified, 1);
  assert.equal(result.status.counts.screened_out, 2);
  assert.equal(result.status.dryRunGreetedToday, 1);
  assert.equal(result.status.circuitOpen, null);
}
