import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function fetchRecentUserBotMessages({
  execFileFn = execFile,
  now = new Date(),
  lookbackMs = 60 * 60 * 1_000,
  timeoutMs = 10_000,
} = {}) {
  const since = new Date(now.getTime() - lookbackMs);
  try {
    const result = await execFileFn(
      "lark-cli",
      [
        "im",
        "messages",
        "--direction",
        "user-to-bot",
        "--since",
        since.toISOString(),
        "--json",
      ],
      { timeout: timeoutMs, windowsHide: true },
    );
    return parseLarkInboxOutput(outputText(result), { since });
  } catch {
    return [];
  }
}

export function parseLarkInboxOutput(stdout, { since = null } = {}) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed.data?.items ?? parsed.items ?? parsed.messages ?? [];
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => normalizeMessage(item))
    .filter((item) => item.text)
    .filter((item) => !since || !item.ts || Number(item.ts) >= since.getTime());
}

function normalizeMessage(item) {
  const rawText =
    item?.text ??
    item?.content ??
    item?.body?.text ??
    item?.message?.text ??
    "";
  return {
    text: extractText(rawText),
    ts: normalizeTimestamp(
      item?.ts ?? item?.timestamp ?? item?.create_time ?? item?.createTime,
    ),
  };
}

function extractText(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return String(parsed.text ?? parsed.content ?? "").trim();
  } catch {
    return trimmed;
  }
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  const numeric = Number.parseInt(text, 10);
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function outputText(result) {
  if (typeof result === "string") {
    return result;
  }
  return result?.stdout ?? "";
}
