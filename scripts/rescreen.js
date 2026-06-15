// 用新的(放宽的)筛选标准 + 更新后的画像, 对已抓取入库的 screened_out 岗位重新筛选。
// 纯本地: JD 已在 db, 不访问 Boss。通过的生成定制招呼语/介绍/简历并转入 queued。
import { config } from "../src/config.js";
import {
  openDatabase,
  getJob,
  saveScreenResult,
  saveMaterials,
  saveResumePath,
} from "../src/db.js";
import { screenJob } from "../src/pipeline/screen.js";
import { genMaterials } from "../src/pipeline/materials.js";
import { genResume } from "../src/pipeline/resume.js";

const db = openDatabase();
const SELECT = "SELECT * FROM jobs WHERE status='screened_out' AND jd IS NOT NULL AND jd != ''";
const targets = db.prepare(SELECT).all();
console.log(`重筛 ${targets.length} 个 screened_out 岗位 (passScore=${config.screening.passScore})...\n`);

// 重置为 discovered 以允许重新进入 queued (状态机不许 screened_out->queued; 重筛是有意重置, 裸 SQL)
db.prepare(
  "UPDATE jobs SET status='discovered', score=NULL, screen_json=NULL WHERE status='screened_out' AND jd IS NOT NULL AND jd != ''",
).run();

let pass = 0;
let reject = 0;
let err = 0;
for (const target of targets) {
  const job = getJob(db, target.id);
  try {
    const screen = await screenJob(job);
    saveScreenResult(db, job.id, screen); // discovered -> queued | screened_out
    if (screen.verdict === "pass" && !screen.bait) {
      const materials = await genMaterials(job);
      saveMaterials(db, job.id, materials);
      const resume = await genResume(job);
      saveResumePath(db, job.id, resume.resumePath);
      pass += 1;
      console.log(`✅ [${screen.score}] ${job.company} | ${job.title}`);
    } else {
      reject += 1;
      const why = screen.bait
        ? `挂羊头: ${screen.bait_reason}`
        : (screen.concerns?.[0] ?? "");
      console.log(`❌ [${screen.score}] ${job.company} | ${job.title} — ${why}`);
    }
  } catch (error) {
    err += 1;
    db.prepare("UPDATE jobs SET status='screened_out' WHERE id=?").run(job.id);
    console.log(`⚠️  ${job.company} | ${job.title}: ${error.message}`);
  }
}
console.log(`\n重筛完成: 通过 ${pass}, 仍拒 ${reject}, 错误 ${err}`);
db.close();
