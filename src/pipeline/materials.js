import fs from "node:fs";
import { config } from "../config.js";
import { chat } from "../llm.js";

export const MATERIALS_SYSTEM_PROMPT =
  "你是求职文案生成器。基于候选人画像为特定岗位生成两段文案。硬约束: 只能引用画像中明确存在的经历/技能/数据, 严禁编造、夸大或虚构任何事实、数字、公司名、项目。语气真诚、具体、不油腻、不堆砌敬语。只输出 JSON。";

const PROJECT_KEYWORDS = ["n8n", "记忆系统", "Hacker News", "OpenClaw"];
const BANNED_CLAIMS = /硕士|博士|3年经验|5年/;
const ALLOWED_PERCENTAGES = new Set(["40"]);

export function buildMaterialsPrompt(job, profileText) {
  return `## 候选人画像
${profileText}

## 目标岗位
${job.title} @ ${job.company}
JD: ${job.jd}

生成 JSON:
{
 "greet_short": "首条招呼语, 100-150字: 一句身份 + 引用JD中的1个具体要求并对应画像中最强的1个匹配点 + 提1个具体项目名。不要'您好我对贵司岗位很感兴趣'这类空话开头。",
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
      validateMaterials(materials);
      return materials;
    } catch (error) {
      lastError = error;
      retryInstruction = `\n\n## 上次输出校验失败
${error.message}
上次输出:
${JSON.stringify(result)}
请返回修正后的完整 JSON。只改动错误消息明确点名的字段，其他字段逐字保留。按汉字、英文字母和数字计数，不计标点与空格；greet_short 控制在 120-140 字，intro_long 控制在 575-625 字。`;
    }
  }

  throw new Error(`Material fact validation failed after retry: ${lastError.message}`, {
    cause: lastError,
  });
}

export function validateMaterials({ greetShort, introLong }) {
  if (typeof greetShort !== "string" || greetShort.trim() === "") {
    throw new Error("greet_short must be a non-empty string");
  }
  if (typeof introLong !== "string" || introLong.trim() === "") {
    throw new Error("intro_long must be a non-empty string");
  }
  const greetLength = countMaterialCharacters(greetShort);
  if (greetLength < 90 || greetLength > 165) {
    throw new Error(
      `greet_short must contain 90-165 characters, got ${greetLength}`,
    );
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
