import assert from "node:assert/strict";
import test from "node:test";
import {
  getConversationByKey,
  insertMessage,
  lastLoginEvent,
  listConversations,
  listMessages,
  openDatabase,
  recordLoginEvent,
  upsertConversation,
} from "../src/db.js";

test("chat tables are created on database open", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversations', 'messages', 'pending_actions', 'login_events') ORDER BY name",
    )
    .all()
    .map((row) => row.name);

  assert.deepEqual(tables, [
    "conversations",
    "login_events",
    "messages",
    "pending_actions",
  ]);
});

test("conversation upsert is idempotent and preserves existing non-null fields", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const first = upsertConversation(db, {
    bossConvKey: "conv-1",
    jobId: "job-1",
    hrName: "陈经理",
    company: "测试公司",
    jobTitle: "AI 应用实习生",
    lastMsgText: "你好",
    lastMsgAt: "昨天",
  });

  const second = upsertConversation(db, {
    bossConvKey: "conv-1",
    lastMsgText: "请发简历",
  });

  assert.equal(second.id, first.id);
  assert.equal(second.job_id, "job-1");
  assert.equal(second.hr_name, "陈经理");
  assert.equal(second.company, "测试公司");
  assert.equal(second.job_title, "AI 应用实习生");
  assert.equal(second.last_msg_text, "请发简历");
  assert.equal(second.last_msg_at, "昨天");
  assert.ok(second.updated_at);
  assert.deepEqual(listConversations(db).map((row) => row.boss_conv_key), [
    "conv-1",
  ]);
  assert.equal(getConversationByKey(db, "conv-1").id, first.id);
});

test("message insertion dedupes by role, text, and sent label per conversation", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const conversation = upsertConversation(db, {
    bossConvKey: "conv-message",
  });

  const first = insertMessage(db, conversation.id, {
    role: "hr",
    text: "请发简历",
    sentLabel: "10:30",
  });
  const duplicate = insertMessage(db, conversation.id, {
    role: "hr",
    text: "请发简历",
    sentLabel: "10:30",
  });
  const differentLabel = insertMessage(db, conversation.id, {
    role: "hr",
    text: "请发简历",
    sentLabel: "10:31",
  });
  const mine = insertMessage(db, conversation.id, {
    role: "me",
    text: "请发简历",
    sentLabel: "10:30",
  });

  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.row.id, first.row.id);
  assert.equal(differentLabel.inserted, true);
  assert.equal(mine.inserted, true);
  assert.deepEqual(
    listMessages(db, conversation.id).map((row) => ({
      role: row.role,
      text: row.text,
      sent_label: row.sent_label,
    })),
    [
      { role: "hr", text: "请发简历", sent_label: "10:30" },
      { role: "hr", text: "请发简历", sent_label: "10:31" },
      { role: "me", text: "请发简历", sent_label: "10:30" },
    ],
  );
});

test("login events are append-only and lastLoginEvent returns the latest", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const expired = recordLoginEvent(db, "expired");
  const recovered = recordLoginEvent(db, "recovered");

  assert.equal(expired.event, "expired");
  assert.equal(recovered.event, "recovered");
  assert.equal(lastLoginEvent(db).id, recovered.id);
  assert.deepEqual(
    db.prepare("SELECT event FROM login_events ORDER BY id").all(),
    [{ event: "expired" }, { event: "recovered" }],
  );
});
