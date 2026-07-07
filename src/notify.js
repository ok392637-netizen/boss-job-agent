import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const LARK_COMMAND = resolveLarkCommand();
const LARK_IDENTITIES = ["user", "bot"];

export async function notifyText(text, { runLarkFn = runLark } = {}) {
  const { receipt } = await runWithIdentityFallback({
    args: [
      "im",
      "+messages-send",
      "--user-id",
      config.lark.userOpenId,
      "--text",
      String(text),
      "--json",
    ],
    runLarkFn,
  });
  return receipt;
}

export async function notifyMarkdown(markdown, { runLarkFn = runLark } = {}) {
  const { receipt } = await runWithIdentityFallback({
    args: [
      "im",
      "+messages-send",
      "--user-id",
      config.lark.userOpenId,
      "--markdown",
      String(markdown),
      "--json",
    ],
    runLarkFn,
  });
  return receipt;
}

function withIdentity(args, identity) {
  return [
    "im",
    "+messages-send",
    "--as",
    identity,
    ...args.slice(2),
  ];
}

async function runWithIdentityFallback({
  args,
  runLarkFn = runLark,
  cwd = config.paths.projectRoot,
  shouldFallback = isAuthenticationError,
} = {}) {
  const failures = [];
  for (const identity of LARK_IDENTITIES) {
    try {
      const receipt = await runLarkFn(withIdentity(args, identity), { cwd });
      return { identity, receipt, failures };
    } catch (error) {
      failures.push({ identity, error });
      if (identity === "user" && !shouldFallback(error)) {
        throw error;
      }
    }
  }

  throw identityFailureError(failures);
}

function identityFailureError(failures) {
  const summaries = failures.map(
    ({ identity, error }) => `${identity}: ${summarizeError(error)}`,
  );
  const error = new Error(
    `lark-cli failed for all identities: ${summaries.join(" | ")}`,
  );
  error.identityFailures = summaries;
  return error;
}

function isAuthenticationError(error) {
  const message = String(error?.message ?? error).toLowerCase();
  return [
    "auth",
    "authentication",
    "unauthorized",
    "token",
    "login",
    "credential",
    "expired",
    "invalid_grant",
    "not logged in",
    "session",
    "401",
  ].some((term) => message.includes(term));
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
  let failures = [];
  try {
    const { identity, receipt } = await runWithIdentityFallback({
      args: fileArguments,
      runLarkFn,
      shouldFallback: () => true,
    });
    results.push({
      mode: "file",
      identity,
      receipt,
    });
    return results;
  } catch (error) {
    failures = error.identityFailures ?? [summarizeError(error)];
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
