import assert from "node:assert/strict";
import test from "node:test";
import {
  getCompanyIntel,
  getJob,
  openDatabase,
  saveCompanyIntel,
} from "../src/db.js";
import { evaluateCompany } from "../src/research/evaluate.js";
import { countMaterialCharacters, genMaterials } from "../src/pipeline/materials.js";
import { researchCompany, runScan } from "../src/workflows.js";

const GOOD_JOB = Object.freeze({
  id: "good-job",
  url: "https://example.test/jobs/good-job",
  title: "AI Agent 实习生",
  company: "广州智流科技有限公司",
  salary: "3-5K",
  city: "广州",
  jd: "岗位要求：熟悉 n8n 自动化流程，能够进行 prompt 调优和 Agent 工作流搭建。",
});

test("evaluateCompany treats degraded search and tyc as missing information", async () => {
  let prompt = "";
  const result = await evaluateCompany(
    {
      boss: {
        data: {
          jobsPosted: [
            { title: "AI Agent 实习生", salary: "3-5K" },
            { title: "电话销售", salary: "8-12K" },
          ],
        },
        degraded: false,
      },
      search: { data: [], degraded: true, reason: "baidu_security_or_captcha" },
      tyc: { data: null, degraded: true, reason: "tyc_login_or_captcha" },
      degraded: ["search", "tyc"],
    },
    GOOD_JOB,
    {
      chatFn: async (messages) => {
        prompt = messages.at(-1).content;
        return {
          company_score: 78,
          red_flags: [],
          bait_and_switch: { value: false, reason: "" },
          style_hint: "初创技术",
          summary: "搜索和工商层降级，只按 Boss 站内岗位画像保守评估。",
        };
      },
    },
  );

  assert.match(prompt, /信息缺失/);
  assert.match(prompt, /不得因为.*降级.*扣分/s);
  assert.equal(result.company_score, 78);
  assert.equal(result.bait_and_switch.value, false);
  assert.equal(result.style_hint, "初创技术");
});

test("researchCompany reuses a fresh company_intel eval cache", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  saveCompanyIntel(db, GOOD_JOB.company, {
    evalJson: {
      company_score: 82,
      red_flags: [],
      bait_and_switch: { value: false, reason: "" },
      style_hint: "初创技术",
      summary: "cached",
    },
    degraded: "search,tyc",
  });

  const result = await researchCompany(db, null, GOOD_JOB, {
    fetchBossFn: async () => {
      throw new Error("cache miss should not fetch Boss");
    },
    searchFn: async () => {
      throw new Error("cache miss should not search Baidu");
    },
    tycFn: async () => {
      throw new Error("cache miss should not fetch TYC");
    },
  });

  assert.equal(result.company_score, 82);
  assert.equal(result.summary, "cached");
});

test("runScan filters stale HR activity before detail fetch", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  let fetchCalls = 0;

  const result = await runScan({
    db,
    page: {},
    queries: ["AI Agent"],
    searchFn: async () => [
      {
        id: "inactive-hr",
        url: "https://example.test/jobs/inactive-hr",
        title: "AI Agent 实习生",
        company: "广州慢回复科技有限公司",
        salary: "3-5K",
        hrName: "鞠峰\n1年前活跃",
      },
    ],
    fetchFn: async () => {
      fetchCalls += 1;
      throw new Error("inactive HR should not fetch detail");
    },
    notifyFn: async () => {},
    output: () => {},
  });

  const job = getJob(db, "inactive-hr");
  assert.equal(fetchCalls, 0);
  assert.equal(result.rejected, 1);
  assert.equal(job.status, "screened_out");
  assert.equal(job.hr_name, "鞠峰");
  assert.equal(job.hr_active, "1年前活跃");
  assert.match(job.screen_json, /HR不活跃/);
});

test("runScan applies company research after JD screening", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const materialsSeen = [];
  const resumeSeen = [];

  const result = await runScan({
    db,
    page: { context: () => ({ newPage: async () => ({ close: async () => {} }) }) },
    queries: ["AI Agent"],
    searchFn: async () => [
      { ...GOOD_JOB, id: "company-risk", company: "广州挂羊头科技有限公司", jd: "" },
      { ...GOOD_JOB, id: "company-pass", company: "广州智流科技有限公司", jd: "" },
    ],
    fetchFn: async (job) => ({ ...job, jd: GOOD_JOB.jd }),
    screenFn: async () => ({
      score: 86,
      bait: false,
      bait_reason: "",
      match_reasons: ["JD match"],
      concerns: [],
      verdict: "pass",
    }),
    researchFn: async (_db, _page, job) =>
      job.id === "company-risk"
        ? {
            company_score: 35,
            red_flags: [
              {
                type: "岗位画像矛盾",
                severity: "high",
                reason: "在招岗位销售占比过高",
                evidence: "Boss 在招岗位：电话销售、地推",
              },
            ],
            bait_and_switch: { value: false, reason: "" },
            style_hint: "未知",
            summary: "company risk",
          }
        : {
            company_score: 72,
            red_flags: [],
            bait_and_switch: { value: false, reason: "" },
            style_hint: "初创技术",
            summary: "company pass",
          },
    materialsFn: async (job) => {
      materialsSeen.push({ id: job.id, styleHint: job.styleHint });
      return { greetShort: "ok", introLong: "ok" };
    },
    resumeFn: async (job) => {
      resumeSeen.push(job.id);
      return { resumePath: `data/resumes/${job.id}.docx` };
    },
    delayFn: async () => 0,
    notifyFn: async () => {},
    output: () => {},
  });

  assert.equal(result.rejected, 1);
  assert.equal(result.passed, 1);
  assert.equal(getJob(db, "company-risk").status, "screened_out");
  assert.equal(getJob(db, "company-risk").company_score, 35);
  assert.match(getJob(db, "company-risk").research_json, /company risk/);
  assert.equal(getJob(db, "company-pass").status, "queued");
  assert.equal(getJob(db, "company-pass").company_score, 72);
  assert.deepEqual(materialsSeen, [
    { id: "company-pass", styleHint: "初创技术" },
  ]);
  assert.deepEqual(resumeSeen, ["company-pass"]);
});

test("genMaterials v2 retries template openings and missing JD keywords", async () => {
  const intro = `n8n 项目选题效率提升 40%。${"我把业务流程拆成自动化工作流并持续复盘。".repeat(38)}`;
  const validGreet =
    "n8n抖音热点自动化项目和JD里的prompt调优、Agent工作流要求贴合，我能把流程拆成可执行节点并快速迭代。";
  const prompts = [];
  let calls = 0;

  const result = await genMaterials(GOOD_JOB, {
    profileText: "n8n 抖音热点自动化监控系统，选题效率提升 40%。",
    chatFn: async (messages) => {
      prompts.push(messages.at(-1).content);
      calls += 1;
      return calls === 1
        ? {
            greet_short: "您好我是罗其立，看到贵司岗位很感兴趣。",
            intro_long: intro,
          }
        : {
            greet_short: validGreet,
            intro_long: intro,
          };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.greetShort, validGreet);
  assert.ok(countMaterialCharacters(result.greetShort) <= 120);
  assert.match(prompts[0], /120/);
  assert.match(prompts[0], /style_hint/);
  assert.match(prompts[1], /模板腔开头|JD keyword|project keyword/);
});
