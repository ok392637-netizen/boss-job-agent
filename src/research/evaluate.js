import { chat } from "../llm.js";

export const COMPANY_EVALUATION_SYSTEM_PROMPT = [
  "你是求职公司背调评估器，只输出 JSON。",
  "目标是识别挂羊头卖狗肉、培训贷、押金、销售伪装、岗位画像矛盾等风险。",
  "所有扣分点必须引用证据；没有证据不得扣分。",
  "degraded 来源只代表信息缺失，不代表负面证据。",
].join("\n");

export function buildCompanyEvaluationPrompt(intel, job) {
  const degraded = normalizeDegradedSources(intel);
  return `## 岗位
标题: ${job.title ?? ""}
公司: ${job.company ?? ""}
城市: ${job.city ?? ""}
薪资: ${job.salary ?? ""}
JD:
${job.jd ?? ""}

## 背调资料
${JSON.stringify(intel, null, 2)}

## 降级来源
${degraded.length > 0 ? degraded.join(", ") : "无"}

硬规则:
- degraded=search/tyc/boss 只表示信息缺失；不得因为搜索或工商层降级、查不到、空结果而扣分。
- 每个扣分点必须引用证据，证据类型只能来自：Boss 在招岗位画像矛盾、搜索负面命中、工商异常。
- 如果搜索和天眼查降级，company_score 主要依据 Boss 站内在招岗位画像；招 AI 岗但在招岗位清一色销售/电销/地推是强红旗。
- 无证据不扣分；信息缺失写入 summary，不写成 red_flag。

输出 JSON:
{
  "company_score": 0-100,
  "red_flags": [{"type":"","severity":"low|medium|high","reason":"","evidence":""}],
  "bait_and_switch": {"value": false, "reason": ""},
  "style_hint": "大厂正式|初创技术|传统稳重|未知",
  "summary": ""
}`;
}

export async function evaluateCompany(
  intel,
  job,
  { chatFn = chat } = {},
) {
  const raw = await chatFn(
    [
      { role: "system", content: COMPANY_EVALUATION_SYSTEM_PROMPT },
      { role: "user", content: buildCompanyEvaluationPrompt(intel, job) },
    ],
    { json: true },
  );
  return validateCompanyEvaluation(raw);
}

export function validateCompanyEvaluation(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Company evaluation must be an object");
  }
  if (
    typeof raw.company_score !== "number" ||
    !Number.isFinite(raw.company_score)
  ) {
    throw new Error("company_score must be a finite number");
  }
  if (!Array.isArray(raw.red_flags)) {
    throw new Error("red_flags must be an array");
  }
  const redFlags = raw.red_flags.map((flag) => {
    if (!flag || typeof flag !== "object") {
      throw new Error("red_flags entries must be objects");
    }
    const normalized = {
      type: stringValue(flag.type),
      severity: enumValue(flag.severity, ["low", "medium", "high"], "medium"),
      reason: stringValue(flag.reason),
      evidence: stringValue(flag.evidence),
    };
    if (!normalized.evidence) {
      throw new Error("red_flags entries require evidence");
    }
    return normalized;
  });

  const bait = normalizeBait(raw.bait_and_switch);
  return {
    company_score: clampScore(raw.company_score),
    red_flags: redFlags,
    bait_and_switch: bait,
    style_hint: enumValue(
      raw.style_hint,
      ["大厂正式", "初创技术", "传统稳重", "未知"],
      "未知",
    ),
    summary: stringValue(raw.summary),
  };
}

function normalizeBait(value) {
  if (typeof value === "boolean") {
    return { value, reason: "" };
  }
  if (!value || typeof value !== "object") {
    throw new Error("bait_and_switch must be an object");
  }
  return {
    value: Boolean(value.value),
    reason: stringValue(value.reason),
  };
}

function normalizeDegradedSources(intel) {
  const sources = new Set();
  for (const source of Array.isArray(intel?.degraded) ? intel.degraded : []) {
    if (source) sources.add(String(source));
  }
  for (const source of ["boss", "search", "tyc"]) {
    if (intel?.[source]?.degraded) {
      sources.add(source);
    }
  }
  return [...sources];
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function stringValue(value) {
  return String(value ?? "").trim();
}
