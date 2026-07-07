import assert from "node:assert/strict";
import test from "node:test";
import {
  createPendingAction,
  getConversationMessages,
  insertMessage,
  listPendingActions,
  openDatabase,
  resolvePendingAction,
  upsertConversation,
} from "../src/db.js";
import { classifyAndDraft } from "../src/pipeline/reply_pipeline.js";

const job = Object.freeze({
  id: "job-reply-1",
  title: "AI Agent 实习生",
  company: "测试科技",
  city: "广州",
  research_json: JSON.stringify({
    strategy: {
      positioning: "AI Agent 求职自动化实践者",
      selected_projects: ["boss-job-agent"],
    },
  }),
});

const memoryFacts = Object.freeze([
  {
    name: "boss-job-agent",
    tag: "个人项目",
    period: "2026.06-2026.07",
    facts: ["支持 HR 回复触发简历定制和沟通辅助。"],
    metrics: [],
    bullets: ["支持 HR 回复触发简历定制和沟通辅助。"],
  },
]);

function draftForIntent(intent) {
  return {
    intent,
    confidence: 0.91,
    send_resume: intent === "ask_resume",
    notify_user: false,
    requires_user_decision: false,
    proposed_reply: "可以的，我这边方便继续沟通，也可以结合岗位要求补充项目经验。",
    questions_for_user: [],
    lark_notice: { title: "", body: "", priority: "normal" },
  };
}

test("classifyAndDraft maps HR intents to reply tiers", async () => {
  const cases = [
    ["interview_invite", "interview"],
    ["salary_or_availability", "sensitive"],
    ["screening_question", "routine"],
    ["other", "routine"],
    ["ask_resume", "routine"],
    ["spam_or_sales", "noise"],
    ["rejection", "noise"],
  ];

  for (const [intent, expectedTier] of cases) {
    const result = await classifyAndDraft(job, {
      reply: "请问你现在方便沟通吗？",
      shadowMode: false,
      chatFn: async () => draftForIntent(intent),
    });

    assert.equal(result.tier, expectedTier, intent);
    assert.equal(result.draft.intent, intent);
  }
});

test("classifyAndDraft forces confirmation for interview and shadow routine drafts", async () => {
  const interview = await classifyAndDraft(job, {
    reply: "明天下午来面试可以吗？",
    shadowMode: false,
    chatFn: async () => draftForIntent("interview_invite"),
  });
  assert.equal(interview.tier, "interview");
  assert.equal(interview.requiresConfirm, true);

  const routineShadow = await classifyAndDraft(job, {
    reply: "你做过哪些 Agent 项目？",
    shadowMode: true,
    chatFn: async () => draftForIntent("screening_question"),
  });
  assert.equal(routineShadow.tier, "routine");
  assert.equal(routineShadow.requiresConfirm, true);
});

test("classifyAndDraft assembles conversation, memory facts, profile and resume strategy context", async () => {
  let prompt = "";
  const result = await classifyAndDraft(job, {
    reply: "能介绍一个相关项目吗？",
    conversationHistory: [
      { role: "me", text: "您好，我对 AI Agent 岗位感兴趣。" },
      { role: "hr", text: "我们更看重落地经验。" },
    ],
    profileText: "个人档案: AI Agent / 自动化工作流。",
    memoryFacts,
    shadowMode: false,
    chatFn: async (messages, options) => {
      assert.equal(options.json, true);
      prompt = messages.at(-1).content;
      return draftForIntent("screening_question");
    },
  });

  assert.equal(result.tier, "routine");
  assert.match(prompt, /您好，我对 AI Agent 岗位感兴趣/);
  assert.match(prompt, /boss-job-agent/);
  assert.match(prompt, /个人档案: AI Agent/);
  assert.match(prompt, /AI Agent 求职自动化实践者/);
});

test("classifyAndDraft treats contact and offline asks as sensitive even when intent is other", async () => {
  const result = await classifyAndDraft(job, {
    reply: "加个微信吧，或者线下聊一下。",
    shadowMode: false,
    chatFn: async () => draftForIntent("other"),
  });

  assert.equal(result.tier, "sensitive");
  assert.equal(result.requiresConfirm, true);
});

test("classifyAndDraft reuses hr_reply_agent validation for unsafe contact replies", async () => {
  await assert.rejects(
    () =>
      classifyAndDraft(job, {
        reply: "发份简历看看",
        shadowMode: false,
        chatFn: async () => ({
          ...draftForIntent("ask_resume"),
          proposed_reply: "可以，电话 13800138000，邮箱 resume@example.com。",
        }),
      }),
    /must not include contact info/,
  );
});

test("database helpers read recent conversation messages and manage pending actions", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());

  const conversation = upsertConversation(db, {
    bossConvKey: "conv-reply",
    jobId: "job-reply-1",
    hrName: "陈经理",
    company: "测试科技",
    jobTitle: "AI Agent 实习生",
  });
  insertMessage(db, conversation.id, { role: "me", text: "第一条" });
  insertMessage(db, conversation.id, { role: "hr", text: "第二条" });
  insertMessage(db, conversation.id, { role: "me", text: "第三条" });

  assert.deepEqual(
    getConversationMessages(db, conversation.id, { limit: 2 }).map((row) => row.text),
    ["第二条", "第三条"],
  );

  const pending = createPendingAction(db, {
    convId: conversation.id,
    type: "reply_draft",
    payload: {
      draftText: "您好，可以继续沟通。",
      conversation: { bossConvKey: "conv-reply", hrName: "陈经理" },
    },
  });

  assert.equal(pending.status, "pending");
  assert.equal(pending.payload.draftText, "您好，可以继续沟通。");
  assert.deepEqual(listPendingActions(db, { status: "pending" }).map((row) => row.id), [
    pending.id,
  ]);

  const resolved = resolvePendingAction(db, pending.id, {
    status: "approved",
    payloadPatch: { approvedText: "改写后的内容" },
  });
  assert.equal(resolved.status, "approved");
  assert.ok(resolved.resolved_at);
  assert.equal(resolved.payload.approvedText, "改写后的内容");
  assert.deepEqual(listPendingActions(db, { status: "pending" }), []);
});
