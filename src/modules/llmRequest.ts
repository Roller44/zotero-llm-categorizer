/**
 * Pure, dependency-free request/response building for the LLM client.
 *
 * This module contains NO Zotero globals and NO config imports so it can be
 * unit-tested under plain Node without a Zotero sandbox. `llmClient.ts` wraps
 * these pure functions with preference reads and `Zotero.HTTP.request`.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
  /** OpenAI reasoning_effort parameter (e.g. "low", "medium", "high"). */
  reasoning_effort?: string;
}

export type Provider = "auto" | "openai" | "anthropic";

export interface LlmSettings {
  endpoint: string;
  apiKey: string;
  model: string;
  provider: Provider;
  /** Max output tokens (passed as max_tokens in the request body). */
  maxTokens: number;
  /** Request timeout in seconds. */
  timeoutSeconds: number;
  /** Reasoning effort: "none" (omit), "low", "medium", "high". */
  reasoningEffort: string;
}

export interface PreparedRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  provider: "openai" | "anthropic";
}

export const ANTHROPIC_API_VERSION = "2023-06-01";

export function normalizeProvider(value: string): Provider {
  if (value === "openai" || value === "anthropic") return value;
  return "auto";
}

/**
 * Resolve the effective provider, applying the `auto` rule:
 * if the endpoint URL contains `anthropic.com` -> anthropic; else -> openai.
 */
export function resolveProvider(
  provider: Provider,
  endpoint: string,
): "openai" | "anthropic" {
  if (provider === "openai" || provider === "anthropic") return provider;
  return endpoint.toLowerCase().includes("anthropic.com")
    ? "anthropic"
    : "openai";
}

/**
 * Normalize the endpoint URL for the given provider.
 *
 * Users often enter a base URL (e.g. `https://api.openai.com/v1` or
 * `https://api.example.com/v1`) rather than the full chat-completions / messages
 * URL. This function appends the correct path when the endpoint doesn't already
 * end with it, so both base URLs and full URLs work.
 */
export function normalizeEndpoint(
  endpoint: string,
  provider: "openai" | "anthropic",
): string {
  const trimmed = endpoint.replace(/\/+$/, ""); // strip trailing slashes
  if (provider === "anthropic") {
    if (/\/v1\/messages$/.test(trimmed)) return trimmed;
    // If it ends with /v1, append /messages; otherwise append /v1/messages
    if (/\/v1$/.test(trimmed)) return trimmed + "/messages";
    return trimmed + "/v1/messages";
  }
  // openai-compatible
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return trimmed + "/chat/completions";
  // If it doesn't even have /v1, append the full path
  return trimmed + "/v1/chat/completions";
}

/**
 * Build the request object (URL, headers, JSON body) for a chat completion
 * WITHOUT making any network call. This is the unit-testable core.
 */
export function buildRequest(
  messages: ChatMessage[],
  settings: LlmSettings,
  options: ChatOptions = {},
): PreparedRequest {
  const provider = resolveProvider(settings.provider, settings.endpoint);

  if (!settings.endpoint) {
    throw new Error("LLM endpoint URL is not configured.");
  }
  if (!settings.model) {
    throw new Error("LLM model is not configured.");
  }

  const url = normalizeEndpoint(settings.endpoint, provider);

  if (provider === "anthropic") {
    const body: Record<string, unknown> = {
      model: settings.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: options.max_tokens ?? settings.maxTokens ?? 1024,
    };
    return {
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(body),
      provider: "anthropic",
    };
  }

  // openai-compatible
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  };
  if (typeof options.temperature === "number") {
    body.temperature = options.temperature;
  }
  // Use options.max_tokens if provided, otherwise fall back to settings.maxTokens
  const effectiveMaxTokens = options.max_tokens ?? settings.maxTokens;
  if (typeof effectiveMaxTokens === "number" && effectiveMaxTokens > 0) {
    body.max_tokens = effectiveMaxTokens;
  }
  // Reasoning effort (OpenAI o-series and some compatible APIs)
  if (settings.reasoningEffort && settings.reasoningEffort !== "none") {
    body.reasoning_effort = settings.reasoningEffort;
  }
  return {
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
    provider: "openai",
  };
}

/**
 * Extract the assistant text from a provider response body.
 */
export function parseResponse(
  provider: "openai" | "anthropic",
  responseText: string,
): string {
  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch (e) {
    throw new Error(
      `LLM response was not valid JSON: ${(e as Error).message}`,
    );
  }
  if (provider === "anthropic") {
    const content = data?.content;
    if (!Array.isArray(content) || content.length === 0) {
      throw new Error("Anthropic response had no content array.");
    }
    return String(content[0]?.text ?? "");
  }
  const choices = data?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("OpenAI response had no choices array.");
  }
  return String(choices[0]?.message?.content ?? "");
}
