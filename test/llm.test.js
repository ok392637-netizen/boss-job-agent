import assert from "node:assert/strict";
import test from "node:test";
import { requestChat } from "../src/llm.js";

test("requestChat falls back after a retryable primary-model failure", async (t) => {
  const originalFetch = globalThis.fetch;
  const models = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    models.push(body.model);
    if (body.model === "primary-model") {
      const error = new Error("timed out");
      error.name = "AbortError";
      throw error;
    }
    return new Response(
      JSON.stringify({
        model: "fallback-model",
        choices: [{ message: { content: "fallback ok" } }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  const result = await requestChat([{ role: "user", content: "test" }], {
    model: "primary-model",
    fallbackModel: "fallback-model",
    retries: 2,
  });

  assert.deepEqual(models, ["primary-model", "fallback-model"]);
  assert.equal(result.content, "fallback ok");
  assert.equal(result.requestedModel, "fallback-model");
});

test("requestChat does not mask a non-retryable authentication error", async (t) => {
  const originalFetch = globalThis.fetch;
  const models = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    models.push(body.model);
    return new Response("unauthorized", { status: 401 });
  };

  await assert.rejects(
    () =>
      requestChat([{ role: "user", content: "test" }], {
        model: "primary-model",
        fallbackModel: "fallback-model",
        retries: 0,
      }),
    /DeepSeek request failed \(401\)/,
  );
  assert.deepEqual(models, ["primary-model"]);
});
