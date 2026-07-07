import assert from "node:assert/strict";
import test from "node:test";
import {
  createPendingAction,
  listPendingActions,
  openDatabase,
  upsertConversation,
} from "../src/db.js";
import {
  pendingActionCode,
  pushPendingToLark,
  reconcilePendingFromLark,
} from "../src/boss/pending_actions.js";
import { fetchRecentUserBotMessages } from "../src/boss/lark_inbox.js";

function createPendingFixture(t, { createdAt = null } = {}) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const conversation = upsertConversation(db, {
    bossConvKey: "boss-conv-1",
    jobId: "job-1",
    hrName: "陈经理",
    company: "测试科技",
    jobTitle: "AI Agent 实习生",
  });
  const pending = createPendingAction(db, {
    convId: conversation.id,
    type: "reply_draft",
    payload: {
      conversation: {
        bossConvKey: "boss-conv-1",
        hrName: "陈经理",
        company: "测试科技",
        jobTitle: "AI Agent 实习生",
      },
      draftText: "您好，我做过 boss-job-agent，可结合岗位继续补充项目细节。",
    },
  });
  if (createdAt) {
    db.prepare("UPDATE pending_actions SET created_at = ? WHERE id = ?").run(
      createdAt,
      pending.id,
    );
    return { db, pending: listPendingActions(db, { status: "pending" })[0] };
  }
  return { db, pending };
}

test("pushPendingToLark sends draft text with short confirmation code and commands", async (t) => {
  const { pending } = createPendingFixture(t);
  const sent = [];

  const result = await pushPendingToLark(pending, {
    notifyFn: async (text) => {
      sent.push(text);
      return { ok: true };
    },
  });

  const code = pendingActionCode(pending.id);
  assert.equal(result.code, code);
  assert.equal(sent.length, 1);
  assert.match(sent[0], new RegExp(`确认 ${code}`));
  assert.match(sent[0], new RegExp(`改 ${code} <新内容>`));
  assert.match(sent[0], /忽略/);
  assert.match(sent[0], /boss-conv-1/);
  assert.match(sent[0], /陈经理/);
  assert.match(sent[0], /boss-job-agent/);
});

test("reconcilePendingFromLark approves a matching confirmation code", async (t) => {
  const { db, pending } = createPendingFixture(t);
  const code = pendingActionCode(pending.id);

  const summary = await reconcilePendingFromLark({
    db,
    larkFetchFn: async () => [{ text: `确认 ${code}`, ts: 1 }],
  });

  assert.equal(summary.approved, 1);
  const [approved] = listPendingActions(db, { status: "approved" });
  assert.equal(approved.id, pending.id);
  assert.equal(approved.payload.approvedText, pending.payload.draftText);
  assert.equal(approved.payload.decision.command, "confirm");
});

test("reconcilePendingFromLark approves edited content for 改 commands", async (t) => {
  const { db, pending } = createPendingFixture(t);
  const code = pendingActionCode(pending.id);

  await reconcilePendingFromLark({
    db,
    larkFetchFn: async () => [{ text: `改 ${code} 新的回复内容`, ts: 1 }],
  });

  const [approved] = listPendingActions(db, { status: "approved" });
  assert.equal(approved.id, pending.id);
  assert.equal(approved.payload.approvedText, "新的回复内容");
  assert.equal(approved.payload.decision.command, "edit");
});

test("reconcilePendingFromLark rejects ignored pending actions", async (t) => {
  const { db, pending } = createPendingFixture(t);
  const code = pendingActionCode(pending.id);

  const summary = await reconcilePendingFromLark({
    db,
    larkFetchFn: async () => [{ text: `忽略 ${code}`, ts: 1 }],
  });

  assert.equal(summary.rejected, 1);
  const [rejected] = listPendingActions(db, { status: "rejected" });
  assert.equal(rejected.id, pending.id);
  assert.equal(rejected.payload.decision.command, "ignore");
});

test("reconcilePendingFromLark ignores unmatched confirmation codes", async (t) => {
  const { db, pending } = createPendingFixture(t);

  const summary = await reconcilePendingFromLark({
    db,
    larkFetchFn: async () => [{ text: "确认 999999", ts: 1 }],
  });

  assert.equal(summary.approved, 0);
  assert.equal(summary.ignored, 1);
  assert.deepEqual(listPendingActions(db, { status: "pending" }).map((row) => row.id), [
    pending.id,
  ]);
});

test("reconcilePendingFromLark expires pending actions older than 24h and reminds once", async (t) => {
  const { db, pending } = createPendingFixture(t, {
    createdAt: "2026-07-04 00:00:00",
  });
  const reminders = [];

  const summary = await reconcilePendingFromLark({
    db,
    now: new Date("2026-07-05T01:00:01"),
    larkFetchFn: async () => [],
    notifyFn: async (text) => reminders.push(text),
  });

  assert.equal(summary.expired, 1);
  const [expired] = listPendingActions(db, { status: "expired" });
  assert.equal(expired.id, pending.id);
  assert.equal(expired.payload.expiredReminderSent, true);
  assert.equal(reminders.length, 1);
  assert.match(reminders[0], /已超时/);
});

test("fetchRecentUserBotMessages degrades to [] when lark-cli is unavailable", async () => {
  const messages = await fetchRecentUserBotMessages({
    execFileFn: async () => {
      const error = new Error("not found");
      error.code = "ENOENT";
      throw error;
    },
  });

  assert.deepEqual(messages, []);
});
