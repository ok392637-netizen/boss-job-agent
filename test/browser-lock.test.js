import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BROWSER_LOCK_STALE_MS,
  BrowserBusyError,
  acquireBrowserLock,
} from "../src/browser.js";

test("browser lock writes pid and timestamp and releases its own file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "agent.lock");
  const now = Date.parse("2026-07-04T10:00:00.000Z");

  const release = acquireBrowserLock({ lockPath, now: () => now });
  const payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));

  assert.equal(payload.pid, process.pid);
  assert.equal(payload.createdAt, "2026-07-04T10:00:00.000Z");

  release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("fresh browser lock throws BrowserBusyError without replacing the file", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "agent.lock");
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 12345, createdAt: "2026-07-04T10:00:00.000Z" }),
  );

  assert.throws(
    () =>
      acquireBrowserLock({
        lockPath,
        now: () => Date.parse("2026-07-04T10:30:00.000Z"),
      }),
    (error) => {
      assert.equal(error instanceof BrowserBusyError, true);
      assert.equal(error.code, "BROWSER_BUSY");
      assert.equal(error.lockInfo.pid, 12345);
      return true;
    },
  );
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 12345);
});

test("stale browser lock older than 90 minutes is replaced", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "agent.lock");
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 12345, createdAt: "2026-07-04T10:00:00.000Z" }),
  );

  const release = acquireBrowserLock({
    lockPath,
    now: () => Date.parse("2026-07-04T11:31:00.000Z"),
    staleAfterMs: BROWSER_LOCK_STALE_MS,
  });
  const payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));

  assert.equal(payload.pid, process.pid);
  assert.equal(payload.createdAt, "2026-07-04T11:31:00.000Z");

  release();
});
