import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase, upsertJob, updateJobStatus, getJob, setMeta } from "../src/db.js";
import { runResearchBackfill } from "../src/workflows.js";

function seedGreetedJob(db, { id, company }) {
  upsertJob(db, { id, url: `https://www.zhipin.com/job_detail/${id}.html`, company, title: "AI实习" });
  updateJobStatus(db, id, "queued");
  updateJobStatus(db, id, "greeted");
}

test("research backfill persists company_score without changing status", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  seedGreetedJob(db, { id: "j1", company: "好公司" });

  const result = await runResearchBackfill({
    db,
    page: {},
    researchFn: async () => ({ company_score: 78, red_flags: [], bait_and_switch: { value: false } }),
    output: () => {},
  });

  assert.equal(result.researched, 1);
  assert.equal(result.rejected, 0);
  const job = getJob(db, "j1");
  assert.equal(job.status, "greeted"); // 状态不变
  assert.equal(job.company_score, 78);
  assert.match(job.research_json, /78/);
});

test("research backfill flags a bait company and researches each company once", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  seedGreetedJob(db, { id: "a1", company: "挂羊头中介" });
  seedGreetedJob(db, { id: "a2", company: "挂羊头中介" }); // 同公司第二岗
  seedGreetedJob(db, { id: "b1", company: "正经公司" });

  let calls = 0;
  const result = await runResearchBackfill({
    db,
    page: {},
    researchFn: async (_db, _page, job) => {
      calls += 1;
      return job.company === "挂羊头中介"
        ? { company_score: 20, red_flags: ["在招清一色销售"], bait_and_switch: { value: true, reason: "劳务中介伪装" } }
        : { company_score: 65, red_flags: [], bait_and_switch: { value: false } };
    },
    output: () => {},
  });

  assert.equal(calls, 2); // 两家公司各调一次 (同公司去重)
  assert.equal(result.rejected, 1);
  // 同公司两个岗位都回填
  assert.equal(getJob(db, "a1").company_score, 20);
  assert.equal(getJob(db, "a2").company_score, 20);
  assert.equal(getJob(db, "a1").status, "greeted");
});

test("research backfill skips when circuit is open", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  seedGreetedJob(db, { id: "c1", company: "任意" });
  setMeta(db, "circuit_open", "2026-07-04 10:00:00");

  let launched = false;
  const result = await runResearchBackfill({
    db,
    now: new Date("2026-07-04T11:00:00"),
    browserFactory: async () => {
      launched = true;
      throw new Error("should not launch");
    },
    researchFn: async () => ({ company_score: 1, red_flags: [], bait_and_switch: { value: false } }),
    output: () => {},
  });

  assert.equal(result.skipped, "circuit_open");
  assert.equal(launched, false);
});
