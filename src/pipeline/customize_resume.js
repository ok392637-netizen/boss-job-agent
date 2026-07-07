import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { chat } from "../llm.js";
import { analyzeCompanyStyle } from "../modules/company_style.js";
import {
  buildDeepResumePrompt,
  DEEP_RESUME_SYSTEM_PROMPT,
  validateDeepResumePlan,
} from "../modules/deep_resume.js";
import { assertPlainObject } from "../modules/fact_utils.js";
import {
  renderResumePdf,
  validateRenderedPdf,
} from "./render_resume_pdf.js";

export async function customizeResume(
  job,
  {
    research = null,
    resumeBase = JSON.parse(fs.readFileSync(config.paths.resumeBase, "utf8")),
    profileText = fs.readFileSync(config.paths.profile, "utf8"),
    memoryFacts = [],
    chatFn = chat,
    outputDirectory = config.paths.resumes,
  } = {},
) {
  assertPlainObject(job, "job");
  assertPlainObject(resumeBase, "resumeBase");

  const styleProfile = await analyzeCompanyStyle(job, {
    research: normalizeStyleResearch(research),
    chatFn,
  });
  const { plan } = await generateResumePlanWithRetry(job, {
    resumeBase,
    profileText,
    research,
    styleProfile,
    memoryFacts,
    chatFn,
  });

  const resumePath = path.join(outputDirectory, neutralResumeFileName(job));
  await renderResumePdf(plan.resume, resumePath);
  validateRenderedPdf(resumePath);

  return {
    resumeJson: plan.resume,
    strategy: plan.strategy,
    resumePath,
    factViolations: [],
  };
}

async function generateResumePlanWithRetry(
  job,
  {
    resumeBase,
    profileText,
    research,
    styleProfile,
    memoryFacts,
    chatFn,
  },
) {
  let retryInstruction = "";
  let lastError = null;
  let factViolations = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await chatFn(
      [
        { role: "system", content: DEEP_RESUME_SYSTEM_PROMPT },
        {
          role: "user",
          content: `${buildDeepResumePrompt({
            job,
            resumeBase,
            profileText,
            research,
            styleProfile,
            memoryProjects: memoryFacts,
          })}${retryInstruction}`,
        },
      ],
      { json: true },
    );

    try {
      const plan = validateDeepResumePlan(raw, resumeBase, {
        memoryProjects: memoryFacts,
      });
      const lengthViolations = resumeLengthViolations(plan.resume);
      if (lengthViolations.length > 0) {
        throw new Error(`一页排版超限: ${lengthViolations.join("; ")}`);
      }
      return { plan, factViolations: [] };
    } catch (error) {
      lastError = error;
      factViolations = [error.message];
      retryInstruction = `\n\n上次输出校验失败: ${error.message}
请重新生成完整 JSON。必须从基础简历逐字恢复姓名、联系方式、教育、工作公司、角色、日期等不可变字段；所有数字只能来自基础简历、个人档案或记忆项目事实；不要新增项目或经历。`;
    }
  }

  const error = new Error(
    `Resume fact validation failed after retry: ${lastError?.message ?? "unknown violation"}`,
    { cause: lastError },
  );
  error.factViolations = factViolations;
  throw error;
}

// 一页排版长度上限 (汉字计数); 超限触发重生成, 保证定制后仍稳定一页
const LEN = Object.freeze({
  strengthsMax: 4, strengthChars: 56,
  workBulletsMax: 3, projectBulletsMax: 3, bulletChars: 52,
  skillDescChars: 42,
});
const charLen = (s) => [...String(s ?? "")].length;

export function resumeLengthViolations(resume) {
  const v = [];
  const r = resume && typeof resume === "object" ? resume : {};
  if (Array.isArray(r.strengths)) {
    if (r.strengths.length > LEN.strengthsMax)
      v.push(`个人优势 ${r.strengths.length} 条应≤${LEN.strengthsMax}`);
    r.strengths.forEach((s, i) => {
      if (charLen(s) > LEN.strengthChars) v.push(`个人优势第${i + 1}条 ${charLen(s)}字应≤${LEN.strengthChars}`);
    });
  }
  for (const [label, list, max] of [["工作", r.work, LEN.workBulletsMax], ["项目", r.projects, LEN.projectBulletsMax]]) {
    if (!Array.isArray(list)) continue;
    list.forEach((it, i) => {
      const b = Array.isArray(it?.bullets) ? it.bullets : [];
      if (b.length > max) v.push(`${label}“${it?.name ?? it?.company ?? i + 1}” ${b.length}条bullet应≤${max}`);
      b.forEach((t, j) => {
        if (charLen(t) > LEN.bulletChars) v.push(`${label}“${it?.name ?? it?.company ?? i + 1}”第${j + 1}条 ${charLen(t)}字应≤${LEN.bulletChars}`);
      });
    });
  }
  if (Array.isArray(r.skills)) {
    r.skills.forEach((s, i) => {
      if (charLen(s?.desc) > LEN.skillDescChars) v.push(`技能“${s?.name ?? i + 1}”描述 ${charLen(s?.desc)}字应≤${LEN.skillDescChars}`);
    });
  }
  return v;
}

function normalizeStyleResearch(research) {
  if (!research || typeof research !== "object" || Array.isArray(research)) {
    return research;
  }
  const styleHint = research.style_hint ?? research.styleHint;
  if (!styleHint) return research;
  return {
    ...research,
    style_hint: styleHint,
    style_hint_instruction: styleHintInstruction(styleHint),
  };
}

function styleHintInstruction(styleHint) {
  const text = String(styleHint);
  if (/startup|初创|技术/u.test(text)) {
    return "偏初创技术团队: 叙事直接, 强调快速落地、工程实践和问题拆解。";
  }
  if (/corporate|traditional|正式|稳重|传统|大厂/u.test(text)) {
    return "偏正式稳重: 强调流程可靠、表达克制、事实清晰和协作稳定。";
  }
  if (/hr|招聘|人力/u.test(text)) {
    return "偏 AI×HR: 强调招聘流程理解、候选人画像、沟通跟进和自动化提效。";
  }
  return "按 balanced 处理: 保持事实优先, 避免夸张表达。";
}

function neutralResumeFileName(job) {
  const digest = crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        id: job.id ?? "",
        url: job.url ?? "",
        title: job.title ?? "",
        jd: job.jd ?? "",
      }),
    )
    .digest("hex")
    .slice(0, 10);
  return `luoqili-resume-${digest}.pdf`;
}
