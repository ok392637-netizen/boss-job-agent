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
});

test("loadConfig strips UTF-8 BOM and deeply freezes config", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const configPath = path.join(directory, "config.json");
  const envPath = path.join(directory, ".env");
  const secretsPath = path.join(directory, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      greeting: { dryRun: true },
      llm: { model: "primary", fallbackModel: "fallback" },
    }),
  );
  fs.writeFileSync(
    secretsPath,
    `\uFEFF${JSON.stringify({ env: { DEEPSEEK_API_KEY: "test-key" } })}`,
  );

  const loaded = loadConfig({
    configPath,
    envPath,
    secretsPath,
    environment: {},
  });
  assert.equal(loaded.llm.apiKey, "test-key");
  assert.equal(loaded.greeting.dryRun, true);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.greeting), true);
  assert.throws(() => {
    loaded.greeting.dryRun = false;
  }, TypeError);
});

test("loadConfig prefers the environment, then a BOM-prefixed .env", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const configPath = path.join(directory, "config.json");
  const envPath = path.join(directory, ".env");
  const secretsPath = path.join(directory, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ llm: {} }));
  fs.writeFileSync(envPath, "\uFEFFDEEPSEEK_API_KEY=env-file-key\n");
  fs.writeFileSync(
    secretsPath,
    JSON.stringify({ env: { DEEPSEEK_API_KEY: "openclaw-key" } }),
  );

  const fromEnvironment = loadConfig({
    configPath,
    envPath,
    secretsPath,
    environment: { DEEPSEEK_API_KEY: "process-key" },
  });
  assert.equal(fromEnvironment.llm.apiKey, "process-key");

  const fromEnvFile = loadConfig({
    configPath,
    envPath,
    secretsPath,
    environment: {},
  });
  assert.equal(fromEnvFile.llm.apiKey, "env-file-key");
});

test("loadConfig names .env and OpenClaw paths when key is missing", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const configPath = path.join(directory, "config.json");
  const envPath = path.join(directory, ".env");
  const secretsPath = path.join(directory, "missing-key-openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ llm: {} }));
  fs.writeFileSync(secretsPath, JSON.stringify({ env: {} }));

  assert.throws(
    () => loadConfig({ configPath, envPath, secretsPath, environment: {} }),
    (error) =>
      error.message.includes("DEEPSEEK_API_KEY") &&
      error.message.includes(envPath) &&
      error.message.includes(secretsPath),
  );
});
