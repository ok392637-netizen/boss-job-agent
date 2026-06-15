import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const LARK_COMMAND = resolveLarkCommand();

export async function notifyText(text) {
  return runLark([
    "im",
    "+messages-send",
    "--as",
    "user",
    "--user-id",
    config.lark.userOpenId,
    "--text",
    String(text),
    "--json",
  ]);
}

export async function notifyMarkdown(markdown) {
  return runLark([
    "im",
    "+messages-send",
    "--as",
    "user",
    "--user-id",
    config.lark.userOpenId,
    "--markdown",
    String(markdown),
    "--json",
  ]);
}

export async function notifyFile(
  filePath,
  caption = "",
  {
    runLarkFn = runLark,
    notifyTextFn = notifyText,
    notifyMarkdownFn = notifyMarkdown,
  } = {},
) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Notification file does not exist: ${absolutePath}`);
  }

  const relativePath = path.relative(config.paths.projectRoot, absolutePath);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `lark-cli only accepts files inside project root: ${absolutePath}`,
    );
  }

  const results = [];
  if (caption) {
    results.push(await notifyTextFn(caption));
  }

  const fileArguments = [
    "im",
    "+messages-send",
    "--user-id",
    config.lark.userOpenId,
    "--file",
    `.${path.sep}${relativePath}`,
    "--json",
  ];
  const failures = [];
  for (const identity of ["user", "bot"]) {
    try {
      const receipt = await runLarkFn(
        [...fileArguments.slice(0, 2), "--as", identity, ...fileArguments.slice(2)],
        { cwd: config.paths.projectRoot },
      );
      results.push({
        mode: "file",
        identity,
        receipt,
      });
      return results;
    } catch (error) {
      failures.push(`${identity}: ${summarizeError(error)}`);
    }
  }

  const fallback = [
    `📎 简历已生成: ${absolutePath}`,
    "",
    `文件直发失败: ${failures.join(" | ")}`,
  ].join("\n");
  const receipt = await notifyMarkdownFn(fallback);
  results.push({
    mode: "path-fallback",
    identity: "user",
    receipt,
    failures,
    path: absolutePath,
  });
  return results;
}

function summarizeError(error) {
  return String(error?.message ?? error)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function runLark(args, { cwd = config.paths.projectRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(LARK_COMMAND.executable, [...LARK_COMMAND.prefix, ...args], {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `lark-cli failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ raw: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

function resolveLarkCommand() {
  if (process.platform !== "win32") {
    return { executable: "lark-cli", prefix: [] };
  }

  const cliScript = path.join(
    process.env.APPDATA ?? "",
    "npm",
    "node_modules",
    "@larksuite",
    "cli",
    "scripts",
    "run.js",
  );
  if (!fs.existsSync(cliScript)) {
    throw new Error(`Cannot locate lark-cli Node entrypoint: ${cliScript}`);
  }
  return { executable: process.execPath, prefix: [cliScript] };
}

async function selfTest() {
  const result = await notifyText(
    "🤖 boss-job-agent 开发中: notify 链路自检 OK",
  );
  console.log(JSON.stringify(result, null, 2));
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain && process.argv.includes("--selftest")) {
  selfTest().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
