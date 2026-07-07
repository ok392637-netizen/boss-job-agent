import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config, loadConfig } from "../src/config.js";

test("default scan configuration is conservative", () => {
  assert.equal(config.search.maxJobsPerScan, 8);
  assert.deepEqual(config.scan.jobDelaySec, [18, 50]);
  assert.deepEqual(config.scan.queryDelaySec, [30, 90]);
  assert.equal(config.screening.companyPassScore, 40);
  assert.deepEqual(config.chat, {
    maxPerRun: 10,
    backfillScrollRounds: 5,
  });
  // 默认保守安全: 不自动发简历/不自动回复; 需在 config.json 显式开启才真发
  assert.deepEqual(config.resume, {
    autoSend: false,
    residentAttachmentName: "简历.pdf",
  });
  assert.deepEqual(config.reply, {
    shadowMode: true,
    autoRoutine: false,
    maxAutoPerRun: 3,
    replyDelaySec: [30, 120],
  });
  assert.equal(
    config.paths.photo,
    path.join(config.paths.projectRoot, "profile", "photo.jpg"),
  );
});

test("loadConfig strips UTF-8 BOM and deeply freezes config", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const configPath = path.join(directory, "config.json");
  const secretsPath = path.join(directory, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      greeting: { dryRun: true },
      resume: { autoSend: true },
      llm: { model: "primary", fallbackModel: "fallback" },
    }),
  );
  fs.writeFileSync(
    secretsPath,
    `\uFEFF${JSON.stringify({ env: { DEEPSEEK_API_KEY: "test-key" } })}`,
  );

  const loaded = loadConfig({ configPath, secretsPath });
  assert.equal(loaded.llm.apiKey, "test-key");
  assert.equal(loaded.greeting.dryRun, true);
  assert.equal(loaded.resume.autoSend, true);
  assert.equal(loaded.resume.residentAttachmentName, "简历.pdf");
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.greeting), true);
  assert.equal(Object.isFrozen(loaded.resume), true);
  assert.throws(() => {
    loaded.greeting.dryRun = false;
  }, TypeError);
});

test("loadConfig names the OpenClaw path when key is missing", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const configPath = path.join(directory, "config.json");
  const secretsPath = path.join(directory, "missing-key-openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ llm: {} }));
  fs.writeFileSync(secretsPath, JSON.stringify({ env: {} }));

  assert.throws(
    () => loadConfig({ configPath, secretsPath }),
    (error) =>
      error.message.includes("DEEPSEEK_API_KEY") &&
      error.message.includes(secretsPath),
  );
});
