import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const COMPLETIONS_PATH = "/chat/completions";

export async function chat(messages, options = {}) {
  const result = await requestChat(messages, options);
  return options.json ? parseJsonResponse(result.content) : result.content;
}

export async function requestChat(
  messages,
  {
    json = false,
    model = config.llm.model,
    fallbackModel = config.llm.fallbackModel,
    timeoutMs = config.llm.timeoutMs,
    retries = config.llm.retries,
    temperature = 0.2,
  } = {},
) {
  const models = [model];
  if (fallbackModel && fallbackModel !== model) {
    models.push(fallbackModel);
  }

  let lastError;
  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const candidate = models[modelIndex];
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await makeRequest(messages, {
          json,
          model: candidate,
          timeoutMs,
          temperature,
        });
      } catch (error) {
        lastError = error;
        const canFallback =
          error.status === 400 &&
          modelIndex === 0 &&
          models.length > 1 &&
          /model|invalid|not found|does not exist/i.test(error.body ?? error.message);
        if (canFallback) {
          break;
        }

        const retryable =
          error.name === "AbortError" ||
          error.status === 408 ||
          error.status === 429 ||
          error.status >= 500 ||
          error.status === undefined;
        if (!retryable) {
          throw error;
        }
        if (
          error.name === "AbortError" &&
          modelIndex < models.length - 1
        ) {
          break;
        }
        if (attempt === retries) {
          if (modelIndex < models.length - 1) {
            break;
          }
          throw error;
        }
        await delay(500 * 2 ** attempt);
      }
    }
  }

  throw lastError;
}

async function makeRequest(messages, { json, model, timeoutMs, temperature }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.llm.endpoint}${COMPLETIONS_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.llm.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
    const body = await response.text();

    if (!response.ok) {
      const error = new Error(
        `DeepSeek request failed (${response.status}) for model ${model}`,
      );
      error.status = response.status;
      error.body = body.slice(0, 1_000);
      throw error;
    }

    const payload = JSON.parse(body);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(`DeepSeek returned no message content for model ${model}`);
    }

    return {
      content: content.trim(),
      model: payload.model ?? model,
      requestedModel: model,
      usage: payload.usage ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function parseJsonResponse(text) {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error(`LLM returned invalid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function selfTest() {
  const result = await requestChat(
    [
      { role: "system", content: "你是连通性测试助手。只回复指定文本。" },
      { role: "user", content: "只回复: boss-job-agent llm selftest OK" },
    ],
    { temperature: 0 },
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        requestedModel: result.requestedModel,
        model: result.model,
        content: result.content,
      },
      null,
      2,
    ),
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain && process.argv.includes("--selftest")) {
  selfTest().catch((error) => {
    console.error(error.message);
    if (error.body) console.error(error.body);
    process.exitCode = 1;
  });
}
