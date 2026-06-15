import fs from "node:fs";
import { config } from "../config.js";
import { chat } from "../llm.js";

export const SCREEN_SYSTEM_PROMPT =
  '你是求职岗位筛选器, 候选人 28 届在读, **只投实习岗, 明确不要全职**。目标方向限三类: AI 产品/运营、AI Agent/应用开发(含 n8n/Coze/Dify 自动化)、AI×HR/招聘/人力资源。识别挂羊头岗位 (名为 AI/HR 实为电话销售/地推/卖课/培训贷)。只输出 JSON。';

export function buildScreenPrompt(job, profileText) {
  return `## 候选人画像
${profileText}

## 岗位
标题: ${job.title} | 公司: ${job.company} | 薪资: ${job.salary} | 城市: ${job.city}
JD 全文:
${job.jd}

输出 JSON: {"score": 0-100 匹配分, "bait": true/false 是否挂羊头, "bait_reason": "", "match_reasons": ["",""], "concerns": ["",""], "verdict": "pass"|"reject"}

判定策略: 候选人 28 届在读, **只投实习岗, 不要全职**。目标方向仅三类: ①AI 产品/运营(产品助理/运营/AI应用落地) ②AI Agent/应用开发(含 n8n/Coze/Dify 自动化工作流) ③AI×HR/招聘/人力资源。
- 实习/兼职/在校可做 **且** 方向属于上述三类之一 → score 60+, pass。
- 院校(如 211)、届别、具体工具(Coze/Dify 已掌握)、专业等不完全匹配可通过沟通尝试, 不作为 reject 理由。
- reject 红线(命中任一即 reject): (1) **全职岗位**(候选人只要实习); (2) bait 挂羊头(销售/培训贷/地推伪装); (3) 明确要求硕士或博士学历; (4) 方向不属于上述三类(如纯算法研究、纯后端、纯数据标注、纯销售/客服)。
- score>=45 且 bait=false 才 pass。`;
}

export async function screenJob(
  job,
  {
    profileText = fs.readFileSync(config.paths.profile, "utf8"),
    chatFn = chat,
  } = {},
) {
  const result = await chatFn(
    [
      { role: "system", content: SCREEN_SYSTEM_PROMPT },
      { role: "user", content: buildScreenPrompt(job, profileText) },
    ],
    { json: true },
  );

  assertScreenResult(result);
  return {
    score: Math.round(result.score),
    bait: result.bait,
    bait_reason: result.bait_reason ?? "",
    match_reasons: result.match_reasons,
    concerns: result.concerns,
    verdict:
      result.score >= config.screening.passScore && result.bait === false
        ? "pass"
        : "reject",
  };
}

function assertScreenResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error("Screening result must be an object");
  }
  if (
    typeof result.score !== "number" ||
    !Number.isFinite(result.score) ||
    result.score < 0 ||
    result.score > 100
  ) {
    throw new Error("Screening result score must be a number from 0 to 100");
  }
  if (typeof result.bait !== "boolean") {
    throw new Error("Screening result bait must be boolean");
  }
  if (!Array.isArray(result.match_reasons) || !Array.isArray(result.concerns)) {
    throw new Error("Screening result reasons and concerns must be arrays");
  }
}
