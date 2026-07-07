import fs from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import JSZip from "jszip";
import { config } from "../config.js";
import { deriveJobId } from "../db.js";
import { chat } from "../llm.js";

export const RESUME_SYSTEM_PROMPT =
  "你是简历定制器。输入候选人基础简历 JSON 和目标岗位 JD, 输出同 schema 的定制简历 JSON。允许: 重写个人优势(strengths)呼应 JD 关键词、改写工作与项目各条 bullets 措辞突出与 JD 相关的方面、改写技能 desc。禁止: 改动项目/工作的 name/公司名/日期/条目顺序, 改动学校/学历/联系方式, 新增任何经历/技能/数字, 删除教育经历。保持 projects 与 work 的条目顺序与基础简历一致。只输出 JSON。";

const BODY_SIZE = 21;
const HEADING_SIZE = 28;
const FONT = "Microsoft YaHei";

export function buildResumePrompt(job, resumeBase) {
  return `基础简历: ${JSON.stringify(resumeBase)}
目标岗位: ${job.title} @ ${job.company}
JD: ${job.jd}
输出定制后的完整简历 JSON (schema 不变)。`;
}

export async function genResume(
  job,
  {
    resumeBase = JSON.parse(fs.readFileSync(config.paths.resumeBase, "utf8")),
    outputDirectory = config.paths.resumes,
    chatFn = chat,
  } = {},
) {
  let customized;
  let lastError;
  let retryInstruction = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await chatFn(
      [
        { role: "system", content: RESUME_SYSTEM_PROMPT },
        {
          role: "user",
          content: `${buildResumePrompt(job, resumeBase)}${retryInstruction}`,
        },
      ],
      { json: true },
    );
    customized = reconcileResume(raw, resumeBase);

    try {
      validateCustomizedResume(customized, resumeBase);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      retryInstruction = `\n\n上次输出校验失败: ${error.message}
上次输出: ${JSON.stringify(customized)}
请返回修正后的完整 JSON。必须从基础简历逐字恢复所有不可变字段，只调整系统提示允许改写的字段，不新增任何数字。`;
    }
  }
  if (lastError) {
    if (/introduced a new number/.test(lastError.message)) {
      const repaired = repairNewNumbers(customized, resumeBase);
      if (repaired !== customized) {
        try {
          validateCustomizedResume(repaired, resumeBase);
          customized = repaired;
          lastError = null;
        } catch (error) {
          lastError = error;
        }
      }
    }
  }
  if (lastError) {
    throw new Error(
      `Resume fact validation failed after retry: ${lastError.message}`,
      { cause: lastError },
    );
  }

  const jobId = deriveJobId(job);
  const company = sanitizeFilePart(job.company || "unknown-company");
  const resumePath = path.join(outputDirectory, `${jobId}-${company}.docx`);
  await renderResume(customized, resumePath);
  await validateRenderedResume(resumePath);

  return { resume: customized, resumePath };
}

export async function renderResume(resume, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 70 },
      children: [
        run(resume.name, { bold: true, size: 32 }),
        run(
          `  |  ${resume.phone}  |  ${resume.email}  |  ${resume.hometown}  |  期望 ${resume.expect.salary} / ${resume.expect.city}`,
        ),
      ],
    }),
    sectionHeading("个人优势"),
    ...resume.strengths.map((item) => bullet(item)),
    sectionHeading("工作经历"),
    ...resume.work.flatMap((item) => [
      itemHeading(`${item.company} | ${item.role} | ${item.period}`),
      ...item.bullets.map((text) => bullet(text)),
    ]),
    sectionHeading("项目经历"),
    ...resume.projects.flatMap((item) => [
      itemHeading(
        [item.name, item.tag, item.period].filter(Boolean).join(" | "),
      ),
      ...item.bullets.map((text) => bullet(text)),
    ]),
    sectionHeading("教育经历"),
    ...resume.education.map((item) =>
      itemHeading(
        `${item.school} | ${item.degree} | ${item.major} | ${item.period}`,
      ),
    ),
    ...(resume.certificates.length > 0
      ? [bodyParagraph(`证书: ${resume.certificates.join("、")}`)]
      : []),
    sectionHeading("专业技能"),
    ...resume.skills.map((item) =>
      bodyParagraph(`${item.name}: ${item.desc}`, { boldPrefix: item.name.length + 1 }),
    ),
  ];

  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: BODY_SIZE },
          paragraph: { spacing: { line: 250 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 500,
              right: 650,
              bottom: 500,
              left: 650,
            },
          },
        },
        children,
      },
    ],
  });

  fs.writeFileSync(outputPath, await Packer.toBuffer(document));
  return outputPath;
}

export function validateCustomizedResume(customized, base) {
  const requiredArrays = [
    "education",
    "certificates",
    "strengths",
    "work",
    "projects",
    "skills",
  ];
  if (!customized || typeof customized !== "object") {
    throw new Error("Customized resume must be an object");
  }
  for (const key of requiredArrays) {
    if (!Array.isArray(customized[key])) {
      throw new Error(`Customized resume field must be an array: ${key}`);
    }
  }

  for (const key of ["name", "gender", "age", "hometown", "phone", "email"]) {
    if (customized[key] !== base[key]) {
      throw new Error(`Customized resume changed immutable field: ${key}`);
    }
  }
  if (JSON.stringify(customized.expect) !== JSON.stringify(base.expect)) {
    throw new Error("Customized resume changed job expectation");
  }
  assertSameRecords(
    customized.education,
    base.education,
    ["school", "degree", "major", "period"],
    "education",
  );
  assertSameRecords(
    customized.work,
    base.work,
    ["company", "role", "period"],
    "work",
  );
  assertSameRecords(
    customized.projects,
    base.projects,
    ["name", "tag", "period"],
    "projects",
  );
  assertSameRecords(customized.skills, base.skills, ["name"], "skills");
  assertSameStrings(customized.certificates, base.certificates, "certificates");

  const allowedNumbers = collectNumbers(base);
  const newNumber = [...collectNumbers(customized)].find(
    (number) => !allowedNumbers.has(number),
  );
  if (newNumber) {
    throw new Error(`Customized resume introduced a new number: ${newNumber}`);
  }
}

// 强制不可变字段取自基础简历, 仅保留 LLM 对 strengths / 各条 bullets / 技能 desc 的改写。
// 避免 LLM 改动 name/日期/顺序导致校验反复失败; 新增数字仍由 validateCustomizedResume 拦截。
function reconcileResume(raw, base) {
  const llm = raw && typeof raw === "object" ? raw : {};
  const mergeBullets = (llmArr, baseArr, nameKey) =>
    baseArr.map((b) => {
      const match = Array.isArray(llmArr)
        ? llmArr.find((x) => x && x[nameKey] === b[nameKey])
        : null;
      return match && Array.isArray(match.bullets) && match.bullets.length > 0
        ? { ...b, bullets: match.bullets.map(String) }
        : b;
    });
  const result = { ...base };
  if (Array.isArray(llm.strengths) && llm.strengths.length > 0) {
    result.strengths = llm.strengths.map(String);
  }
  result.work = mergeBullets(llm.work, base.work, "company");
  result.projects = mergeBullets(llm.projects, base.projects, "name");
  result.skills = base.skills.map((b) => {
    const match = Array.isArray(llm.skills)
      ? llm.skills.find((x) => x && x.name === b.name)
      : null;
    return match && typeof match.desc === "string"
      ? { name: b.name, desc: match.desc }
      : b;
  });
  return result;
}

export async function validateRenderedResume(resumePath) {
  const bytes = fs.readFileSync(resumePath);
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry) {
    throw new Error(`Invalid docx: word/document.xml missing in ${resumePath}`);
  }
  const xml = await entry.async("string");
  for (const requiredText of ["罗其立", "广州中医药大学"]) {
    if (!xml.includes(requiredText)) {
      throw new Error(`Invalid docx: missing required text ${requiredText}`);
    }
  }
  return xml;
}

function assertSameRecords(actual, expected, keys, label) {
  if (actual.length !== expected.length) {
    throw new Error(`Customized resume changed ${label} item count`);
  }
  const signatures = (items) =>
    items
      .map((item) => keys.map((key) => item[key] ?? "").join("\u0000"))
      .sort();
  if (JSON.stringify(signatures(actual)) !== JSON.stringify(signatures(expected))) {
    throw new Error(`Customized resume changed immutable ${label} fields`);
  }
}

function assertSameStrings(actual, expected, label) {
  if (
    JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
  ) {
    throw new Error(`Customized resume changed ${label}`);
  }
}

function collectNumbers(value, target = new Set()) {
  if (typeof value === "number") {
    target.add(String(value));
  } else if (typeof value === "string") {
    for (const match of value.matchAll(/\d+(?:\.\d+)?%?/g)) {
      target.add(match[0]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, target);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNumbers(item, target);
  }
  return target;
}

function repairNewNumbers(customized, base) {
  const allowedNumbers = collectNumbers(base);
  const result = structuredClone(customized);
  let changed = false;
  const repairString = (value, fallback) => {
    const text = String(value ?? "");
    if (!hasDisallowedNumber(text, allowedNumbers)) {
      return text;
    }
    changed = true;
    return String(fallback ?? "");
  };
  const repairStrings = (values, fallbacks) =>
    Array.isArray(values)
      ? values.map((value, index) => repairString(value, fallbacks?.[index] ?? ""))
      : values;

  result.strengths = repairStrings(result.strengths, base.strengths);
  result.work = result.work.map((item, index) => ({
    ...item,
    bullets: repairStrings(item.bullets, base.work[index]?.bullets),
  }));
  result.projects = result.projects.map((item, index) => ({
    ...item,
    bullets: repairStrings(item.bullets, base.projects[index]?.bullets),
  }));

  const baseSkills = new Map(base.skills.map((item) => [item.name, item]));
  result.skills = result.skills.map((item) => ({
    ...item,
    desc: repairString(item.desc, baseSkills.get(item.name)?.desc),
  }));

  return changed ? result : customized;
}

function hasDisallowedNumber(value, allowedNumbers) {
  for (const match of String(value ?? "").matchAll(/\d+(?:\.\d+)?%?/g)) {
    if (!allowedNumbers.has(match[0])) {
      return true;
    }
  }
  return false;
}

function sanitizeFilePart(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 60) || "unknown-company";
}

function run(text, { bold = false, size = BODY_SIZE } = {}) {
  return new TextRun({ text, bold, size, font: FONT });
}

function sectionHeading(text) {
  return new Paragraph({
    keepNext: true,
    spacing: { before: 90, after: 35 },
    children: [run(text, { bold: true, size: HEADING_SIZE })],
  });
}

function itemHeading(text) {
  return new Paragraph({
    keepNext: true,
    spacing: { before: 35, after: 10 },
    children: [run(text, { bold: true })],
  });
}

function bullet(text) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 10 },
    children: [run(text)],
  });
}

function bodyParagraph(text, { boldPrefix = 0 } = {}) {
  return new Paragraph({
    spacing: { after: 10 },
    children:
      boldPrefix > 0
        ? [
            run(text.slice(0, boldPrefix), { bold: true }),
            run(text.slice(boldPrefix)),
          ]
        : [run(text)],
  });
}
