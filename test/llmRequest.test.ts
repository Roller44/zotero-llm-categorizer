/**
 * No-network unit test for the LLM request-building logic.
 *
 * Verifies the OpenAI and Anthropic request shapes (headers + body) and the
 * response parser WITHOUT making any network call or requiring a live API key.
 *
 * Run with: node --test --experimental-strip-types test/llmRequest.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequest,
  normalizeEndpoint,
  normalizeProvider,
  parseResponse,
  resolveProvider,
  type LlmSettings,
} from "../src/modules/llmRequest.ts";

const openaiSettings: LlmSettings = {
  endpoint: "https://api.openai.com/v1/chat/completions",
  apiKey: "sk-test-key-123",
  model: "gpt-4o-mini",
  provider: "openai",
  maxTokens: 16384,
  timeoutSeconds: 300,
  reasoningEffort: "none",
};

const anthropicSettings: LlmSettings = {
  endpoint: "https://api.anthropic.com/v1/messages",
  apiKey: "sk-ant-test-key-456",
  model: "claude-3-5-sonnet-20241022",
  provider: "anthropic",
  maxTokens: 16384,
  timeoutSeconds: 300,
  reasoningEffort: "none",
};

test("normalizeProvider accepts valid values and defaults to auto", () => {
  assert.equal(normalizeProvider("openai"), "openai");
  assert.equal(normalizeProvider("anthropic"), "anthropic");
  assert.equal(normalizeProvider("auto"), "auto");
  assert.equal(normalizeProvider("garbage"), "auto");
  assert.equal(normalizeProvider(""), "auto");
});

test("resolveProvider: auto detects anthropic.com in endpoint", () => {
  assert.equal(
    resolveProvider("auto", "https://api.anthropic.com/v1/messages"),
    "anthropic",
  );
  assert.equal(
    resolveProvider("auto", "https://api.openai.com/v1/chat/completions"),
    "openai",
  );
  assert.equal(
    resolveProvider("auto", "https://my-llm-proxy.example.com/v1/chat"),
    "openai",
  );
});

test("resolveProvider: explicit provider overrides auto", () => {
  assert.equal(
    resolveProvider("anthropic", "https://api.openai.com/v1/chat/completions"),
    "anthropic",
  );
  assert.equal(
    resolveProvider("openai", "https://api.anthropic.com/v1/messages"),
    "openai",
  );
});

test("buildRequest: OpenAI shape (headers + body)", () => {
  const req = buildRequest(
    [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ],
    openaiSettings,
    { temperature: 0.2, max_tokens: 100 },
  );

  assert.equal(req.method, "POST");
  assert.equal(req.url, openaiSettings.endpoint);
  assert.equal(req.provider, "openai");
  assert.equal(req.headers["Content-Type"], "application/json");
  assert.equal(req.headers["Authorization"], "Bearer sk-test-key-123");
  assert.equal(req.headers["x-api-key"], undefined);
  assert.equal(req.headers["anthropic-version"], undefined);

  const body = JSON.parse(req.body);
  assert.equal(body.model, "gpt-4o-mini");
  assert.deepEqual(body.messages, [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" },
  ]);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 100);
});

test("buildRequest: OpenAI omits temperature when not provided, uses settings max_tokens", () => {
  const req = buildRequest([{ role: "user", content: "ping" }], openaiSettings);
  const body = JSON.parse(req.body);
  assert.equal("temperature" in body, false);
  // max_tokens now comes from settings.maxTokens (16384)
  assert.equal(body.max_tokens, 16384);
});

test("buildRequest: Anthropic shape (headers + body, default max_tokens)", () => {
  const req = buildRequest(
    [{ role: "user", content: "Hello" }],
    anthropicSettings,
  );

  assert.equal(req.method, "POST");
  assert.equal(req.url, anthropicSettings.endpoint);
  assert.equal(req.provider, "anthropic");
  assert.equal(req.headers["Content-Type"], "application/json");
  assert.equal(req.headers["x-api-key"], "sk-ant-test-key-456");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.equal(req.headers["Authorization"], undefined);

  const body = JSON.parse(req.body);
  assert.equal(body.model, "claude-3-5-sonnet-20241022");
  assert.deepEqual(body.messages, [
    { role: "user", content: "Hello" },
  ]);
  assert.equal(body.max_tokens, 16384);
  assert.equal("temperature" in body, false);
});

test("buildRequest: auto provider routes to anthropic via endpoint URL", () => {
  const autoAnthropic: LlmSettings = { ...anthropicSettings, provider: "auto" };
  const req = buildRequest([{ role: "user", content: "hi" }], autoAnthropic);
  assert.equal(req.provider, "anthropic");
  assert.equal(req.headers["x-api-key"], "sk-ant-test-key-456");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
});

test("buildRequest: throws on missing endpoint", () => {
  assert.throws(
    () =>
      buildRequest(
        [{ role: "user", content: "x" }],
        { ...openaiSettings, endpoint: "" },
      ),
    /endpoint URL is not configured/i,
  );
});

test("buildRequest: throws on missing model", () => {
  assert.throws(
    () =>
      buildRequest(
        [{ role: "user", content: "x" }],
        { ...openaiSettings, model: "" },
      ),
    /model is not configured/i,
  );
});

test("parseResponse: OpenAI choices[0].message.content", () => {
  const text = JSON.stringify({
    choices: [{ message: { content: "Hello back!" } }],
  });
  assert.equal(parseResponse("openai", text), "Hello back!");
});

test("parseResponse: Anthropic content[0].text", () => {
  const text = JSON.stringify({
    content: [{ type: "text", text: "Anthropic reply" }],
  });
  assert.equal(parseResponse("anthropic", text), "Anthropic reply");
});

test("parseResponse: throws on invalid JSON", () => {
  assert.throws(
    () => parseResponse("openai", "not json{"),
    /not valid JSON/i,
  );
});

test("parseResponse: throws on missing choices/content", () => {
  assert.throws(
    () => parseResponse("openai", JSON.stringify({})),
    /no choices/i,
  );
  assert.throws(
    () => parseResponse("anthropic", JSON.stringify({})),
    /no content/i,
  );
});

// --- normalizeEndpoint tests ---

test("normalizeEndpoint: OpenAI full URL passes through", () => {
  assert.equal(
    normalizeEndpoint("https://api.openai.com/v1/chat/completions", "openai"),
    "https://api.openai.com/v1/chat/completions",
  );
});

test("normalizeEndpoint: OpenAI base URL gets /chat/completions appended", () => {
  assert.equal(
    normalizeEndpoint("https://api.example.com/v1", "openai"),
    "https://api.example.com/v1/chat/completions",
  );
});

test("normalizeEndpoint: OpenAI bare URL gets /v1/chat/completions appended", () => {
  assert.equal(
    normalizeEndpoint("https://my-proxy.example.com", "openai"),
    "https://my-proxy.example.com/v1/chat/completions",
  );
});

test("normalizeEndpoint: trailing slashes are stripped", () => {
  assert.equal(
    normalizeEndpoint("https://api.openai.com/v1/chat/completions/", "openai"),
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    normalizeEndpoint("https://api.example.com/v1/", "openai"),
    "https://api.example.com/v1/chat/completions",
  );
});

test("normalizeEndpoint: Anthropic full URL passes through", () => {
  assert.equal(
    normalizeEndpoint("https://api.anthropic.com/v1/messages", "anthropic"),
    "https://api.anthropic.com/v1/messages",
  );
});

test("normalizeEndpoint: Anthropic base URL gets /messages appended", () => {
  assert.equal(
    normalizeEndpoint("https://api.anthropic.com/v1", "anthropic"),
    "https://api.anthropic.com/v1/messages",
  );
});

test("normalizeEndpoint: Anthropic bare URL gets /v1/messages appended", () => {
  assert.equal(
    normalizeEndpoint("https://my-anthropic-proxy.example.com", "anthropic"),
    "https://my-anthropic-proxy.example.com/v1/messages",
  );
});

test("buildRequest: OpenAI base URL is normalized to full chat completions URL", () => {
  const baseSettings: LlmSettings = {
    endpoint: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "gpt-4o-mini",
    provider: "openai",
    maxTokens: 16384,
    timeoutSeconds: 300,
    reasoningEffort: "none",
  };
  const req = buildRequest([{ role: "user", content: "ping" }], baseSettings);
  assert.equal(req.url, "https://api.example.com/v1/chat/completions");
});
