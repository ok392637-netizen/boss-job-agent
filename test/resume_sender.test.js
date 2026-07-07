import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getOrCreatePage, launchBrowser } from "../src/browser.js";
import {
  buildReplySendPlan,
  buildResumeSendPlan,
  sendReply,
  sendResumeFromLibrary,
} from "../src/modules/resume_sender.js";

const FIXTURE_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pages",
);

function fixtureUrl(...parts) {
  return pathToFileURL(path.join(FIXTURE_DIRECTORY, ...parts)).href;
}

test("sendResumeFromLibrary dry-run is default and plans verified Boss paths", async () => {
  const result = await sendResumeFromLibrary(null, {
    conversation: { bossConvKey: "conv-1", hrName: "陈经理" },
    attachmentName: "罗其立-简历.pdf",
    message: "附件是我的简历。",
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.sent, false);
  assert.deepEqual(result.observedPaths, ["request-card", "toolbar-request"]);
  assert.deepEqual(result.plannedSteps, [
    "open Boss chat conversation: conv-1",
    "send approved intro message before resume request",
    "use Boss attachment-library resume/default attachment: 罗其立-简历.pdf",
    "prefer HR resume-request card when present",
    "otherwise click active chat toolbar entry [d-c='62009'] 发简历",
    "do not use direct chat file upload input",
    "wait for 附件简历请求已发送 or 附件简历已发送 receipt",
  ]);
});

test("sendReply dry-run is default and plans only chat text sending", async () => {
  const result = await sendReply(null, {
    conversation: { bossConvKey: "conv-reply", hrName: "陈经理" },
    text: "您好，可以继续沟通。",
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.sent, false);
  assert.deepEqual(result.conversation, {
    bossConvKey: "conv-reply",
    conversationUrl: null,
    index: null,
    hrName: "陈经理",
    company: null,
    jobTitle: null,
  });
  assert.deepEqual(result.plannedSteps, [
    "open Boss chat conversation: conv-reply",
    "wait human reply delay before sending text",
    "type approved reply into Boss chat editor",
    "click Boss chat send button",
    "do not upload files or send resume attachments",
  ]);
});

test("sendReply real execution requires approved=true", async () => {
  await assert.rejects(
    () =>
      sendReply(fakePage(), {
        text: "真实发送必须显式批准。",
        dryRun: false,
      }),
    /approved=true/,
  );
});

test("buildReplySendPlan accepts current conversation mode", () => {
  assert.deepEqual(
    buildReplySendPlan({ text: "当前会话回复", navigate: false }),
    [
      "use current open Boss chat conversation",
      "wait human reply delay before sending text",
      "type approved reply into Boss chat editor",
      "click Boss chat send button",
      "do not upload files or send resume attachments",
    ],
  );
});

test("sendResumeFromLibrary real execution requires approved=true", async () => {
  await assert.rejects(
    () =>
      sendResumeFromLibrary(fakePage(), {
        dryRun: false,
        attachmentName: "罗其立-简历.pdf",
      }),
    /approved=true/,
  );
});

test("buildResumeSendPlan accepts old resumePath callers without direct upload", () => {
  const plan = buildResumeSendPlan({
    conversation: { conversationUrl: "https://www.zhipin.com/web/geek/chat" },
    resumePath: "C:/tmp/罗其立-简历.docx",
  });

  assert.ok(plan.some((step) => step.includes("罗其立-简历.docx")));
  assert.ok(plan.some((step) => step.includes("do not use direct chat file upload input")));
});

test("sendResumeFromLibrary clicks an HR resume request card after approval", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("chat-resume-request-card.html"));

    const result = await sendResumeFromLibrary(page, {
      attachmentName: "罗其立-简历.pdf",
      dryRun: false,
      approved: true,
      navigate: false,
      delayFn: async () => {},
      waitTimeoutMs: 2_000,
    });

    assert.equal(result.path, "request-card");
    assert.equal(result.sent, true);
    assert.equal(result.requestSent, false);
    assert.match(await page.locator("body").innerText(), /您的附件简历已发送给对方/);
  } finally {
    await context.close();
  }
});

test("sendResumeFromLibrary still matches a visible conversation list item before search", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("chat-lazy-search.html"));
    const chatPage = createChatUrlPage(page);

    const result = await sendResumeFromLibrary(chatPage, {
      conversation: {
        bossConvKey: "boss-chat-stale-avatar-key",
        hrName: "周女士",
        company: "广州彩集",
      },
      attachmentName: "罗其立-简历.pdf",
      dryRun: false,
      approved: true,
      delayFn: async () => {},
      waitTimeoutMs: 2_000,
    });

    assert.equal(result.path, "toolbar-request");
    assert.equal(result.requestSent, true);
    const state = await page.evaluate(() => ({ ...document.body.dataset }));
    assert.equal(state.clickedHr, "周女士");
    assert.equal(state.clickedCompany, "广州彩集");
    assert.equal(state.clickedSource, "list");
    assert.equal(state.submittedSearches, undefined);
    assert.equal(state.toolbarResume, "true");
  } finally {
    await context.close();
  }
});

test("sendResumeFromLibrary matches same-name HR by company after lazy search", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("chat-lazy-search.html"));
    const chatPage = createChatUrlPage(page);

    const result = await sendResumeFromLibrary(chatPage, {
      conversation: {
        bossConvKey: "boss-chat-stale-avatar-key",
        hrName: "周女士",
        company: "瘦吧健康产业集团",
      },
      attachmentName: "罗其立-简历.pdf",
      dryRun: false,
      approved: true,
      delayFn: async () => {},
      waitTimeoutMs: 2_000,
    });

    assert.equal(result.path, "toolbar-request");
    assert.equal(result.sent, false);
    assert.equal(result.requestSent, true);
    const searchState = await page.evaluate(() => ({ ...document.body.dataset }));
    assert.equal(searchState.clickedHr, "周女士");
    assert.equal(searchState.clickedCompany, "瘦吧健康产业集团");
    assert.equal(searchState.clickedSource, "search");
    assert.equal(searchState.submittedSearches, "周女士|瘦吧健康");
    assert.equal(searchState.typedQuery, "瘦吧健康");
    assert.equal(searchState.enterPressed, "true");
    assert.equal(searchState.fillLikeQueryInput, undefined);
    assert.equal(searchState.searchedSameNameOnly, "true");
    assert.equal(searchState.lastSearch, "");
    assert.equal(searchState.searchCleared, "true");
    assert.equal(searchState.searchedTarget, "true");
    assert.equal(searchState.toolbarResume, "true");
    assert.equal(await page.locator("#conversation-search").inputValue(), "");
  } finally {
    await context.close();
  }
});

test("sendResumeFromLibrary waits for enabled send button in attachment panel", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("chat-resume-panel.html"));

    const result = await sendResumeFromLibrary(page, {
      attachmentName: "罗其立简历.pdf",
      dryRun: false,
      approved: true,
      navigate: false,
      delayFn: async () => {},
      waitTimeoutMs: 2_000,
    });

    assert.equal(result.path, "library-panel");
    assert.equal(result.sent, true);
    assert.equal(result.requestSent, false);
    assert.equal(
      await page.evaluate(() => document.body.dataset.selectedAttachment),
      "罗其立简历.pdf",
    );
    assert.equal(
      await page.evaluate(() => document.body.dataset.sentWhileDisabled),
      undefined,
    );
    assert.equal(
      await page.evaluate(() => document.body.dataset.events),
      "toolbar-resume|select:罗其立简历.pdf|send-click",
    );
  } finally {
    await context.close();
  }
});

test("sendResumeFromLibrary reports when attachment selection does not enable send button", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("chat-resume-panel.html"));

    await assert.rejects(
      () =>
        sendResumeFromLibrary(page, {
          attachmentName: "不会启用发送.pdf",
          dryRun: false,
          approved: true,
          navigate: false,
          delayFn: async () => {},
          waitTimeoutMs: 2_000,
        }),
      /attachment selection did not enable send button/,
    );
    assert.equal(
      await page.evaluate(() => document.body.dataset.selectedAttachment),
      "不会启用发送.pdf",
    );
    assert.equal(
      await page.evaluate(() => document.body.dataset.events),
      "toolbar-resume|select:不会启用发送.pdf",
    );
  } finally {
    await context.close();
  }
});

test("sendResumeFromLibrary uses active 发简历 toolbar when no request card exists", async () => {
  const context = await launchBrowser();
  try {
    const page = await getOrCreatePage(context);
    await page.goto(fixtureUrl("chat-resume-toolbar.html"));

    const result = await sendResumeFromLibrary(page, {
      attachmentName: "罗其立-简历.pdf",
      dryRun: false,
      approved: true,
      navigate: false,
      delayFn: async () => {},
      waitTimeoutMs: 2_000,
    });

    assert.equal(result.path, "toolbar-request");
    assert.equal(result.sent, false);
    assert.equal(result.requestSent, true);
    assert.match(await page.locator("body").innerText(), /附件简历请求已发送/);
  } finally {
    await context.close();
  }
});

function fakePage() {
  return {
    locator() {
      return {
        async count() {
          return 0;
        },
      };
    },
  };
}

function createChatUrlPage(page) {
  return new Proxy(page, {
    get(target, property, receiver) {
      if (property === "url") {
        return () => "https://www.zhipin.com/web/geek/chat";
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
