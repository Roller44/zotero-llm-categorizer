/**
 * LLM HTTP client for Zotero Smart Organizer.
 *
 * Supports two provider paths, selected by `provider` pref (auto/openai/anthropic):
 *  - openai-compatible: POST {model, messages, temperature?, max_tokens?}
 *    with `Authorization: Bearer <apiKey>` to the configured endpoint
 *    (the endpoint IS the full chat completions URL).
 *  - anthropic: POST {model, messages, max_tokens} with `x-api-key` and
 *    `anthropic-version` headers to the configured endpoint (full /v1/messages URL).
 *
 * All network access goes through `Zotero.HTTP.request`, which is available
 * inside the plugin sandbox (verified against Zotero 9 source — see
 * references/zotero-js-api.md). No item/library reads or writes happen here.
 *
 * The pure request/response logic lives in `llmRequest.ts` (no Zotero/config
 * deps) so it can be unit-tested under plain Node.
 */

import { config } from "../../package.json";
import {
  ANTHROPIC_API_VERSION,
  buildRequest as buildRequestPure,
  normalizeProvider,
  parseResponse,
  resolveProvider,
  type ChatMessage,
  type ChatOptions,
  type LlmSettings,
  type PreparedRequest,
  type Provider,
} from "./llmRequest";

export type {
  ChatMessage,
  ChatOptions,
  LlmSettings,
  PreparedRequest,
  Provider,
  ChatRole,
} from "./llmRequest";
export { buildRequestPure, normalizeProvider, parseResponse, resolveProvider };

/**
 * Callback invoked for each chunk decoded from an SSE stream. `kind` is
 * `"content"` for normal assistant text or `"reasoning"` for a reasoning-model
 * thinking trace (e.g. OpenAI `delta.reasoning_content` or Anthropic
 * `thinking_delta`). The text is the delta for this chunk only (not
 * accumulated).
 */
export type ChunkCallback = (
  kind: "content" | "reasoning",
  text: string,
) => void;

const PREFS_PREFIX = config.prefsPrefix;

/**
 * Read the LLM settings from Zotero preferences.
 * Wraps each read in try/catch because Zotero.Prefs.get throws if the pref
 * doesn't exist (the `|| ""` fallback only catches undefined, not thrown errors).
 */
function safeGetPref(key: string): string {
  try {
    return (Zotero.Prefs.get(key, true) as string | undefined) || "";
  } catch {
    return "";
  }
}

export { safeGetPref };

function safeGetInt(key: string, defaultValue: number): number {
  const raw = safeGetPref(key);
  const n = parseInt(raw, 10);
  return isNaN(n) || n <= 0 ? defaultValue : n;
}

export function getSettings(): LlmSettings {
  const endpoint = safeGetPref(`${PREFS_PREFIX}.endpoint`);
  const apiKey = safeGetPref(`${PREFS_PREFIX}.apiKey`);
  const model = safeGetPref(`${PREFS_PREFIX}.model`);
  const providerPref = safeGetPref(`${PREFS_PREFIX}.provider`) || "auto";
  const maxTokens = safeGetInt(`${PREFS_PREFIX}.maxTokens`, 16384);
  const timeoutSeconds = safeGetInt(`${PREFS_PREFIX}.timeoutSeconds`, 300);
  const reasoningEffort = safeGetPref(`${PREFS_PREFIX}.reasoningEffort`) || "none";
  return {
    endpoint,
    apiKey,
    model,
    provider: normalizeProvider(providerPref),
    maxTokens,
    timeoutSeconds,
    reasoningEffort,
  };
}

/**
 * Build the request object (URL, headers, JSON body) for a chat completion
 * WITHOUT making any network call. Re-exported pure function.
 */
export function buildRequest(
  messages: ChatMessage[],
  settings: LlmSettings,
  options?: ChatOptions,
): PreparedRequest {
  return buildRequestPure(messages, settings, options);
}

/**
 * Send a chat completion request and return the assistant message text.
 *
 * Uses fetch() instead of Zotero.HTTP.request because many LLM endpoints
 * (especially reasoning models like Kimi-K3) hold the connection open
 * without sending data while "thinking". Zotero.HTTP.request (XHR-based,
 * non-streaming) interprets this silence as a timeout. fetch() with
 * streaming keeps the connection alive and reads the response as it arrives.
 */
export async function chatComplete(
  messages: ChatMessage[],
  options?: ChatOptions,
  onChunk?: ChunkCallback,
): Promise<string> {
  const settings = getSettings();
  const prepared = buildRequestPure(messages, settings, options);

  // Use the global fetch() from the Zotero/Firefox environment.
  const fetchFn =
    (Zotero as any).getMainWindow?.()?.fetch ??
    (globalThis as any).fetch;
  if (!fetchFn) {
    throw new Error("fetch() is not available in this environment.");
  }

  let response: Response;
  try {
    response = await fetchFn(prepared.url, {
      method: "POST",
      headers: prepared.headers,
      body: prepared.body,
    });
  } catch (e: any) {
    throw new Error(
      `LLM request failed (network error): ${e?.message ?? String(e)}`.slice(0, 1000),
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `LLM endpoint returned HTTP ${response.status}: ${errorText.slice(0, 500)}`,
    );
  }

  // Check if the response is a streaming SSE response.
  const contentType = response.headers.get("content-type") || "";
  const isStreaming =
    contentType.includes("text/event-stream") ||
    contentType.includes("octet-stream");

  if (isStreaming && response.body) {
    // Read the SSE stream — readSSEStream returns the accumulated
    // assistant message content directly (not wrapped in an API response).
    const content = await readSSEStream(
      response.body,
      prepared.provider,
      onChunk,
    );
    if (!content || content.trim().length === 0) {
      throw new Error("LLM streaming response was empty.");
    }
    return content;
  }

  // Non-streaming: read the full response as text and parse the API wrapper.
  const responseText = await response.text();
  return parseResponse(prepared.provider, responseText);
}

/**
 * Read an SSE (Server-Sent Events) stream from an OpenAI-compatible endpoint
 * and extract the accumulated assistant message content.
 */
async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  provider: "openai" | "anthropic",
  onChunk?: ChunkCallback,
): Promise<string> {
  const reader = body.getReader() as any;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let accumulated = "";
  let chunkCount = 0;
  let reasoningChars = 0;
  let reasoningAccumulated = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep the last partial line in the buffer.

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // Skip empty lines and comments.

        if (trimmed === "data: [DONE]") {
          reader.cancel().catch(() => undefined);
          Zotero.debug(`[SmartOrganizer] SSE stream done: ${chunkCount} chunks, ${accumulated.length} content chars, ${reasoningChars} reasoning chars`);
          Zotero.debug(`[SmartOrganizer] SSE content (first 500): ${accumulated.slice(0, 500)}`);
          if (reasoningChars > 0) {
            Zotero.debug(`[SmartOrganizer] SSE reasoning (first 500): ${reasoningAccumulated.slice(0, 500)}`);
          }
          // If content is empty but reasoning has data, use reasoning as the output.
          // Some reasoning models (e.g. Kimi-K3) put their entire answer in reasoning_content.
          if (accumulated.length === 0 && reasoningAccumulated.length > 0) {
            Zotero.debug(`[SmartOrganizer] SSE: content empty, using reasoning as output (${reasoningAccumulated.length} chars)`);
            return reasoningAccumulated;
          }
          return accumulated;
        }

        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          try {
            const chunk = JSON.parse(jsonStr);
            chunkCount++;
            if (provider === "anthropic") {
              // Anthropic SSE format: { type: "content_block_delta", delta: { text: "..." } }
              if (chunk?.delta?.type === "thinking_delta" && chunk?.delta?.thinking) {
                onChunk?.("reasoning", chunk.delta.thinking);
              } else if (chunk?.delta?.text) {
                accumulated += chunk.delta.text;
                onChunk?.("content", chunk.delta.text);
              }
            } else {
              // OpenAI SSE format: { choices: [{ delta: { content: "..." } }] }
              const delta = chunk?.choices?.[0]?.delta;
              // Debug: log the first chunk's full structure to see field names
              if (chunkCount === 1) {
                Zotero.debug(`[SmartOrganizer] SSE: first chunk delta keys: ${JSON.stringify(Object.keys(delta || {}))}`);
                Zotero.debug(`[SmartOrganizer] SSE: first chunk delta: ${JSON.stringify(delta)?.slice(0, 500)}`);
              }
              if (delta?.reasoning_content) {
                // Reasoning models expose their thinking trace here.
                onChunk?.("reasoning", delta.reasoning_content);
                reasoningAccumulated += delta.reasoning_content;
                if (reasoningChars === 0) {
                  Zotero.debug(`[SmartOrganizer] SSE: first reasoning_content chunk: ${delta.reasoning_content.slice(0, 200)}`);
                }
                reasoningChars += delta.reasoning_content.length;
              } else if (delta?.reasoning) {
                // Some providers use `reasoning` instead of `reasoning_content`.
                // Guarded with `else if` so a delta carrying both fields is not
                // double-counted into the accumulated reasoning text.
                onChunk?.("reasoning", delta.reasoning);
                reasoningAccumulated += delta.reasoning;
                reasoningChars += delta.reasoning.length;
              }
              if (delta?.content) {
                accumulated += delta.content;
                onChunk?.("content", delta.content);
              }
            }
          } catch {
            // Not valid JSON — could be a partial chunk or a non-SSE response.
            // If this is the first "chunk" and it doesn't start with "data: ",
            // the server might have returned a non-streaming response despite stream:true.
            Zotero.debug(`[SmartOrganizer] SSE: could not parse chunk: ${jsonStr.slice(0, 200)}`);
          }
        } else if (chunkCount === 0 && accumulated === "") {
          // The response might not be SSE-formatted at all.
          // Some servers ignore stream:true and return plain JSON.
          // Accumulate the raw text and try to parse it later.
          accumulated += trimmed;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // If we got here without [DONE], return whatever we accumulated.
  // If no SSE chunks were parsed, the accumulated text might be the raw
  // non-streaming response — try to extract content from it.
  if (chunkCount === 0 && accumulated.length > 0) {
    Zotero.debug(`[SmartOrganizer] No SSE chunks found, raw response: ${accumulated.slice(0, 300)}`);
    try {
      // Try parsing as a standard OpenAI response.
      const parsed = JSON.parse(accumulated);
      const content = parsed?.choices?.[0]?.message?.content;
      if (content) return content;
    } catch {
      // Not JSON either — return as-is and let the caller's JSON parser handle it.
    }
  }

  Zotero.debug(`[SmartOrganizer] SSE stream ended: ${chunkCount} chunks, ${accumulated.length} content chars, ${reasoningChars} reasoning chars`);
  Zotero.debug(`[SmartOrganizer] SSE content (first 500): ${accumulated.slice(0, 500)}`);
  if (reasoningChars > 0) {
    Zotero.debug(`[SmartOrganizer] SSE reasoning (first 500): ${reasoningAccumulated.slice(0, 500)}`);
  }
  // Fallback: if content is empty but reasoning has data, use reasoning.
  if (accumulated.length === 0 && reasoningAccumulated.length > 0) {
    Zotero.debug(`[SmartOrganizer] SSE: content empty (stream ended), using reasoning as output (${reasoningAccumulated.length} chars)`);
    return reasoningAccumulated;
  }
  return accumulated;
}

/**
 * Send a trivial ping to verify connectivity and credentials.
 * Used by the settings pane "Test connection" button.
 */
export async function testConnection(): Promise<{
  ok: boolean;
  message: string;
}> {
  const settings = getSettings();
  if (!settings.endpoint) {
    return { ok: false, message: "Endpoint URL is not set." };
  }
  if (!settings.apiKey) {
    return { ok: false, message: "API key is not set." };
  }
  if (!settings.model) {
    return { ok: false, message: "Model is not set." };
  }

  try {
    const reply = await chatComplete([{ role: "user", content: "ping" }], {
      max_tokens: 16,
    });
    const preview = reply.replace(/\s+/g, " ").trim().slice(0, 120);
    return {
      ok: true,
      message: `Connection successful. Reply: ${preview || "(empty)"}`,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// Keep the exported constant referenced so it is part of the module surface.
export { ANTHROPIC_API_VERSION };
