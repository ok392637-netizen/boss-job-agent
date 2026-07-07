import { chat } from "../llm.js";
import {
  assertPlainObject,
  booleanValue,
  enumValue,
  numberValue,
  stringArray,
  stringValue,
} from "./fact_utils.js";

export const HR_REPLY_SYSTEM_PROMPT = [
  "你是求职 HR 对话代理。",
  "目标: 识别 HR 回复意图, 生成下一步回复草稿, 判断是否需要发送简历或通知用户确认面试。",
  "事实边界: 只能引用候选人档案、已生成简历策略、岗位信息和对话原文。",
  "默认不替用户承诺面试时间; 面试邀约必须通知用户确认。",
  "只输出 JSON。",
].join("\n");

export const HR_INTENTS = Object.freeze([
  "ask_resume",
  "interview_invite",
  "screening_question",
  "salary_or_availability",
  "rejection",
  "spam_or_sales",
  "other",
]);

export function buildHrReplyPrompt({
  job,
  reply,
  profileText = "",
  resumeStrategy = null,
  conversation = [],
}) {
  assertPlainObject(job, "job");
  return `## 候选人档案
${profileText}

## 岗位
${JSON.stringify(job, null, 2)}

## 简历策略
${JSON.stringify(resumeStrategy, null, 2)}

## 历史对话
${JSON.stringify(conversation, null, 2)}

## HR 最新回复
${reply}

输出 JSON:
{
  "intent": "ask_resume|interview_invite|screening_question|salary_or_availability|rejection|spam_or_sales|other",
  "confidence": 0-1,
  "send_resume": true/false,
  "notify_user": true/false,
  "requires_user_decision": true/false,
  "proposed_reply": "短聊天回复。需要发送简历时只写一句说明, 不要粘贴完整简历、电话、邮箱或长自我介绍",
  "questions_for_user": ["需要用户确认的问题"],
  "lark_notice": {"title":"","body":"","priority":"low|normal|high"}
}`;
}

export async function draftHrReply(
  job,
  {
    reply,
    profileText = "",
    resumeStrategy = null,
    conversation = [],
    chatFn = chat,
  } = {},
) {
  let lastError;
  let retryInstruction = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await chatFn(
      [
        { role: "system", content: HR_REPLY_SYSTEM_PROMPT },
        {
          role: "user",
          content: `${buildHrReplyPrompt({
            job,
            reply,
            profileText,
            resumeStrategy,
            conversation,
          })}${retryInstruction}`,
        },
      ],
      { json: true },
    );
    try {
      return validateHrReplyDraft(raw);
    } catch (error) {
      lastError = error;
      retryInstruction = `\n\n上次输出校验失败: ${error.message}\n请只修正 proposed_reply: 保持短聊天语气, 不粘贴完整简历、电话、邮箱或长自我介绍。`;
    }
  }
  throw lastError;
}

export function validateHrReplyDraft(raw) {
  assertPlainObject(raw, "HR reply draft");
  const intent = enumValue(raw.intent, HR_INTENTS, "other");
  const requiresUserDecision = booleanValue(raw.requires_user_decision, false);
  const notifyUser =
    intent === "interview_invite" ||
    requiresUserDecision ||
    booleanValue(raw.notify_user, false);
  const larkNotice = raw.lark_notice && typeof raw.lark_notice === "object"
    ? raw.lark_notice
    : {};
  const normalized = {
    intent,
    confidence: Math.max(0, Math.min(1, numberValue(raw.confidence, 0))),
    sendResume: booleanValue(raw.send_resume, false),
    notifyUser,
    requiresUserDecision,
    proposedReply: stringValue(raw.proposed_reply),
    questionsForUser: stringArray(raw.questions_for_user),
    larkNotice: {
      title: stringValue(larkNotice.title),
      body: stringValue(larkNotice.body),
      priority: enumValue(larkNotice.priority, ["low", "normal", "high"], "normal"),
    },
  };
  if (!normalized.proposedReply && intent !== "rejection") {
    throw new Error("HR reply draft requires proposed_reply");
  }
  if (intent === "ask_resume") {
    validateResumeRequestReply(normalized.proposedReply);
  }
  if (intent === "interview_invite" && !normalized.notifyUser) {
    throw new Error("interview invite must notify user");
  }
  return normalized;
}

function validateResumeRequestReply(text) {
  if ([...text].length > 220) {
    throw new Error("ask_resume proposed_reply must be short and not paste resume content");
  }
  if (
    /(1[3-9]\d{9}|[\w.+-]+@[\w.-]+\.\w+|项目经历|工作经历|教育经历|技能[:：]|简历[:：])/i.test(
      text,
    )
  ) {
    throw new Error("ask_resume proposed_reply must not include contact info or full resume sections");
  }
}
