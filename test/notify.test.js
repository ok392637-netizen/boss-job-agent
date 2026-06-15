import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { config } from "../src/config.js";
import { notifyFile } from "../src/notify.js";

const fixturePath = path.join(config.paths.projectRoot, "test", "notify-fixture.docx");

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
