import {
  listPendingActions,
  resolvePendingAction,
} from "../db.js";

const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1_000;

export function pendingActionCode(id) {
  return normalizeCode(id);
}

export async function pushPendingToLark(pending, { notifyFn } = {}) {
  const code = pendingActionCode(pending?.id);
  const text = formatPendingDraftMessage(pending, code);
  const receipt = notifyFn ? await notifyFn(text) : null;
  return { code, text, receipt };
}

export async function reconcilePendingFromLark({
  db,
  larkFetchFn,
  notifyFn,
  now = new Date(),
} = {}) {
  if (!db) {
    throw new Error("reconcilePendingFromLark requires db");
  }
  const summary = {
    messages: 0,
    approved: 0,
    rejected: 0,
    expired: 0,
    ignored: 0,
    reminders: 0,
  };
  const pendingByCode = new Map(
    listPendingActions(db, { status: "pending" }).map((pending) => [
      pendingActionCode(pending.id),
      pending,
    ]),
  );
  const messages = await fetchLarkMessages(larkFetchFn);
  summary.messages = messages.length;

  const settledIds = new Set();
  for (const message of messages) {
    const command = parseLarkCommand(message?.text);
    if (!command) {
      continue;
    }
    const pending = pendingByCode.get(command.code);
    if (!pending || settledIds.has(pending.id)) {
      summary.ignored += 1;
      continue;
    }

    if (command.command === "ignore") {
      resolvePendingAction(db, pending.id, {
        status: "rejected",
        payloadPatch: {
          decision: decisionPayload(command, message, now),
        },
      });
      settledIds.add(pending.id);
      summary.rejected += 1;
      continue;
    }

    const approvedText =
      command.command === "edit" ? command.text : pendingDraftText(pending);
    resolvePendingAction(db, pending.id, {
      status: "approved",
      payloadPatch: {
        approvedText,
        decision: decisionPayload(command, message, now),
      },
    });
    settledIds.add(pending.id);
    summary.approved += 1;
  }

  for (const pending of listPendingActions(db, { status: "pending" })) {
    if (!isExpired(pending, now)) {
      continue;
    }
    const payload = objectPayload(pending.payload);
    if (!payload.expiredReminderSent && notifyFn) {
      await notifyFn(formatExpiredReminder(pending));
      summary.reminders += 1;
    }
    resolvePendingAction(db, pending.id, {
      status: "expired",
      payloadPatch: {
        expiredReminderSent: true,
        decision: {
          source: "lark",
          command: "expired",
          decidedAt: now.toISOString(),
        },
      },
    });
    summary.expired += 1;
  }

  return summary;
}

export function parseLarkCommand(text) {
  const value = String(text ?? "").trim();
  const edit = value.match(/^改\s*([A-Za-z0-9_-]{1,12})\s+([\s\S]+?)\s*$/u);
  if (edit) {
    return {
      command: "edit",
      code: normalizeCode(edit[1]),
      text: edit[2].trim(),
    };
  }

  const confirm = value.match(/^确认\s*([A-Za-z0-9_-]{1,12})\s*$/u);
  if (confirm) {
    return { command: "confirm", code: normalizeCode(confirm[1]) };
  }

  const ignore = value.match(/^忽略\s*([A-Za-z0-9_-]{1,12})\s*$/u);
  if (ignore) {
    return { command: "ignore", code: normalizeCode(ignore[1]) };
  }
  return null;
}

function formatPendingDraftMessage(pending, code) {
  const payload = objectPayload(parsePayload(pending?.payload));
  const conversation = objectPayload(payload.conversation);
  return [
    "HR 回复草稿待确认",
    `确认码: ${code}`,
    `会话: ${conversation.bossConvKey ?? pending?.conv_id ?? "未知"}`,
    `公司: ${conversation.company ?? "未知"}`,
    `岗位: ${conversation.jobTitle ?? "未知"}`,
    `HR: ${conversation.hrName ?? "未知"}`,
    "",
    "草稿:",
    pendingDraftText({ ...pending, payload }),
    "",
    `飞书回复 \`确认 ${code}\` / \`改 ${code} <新内容>\` / \`忽略 ${code}\`。`,
  ].join("\n");
}

function formatExpiredReminder(pending) {
  const code = pendingActionCode(pending.id);
  const payload = objectPayload(parsePayload(pending.payload));
  const conversation = objectPayload(payload.conversation);
  return [
    "HR 回复草稿已超时",
    `确认码: ${code}`,
    `会话: ${conversation.bossConvKey ?? pending.conv_id ?? "未知"}`,
    `HR: ${conversation.hrName ?? "未知"}`,
    "状态已标记 expired；如仍需回复请重新生成确认。",
  ].join("\n");
}

function pendingDraftText(pending) {
  const payload = objectPayload(parsePayload(pending?.payload));
  return String(
    payload.draftText ??
      payload.draft?.proposedReply ??
      payload.proposedReply ??
      payload.reply ??
      "",
  ).trim();
}

function decisionPayload(command, message, now) {
  return {
    source: "lark",
    command: command.command,
    text: command.text ?? null,
    messageTs: message?.ts ?? null,
    decidedAt: now.toISOString(),
  };
}

async function fetchLarkMessages(larkFetchFn) {
  if (!larkFetchFn) {
    return [];
  }
  const messages = await larkFetchFn();
  return Array.isArray(messages) ? messages : [];
}

function isExpired(pending, now) {
  const createdAt = parseLocalTimestamp(pending.created_at);
  if (!createdAt) {
    return false;
  }
  return now.getTime() - createdAt.getTime() > EXPIRE_AFTER_MS;
}

function parseLocalTimestamp(value) {
  const date = new Date(String(value ?? "").replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parsePayload(payload) {
  if (!payload || typeof payload !== "string") {
    return payload;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

function objectPayload(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeCode(value) {
  return String(value ?? "").trim().slice(-6).padStart(6, "0");
}
