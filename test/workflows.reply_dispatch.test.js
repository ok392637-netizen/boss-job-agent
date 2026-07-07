import assert from "node:assert/strict";
import test from "node:test";
import {
  createPendingAction,
  getConversationByKey,
  getMeta,
  listMessages,
  listPendingActions,
  openDatabase,
  saveScreenResult,
  updateJobStatus,
  upsertConversation,
  upsertJob,
} from "../src/db.js";
import { pendingActionCode } from "../src/boss/pending_actions.js";
import { runChat } from "../src/workflows.js";

test("runChat shadow mode turns routine HR replies into pending Lark drafts", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const job = greetedJob(db, {
    id: "job-shadow",
    title: "AI Agent 实习生",
    company: "影子科技",
  });
  const notifications = [];
  const sentReplies = [];

  const result = await runChat({
    db,
    page: fakePage(),
    listFn: async () => [
      conversationFixture({
        bossConvKey: "conv-shadow",
        company: job.company,
        jobTitle: job.title,
        lastMsgText: "可以介绍一下项目吗？",
      }),
    ],
    readFn: async () => [
      { role: "hr", text: "可以介绍一下项目吗？", sentLabel: "shadow-1" },
    ],
    classifyAndDraftFn: async () => routineDraft(),
    sendReplyFn: async (_page, options) => sentReplies.push(options),
    notifyTextFn: async (text) => notifications.push(text),
    larkFetchFn: async () => [],
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  const conversation = getConversationByKey(db, "conv-shadow");
  const [message] = listMessages(db, conversation.id);
  const [pending] = listPendingActions(db, { status: "pending" });
  assert.equal(result.pendingReplies, 1);
  assert.equal(result.autoReplies, 0);
  assert.equal(message.action_taken, "reply_pending");
  assert.equal(pending.type, "reply_draft");
  assert.equal(pending.payload.tier, "routine");
  assert.equal(pending.payload.draftText, "您好，可以结合岗位要求继续补充项目细节。");
  assert.equal(sentReplies.length, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /确认 \d{6}/);
});

test("runChat auto-sends routine replies only when shadow is off and autoRoutine is on", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const job = greetedJob(db, {
    id: "job-auto",
    title: "AI 应用实习生",
    company: "自动科技",
  });
  const sentReplies = [];

  const result = await runChat({
    db,
    page: fakePage(),
    replyConfig: { shadowMode: false, autoRoutine: true, maxAutoPerRun: 3 },
    listFn: async () => [
      conversationFixture({
        bossConvKey: "conv-auto",
        company: job.company,
        jobTitle: job.title,
        lastMsgText: "你做过哪些项目？",
      }),
    ],
    readFn: async () => [
      { role: "hr", text: "你做过哪些项目？", sentLabel: "auto-1" },
    ],
    classifyAndDraftFn: async () => routineDraft(),
    sendReplyFn: async (_page, options) => {
      sentReplies.push(options);
      return { dryRun: false, sent: true, plannedSteps: ["reply sent"] };
    },
    notifyTextFn: async () => {
      throw new Error("routine auto-send should not push a Lark draft");
    },
    larkFetchFn: async () => [],
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  const conversation = getConversationByKey(db, "conv-auto");
  const [message] = listMessages(db, conversation.id);
  assert.equal(result.autoReplies, 1);
  assert.equal(result.pendingReplies, 0);
  assert.equal(message.action_taken, "auto_replied");
  assert.equal(sentReplies.length, 1);
  assert.equal(sentReplies[0].text, "您好，可以结合岗位要求继续补充项目细节。");
  assert.equal(sentReplies[0].dryRun, false);
  assert.deepEqual(listPendingActions(db, { status: "pending" }), []);
});

test("runChat reconciles approved Lark confirmations before reading new messages", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const conversation = upsertConversation(db, {
    bossConvKey: "conv-approved",
    hrName: "陈经理",
    company: "确认科技",
    jobTitle: "AI Agent 实习生",
  });
  const pending = createPendingAction(db, {
    convId: conversation.id,
    type: "reply_draft",
    payload: {
      conversation: {
        bossConvKey: "conv-approved",
        hrName: "陈经理",
        company: "确认科技",
        jobTitle: "AI Agent 实习生",
      },
      draftText: "这是待确认草稿。",
    },
  });
  const code = pendingActionCode(pending.id);
  const sentReplies = [];
  let listed = false;

  const result = await runChat({
    db,
    page: fakePage(),
    listFn: async () => {
      listed = true;
      return [];
    },
    readFn: async () => {
      throw new Error("no conversations should be opened");
    },
    larkFetchFn: async () => [{ text: `确认 ${code}`, ts: 1 }],
    sendReplyFn: async (_page, options) => {
      sentReplies.push(options);
      return { dryRun: true, sent: false, plannedSteps: ["approved dry-run"] };
    },
    notifyTextFn: async () => {},
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  const [approved] = listPendingActions(db, { status: "approved" });
  assert.equal(listed, true);
  assert.equal(result.reconciledApproved, 1);
  assert.equal(sentReplies.length, 1);
  assert.equal(sentReplies[0].conversation.bossConvKey, "conv-approved");
  assert.equal(sentReplies[0].text, "这是待确认草稿。");
  assert.equal(approved.payload.replySendResult.plannedSteps[0], "approved dry-run");
});

test("runChat enforces max auto replies per run and moves overflow to pending", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const jobs = Array.from({ length: 4 }, (_, index) =>
    greetedJob(db, {
      id: `job-limit-${index}`,
      title: "AI 实习生",
      company: `限额科技${index}`,
    }),
  );
  const sentReplies = [];
  const notifications = [];

  const result = await runChat({
    db,
    page: fakePage(),
    now: new Date("2026-07-05T10:00:00"),
    replyConfig: { shadowMode: false, autoRoutine: true, maxAutoPerRun: 2 },
    listFn: async () =>
      jobs.map((job, index) =>
        conversationFixture({
          bossConvKey: `conv-limit-${index}`,
          company: job.company,
          jobTitle: job.title,
          lastMsgText: `问题 ${index}`,
          lastMsgTimeLabel: `11:0${index}`,
        }),
      ),
    readFn: async (_page, key) => [
      { role: "hr", text: `问题 ${key.at(-1)}`, sentLabel: `${key}-m` },
    ],
    classifyAndDraftFn: async () => routineDraft(),
    sendReplyFn: async (_page, options) => {
      sentReplies.push(options);
      return { dryRun: false, sent: true, plannedSteps: ["limited sent"] };
    },
    notifyTextFn: async (text) => notifications.push(text),
    larkFetchFn: async () => [],
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  assert.equal(result.autoReplies, 2);
  assert.equal(result.pendingReplies, 2);
  assert.equal(sentReplies.length, 2);
  assert.equal(listPendingActions(db, { status: "pending" }).length, 2);
  assert.equal(getMeta(db, "reply_auto_count_2026-07-05"), "2");
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) =>
      listMessages(db, getConversationByKey(db, `conv-limit-${index}`).id)[0]
        .action_taken,
    ),
    ["auto_replied", "auto_replied", "reply_pending", "reply_pending"],
  );
  assert.equal(notifications.length, 2);
});

test("runChat marks noise replies as skipped without pending or sending", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const job = greetedJob(db, {
    id: "job-noise",
    title: "AI 实习生",
    company: "噪声科技",
  });
  const sentReplies = [];

  const result = await runChat({
    db,
    page: fakePage(),
    listFn: async () => [
      conversationFixture({
        bossConvKey: "conv-noise",
        company: job.company,
        jobTitle: job.title,
        lastMsgText: "暂时不合适",
      }),
    ],
    readFn: async () => [
      { role: "hr", text: "暂时不合适", sentLabel: "noise-1" },
    ],
    classifyAndDraftFn: async () => ({
      tier: "noise",
      draft: { intent: "rejection", proposedReply: "" },
      requiresConfirm: true,
    }),
    sendReplyFn: async (_page, options) => sentReplies.push(options),
    notifyTextFn: async () => {
      throw new Error("noise should not notify");
    },
    larkFetchFn: async () => [],
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  const conversation = getConversationByKey(db, "conv-noise");
  const [message] = listMessages(db, conversation.id);
  assert.equal(result.noiseReplies, 1);
  assert.equal(message.action_taken, "reply_noise");
  assert.equal(sentReplies.length, 0);
  assert.deepEqual(listPendingActions(db, { status: "pending" }), []);
});

function routineDraft() {
  return {
    tier: "routine",
    draft: {
      intent: "screening_question",
      proposedReply: "您好，可以结合岗位要求继续补充项目细节。",
    },
    requiresConfirm: true,
  };
}

function fakePage() {
  return {
    gotos: [],
    async goto(url) {
      this.gotos.push(url);
    },
    url() {
      return this.gotos.at(-1) ?? "about:blank";
    },
  };
}

function conversationFixture(patch = {}) {
  return {
    bossConvKey: "conv-fixture",
    hrName: "陈经理",
    company: "测试公司",
    jobTitle: "AI 实习生",
    lastMsgText: "可以聊聊项目吗？",
    lastMsgTimeLabel: "11:00",
    ...patch,
  };
}

function greetedJob(db, { id, title, company }) {
  const job = upsertJob(db, {
    id,
    url: `https://example.test/${id}`,
    title,
    company,
  });
  saveScreenResult(db, job.id, {
    score: 90,
    bait: false,
    verdict: "pass",
  });
  return updateJobStatus(db, job.id, "greeted");
}
