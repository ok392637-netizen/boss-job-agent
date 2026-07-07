import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");
const DEFAULT_SECRETS_PATH = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  ".openclaw",
  "openclaw.json",
);

function readJson(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
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
  secretsPath = DEFAULT_SECRETS_PATH,
} = {}) {
  const appConfig = readJson(configPath);
  const secrets = readJson(secretsPath);
  const apiKey = secrets?.env?.DEEPSEEK_API_KEY;

  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error(
      `Missing env.DEEPSEEK_API_KEY in OpenClaw config: ${secretsPath}`,
    );
  }

  return deepFreeze({
    ...appConfig,
    screening: {
      companyPassScore: 40,
      ...appConfig.screening,
    },
    resume: {
      autoSend: false,
      residentAttachmentName: "简历.pdf",
      ...appConfig.resume,
    },
    reply: {
      shadowMode: true,
      autoRoutine: false,
      maxAutoPerRun: 3,
      replyDelaySec: [30, 120],
      ...appConfig.reply,
    },
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
      openClaw: path.resolve(secretsPath),
      profile: path.join(PROJECT_ROOT, "profile", "profile.md"),
      photo: path.join(PROJECT_ROOT, "profile", "photo.jpg"),
      resumeBase: path.join(PROJECT_ROOT, "profile", "resume-base.json"),
      database: path.join(PROJECT_ROOT, "data", "agent.db"),
      resumes: path.join(PROJECT_ROOT, "data", "resumes"),
      browserProfile: path.join(PROJECT_ROOT, "data", "browser-profile"),
    },
  });
}

export const config = loadConfig();
export { PROJECT_ROOT };
