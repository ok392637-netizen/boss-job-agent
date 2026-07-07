import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("workflows no longer imports legacy pollReplies", () => {
  const source = fs.readFileSync("src/workflows.js", "utf8");
  assert.doesNotMatch(source, /pollReplies/);
});
