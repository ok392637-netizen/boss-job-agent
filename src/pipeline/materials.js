import fs from "node:fs";
import { config } from "../config.js";
import { chat } from "../llm.js";

export const MATERIALS_SYSTEM_PROMPT =
  "你是求职文案生成器。基于候选人画像为特定岗位生成两段文案。硬约束: 只能引用画像中明确存在的经历/技能/数据, 严禁编造、夸大或虚构任何事实、数字、公司名、项目。语气真诚、具体、不油腻、不堆砌敬语。只输出 JSON。";

const PROJECT_KEYWORDS = [
  "n8n",
  "抖音热点自动化",
  "记忆系统",
  "Hacker News",
  "OpenClaw",
  "求职自动化 Agent",
];
const BANNED_CLAIMS = /硕士|博士|3年经验|5年/;
const ALLOWED_PERCENTAGES = new Set(["40"]);
const TEMPLATE_OPENING =
  /^(您好|你好|哈喽|hello|hi)[，,\s]*(我是|我叫)|^看到贵司|^您好我是|^你好我是/i;
export const GREET_SHORT_MIN_CHARACTERS = 40;
export const GREET_SHORT_MAX_CHARACTERS = 120;

export function buildMaterialsPrompt(job, profileText) {
  const jdQuote = pickJdQuote(job.jd);
  const styleHint = job.styleHint ?? job.style_hint ?? "未知";
  return `## 候选人画像
${profileText}

## 目标岗位
${job.title} @ ${job.company}
JD: ${job.jd}
JD 原句钩子: ${jdQuote}
style_hint: ${styleHint}

生成 JSON:
{
 "greet_short": "首条招呼语, 120字硬上限。必须引用或紧贴 JD 原句钩子里的1个具体要求, 必须包含一个具体项目名(n8n/抖音热点自动化/记忆系统/Hacker News/OpenClaw/求职自动化 Agent), 并按 style_hint 调整语气。禁止以'您好我是/你好我是/看到贵司'等模板腔开头。",
 "intro_long": "长版自我介绍, 500-700字, 5段: ①身份一句话(28届本科在读, 方向 AI Agent/Vibe Coding/自动化) ②为什么对这个岗位感兴趣(必须引用JD原文细节) ③从画像挑与本岗最相关的2-3个项目展开 ④三点匹配(JD要求↔自身经历逐条对应) ⑤意愿表态+期待沟通"
}`;
}

export async function genMaterials(
  job,
  {
    profileText = fs.readFileSync(config.paths.profile, "utf8"),
    chatFn = chat,
  } = {},
) {
  let lastError;
  let retryInstruction = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await chatFn(
      [
        { role: "system", content: MATERIALS_SYSTEM_PROMPT },
        {
          role: "user",
          content: `${buildMaterialsPrompt(job, profileText)}${retryInstruction}`,
        },
      ],
      { json: true },
    );

    try {
      const materials = normalizeMaterials(result);
      validateMaterials(materials, { job });
      return materials;
    } catch (error) {
      lastError = error;
      retryInstruction = `\n\n## 上次输出校验失败
${error.message}
上次输出:
${JSON.stringify(result)}
请返回修正后的完整 JSON。只改动错误消息明确点名的字段。greet_short 必须避开模板腔开头，必须含 project keyword 和 JD keyword，且不超过 120 字；intro_long 控制在 575-625 字。`;
    }
  }

  throw new Error(`Material fact validation failed after retry: ${lastError.message}`, {
    cause: lastError,
  });
}

export function validateMaterials(
  { greetShort, introLong },
  { job } = {},
) {
  if (typeof greetShort !== "string" || greetShort.trim() === "") {
    throw new Error("greet_short must be a non-empty string");
  }
  if (typeof introLong !== "string" || introLong.trim() === "") {
    throw new Error("intro_long must be a non-empty string");
  }
  const greetLength = countMaterialCharacters(greetShort);
  if (
    greetLength < GREET_SHORT_MIN_CHARACTERS ||
    greetLength > GREET_SHORT_MAX_CHARACTERS
  ) {
    throw new Error(
      `greet_short must contain ${GREET_SHORT_MIN_CHARACTERS}-${GREET_SHORT_MAX_CHARACTERS} characters, got ${greetLength}`,
    );
  }
  if (TEMPLATE_OPENING.test(greetShort.trim())) {
    throw new Error("greet_short has a template opening");
  }
  if (job) {
    const combined = `${greetShort}\n${introLong}`;
    if (!PROJECT_KEYWORDS.some((keyword) => combined.includes(keyword))) {
      throw new Error("generated materials missing project keyword");
    }
    if (!jdKeywords(job.jd).some((keyword) => combined.includes(keyword))) {
      throw new Error("generated materials missing JD keyword");
    }
  }
  const introLength = countMaterialCharacters(introLong);
  if (introLength < 500 || introLength > 700) {
    throw new Error(
      `intro_long must contain 500-700 characters, got ${introLength}`,
    );
  }
  if (!PROJECT_KEYWORDS.some((keyword) => introLong.includes(keyword))) {
    throw new Error("intro_long does not contain a project keyword from profile");
  }

  const percentages = [...introLong.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(
    (match) => match[1],
  );
  const unsupported = percentages.find(
    (percentage) => !ALLOWED_PERCENTAGES.has(percentage),
  );
  if (unsupported) {
    throw new Error(`intro_long contains unsupported percentage: ${unsupported}%`);
  }
  if (BANNED_CLAIMS.test(introLong)) {
    throw new Error(`intro_long contains a banned claim: ${introLong.match(BANNED_CLAIMS)[0]}`);
  }
}

export function countMaterialCharacters(value) {
  return [...value.matchAll(/[\p{L}\p{N}]/gu)].length;
}

function normalizeMaterials(result) {
  if (!result || typeof result !== "object") {
    throw new Error("Material result must be an object");
  }
  return {
    greetShort: result.greet_short,
    introLong: trimLongIntroduction(result.intro_long),
  };
}

function trimLongIntroduction(value) {
  if (typeof value !== "string" || countMaterialCharacters(value) <= 700) {
    return value;
  }

  let counted = 0;
  let rawEnd = 0;
  let sentenceEnd = 0;
  for (const [index, character] of [...value].entries()) {
    if (/[\p{L}\p{N}]/u.test(character)) {
      counted += 1;
    }
    if (counted > 700) {
      break;
    }
    rawEnd = index + 1;
    if (counted >= 500 && /[。！？；\n]/u.test(character)) {
      sentenceEnd = rawEnd;
    }
  }

  const characters = [...value];
  return characters.slice(0, sentenceEnd || rawEnd).join("").trim();
}

function pickJdQuote(jd) {
  const text = String(jd ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return (
    text.split(/[。！？；;.!?]/u).find((sentence) => sentence.length >= 12) ??
    text
  ).slice(0, 120);
}

function jdKeywords(jd) {
  const text = String(jd ?? "");
  const candidates = [
    "n8n",
    "dify",
    "Dify",
    "Coze",
    "Agent",
    "prompt",
    "LLM",
    "自动化",
    "工作流",
    "AI",
    "招聘",
    "HR",
  ];
  return candidates.filter((keyword) =>
    text.toLowerCase().includes(keyword.toLowerCase()),
  );
}
