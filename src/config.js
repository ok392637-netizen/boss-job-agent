import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");
const DEFAULT_ENV_PATH = path.join(PROJECT_ROOT, ".env");
const DEFAULT_SECRETS_PATH = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  ".openclaw",
  "openclaw.json",
);

function readJson(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function loadEnvFile(filePath, environment) {
  if (!fs.existsSync(filePath)) return;

  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/,
    );
    if (!match || match[0].trimStart().startsWith("#")) continue;

    const [, key, rawValue] = match;
    if (typeof environment[key] === "string" && environment[key].trim() !== "") {
      continue;
    }
    environment[key] =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;
  }
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function loadConfig({
  configPath = DEFAULT_CONFIG_PATH,
  envPath = DEFAULT_ENV_PATH,
  secretsPath = DEFAULT_SECRETS_PATH,
  environment = process.env,
} = {}) {
  const appConfig = readJson(configPath);
  loadEnvFile(envPath, environment);

  let apiKey = environment.DEEPSEEK_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    const secrets = readJson(secretsPath);
    apiKey = secrets?.env?.DEEPSEEK_API_KEY;
  }

  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error(
      `Missing DEEPSEEK_API_KEY in environment, ${envPath}, or OpenClaw config: ${secretsPath}`,
    );
  }

  return deepFreeze({
    ...appConfig,
    llm: {
      ...appConfig.llm,
      apiKey: apiKey.trim(),
      endpoint: "https://api.deepseek.com",
      timeoutMs: 60_000,
      retries: 2,
    },
    paths: {
      projectRoot: PROJECT_ROOT,
      config: path.resolve(configPath),
      env: path.resolve(envPath),
      openClaw: path.resolve(secretsPath),
      profile: path.join(PROJECT_ROOT, "profile", "profile.md"),
      resumeBase: path.join(PROJECT_ROOT, "profile", "resume-base.json"),
      database: path.join(PROJECT_ROOT, "data", "agent.db"),
      resumes: path.join(PROJECT_ROOT, "data", "resumes"),
      browserProfile: path.join(PROJECT_ROOT, "data", "browser-profile"),
    },
  });
}

export const config = loadConfig();
export { PROJECT_ROOT };
