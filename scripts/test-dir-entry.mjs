import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testDir = join(root, "test");

function collectTestFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(path);
    }
  }
  return files;
}

const testFiles = collectTestFiles(testDir)
  .filter((file) => statSync(file).isFile())
  .sort()
  .map((file) => relative(root, file));

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith("NODE_TEST")) {
    delete env[key];
  }
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: root,
  env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
