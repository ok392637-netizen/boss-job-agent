import { draftHrReply } from "../modules/hr_reply_agent.js";

const ROUTINE_INTENTS = new Set(["ask_resume", "screening_question", "other"]);
const NOISE_INTENTS = new Set(["spam_or_sales", "rejection"]);

export async function classifyAndDraft(
  job,
  {
    reply,
    conversationHistory = [],
    profileText = "",
    memoryFacts = [],
    chatFn,
    shadowMode = true,
  } = {},
) {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new Error("classifyAndDraft requires job");
  }
  if (!String(reply ?? "").trim()) {
    throw new Error("classifyAndDraft requires reply");
  }

  const draft = await draftHrReply(job, {
    reply,
    profileText: buildProfileContext(profileText, memoryFacts),
    resumeStrategy: extractResumeStrategy(job),
    conversation: normalizeConversationHistory(conversationHistory),
    chatFn,
  });
  const tier = tierForHrIntent(draft.intent, { reply });
  return {
    tier,
    draft,
    requiresConfirm: tier !== "routine" || Boolean(shadowMode),
  };
}

export function tierForHrIntent(intent, { reply = "" } = {}) {
  if (intent === "interview_invite") {
    return "interview";
  }
  if (NOISE_INTENTS.has(intent)) {
    return "noise";
  }
  if (intent === "salary_or_availability" || isSensitiveAsk(reply)) {
    return "sensitive";
  }
  if (ROUTINE_INTENTS.has(intent)) {
    return "routine";
  }
  return "routine";
}

export function extractResumeStrategy(job = {}) {
  const research = parseJsonMaybe(job.research_json ?? job.researchJson ?? job.research);
  if (!research || typeof research !== "object" || Array.isArray(research)) {
    return null;
  }
  return (
    research.resumeStrategy ??
    research.resume_strategy ??
    research.strategy ??
    research.customized?.strategy ??
    null
  );
}

function buildProfileContext(profileText, memoryFacts) {
  const base = String(profileText ?? "").trim();
  const memoryText = formatMemoryFacts(memoryFacts);
  return [base, memoryText].filter(Boolean).join("\n\n");
}

function formatMemoryFacts(memoryFacts) {
  if (!Array.isArray(memoryFacts) || memoryFacts.length === 0) {
    return "";
  }
  const lines = ["## memory_facts 项目素材"];
  for (const fact of memoryFacts) {
    if (!fact || typeof fact !== "object") {
      continue;
    }
    const name = String(fact.name ?? "").trim();
    if (!name) {
      continue;
    }
    const meta = [fact.tag, fact.period]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join(", ");
    lines.push(`- ${name}${meta ? ` (${meta})` : ""}`);
    for (const bullet of fact.bullets ?? fact.facts ?? []) {
      const text = String(bullet ?? "").trim();
      if (text) {
        lines.push(`  - ${text}`);
      }
    }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function normalizeConversationHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .map((message) => {
      if (!message || typeof message !== "object") {
        return null;
      }
      const text = String(message.text ?? message.content ?? "").trim();
      if (!text) {
        return null;
      }
      return {
        role: normalizeRole(message.role),
        text,
        sentLabel: message.sentLabel ?? message.sent_label ?? undefined,
        seenAt: message.seenAt ?? message.seen_at ?? undefined,
      };
    })
    .filter(Boolean);
}

function normalizeRole(role) {
  return ["hr", "me", "system"].includes(role) ? role : "system";
}

function isSensitiveAsk(text) {
  return /(微信|vx|v信|加v|加 V|联系方式|手机号|电话|线下|到店|来公司|现场|面聊|地址|到岗|入职|薪资|期望薪资)/iu.test(
    String(text ?? ""),
  );
}

function parseJsonMaybe(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
