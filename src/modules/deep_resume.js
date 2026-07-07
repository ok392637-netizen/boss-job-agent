import fs from "node:fs";
import { chat } from "../llm.js";
import { config } from "../config.js";
import { renderResume } from "../pipeline/resume.js";
import {
  assertNoUnsupportedNumbers,
  assertPlainObject,
  buildCandidateFactIndex,
  normalizeProjectFacts,
  sameJson,
  stringArray,
  stringValue,
} from "./fact_utils.js";

export const DEEP_RESUME_SYSTEM_PROMPT = [
  "你是深度简历定制 agent。",
  "目标: 针对单个 JD、公司画像和风格画像, 生成一份岗位专属简历策略和简历 JSON。",
  "事实边界: 只能使用基础简历、个人档案、记忆系统项目事实中的内容; 不得新增学历、公司、日期、数字、项目成果。",
  "允许: 重写个人优势、工作/项目 bullet、技能描述; 从候选项目事实中选择最匹配项目并调整排序。",
  "禁止: 修改姓名/联系方式/教育/工作公司和日期; 编造任何经历或数字。",
  "排版: 简历渲染成 A4 单页, 内容必须精简到一页装得下; 措辞紧凑、动词开头、量化优先、去空话; 严守用户消息里的每段条数与字数上限。",
  "只输出 JSON。",
].join("\n");

export function buildDeepResumePrompt({
  job,
  resumeBase,
  profileText = "",
  research = null,
  styleProfile = null,
  memoryProjects = [],
}) {
  assertPlainObject(job, "job");
  assertPlainObject(resumeBase, "resumeBase");
  return `## 基础简历 JSON
${JSON.stringify(resumeBase, null, 2)}

## 个人档案
${profileText}

## 记忆系统项目事实
${JSON.stringify(normalizeProjectFacts(memoryProjects), null, 2)}

## 目标岗位
${JSON.stringify(job, null, 2)}

## 公司背调
${JSON.stringify(research, null, 2)}

## 公司风格画像
${JSON.stringify(styleProfile, null, 2)}

输出 JSON:
{
  "strategy": {
    "positioning": "",
    "selected_projects": ["项目名"],
    "jd_keywords": ["关键词"],
    "company_style_notes": ["风格调整"],
    "risk_notes": ["风险/不确定点"]
  },
  "resume": 基于基础简历 schema 的完整 JSON,
  "change_log": ["改了什么以及为什么"],
  "fact_usage": [{"claim":"","source":"base_resume|profile|memory","evidence":""}]
}

## 一页排版硬约束 (简历会渲染成 A4 单页, 超长会溢出/被裁, 必须严守)
- strengths(个人优势): **恰好 4 条**, 每条 ≤ 42 个汉字(约一行), 前半句点明与 JD 的匹配点。
- work(工作/实习)每段 bullets: **≤ 3 条**, 每条 ≤ 40 个汉字。
- projects(项目)条目数与顺序**与基础简历一致**(不增删项目); 每个项目 bullets **≤ 2 条**(最相关的可 3 条), 每条 ≤ 42 个汉字。
- skills(技能): 条目数与基础简历一致; 每条 desc ≤ 26 个汉字(侧栏一行, 超长会换行挤爆)。
- 总则: **宁精简勿溢出**。措辞紧凑、去空话、动词开头、量化优先; 不确定能否一页时就再压缩, 而不是堆字。
- 只删减/改写措辞来控长, 严禁为凑字数新增任何经历、数字或项目。`;
}

export async function generateDeepResume(
  job,
  {
    resumeBase = JSON.parse(fs.readFileSync(config.paths.resumeBase, "utf8")),
    profileText = fs.readFileSync(config.paths.profile, "utf8"),
    research = null,
    styleProfile = null,
    memoryProjects = [],
    chatFn = chat,
    outputPath = null,
  } = {},
) {
  const raw = await chatFn(
    [
      { role: "system", content: DEEP_RESUME_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildDeepResumePrompt({
          job,
          resumeBase,
          profileText,
          research,
          styleProfile,
          memoryProjects,
        }),
      },
    ],
    { json: true },
  );
  const result = validateDeepResumePlan(raw, resumeBase, { memoryProjects });
  if (outputPath) {
    await renderResume(result.resume, outputPath);
    result.resumePath = outputPath;
  }
  return result;
}

export function validateDeepResumePlan(raw, resumeBase, { memoryProjects = [] } = {}) {
  assertPlainObject(raw, "deep resume plan");
  assertPlainObject(raw.strategy, "deep resume strategy");
  assertPlainObject(raw.resume, "deep resume");
  assertRawProjectsKnown(raw.resume, resumeBase, { memoryProjects });
  const resume = reconcileDeepResume(raw.resume, resumeBase, { memoryProjects });

  const normalized = {
    strategy: {
      positioning: stringValue(raw.strategy.positioning),
      selectedProjects: stringArray(raw.strategy.selected_projects),
      jdKeywords: stringArray(raw.strategy.jd_keywords),
      companyStyleNotes: stringArray(raw.strategy.company_style_notes),
      riskNotes: stringArray(raw.strategy.risk_notes),
    },
    resume,
    changeLog: stringArray(raw.change_log),
    factUsage: Array.isArray(raw.fact_usage) ? raw.fact_usage : [],
  };

  validateDeepResume(normalized.resume, resumeBase, { memoryProjects });
  if (!normalized.strategy.positioning) {
    throw new Error("deep resume strategy requires positioning");
  }
  if (normalized.strategy.selectedProjects.length === 0) {
    throw new Error("deep resume strategy requires selected_projects");
  }
  return normalized;
}

function assertRawProjectsKnown(rawResume, resumeBase, { memoryProjects = [] } = {}) {
  if (!Array.isArray(rawResume.projects)) return;
  const factIndex = buildCandidateFactIndex(resumeBase, memoryProjects);
  const unknown = rawResume.projects.find((project) => {
    const name = stringValue(project?.name);
    return name && !factIndex.projectByName.has(name);
  });
  if (unknown) {
    throw new Error(`Deep resume used unknown project: ${unknown.name}`);
  }
}

export function reconcileDeepResume(rawResume, resumeBase, { memoryProjects = [] } = {}) {
  const factIndex = buildCandidateFactIndex(resumeBase, memoryProjects);
  const raw = rawResume && typeof rawResume === "object" ? rawResume : {};
  const result = {
    ...raw,
    name: resumeBase.name,
    gender: resumeBase.gender,
    age: resumeBase.age,
    hometown: resumeBase.hometown,
    phone: resumeBase.phone,
    email: resumeBase.email,
    expect: resumeBase.expect,
    education: resumeBase.education,
    certificates: resumeBase.certificates,
  };

  if (!Array.isArray(result.strengths) || result.strengths.length === 0) {
    result.strengths = resumeBase.strengths;
  }

  result.work = resumeBase.work.map((baseItem) => {
    const match = Array.isArray(raw.work)
      ? raw.work.find((item) => item?.company === baseItem.company)
      : null;
    return {
      ...baseItem,
      bullets:
        Array.isArray(match?.bullets) && match.bullets.length > 0
          ? match.bullets.map(String)
          : baseItem.bullets,
    };
  });

  const rawProjects = Array.isArray(raw.projects) ? raw.projects : [];
  const reconciledProjects = [];
  for (const item of rawProjects) {
    const source = factIndex.projectByName.get(item?.name);
    if (!source) continue;
    reconciledProjects.push({
      ...source,
      bullets:
        Array.isArray(item.bullets) && item.bullets.length > 0
          ? item.bullets.map(String)
          : source.bullets,
    });
  }
  result.projects =
    reconciledProjects.length > 0 ? reconciledProjects : resumeBase.projects;

  result.skills = resumeBase.skills.map((baseItem) => {
    const match = Array.isArray(raw.skills)
      ? raw.skills.find((item) => item?.name === baseItem.name)
      : null;
    return {
      ...baseItem,
      desc: typeof match?.desc === "string" ? match.desc : baseItem.desc,
    };
  });

  return result;
}

export function validateDeepResume(resume, resumeBase, { memoryProjects = [] } = {}) {
  assertPlainObject(resume, "deep resume");
  const immutableKeys = ["name", "gender", "age", "hometown", "phone", "email"];
  for (const key of immutableKeys) {
    if (resume[key] !== resumeBase[key]) {
      throw new Error(`Deep resume changed immutable field: ${key}`);
    }
  }
  if (!sameJson(resume.expect, resumeBase.expect)) {
    throw new Error("Deep resume changed job expectation");
  }
  if (!sameJson(resume.education, resumeBase.education)) {
    throw new Error("Deep resume changed education");
  }
  if (!sameJson([...resume.certificates].sort(), [...resumeBase.certificates].sort())) {
    throw new Error("Deep resume changed certificates");
  }
  assertSameWorkRecords(resume.work, resumeBase.work);
  assertAllowedProjects(resume.projects, resumeBase, memoryProjects);
  assertSameSkillNames(resume.skills, resumeBase.skills);

  const factIndex = buildCandidateFactIndex(resumeBase, memoryProjects);
  assertNoUnsupportedNumbers(resume, factIndex.numbers);
  return true;
}

function assertSameWorkRecords(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw new Error("Deep resume changed work item count");
  }
  for (let index = 0; index < expected.length; index += 1) {
    for (const key of ["company", "role", "period"]) {
      if (actual[index]?.[key] !== expected[index][key]) {
        throw new Error(`Deep resume changed work.${index}.${key}`);
      }
    }
    if (!Array.isArray(actual[index].bullets) || actual[index].bullets.length === 0) {
      throw new Error(`Deep resume work.${index}.bullets must be non-empty`);
    }
  }
}

function assertAllowedProjects(actual, resumeBase, memoryProjects) {
  if (!Array.isArray(actual) || actual.length === 0) {
    throw new Error("Deep resume projects must be a non-empty array");
  }
  const factIndex = buildCandidateFactIndex(resumeBase, memoryProjects);
  for (const project of actual) {
    const source = factIndex.projectByName.get(project?.name);
    if (!source) {
      throw new Error(`Deep resume used unknown project: ${project?.name ?? ""}`);
    }
    for (const key of ["tag", "period"]) {
      if ((project[key] ?? "") !== (source[key] ?? "")) {
        throw new Error(`Deep resume changed project ${project.name} ${key}`);
      }
    }
    if (!Array.isArray(project.bullets) || project.bullets.length === 0) {
      throw new Error(`Deep resume project ${project.name} bullets must be non-empty`);
    }
  }
}

function assertSameSkillNames(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw new Error("Deep resume changed skills item count");
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index]?.name !== expected[index].name) {
      throw new Error(`Deep resume changed skills.${index}.name`);
    }
  }
}
