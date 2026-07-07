import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { config } from "../src/config.js";
import { notifyFile, notifyMarkdown, notifyText } from "../src/notify.js";

const fixturePath = path.join(config.paths.projectRoot, "test", "notify-fixture.docx");
const messageNotifiers = [
  {
    name: "notifyText",
    flag: "--text",
    call: (runLarkFn) => notifyText("hello", { runLarkFn }),
  },
  {
    name: "notifyMarkdown",
    flag: "--markdown",
    call: (runLarkFn) => notifyMarkdown("**hello**", { runLarkFn }),
  },
];

test("message notifications use user identity when it succeeds", async (t) => {
  for (const notifier of messageNotifiers) {
    await t.test(notifier.name, async () => {
      const calls = [];
      const result = await notifier.call(async (args) => {
        calls.push(args);
        return {
          ok: true,
          identity: args[args.indexOf("--as") + 1],
        };
      });

      assert.deepEqual(calls.map(identityFromArgs), ["user"]);
      assert.ok(calls[0].includes(notifier.flag));
      assert.equal(result.identity, "user");
    });
  }
});

test("message notifications fall back to bot when user authentication fails", async (t) => {
  for (const notifier of messageNotifiers) {
    await t.test(notifier.name, async () => {
      const calls = [];
      const result = await notifier.call(async (args) => {
        const identity = identityFromArgs(args);
        calls.push(args);
        if (identity === "user") {
          throw new Error("Authentication token expired");
        }
        return { ok: true, identity };
      });

      assert.deepEqual(calls.map(identityFromArgs), ["user", "bot"]);
      assert.equal(result.identity, "bot");
    });
  }
});

test("message notifications throw after both identities fail", async (t) => {
  for (const notifier of messageNotifiers) {
    await t.test(notifier.name, async () => {
      const calls = [];
      await assert.rejects(
        notifier.call(async (args) => {
          const identity = identityFromArgs(args);
          calls.push(args);
          if (identity === "user") {
            throw new Error("Authentication token expired");
          }
          throw new Error("bot send failed");
        }),
        /lark-cli failed for all identities: user: Authentication token expired \| bot: bot send failed/,
      );

      assert.deepEqual(calls.map(identityFromArgs), ["user", "bot"]);
    });
  }
});

test("notifyFile falls back from user identity to bot identity", async (t) => {
  fs.writeFileSync(fixturePath, "fixture");
  t.after(() => fs.rmSync(fixturePath, { force: true }));
  const identities = [];

  const result = await notifyFile(fixturePath, "", {
    runLarkFn: async (args) => {
      const identity = args[args.indexOf("--as") + 1];
      identities.push(identity);
      if (identity === "user") throw new Error("missing scope");
      return { ok: true, identity };
    },
  });

  assert.deepEqual(identities, ["user", "bot"]);
  assert.equal(result[0].mode, "file");
  assert.equal(result[0].identity, "bot");
});

test("notifyFile sends a markdown path fallback when both identities fail", async (t) => {
  fs.writeFileSync(fixturePath, "fixture");
  t.after(() => fs.rmSync(fixturePath, { force: true }));
  const markdownMessages = [];

  const result = await notifyFile(fixturePath, "", {
    runLarkFn: async (args) => {
      const identity = args[args.indexOf("--as") + 1];
      throw new Error(`${identity} upload failed`);
    },
    notifyMarkdownFn: async (markdown) => {
      markdownMessages.push(markdown);
      return { ok: true };
    },
  });

  assert.equal(result[0].mode, "path-fallback");
  assert.match(markdownMessages[0], /📎 简历已生成:/);
  assert.match(markdownMessages[0], new RegExp(escapeRegExp(path.resolve(fixturePath))));
  assert.match(markdownMessages[0], /user upload failed/);
  assert.match(markdownMessages[0], /bot upload failed/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identityFromArgs(args) {
  return args[args.indexOf("--as") + 1];
}
