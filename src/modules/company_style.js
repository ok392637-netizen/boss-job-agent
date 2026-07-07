import { chat } from "../llm.js";
import {
  assertPlainObject,
  enumValue,
  normalizeEvidence,
  objectArray,
  stringArray,
  stringValue,
} from "./fact_utils.js";

export const COMPANY_STYLE_SYSTEM_PROMPT = [
  "你是求职材料风格画像分析器。",
  "根据公司背调、JD 和招聘者话术, 判断简历/沟通材料应该采用什么叙事风格。",
  "输出要服务于简历定制: 哪些项目先讲, 哪些能力强调, 语气应技术化/产品化/运营化/招聘化。",
  "只能基于输入资料推断, 不确定就降级为 balanced。",
  "只输出 JSON。",
].join("\n");

export function buildCompanyStylePrompt({
  job,
  research = null,
  conversation = [],
} = {}) {
  assertPlainObject(job, "job");
  return `## 岗位
${JSON.stringify(job, null, 2)}

## 公司背调
${JSON.stringify(research, null, 2)}

## 招聘者/公司公开话术
${JSON.stringify(conversation, null, 2)}

输出 JSON:
{
  "style_type": "technical|product|operations|hr|startup|corporate|balanced",
  "tone": "direct|warm|formal|energetic|pragmatic",
  "resume_angle": "",
  "emphasis_order": ["优先强调的能力/项目"],
  "keyword_bias": ["应该覆盖的关键词"],
  "avoid": ["应该避免的表达"],
  "evidence": [{"source":"","title":"","quote":"","url":""}]
}`;
}

export async function analyzeCompanyStyle(
  job,
  { research = null, conversation = [], chatFn = chat } = {},
) {
  const raw = await chatFn(
    [
      { role: "system", content: COMPANY_STYLE_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildCompanyStylePrompt({ job, research, conversation }),
      },
    ],
    { json: true },
  );
  return validateCompanyStyle(raw);
}

export function validateCompanyStyle(raw) {
  assertPlainObject(raw, "company style");
  const styleType = enumValue(
    raw.style_type,
    ["technical", "product", "operations", "hr", "startup", "corporate", "balanced"],
    "balanced",
  );
  const tone = enumValue(
    raw.tone,
    ["direct", "warm", "formal", "energetic", "pragmatic"],
    "pragmatic",
  );
  const normalized = {
    styleType,
    tone,
    resumeAngle: stringValue(raw.resume_angle),
    emphasisOrder: stringArray(raw.emphasis_order),
    keywordBias: stringArray(raw.keyword_bias),
    avoid: stringArray(raw.avoid),
    evidence: normalizeEvidence(raw.evidence),
    rawSignals: objectArray(raw.raw_signals),
  };
  if (!normalized.resumeAngle) {
    throw new Error("company style requires resume_angle");
  }
  return normalized;
}
