import assert from "node:assert/strict";
import test from "node:test";
import { BrowserBusyError } from "../src/browser.js";
import {
  getJob,
  openDatabase,
  saveScreenResult,
  upsertJob,
} from "../src/db.js";
import { runChat, runGreetQueue, runScan } from "../src/workflows.js";

test("runScan returns browser_busy when the shared browser profile is locked", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  let searched = false;

  const result = await runScan({
    db,
    browserFactory: async () => {
      throw new BrowserBusyError("data/agent.lock", { pid: 12345 });
    },
    searchFn: async () => {
      searched = true;
      return [];
    },
    notifyFn: async () => {},
    output: () => {},
  });

  assert.equal(result.skipped, "browser_busy");
  assert.equal(result.errors, 0);
  assert.equal(searched, false);
});

test("runGreetQueue returns browser_busy without marking the queued job as error", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const job = queueJob(db, "busy-greet");
  let greeted = false;

  const result = await runGreetQueue({
    db,
    now: new Date("2026-06-13T10:00:00+08:00"),
    browserFactory: async () => {
      throw new BrowserBusyError("data/agent.lock", { pid: 12345 });
    },
    greetFn: async () => {
      greeted = true;
    },
  });

  assert.deepEqual(result, {
    attempted: 0,
    results: [],
    skipped: "browser_busy",
  });
  assert.equal(greeted, false);
  assert.equal(getJob(db, job.id).status, "queued");
});

test("runChat returns browser_busy before navigation when the profile is locked", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  let listed = false;

  const result = await runChat({
    db,
    browserFactory: async () => {
      throw new BrowserBusyError("data/agent.lock", { pid: 12345 });
    },
    listFn: async () => {
      listed = true;
      return [];
    },
    notifyTextFn: async () => {},
  });

  assert.equal(result.skipped, "browser_busy");
  assert.equal(result.opened, 0);
  assert.equal(listed, false);
});

function queueJob(db, id) {
  const job = upsertJob(db, {
    id,
    url: `https://example.test/${id}`,
    title: "AI Intern",
    company: "Local Company",
  });
  return saveScreenResult(db, job.id, {
    score: 90,
    bait: false,
    verdict: "pass",
  });
}
