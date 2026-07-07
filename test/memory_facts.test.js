import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { readProjectFacts } from "../src/modules/memory_facts.js";

function createMemoFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-memo-facts-"));
  const dbPath = path.join(directory, "memo.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      pinned INTEGER DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(
      title, content, tags,
      content='memories', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db, dbPath };
}

function insertMemory(db, { title, content, tags, archived = 0 }) {
  const info = db.prepare(`
    INSERT INTO memories (scope, type, title, content, tags, archived)
    VALUES ('personal', 'fact', @title, @content, @tags, @archived)
  `).run({ title, content, tags, archived });
  db.prepare(`
    INSERT INTO memory_fts(rowid, title, content, tags)
    VALUES (@rowid, @title, @content, @tags)
  `).run({ rowid: info.lastInsertRowid, title, content, tags });
}

test("readProjectFacts reads FTS hits and extracts project facts for deep_resume", (t) => {
  const { db, dbPath } = createMemoFixture(t);
  insertMemory(db, {
    title: "罗其立个人经历档案",
    tags: "job-hunting,resume,profile",
    content: `
## 项目经历
1. **boss-job-agent** (个人项目, 2026.06-2026.07): 岗位筛选、JD 评估、简历定制、沟通辅助; 12 个真实岗位全部成功定制化打招呼
   - 支持 HR 回复触发简历定制。
2. **基于 n8n 的抖音热点自动化监控系统** (个人, 2025.09-2026.01): n8n 全链路 + AI 生成报告推送; 选题效率提升 40%, 数据响应缩短至 10 分钟内
`,
  });
  insertMemory(db, {
    title: "无关烹饪笔记",
    tags: "cooking",
    content: "## 项目经历\n1. **烘焙实验**: 与求职无关。",
  });

  const facts = readProjectFacts({
    dbPath,
    query: "job-hunting profile boss-job-agent",
    limit: 8,
  });

  assert.equal(facts.length, 2);
  assert.equal(facts[0].title, "罗其立个人经历档案");
  assert.deepEqual(facts[0].tags, ["job-hunting", "resume", "profile"]);
  assert.equal(facts[0].name, "boss-job-agent");
  assert.deepEqual(facts[0].metrics, ["12 个真实岗位全部成功定制化打招呼"]);
  assert.ok(facts[0].facts.some((item) => item.includes("HR 回复触发简历定制")));
  assert.deepEqual(facts[0].bullets, facts[0].facts);

  const n8n = facts.find((item) => item.name.includes("n8n"));
  assert.ok(n8n);
  assert.deepEqual(n8n.metrics, [
    "选题效率提升 40%, 数据响应缩短至 10 分钟内",
  ]);
  assert.equal(n8n.period, "2025.09-2026.01");
});

test("readProjectFacts honors limit and ignores archived memories", (t) => {
  const { db, dbPath } = createMemoFixture(t);
  insertMemory(db, {
    title: "已归档素材",
    tags: "job-hunting,profile",
    archived: 1,
    content: "## 项目经历\n1. **旧项目**: 不应返回。",
  });
  insertMemory(db, {
    title: "新素材",
    tags: "job-hunting,profile",
    content: "## 项目经历\n1. **AI 记忆系统后端开发** (Java, 2026.01-2026.06): 支持多轮交互信息记录、读取和调用。",
  });

  const facts = readProjectFacts({ dbPath, query: "job-hunting", limit: 1 });

  assert.equal(facts.length, 1);
  assert.equal(facts[0].name, "AI 记忆系统后端开发");
});

test("readProjectFacts degrades to empty array when memo db cannot be opened", () => {
  const missingPath = path.join(os.tmpdir(), "missing-claude-memo.sqlite");
  assert.deepEqual(readProjectFacts({ dbPath: missingPath }), []);
});
