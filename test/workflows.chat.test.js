import assert from "node:assert/strict";
import test from "node:test";
import {
  getConversationByKey,
  getJob,
  insertMessage,
  lastLoginEvent,
  listMessages,
  listPendingActions,
  openDatabase,
  saveJobResearch,
  saveScreenResult,
  saveMaterials,
  updateJobStatus,
  setMeta,
  upsertConversation,
  upsertJob,
} from "../src/db.js";
import {
  linkConversationToJob,
  runChat,
  withoutAlreadyRepliedGroups,
} from "../src/workflows.js";

test("runChat skips unchanged conversations on the second incremental run", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const notifications = [];
  let readCalls = 0;
  const conversation = {
    bossConvKey: "conv-incremental",
    hrName: "陈经理",
    company: "测试公司",
    jobTitle: "AI 应用实习生",
    lastMsgText: "可以聊聊你的项目吗？",
    lastMsgTimeLabel: "11:03",
  };

  const first = await runChat({
    db,
    page: fakePage(),
    listFn: async () => [conversation],
    readFn: async () => {
      readCalls += 1;
      return [
        {
          role: "hr",
          text: "可以聊聊你的项目吗？",
          sentLabel: "m-1",
        },
      ];
    },
    notifyTextFn: async (text) => notifications.push(text),
    classifyAndDraftFn: async () => routineReplyDraft(),
    larkFetchFn: async () => [],
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });
  const second = await runChat({
    db,
    page: fakePage(),
    listFn: async () => [conversation],
    readFn: async () => {
      readCalls += 1;
      return [];
    },
    notifyTextFn: async (text) => notifications.push(text),
    classifyAndDraftFn: async () => routineReplyDraft(),
    larkFetchFn: async () => [],
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  assert.equal(first.opened, 1);
  assert.equal(second.opened, 0);
  assert.equal(readCalls, 1);
  assert.equal(notifications.length, 1);
});

test("runChat persists new HR messages and reuses reply notification semantics", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const job = greetedJob(db, {
    id: "job-chat",
    title: "AI 应用实习生",
    company: "测试公司",
  });
  const notifications = [];

  const result = await runChat({
    db,
    page: fakePage(),
    listFn: async () => [
      {
        bossConvKey: "conv-job-chat",
        hrName: "陈经理",
        company: "测试公司",
        jobTitle: job.title,
        lastMsgText: "请发简历",
        lastMsgTimeLabel: "11:20",
      },
    ],
    readFn: async () => [
      { role: "hr", text: "请发简历", sentLabel: "m-2" },
    ],
    notifyTextFn: async (text) => {
      notifications.push(text);
      return { message_id: "text" };
    },
    classifyAndDraftFn: async () => routineReplyDraft(),
    larkFetchFn: async () => [],
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  assert.equal(result.newHrMessages, 1);
  assert.equal(result.notified, 1);
  assert.equal(result.pendingReplies, 1);
  assert.equal(listMessages(db, 1).length, 1);
  assert.equal(getJob(db, job.id).status, "replied");
  assert.equal(listMessages(db, 1)[0].action_taken, "reply_pending");
  assert.equal(listPendingActions(db, { status: "pending" }).length, 1);
  assert.match(notifications[0], /HR 回复草稿待确认/);
  assert.match(notifications[0], /确认 \d{6}/);
});

test("runChat links opened conversations to jobs before notifying replies", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const job = greetedJob(db, {
    id: "job-direct",
    title: "AI Agent Intern",
    company: "Acme AI",
  });
  saveMaterials(db, job.id, {
    greetShort: "short hello",
    introLong: "long intro for matched job",
  });
  const notifications = [];

  const result = await runChat({
    db,
    page: fakePage(),
    listFn: async () => [
      {
        bossConvKey: "conv-direct",
        hrName: "Chen",
        company: "Acme AI",
        jobTitle: "",
        lastMsgText: "Please send resume",
        lastMsgTimeLabel: "11:20",
      },
    ],
    readFn: async () => ({
      conversation: {
        jobId: "job-direct",
        company: "Acme AI",
        jobTitle: "AI Agent Intern",
      },
      messages: [{ role: "hr", text: "Please send resume", sentLabel: "m-2" }],
    }),
    notifyTextFn: async (text) => {
      notifications.push(text);
      return { message_id: "text" };
    },
    classifyAndDraftFn: async () => routineReplyDraft(),
    larkFetchFn: async () => [],
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  const conversation = getConversationByKey(db, "conv-direct");
  const [message] = listMessages(db, conversation.id);
  assert.equal(result.notified, 1);
  assert.equal(result.pendingReplies, 1);
  assert.equal(conversation.job_id, "job-direct");
  assert.equal(conversation.job_title, "AI Agent Intern");
  assert.equal(message.action_taken, "reply_pending");
  assert.equal(getJob(db, job.id).status, "replied");
  assert.match(notifications[0], /HR 回复草稿待确认/);
});

test("runChat turns linked resume requests into a dry-run customization plan", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const job = greetedJob(db, {
    id: "job-resume-request",
    title: "AI HR Intern",
    company: "Talent AI",
  });
  saveJobResearch(db, job.id, {
    companyScore: 88,
    research: { style_hint: "hr_ai", notes: ["recruiting automation"] },
  });

  const notifications = [];
  const files = [];
  const calls = [];
  const result = await runChat({
    db,
    page: fakePage(),
    listFn: async () => [
      {
        bossConvKey: "conv-resume-request",
        hrName: "Chen",
        company: "Talent AI",
        jobTitle: job.title,
        lastMsgText: "发我简历",
        lastMsgTimeLabel: "11:30",
      },
    ],
    readFn: async () => ({
      conversation: {
        jobId: job.id,
        company: "Talent AI",
        jobTitle: "AI HR Intern",
      },
      messages: [{ role: "hr", text: "发我简历", sentLabel: "m-resume" }],
    }),
    customizeFn: async (customJob, options) => {
      calls.push(["customize", customJob.id, options]);
      assert.equal(customJob.id, job.id);
      assert.deepEqual(options.research, {
        style_hint: "hr_ai",
        notes: ["recruiting automation"],
      });
      assert.deepEqual(options.resumeBase, { name: "Luo Qili" });
      assert.equal(options.profileText, "profile text");
      assert.deepEqual(options.memoryFacts, [
        { name: "boss-job-agent", facts: ["chat-triggered resume"] },
      ]);
      return {
        resumePath: "C:/tmp/luoqili-resume-custom.docx",
        strategy: {
          positioning: "AI x HR automation candidate",
          selectedProjects: ["boss-job-agent"],
          jdKeywords: ["AI HR"],
          companyStyleNotes: ["focus recruiting workflow"],
          riskNotes: [],
        },
      };
    },
    uploadFn: async (_page, filePath, options) => {
      calls.push(["upload", filePath, options]);
      assert.equal(filePath, "C:/tmp/luoqili-resume-custom.docx");
      assert.equal(options.dryRun, true);
      assert.equal(options.approved, false);
      return { dryRun: true, plannedSteps: ["upload dry-run step"] };
    },
    sendResumeFn: async (_page, options) => {
      calls.push(["send", options]);
      assert.equal(options.attachmentName, "luoqili-resume-custom.docx");
      assert.equal(options.conversation.bossConvKey, "conv-resume-request");
      assert.equal(options.dryRun, true);
      assert.equal(options.approved, false);
      return { dryRun: true, plannedSteps: ["send dry-run step"] };
    },
    readProjectFactsFn: () => [
      { name: "boss-job-agent", facts: ["chat-triggered resume"] },
    ],
    resumeBase: { name: "Luo Qili" },
    profileText: "profile text",
    notifyTextFn: async (text) => {
      notifications.push(text);
      return { message_id: "text-resume" };
    },
    notifyFileFn: async (filePath, caption) => {
      files.push({ filePath, caption });
      return { message_id: "file-resume" };
    },
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  const conversation = getConversationByKey(db, "conv-resume-request");
  const [message] = listMessages(db, conversation.id);
  assert.equal(result.newHrMessages, 1);
  assert.equal(result.resumeRequests, 1);
  assert.equal(result.notified, 1);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["customize", "upload", "send"],
  );
  assert.equal(getJob(db, job.id).status, "resume_sent");
  assert.ok(getJob(db, job.id).resume_sent_at);
  assert.equal(message.action_taken, "resume_requested");
  assert.match(notifications[0], /Talent AI/);
  assert.match(notifications[0], /AI HR Intern/);
  assert.match(notifications[0], /AI x HR automation candidate/);
  assert.match(notifications[0], /upload dry-run step/);
  assert.match(notifications[0], /send dry-run step/);
  assert.deepEqual(files, [
    {
      filePath: "C:/tmp/luoqili-resume-custom.docx",
      caption: "定制简历副本: Talent AI | AI HR Intern",
    },
  ]);
});

test("runChat turns non-resume messages into pending reply drafts", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const job = greetedJob(db, {
    id: "job-not-resume",
    title: "AI Ops Intern",
    company: "Ops AI",
  });
  saveMaterials(db, job.id, {
    greetShort: "hello",
    introLong: "normal reply intro",
  });
  const notifications = [];

  const result = await runChat({
    db,
    page: fakePage(),
    listFn: async () => [
      {
        bossConvKey: "conv-not-resume",
        hrName: "Wang",
        company: "Ops AI",
        jobTitle: job.title,
        lastMsgText: "可以聊聊项目吗",
        lastMsgTimeLabel: "11:31",
      },
    ],
    readFn: async () => [
      { role: "hr", text: "可以聊聊项目吗", sentLabel: "m-normal" },
    ],
    customizeFn: async () => {
      throw new Error("customize should not run");
    },
    uploadFn: async () => {
      throw new Error("upload should not run");
    },
    sendResumeFn: async () => {
      throw new Error("send should not run");
    },
    notifyTextFn: async (text) => {
      notifications.push(text);
      return { message_id: "text-normal" };
    },
    classifyAndDraftFn: async () => routineReplyDraft(),
    larkFetchFn: async () => [],
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  assert.equal(result.resumeRequests, 0);
  assert.equal(result.notified, 1);
  assert.equal(result.pendingReplies, 1);
  assert.equal(getJob(db, job.id).status, "replied");
  assert.equal(listMessages(db, 1)[0].action_taken, "reply_pending");
  assert.equal(listPendingActions(db, { status: "pending" }).length, 1);
  assert.match(notifications[0], /HR 回复草稿待确认/);
});

test("runChat degrades resume request notifications when no job is linked", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const notifications = [];

  const result = await runChat({
    db,
    page: fakePage(),
    listFn: async () => [
      {
        bossConvKey: "conv-unlinked-resume",
        hrName: "Li",
        company: "Unknown AI",
        jobTitle: "AI Intern",
        lastMsgText: "请求附件简历",
        lastMsgTimeLabel: "11:32",
      },
    ],
    readFn: async () => [
      { role: "system", text: "请求附件简历", sentLabel: "sys-resume" },
    ],
    customizeFn: async () => {
      throw new Error("customize should not run without a linked job");
    },
    uploadFn: async () => {
      throw new Error("upload should not run without a linked job");
    },
    sendResumeFn: async () => {
      throw new Error("send should not run without a linked job");
    },
    notifyTextFn: async (text) => {
      notifications.push(text);
      return { message_id: "text-unlinked" };
    },
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  assert.equal(result.newHrMessages, 0);
  assert.equal(result.resumeRequests, 1);
  assert.equal(result.notified, 1);
  assert.match(notifications[0], /无法定制/);
  assert.match(notifications[0], /未关联岗位/);
  assert.equal(listMessages(db, 1)[0].action_taken, "resume_requested");
});

test("withoutAlreadyRepliedGroups drops conversations already answered by me", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const conv = upsertConversation(db, { bossConvKey: "c1", hrName: "H", company: "Co" });
  const hrMsg = insertMessage(db, conv.id, { role: "hr", text: "在广州吗" });
  const groups = [{ convId: conv.id, messageIds: [hrMsg.row.id] }];
  // 无我方后续消息 → 保留
  assert.equal(withoutAlreadyRepliedGroups(db, groups).length, 1);
  // 我方已回复(更晚的id) → 过滤掉
  insertMessage(db, conv.id, { role: "me", text: "是的" });
  assert.equal(withoutAlreadyRepliedGroups(db, groups).length, 0);
});

test("autoRoutine sends real reply only when sendReply confirms sent, else falls to pending", async (t) => {
  for (const [label, sent, expectAuto] of [["sent", true, 1], ["not-sent", false, 0]]) {
    const db = openDatabase(":memory:");
    const larkPushes = [];
    const result = await runChat({
      db,
      page: fakePage(),
      replyConfig: { shadowMode: false, autoRoutine: true, maxAutoPerRun: 3, replyDelaySec: [0, 0] },
      listFn: async () => [
        { bossConvKey: "conv-routine", hrName: "Wu", company: "AI Co", jobTitle: "AI 实习", lastMsgText: "在广州吗？", lastMsgTimeLabel: "12:00" },
      ],
      readFn: async () => [{ role: "hr", text: "在广州吗？", sentLabel: "m1" }],
      classifyAndDraftFn: async () => ({
        tier: "routine",
        draft: { intent: "screening_question", proposedReply: "是的，我在广州，随时可到岗。", notifyUser: false },
        requiresConfirm: false,
      }),
      sendReplyFn: async () => ({ sent, dryRun: false, approved: true }),
      pushPendingToLarkFn: async (pending) => { larkPushes.push(pending); return { code: "000001" }; },
      reconcilePendingFromLarkFn: async () => [],
      larkFetchFn: async () => [],
      readProjectFactsFn: () => [],
      profileText: "候选人：罗其立",
      notifyTextFn: async () => ({ message_id: "x" }),
      assertPageSafeFn: async () => true,
      delayFn: async () => 0,
    });
    assert.equal(result.autoReplies, expectAuto, `${label}: autoReplies`);
    // 真发了→标记 auto_replied 不进 pending; 没发出→落 pending 草稿
    assert.equal(larkPushes.length, sent ? 0 : 1, `${label}: pending pushes`);
    db.close();
  }
});

test("linkConversationToJob matches direct job ids and unique company names once", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  greetedJob(db, {
    id: "job-from-url",
    title: "Direct Match",
    company: "Direct Co",
  });
  greetedJob(db, {
    id: "job-company",
    title: "Company Match",
    company: "Acme Technology",
  });
  greetedJob(db, {
    id: "job-existing",
    title: "Existing",
    company: "Other Co",
  });

  const direct = upsertConversation(db, { bossConvKey: "conv-url" });
  const linkedDirect = linkConversationToJob(db, {
    ...direct,
    source_job_id: "job-from-url",
  });
  assert.equal(linkedDirect.job_id, "job-from-url");

  const company = upsertConversation(db, {
    bossConvKey: "conv-company",
    company: "Acme",
    jobTitle: "Company Match",
  });
  const linkedCompany = linkConversationToJob(db, company);
  assert.equal(linkedCompany.job_id, "job-company");

  const existing = upsertConversation(db, {
    bossConvKey: "conv-existing",
    jobId: "job-existing",
    company: "Acme Technology",
  });
  const unchanged = linkConversationToJob(db, {
    ...existing,
    source_job_id: "job-from-url",
  });
  assert.equal(unchanged.job_id, "job-existing");
});

test("runChat retries pending HR notifications from the database after send failure", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  let shouldFail = true;
  let readCalls = 0;
  const notifications = [];
  const conversation = {
    bossConvKey: "conv-retry",
    hrName: "Chen",
    company: "Retry Co",
    lastMsgText: "Retry me",
    lastMsgTimeLabel: "11:20",
  };
  const options = {
    db,
    page: fakePage(),
    listFn: async () => [conversation],
    readFn: async () => {
      readCalls += 1;
      return [{ role: "hr", text: "Retry me", sentLabel: "retry-1" }];
    },
    notifyTextFn: async (text) => {
      notifications.push(text);
      if (shouldFail) {
        throw new Error("lark token expired");
      }
      return { message_id: "ok" };
    },
    classifyAndDraftFn: async () => routineReplyDraft(),
    larkFetchFn: async () => [],
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  };

  await assert.rejects(() => runChat(options), /lark token expired/);
  const pendingMessage = listMessages(db, 1)[0];
  assert.equal(pendingMessage.action_taken, null);
  assert.equal(listPendingActions(db, { status: "pending" }).length, 1);

  shouldFail = false;
  const retry = await runChat(options);
  const retriedMessage = listMessages(db, 1)[0];

  assert.equal(retry.opened, 0);
  assert.equal(retry.notified, 1);
  assert.equal(retry.pendingReplies, 1);
  assert.equal(readCalls, 1);
  assert.equal(retriedMessage.action_taken, "reply_pending");
  assert.equal(listPendingActions(db, { status: "pending" }).length, 1);
  assert.equal(notifications.length, 2);
});

test("runChat backfill opens all conversations and sends one aggregate notification", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const notifications = [];
  const conversations = [
    {
      bossConvKey: "conv-a",
      hrName: "陈经理",
      company: "甲公司",
      lastMsgText: "A",
      lastMsgTimeLabel: "11:01",
    },
    {
      bossConvKey: "conv-b",
      hrName: "王女士",
      company: "乙公司",
      lastMsgText: "B",
      lastMsgTimeLabel: "11:02",
    },
  ];

  const result = await runChat({
    db,
    page: fakePage(),
    backfill: true,
    listFn: async () => conversations,
    readFn: async (_page, key) =>
      key === "conv-a"
        ? [
            { role: "hr", text: "A", sentLabel: "a-1" },
            { role: "me", text: "收到", sentLabel: "a-2" },
          ]
        : [{ role: "hr", text: "B", sentLabel: "b-1" }],
    notifyTextFn: async (text) => notifications.push(text),
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  assert.equal(result.conversations, 2);
  assert.equal(result.opened, 2);
  assert.equal(result.newHrMessages, 2);
  assert.equal(result.notified, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /Backfill/);
  assert.match(notifications[0], /甲公司.*陈经理/);
  assert.match(notifications[0], /乙公司.*王女士/);
  assert.deepEqual(
    [listMessages(db, 1)[0].action_taken, listMessages(db, 2)[0].action_taken],
    ["backfilled", "backfilled"],
  );
});

test("runChat records expired login and exits cleanly on login errors", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const loginError = new Error("login required");
  loginError.code = "BOSS_LOGIN_REQUIRED";

  const result = await runChat({
    db,
    page: fakePage(),
    listFn: async () => {
      throw loginError;
    },
    notifyTextFn: async () => {},
    assertPageSafeFn: async () => true,
    delayFn: async () => 0,
  });

  assert.equal(result.loginOk, false);
  assert.equal(lastLoginEvent(db).event, "expired");
});

test("runChat skips recent open circuits before launching a browser", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  setMeta(db, "circuit_open", "2026-07-04 10:00:00");
  let launched = false;

  const result = await runChat({
    db,
    now: new Date("2026-07-04T11:30:00"),
    browserFactory: async () => {
      launched = true;
      throw new Error("browser should not launch");
    },
  });

  assert.equal(result.skipped, "circuit_open");
  assert.equal(result.opened, 0);
  assert.equal(launched, false);
});

test("runChat does not notify duplicate messages when a changed conversation is reopened", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const notifications = [];
  let lastMsgText = "first";

  const run = () =>
    runChat({
      db,
      page: fakePage(),
      listFn: async () => [
        {
          bossConvKey: "conv-dedupe",
          hrName: "陈经理",
          company: "测试公司",
          jobTitle: "AI 应用实习生",
          lastMsgText,
          lastMsgTimeLabel: "11:20",
        },
      ],
      readFn: async () => [
        { role: "hr", text: "相同消息", sentLabel: "same-mid" },
      ],
      notifyTextFn: async (text) => notifications.push(text),
      classifyAndDraftFn: async () => routineReplyDraft(),
      larkFetchFn: async () => [],
      assertPageSafeFn: async () => true,
      delayFn: async () => 0,
    });

  await run();
  lastMsgText = "changed list preview";
  const second = await run();

  assert.equal(second.opened, 1);
  assert.equal(second.newHrMessages, 0);
  assert.equal(notifications.length, 1);
  assert.equal(listMessages(db, 1).length, 1);
});

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

function routineReplyDraft() {
  return {
    tier: "routine",
    draft: {
      intent: "screening_question",
      proposedReply: "您好，可以结合岗位要求继续补充项目细节。",
    },
    requiresConfirm: true,
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
