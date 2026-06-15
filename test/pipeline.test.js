import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  genMaterials,
  validateMaterials,
} from "../src/pipeline/materials.js";
import {
  genResume,
  validateCustomizedResume,
  validateRenderedResume,
} from "../src/pipeline/resume.js";
import { screenJob } from "../src/pipeline/screen.js";

const FIXTURE_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "jds",
);

const TEST_PROFILE_TEXT = `## 基本信息
测试候选人，28 届本科在读，目标方向为 AI 应用、AI Agent 和自动化，可连续实习且每周到岗 4 天。

## 项目经历
- n8n 自动化工作流：采集公开信息，调用 LLM API 完成文本分类和结构化整理，并发送结果通知，将选题整理效率提升 40%。
- OpenClaw 求职流程 Agent：拆分岗位搜索、匹配筛选、材料生成和状态记录流程，使用日志和重试机制处理异常。
- DeepSeek 文本处理实验：使用 JavaScript 和 Node.js 调用模型接口，完成提示词设计、JSON 输出校验、效果测试和迭代。

## 技能
熟悉 JavaScript、Node.js、n8n、DeepSeek、提示词设计、工作流编排、使用文档整理和 AI 应用落地；能够主动沟通并复盘测试结果。`;

const TEST_RESUME_BASE = {
  name: "测试候选人",
  gender: "",
  age: 0,
  hometown: "",
  phone: "",
  email: "candidate@example.com",
  expect: { salary: "面议", city: "示例城市" },
  education: [
    {
      school: "测试大学",
      degree: "本科",
      major: "测试专业",
      period: "在读",
    },
  ],
  certificates: [],
  strengths: ["具备自动化工作流和 AI 应用实践经验"],
  work: [
    {
      company: "测试公司",
      role: "实习生",
      period: "实习期间",
      bullets: ["参与自动化流程设计与验证"],
    },
  ],
  projects: [
    {
      name: "测试项目",
      tag: "个人",
      period: "项目期间",
      bullets: ["使用 n8n 搭建自动化工作流"],
    },
  ],
  skills: [{ name: "自动化", desc: "熟悉 Node.js 和工作流编排" }],
};

function fixture(name) {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIRECTORY, `${name}.json`), "utf8"),
  );
}

test("real LLM screens all three fixture JDs as planned", async () => {
  const good = await screenJob(fixture("good-match"), {
    profileText: TEST_PROFILE_TEXT,
  });
  assert.equal(good.verdict, "pass");
  assert.ok(good.score >= 70, `expected score >= 70, got ${good.score}`);
  assert.equal(good.bait, false);

  const mismatch = await screenJob(fixture("mismatch"), {
    profileText: TEST_PROFILE_TEXT,
  });
  assert.equal(mismatch.verdict, "reject");
  assert.ok(mismatch.score < 60, `expected score < 60, got ${mismatch.score}`);

  const bait = await screenJob(fixture("bait"), {
    profileText: TEST_PROFILE_TEXT,
  });
  assert.equal(bait.bait, true);
  assert.equal(bait.verdict, "reject");
});

test("real LLM generates materials that pass the plan fact checks", async () => {
  const materials = await genMaterials(fixture("good-match"), {
    profileText: TEST_PROFILE_TEXT,
  });
  validateMaterials(materials);
  assert.ok(materials.greetShort.length > 0);
  assert.ok(materials.introLong.length > 0);
});

test("real LLM customizes and renders a valid docx resume", async (t) => {
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "boss-resume-real-"),
  );
  t.after(() =>
    fs.rmSync(outputDirectory, { recursive: true, force: true }),
  );
  const result = await genResume(fixture("good-match"), {
    resumeBase: structuredClone(TEST_RESUME_BASE),
    outputDirectory,
  });
  assert.equal(fs.existsSync(result.resumePath), true);

  const xml = await validateRenderedResume(result.resumePath, result.resume);
  assert.match(xml, /测试候选人/);
  assert.match(xml, /测试大学/);
});

test("resume generation reconciles immutable changes without retrying", async (t) => {
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "boss-resume-reconcile-"),
  );
  t.after(() =>
    fs.rmSync(outputDirectory, { recursive: true, force: true }),
  );
  const resumeBase = structuredClone(TEST_RESUME_BASE);
  const tampered = structuredClone(resumeBase);
  tampered.projects[0].name = "虚构项目"; // 篡改不可变 name -> 应被强制恢复为基础值
  tampered.strengths = ["针对该岗位改写的个人优势"]; // 合法改写 -> 应保留
  let calls = 0;

  const result = await genResume(fixture("good-match"), {
    resumeBase,
    outputDirectory,
    chatFn: async () => {
      calls += 1;
      return structuredClone(tampered);
    },
  });

  assert.equal(calls, 1); // reconcile 直接修正不可变字段, 无需重试
  assert.equal(result.resume.projects[0].name, resumeBase.projects[0].name); // 篡改的 name 被恢复
  assert.deepEqual(result.resume.strengths, ["针对该岗位改写的个人优势"]); // 合法 strengths 改写保留
  assert.equal(fs.existsSync(result.resumePath), true);
});

test("material generation retries once after a fact validation failure", async () => {
  const validIntro = `n8n 项目选题效率提升 40%。${"我持续进行自动化工作流实践。".repeat(40)}`;
  const replies = [
    {
      greet_short: "第一次".repeat(40),
      intro_long: `n8n 项目把效率提升 90%。${"自动化实践。".repeat(60)}`,
    },
    {
      greet_short: "第二次生成的招呼语".repeat(12),
      intro_long: validIntro,
    },
  ];
  let calls = 0;
  const prompts = [];

  const result = await genMaterials(fixture("good-match"), {
    profileText: "n8n 项目，选题效率提升 40%。",
    chatFn: async (messages) => {
      prompts.push(messages.at(-1).content);
      return replies[calls++];
    },
  });

  assert.equal(calls, 2);
  assert.match(result.greetShort, /^第二次/);
  assert.match(prompts[1], /上次输出校验失败/);
  assert.match(prompts[1], /intro_long must contain 500-700/);
  assert.match(prompts[1], /"greet_short":"第一次/);
  assert.match(prompts[1], /只改动错误消息明确点名的字段/);
});

test("material generation trims an overlong introduction at a sentence boundary", async () => {
  const sentence = "我使用 n8n 搭建自动化工作流，并持续复盘岗位要求与项目结果。";
  const result = await genMaterials(fixture("good-match"), {
    profileText: "n8n 项目，选题效率提升 40%。",
    chatFn: async () => ({
      greet_short: "在校生自动化项目经验与岗位要求匹配".repeat(7),
      intro_long: sentence.repeat(35),
    }),
  });

  const length = [...result.introLong.matchAll(/[\p{L}\p{N}]/gu)].length;
  assert.ok(length >= 500 && length <= 700, `unexpected length ${length}`);
  assert.match(result.introLong, /。$/);
});

test("material validation rejects unsupported facts", () => {
  const validGreet = "在校生自动化项目经验与岗位要求匹配".repeat(7);
  const validIntro = `n8n 项目。${"我持续进行自动化工作流实践。".repeat(40)}`;
  assert.throws(
    () =>
      validateMaterials({
        greetShort: validGreet,
        introLong: `${validIntro}提升 80%`,
      }),
    /unsupported percentage/,
  );
  assert.throws(
    () =>
      validateMaterials({
        greetShort: validGreet,
        introLong: `${validIntro}有 3年经验`,
      }),
    /banned claim/,
  );
});

test("material validation enforces prompt length contracts", () => {
  assert.throws(
    () =>
      validateMaterials({
        greetShort: "太短",
        introLong: `n8n ${"自动化实践。".repeat(100)}`,
      }),
    /greet_short must contain 90-165/,
  );
  assert.throws(
    () =>
      validateMaterials({
        greetShort: "在校生自动化项目经验与岗位要求匹配".repeat(7),
        introLong: "n8n 太短",
      }),
    /intro_long must contain 500-700/,
  );
});

test("resume validation rejects changed immutable data and new numbers", () => {
  const base = structuredClone(TEST_RESUME_BASE);
  const changedSchool = structuredClone(base);
  changedSchool.education[0].school = "其他大学";
  assert.throws(
    () => validateCustomizedResume(changedSchool, base),
    /immutable education/,
  );

  const newNumber = structuredClone(base);
  newNumber.strengths.push("完成 99 个自动化项目");
  assert.throws(
    () => validateCustomizedResume(newNumber, base),
    /introduced a new number: 99/,
  );
});
