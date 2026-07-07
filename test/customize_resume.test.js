import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { customizeResume, resumeLengthViolations } from "../src/pipeline/customize_resume.js";

test("resumeLengthViolations passes concise resume and flags overflow", () => {
  const concise = {
    strengths: ["跨专业转 AI，上手快", "熟练 n8n 自动化落地", "深度用 Claude/Cursor", "对 Agent 边界有理解"],
    work: [{ company: "X", bullets: ["做了 AI 记忆后端", "接口与存储"] }],
    projects: [{ name: "P", bullets: ["n8n 全链路自动化", "效率提升 40%"] }],
    skills: [{ name: "AI 工具", desc: "Claude · Cursor · Coze" }],
  };
  assert.deepEqual(resumeLengthViolations(concise), []);

  const overflow = {
    strengths: ["a", "b", "c", "d", "e"], // 5 条超上限
    work: [{ company: "X", bullets: ["1", "2", "3", "4"] }], // 4 条超上限
    projects: [{ name: "P", bullets: ["这是一条非常长的项目描述".repeat(6)] }], // 超字数
    skills: [{ name: "S", desc: "很长的技能描述".repeat(8) }], // 超字数
  };
  const v = resumeLengthViolations(overflow);
  assert.ok(v.length >= 4, `should flag multiple: ${JSON.stringify(v)}`);
});

const job = Object.freeze({
  id: "job-1",
  title: "AI Agent 实习生",
  company: "测试科技",
  city: "广州",
  salary: "3-6K",
  jd: "负责 AI Agent 工作流、自动化流程拆解和求职场景落地。",
});

const resumeBase = Object.freeze({
  name: "罗其立",
  gender: "男",
  age: 19,
  hometown: "韶关",
  phone: "13800138000",
  email: "resume@example.com",
  expect: { salary: "3-8K", city: "广州" },
  education: [
    {
      school: "广州中医药大学",
      degree: "本科",
      major: "中药资源与开发",
      period: "2024-2028",
    },
  ],
  certificates: ["CET-4"],
  strengths: ["跨专业 AI 实践者。"],
  work: [
    {
      company: "深圳市诸葛瓜科技有限公司",
      role: "Java",
      period: "2026.01-2026.04",
      bullets: ["AI 记忆系统模块设计、开发与优化。"],
    },
  ],
  projects: [
    {
      name: "AI 记忆系统后端开发",
      tag: "Java",
      period: "2026.01-2026.06",
      bullets: ["支持多轮交互信息记录、读取和调用。"],
    },
  ],
  skills: [
    { name: "AI 工具", desc: "ChatGPT、Claude、Cursor、Claude Code。" },
  ],
});

const memoryFacts = Object.freeze([
  {
    name: "boss-job-agent",
    tag: "个人项目",
    period: "2026.06-2026.07",
    facts: ["岗位筛选、JD 评估、简历定制、沟通辅助。", "12 个真实岗位全部成功定制化打招呼。"],
    metrics: ["12 个真实岗位全部成功定制化打招呼。"],
    bullets: ["岗位筛选、JD 评估、简历定制、沟通辅助。"],
  },
]);

function tempOutput(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-custom-resume-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function validDeepResume(positioning = "AI Agent 求职自动化实践者") {
  const base = structuredClone(resumeBase);
  return {
    strategy: {
      positioning,
      selected_projects: ["boss-job-agent", "AI 记忆系统后端开发"],
      jd_keywords: ["AI Agent", "自动化流程"],
      company_style_notes: ["突出落地"],
      risk_notes: ["职责需二次确认"],
    },
    resume: {
      ...base,
      strengths: ["围绕 AI Agent 和自动化流程做项目落地。"],
      projects: [
        {
          ...structuredClone(memoryFacts[0]),
          bullets: ["围绕岗位筛选、JD 评估、简历定制、沟通辅助构建求职 agent。"],
        },
        {
          ...base.projects[0],
          bullets: ["支持多轮交互信息记录、读取和调用，可服务 AI Agent 长期上下文。"],
        },
      ],
      skills: [
        {
          name: "AI 工具",
          desc: "围绕 AI Agent、Claude Code 和自动化工作流做落地。",
        },
      ],
    },
    change_log: ["按 JD 调整项目排序"],
    fact_usage: [{ claim: "boss-job-agent", source: "memory", evidence: "项目事实" }],
  };
}

function styleResponse(styleType = "startup", resumeAngle = "突出初创团队重视的技术落地") {
  return {
    style_type: styleType,
    tone: styleType === "corporate" ? "formal" : "direct",
    resume_angle: resumeAngle,
    emphasis_order: ["boss-job-agent", "AI 记忆系统"],
    keyword_bias: ["AI Agent", "招聘自动化"],
    avoid: ["算法研究叙事"],
    evidence: [{ source: "research.style_hint", quote: resumeAngle }],
  };
}

test("customizeResume generates a neutral-named PDF with style and memory projects", async (t) => {
  const outputDirectory = tempOutput(t);
  const seen = { stylePrompt: "", deepPrompt: "" };
  const result = await customizeResume(job, {
    research: { style_hint: "startup_technical" },
    resumeBase,
    profileText: "个人档案: AI Agent / 自动化工作流。",
    memoryFacts,
    outputDirectory,
    chatFn: async (messages, options) => {
      assert.equal(options.json, true);
      const prompt = messages.at(-1).content;
      if (prompt.includes('"style_type"')) {
        seen.stylePrompt = prompt;
        return styleResponse("startup", "初创技术团队强调快速落地");
      }
      seen.deepPrompt = prompt;
      assert.match(prompt, /boss-job-agent/);
      assert.match(prompt, /startup/);
      return validDeepResume("初创技术落地型 AI Agent 实践者");
    },
  });

  assert.match(seen.stylePrompt, /startup_technical/);
  assert.equal(result.resumeJson.projects[0].name, "boss-job-agent");
  assert.match(result.strategy.positioning, /初创技术/);
  assert.deepEqual(result.factViolations, []);
  assert.equal(fs.existsSync(result.resumePath), true);
  assert.doesNotMatch(path.basename(result.resumePath), /测试科技/);
  assert.match(path.basename(result.resumePath), /resume/i);
  assert.equal(path.extname(result.resumePath), ".pdf");
});

test("customizeResume retries once after unsupported generated numbers", async (t) => {
  const outputDirectory = tempOutput(t);
  let deepCalls = 0;
  const prompts = [];
  const result = await customizeResume(job, {
    research: { style_hint: "startup_technical" },
    resumeBase,
    profileText: "个人档案",
    memoryFacts,
    outputDirectory,
    chatFn: async (messages) => {
      const prompt = messages.at(-1).content;
      if (prompt.includes('"style_type"')) return styleResponse();
      deepCalls += 1;
      prompts.push(prompt);
      if (deepCalls === 1) {
        const invalid = validDeepResume();
        invalid.resume.strengths = ["虚构 99% 增长。"];
        return invalid;
      }
      return validDeepResume("修正后只使用可追溯事实");
    },
  });

  assert.equal(deepCalls, 2);
  assert.match(prompts[1], /上次输出校验失败/);
  assert.doesNotMatch(JSON.stringify(result.resumeJson), /99%/);
  assert.deepEqual(result.factViolations, []);
});

test("customizeResume restores immutable fields before rendering", async (t) => {
  const outputDirectory = tempOutput(t);
  const result = await customizeResume(job, {
    research: { style_hint: "corporate_formal" },
    resumeBase,
    profileText: "个人档案",
    memoryFacts,
    outputDirectory,
    chatFn: async (messages) => {
      const prompt = messages.at(-1).content;
      if (prompt.includes('"style_type"')) return styleResponse("corporate", "正式稳重");
      const tampered = validDeepResume("正式稳重的 AI Agent 实践者");
      tampered.resume.name = "张三";
      tampered.resume.education[0].school = "虚构大学";
      tampered.resume.work[0].company = "虚构公司";
      tampered.resume.work[0].period = "2099";
      return tampered;
    },
  });

  assert.equal(result.resumeJson.name, resumeBase.name);
  assert.deepEqual(result.resumeJson.education, resumeBase.education);
  assert.equal(result.resumeJson.work[0].company, resumeBase.work[0].company);
  assert.equal(result.resumeJson.work[0].period, resumeBase.work[0].period);
});

test("customizeResume lets research.style_hint drive final positioning", async (t) => {
  const outputDirectory = tempOutput(t);
  const result = await customizeResume(job, {
    research: { style_hint: "traditional_stable" },
    resumeBase,
    profileText: "个人档案",
    memoryFacts,
    outputDirectory,
    chatFn: async (messages) => {
      const prompt = messages.at(-1).content;
      if (prompt.includes('"style_type"')) {
        assert.match(prompt, /traditional_stable/);
        return styleResponse("corporate", "传统企业偏好正式稳重和流程可靠");
      }
      assert.match(prompt, /corporate/);
      return validDeepResume("正式稳重的流程自动化候选人");
    },
  });

  assert.match(result.strategy.positioning, /正式稳重/);
});
