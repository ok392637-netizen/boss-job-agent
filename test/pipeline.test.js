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

function fixture(name) {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIRECTORY, `${name}.json`), "utf8"),
  );
}

test("real LLM screens all three fixture JDs as planned", async () => {
  const good = await screenJob(fixture("good-match"));
  assert.equal(good.verdict, "pass");
  assert.ok(good.score >= 70, `expected score >= 70, got ${good.score}`);
  assert.equal(good.bait, false);

  const mismatch = await screenJob(fixture("mismatch"));
  assert.equal(mismatch.verdict, "reject");
  assert.ok(mismatch.score < 60, `expected score < 60, got ${mismatch.score}`);

  const bait = await screenJob(fixture("bait"));
  assert.equal(bait.bait, true);
  assert.equal(bait.verdict, "reject");
});

test("real LLM generates materials that pass the plan fact checks", async () => {
  const materials = await genMaterials(fixture("good-match"));
  validateMaterials(materials);
  assert.ok(materials.greetShort.length > 0);
  assert.ok(materials.introLong.length > 0);
});

test("real LLM customizes and renders a valid docx resume", async () => {
  const result = await genResume(fixture("good-match"));
  assert.equal(fs.existsSync(result.resumePath), true);

  const xml = await validateRenderedResume(result.resumePath);
  assert.match(xml, /罗其立/);
  assert.match(xml, /广州中医药大学/);
});

test("resume generation reconciles immutable changes without retrying", async (t) => {
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "boss-resume-reconcile-"),
  );
  t.after(() =>
    fs.rmSync(outputDirectory, { recursive: true, force: true }),
  );
  const resumeBase = JSON.parse(
    fs.readFileSync(
      path.join(FIXTURE_DIRECTORY, "..", "..", "..", "profile", "resume-base.json"),
      "utf8",
    ),
  );
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

test("resume generation repairs new-number rewrites after retry", async (t) => {
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "boss-resume-new-number-repair-"),
  );
  t.after(() =>
    fs.rmSync(outputDirectory, { recursive: true, force: true }),
  );
  const resumeBase = JSON.parse(
    fs.readFileSync(
      path.join(FIXTURE_DIRECTORY, "..", "..", "..", "profile", "resume-base.json"),
      "utf8",
    ),
  );
  const invalid = structuredClone(resumeBase);
  invalid.strengths = [
    `${resumeBase.strengths[0]} 0`,
    ...resumeBase.strengths.slice(1),
  ];
  invalid.skills = resumeBase.skills.map((skill, index) =>
    index === 0 ? { ...skill, desc: `${skill.desc} 99` } : skill,
  );
  let calls = 0;

  const result = await genResume(fixture("good-match"), {
    resumeBase,
    outputDirectory,
    chatFn: async () => {
      calls += 1;
      return structuredClone(invalid);
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.resume.strengths[0], resumeBase.strengths[0]);
  assert.equal(result.resume.skills[0].desc, resumeBase.skills[0].desc);
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
    /greet_short must contain 40-120/,
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
  const base = JSON.parse(
    fs.readFileSync(
      path.join(FIXTURE_DIRECTORY, "..", "..", "..", "profile", "resume-base.json"),
      "utf8",
    ),
  );
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
