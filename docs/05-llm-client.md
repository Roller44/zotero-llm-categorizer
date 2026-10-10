# LLM Client and SSE Streaming

This document covers the LLM API layer of the Zotero Smart Organizer plugin: how chat-completion requests are built and sent, how streaming Server-Sent Events (SSE) responses are decoded, and why the implementation chose `fetch()` over `Zotero.HTTP.request`. The layer is split across two files:

- `src/modules/llmRequest.ts` — pure, dependency-free request/response building (no Zotero globals, no config imports). Unit-testable under plain Node.
- `src/modules/llmClient.ts` — wraps the pure functions with Zotero preference reads, the network call, and the SSE stream reader.

The split is intentional: `llmRequest.ts:1-7` states that the pure module "contains NO Zotero globals and NO config imports so it can be unit-tested under plain Node without a Zotero sandbox," while `llmClient.ts:20-22` notes that "the pure request/response logic lives in `llmRequest.ts` (no Zotero/config deps) so it can be unit-tested under plain Node."

## Why `fetch()` instead of `Zotero.HTTP.request`

This is the central design decision of the layer and is documented at `llmClient.ts:11-18` and reiterated at `llmClient.ts:114-122`:

> Network access goes through `fetch()` … NOT `Zotero.HTTP.request`. fetch() is used because many LLM endpoints (especially reasoning models like Kimi-K3) hold the connection open without sending data while "thinking"; `Zotero.HTTP.request` (XHR-based, non-streaming) interprets that silence as a timeout, while `fetch()` with streaming keeps the connection alive and reads the response as it arrives.

In other words, reasoning models can sit silent on the wire for tens of seconds before emitting the first token. XHR-based `Zotero.HTTP.request` has no way to distinguish "the server is still thinking" from "the connection is dead," so it times out. `fetch()` returns a `Response` whose `body` is a `ReadableStream`; reading it keeps the TCP connection alive and yields bytes as soon as the server sends them. This is also what enables the live reasoning-trace capture described below.

The `fetch` implementation is resolved defensively at call time (`llmClient.ts:135-141`):

```ts
const fetchFn =
  (Zotero as any).getMainWindow?.()?.fetch ??
  (globalThis as any).fetch;
if (!fetchFn) {
  throw new Error("fetch() is not available in this environment.");
}
```

It prefers the window-scoped `fetch` from Zotero's main window and falls back to `globalThis.fetch`. If neither exists the call throws a clear error rather than a `TypeError` on `undefined`.

## The `LLMRequest` config interface (`llmRequest.ts`)

All request-shape types live in `llmRequest.ts` so they can be reused and re-exported.

### `ChatRole` and `ChatMessage` (`llmRequest.ts:9-14`)

```ts
export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}
```

A minimal message type. Only `content: string` is supported — no multimodal parts — which keeps the body construction trivial (`llmRequest.ts:116, 135`).

**`ChatMessage` Fields:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `role` | `ChatRole` | Yes | Sender role: `"system"`, `"user"`, or `"assistant"`. |
| `content` | `string` | Yes | The message text. Multimodal parts are not supported. |

### `ChatOptions` (`llmRequest.ts:16-21`)

```ts
export interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
  /** OpenAI reasoning_effort parameter (e.g. "low", "medium", "high"). */
  reasoning_effort?: string;
}
```

Per-call overrides. Note `reasoning_effort` here is an alternative to the settings-level `reasoningEffort` field; the settings level is what is actually wired into the body today (see `buildRequest`).

**`ChatOptions` Fields:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `temperature` | `number` | No | Sampling temperature. Only wired into the OpenAI-compatible body. |
| `max_tokens` | `number` | No | Per-call output-token cap; overrides `LlmSettings.maxTokens`. |
| `reasoning_effort` | `string` | No | OpenAI `reasoning_effort` value (e.g. `"low"`, `"medium"`, `"high"`). Currently unused by `buildRequest` — kept for future use. |

### `Provider` (`llmRequest.ts:23`)

```ts
export type Provider = "auto" | "openai" | "anthropic";
```

`auto` is resolved to a concrete provider at request-build time by `resolveProvider`.

### `LlmSettings` (`llmRequest.ts:25-36`)

```ts
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
```

This is the full LLM configuration surface. Each field maps to a Zotero preference read by `getSettings()` in `llmClient.ts` (see below). Of note:

- `endpoint` is the user-supplied URL, **not necessarily the full chat-completions URL** — `normalizeEndpoint` will append the right path.
- `maxTokens` is the default output-token cap; per-call `ChatOptions.max_tokens` overrides it.
- `timeoutSeconds` is part of the interface but is **not enforced** by `chatComplete` — the current implementation relies on the host `fetch`'s default timeout behaviour. It is preserved on the interface for future use and for surfacing in the settings UI.
- `reasoningEffort` is `"none"` to mean "omit the parameter"; any other value (`"low"`, `"medium"`, `"high"`) is forwarded as `reasoning_effort` in the OpenAI body (`llmRequest.ts:147-149`).

**`LlmSettings` Fields:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `endpoint` | `string` | Yes | User-supplied endpoint URL (base or full path); normalized by `normalizeEndpoint`. |
| `apiKey` | `string` | Yes | API key. Not validated by `buildRequest` — an empty key surfaces as an HTTP 401 upstream. |
| `model` | `string` | Yes | Model identifier. Validated as non-empty by `buildRequest`. |
| `provider` | `Provider` | Yes | `"auto"`, `"openai"`, or `"anthropic"`. `"auto"` is resolved by `resolveProvider`. |
| `maxTokens` | `number` | Yes | Default output-token cap. Overridden per-call by `ChatOptions.max_tokens`. |
| `timeoutSeconds` | `number` | Yes | Request timeout in seconds. Read into the interface but **not enforced** by `chatComplete`. |
| `reasoningEffort` | `string` | Yes | `"none"` to omit, or `"low"`/`"medium"`/`"high"` to forward as `reasoning_effort`. |

### `PreparedRequest` (`llmRequest.ts:38-44`)

```ts
export interface PreparedRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  provider: "openai" | "anthropic";
}
```

The output of `buildRequest` — a fully-formed, ready-to-`fetch` request. `provider` is the **resolved** provider (never `"auto"`), which is why `chatComplete` uses `prepared.provider` to drive SSE parsing.

**`PreparedRequest` Fields:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | `string` | Yes | Normalized, full request URL. |
| `method` | `"POST"` | Yes | HTTP method; always `POST`. |
| `headers` | `Record<string, string>` | Yes | Provider-specific auth and content-type headers. |
| `body` | `string` | Yes | JSON-stringified request body. |
| `provider` | `"openai" \| "anthropic"` | Yes | Resolved provider (never `"auto"`); drives SSE parsing. |

### `ANTHROPIC_API_VERSION` (`llmRequest.ts:46`)

```ts
export const ANTHROPIC_API_VERSION = "2023-06-01";
```

Sent as the `anthropic-version` header for Anthropic requests (`llmRequest.ts:125`). Re-exported from `llmClient.ts:389` so consumers do not need to depend on `llmRequest` directly.

## Provider resolution

### normalizeProvider

Coerces arbitrary pref strings into the `Provider` union.

```ts
export function normalizeProvider(value: string): Provider
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `value` | `string` | Yes | Raw preference string to coerce. |

**Returns:** `Provider` — `"openai"` or `"anthropic"` if `value` matches exactly, otherwise `"auto"`.

**Throws:** None.

```ts
export function normalizeProvider(value: string): Provider {
  if (value === "openai" || value === "anthropic") return value;
  return "auto";
}
```

Source: `llmRequest.ts:48-51`. Anything that is not exactly `"openai"` or `"anthropic"` collapses to `"auto"`. Used by `getSettings()` at `llmClient.ts:95`.

### resolveProvider

Resolves the effective provider, applying the `auto` rule based on the endpoint URL.

```ts
export function resolveProvider(
  provider: Provider,
  endpoint: string,
): "openai" | "anthropic"
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `provider` | `Provider` | Yes | The provider setting; `"auto"` triggers endpoint-based resolution. |
| `endpoint` | `string` | Yes | The endpoint URL, inspected for `anthropic.com`. |

**Returns:** `"openai" | "anthropic"` — the concrete provider to use.

**Throws:** None.

```ts
export function resolveProvider(
  provider: Provider,
  endpoint: string,
): "openai" | "anthropic" {
  if (provider === "openai" || provider === "anthropic") return provider;
  return endpoint.toLowerCase().includes("anthropic.com")
    ? "anthropic"
    : "openai";
}
```

Source: `llmRequest.ts:57-65`. The `auto` rule: if the endpoint hostname contains `anthropic.com`, treat it as Anthropic; otherwise default to OpenAI-compatible. This is a deliberate, conservative heuristic — most third-party OpenAI-compatible gateways (DeepSeek, Moonshot/Kimi, local vLLM, etc.) do not contain `anthropic.com` in their URL, so they correctly fall into the OpenAI bucket. Users who point at an Anthropic-compatible proxy that does not live under `anthropic.com` must set `provider` explicitly to `"anthropic"`.

### normalizeEndpoint

Normalizes the endpoint URL for the given provider, appending the correct path when the endpoint doesn't already end with it.

```ts
export function normalizeEndpoint(
  endpoint: string,
  provider: "openai" | "anthropic",
): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `endpoint` | `string` | Yes | User-supplied endpoint URL (base or full). Trailing slashes are stripped first. |
| `provider` | `"openai" \| "anthropic"` | Yes | Resolved provider; selects the path convention. |

**Returns:** `string` — the normalized, full request URL.

**Throws:** None.

```ts
export function normalizeEndpoint(
  endpoint: string,
  provider: "openai" | "anthropic",
): string {
  const trimmed = endpoint.replace(/\/+$/, ""); // strip trailing slashes
  if (provider === "anthropic") {
    if (/\/v1\/messages$/.test(trimmed)) return trimmed;
    if (/\/v1$/.test(trimmed)) return trimmed + "/messages";
    return trimmed + "/v1/messages";
  }
  // openai-compatible
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return trimmed + "/chat/completions";
  return trimmed + "/v1/chat/completions";
}
```

Source: `llmRequest.ts:75-91`. This is the URL-forgiveness layer. Users typically paste a base URL like `https://api.openai.com/v1` or `https://api.example.com/v1` rather than the full chat-completions or messages path. `normalizeEndpoint` accepts any of:

| User input                                  | Provider   | Resolved URL                                          |
|---------------------------------------------|------------|-------------------------------------------------------|
| `https://api.openai.com/v1`                 | openai     | `…/v1/chat/completions`                               |
| `https://api.openai.com/v1/chat/completions`| openai     | `…/v1/chat/completions` (unchanged)                   |
| `https://api.example.com`                   | openai     | `…/v1/chat/completions`                               |
| `https://api.anthropic.com/v1`              | anthropic  | `…/v1/messages`                                       |
| `https://api.anthropic.com/v1/messages`     | anthropic  | `…/v1/messages` (unchanged)                           |
| `https://api.anthropic.com`                 | anthropic  | `…/v1/messages`                                       |

Trailing slashes are stripped first (`endpoint.replace(/\/+$/, "")`) so `https://api.openai.com/v1/` is treated the same as `https://api.openai.com/v1`. The function is idempotent: passing an already-normalized URL returns it unchanged.

## Building the request body — `buildRequest` (`llmRequest.ts:97-160`)

### buildRequest

Builds the request object (URL, headers, JSON body) for a chat completion WITHOUT making any network call. This is the unit-testable core.

```ts
export function buildRequest(
  messages: ChatMessage[],
  settings: LlmSettings,
  options: ChatOptions = {},
): PreparedRequest
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `messages` | `ChatMessage[]` | Yes | Conversation messages to send. |
| `settings` | `LlmSettings` | Yes | LLM settings; `endpoint` and `model` must be non-empty. |
| `options` | `ChatOptions` | No | Per-call overrides. Defaults to `{}`. |

**Returns:** `PreparedRequest` — a fully-formed, ready-to-`fetch` request with the resolved provider.

**Throws:** `Error` with message `"LLM endpoint URL is not configured."` if `settings.endpoint` is empty (`llmRequest.ts:105`), or `"LLM model is not configured."` if `settings.model` is empty (`llmRequest.ts:108`). Note that **`apiKey` is not validated here** — an empty key is allowed through so the resulting HTTP 401 surfaces as a clear upstream error message in `chatComplete`.

It:

1. Resolves the provider (`resolveProvider`).
2. Validates that `settings.endpoint` and `settings.model` are non-empty, throwing `"LLM endpoint URL is not configured."` (`llmRequest.ts:105`) or `"LLM model is not configured."` (`llmRequest.ts:108`) otherwise. Note that **`apiKey` is not validated here** — an empty key is allowed through so the resulting HTTP 401 surfaces as a clear upstream error message in `chatComplete`.
3. Normalizes the URL via `normalizeEndpoint`.
4. Builds the provider-specific body and headers.

#### Anthropic body (`llmRequest.ts:113-130`)

```ts
const body = {
  model: settings.model,
  messages: messages.map((m) => ({ role: m.role, content: m.content })),
  max_tokens: options.max_tokens ?? settings.maxTokens ?? 1024,
};
```

Headers:

```
Content-Type: application/json
x-api-key: <settings.apiKey>
anthropic-version: 2023-06-01
```

Notable choices:
- `max_tokens` is **required** by the Anthropic API, so the fallback chain `options.max_tokens ?? settings.maxTokens ?? 1024` always produces a number.
- No `temperature` is sent for Anthropic (the field exists on `ChatOptions` but is only wired into the OpenAI branch). This avoids sending a parameter that Anthropic models may reject for reasoning-style calls.
- No `stream: true` is set for Anthropic — the body is built for non-streaming. The streaming behaviour in `chatComplete` is driven by the response `Content-Type`, not by the request body.

#### OpenAI-compatible body (`llmRequest.ts:132-160`)

```ts
const body = {
  model: settings.model,
  messages: messages.map((m) => ({ role: m.role, content: m.content })),
  stream: true,
};
if (typeof options.temperature === "number") body.temperature = options.temperature;
const effectiveMaxTokens = options.max_tokens ?? settings.maxTokens;
if (typeof effectiveMaxTokens === "number" && effectiveMaxTokens > 0) {
  body.max_tokens = effectiveMaxTokens;
}
if (settings.reasoningEffort && settings.reasoningEffort !== "none") {
  body.reasoning_effort = settings.reasoningEffort;
}
```

Headers:

```
Content-Type: application/json
Authorization: Bearer <settings.apiKey>
```

Key decisions:
- **`stream: true` is hardcoded** for the OpenAI path (`llmRequest.ts:137`). This is the lever that makes reasoning models like Kimi-K3 survivable: even if the caller does not care about chunks, streaming keeps the connection alive so the host does not time out during the silent "thinking" phase. The downside — the response is now SSE and must be parsed by `readSSEStream` rather than `parseResponse` — is handled by content-type sniffing in `chatComplete`.
- `max_tokens` is only added when `effectiveMaxTokens > 0`. This lets callers omit it (e.g. some reasoning models reject `max_tokens` in favour of `reasoning_effort`).
- `reasoning_effort` comes from `settings.reasoningEffort`, not `options.reasoning_effort`. The per-call option exists on the type for future use but is currently unused.

## Parsing a non-streaming response — `parseResponse` (`llmRequest.ts:165-189`)

### parseResponse

Extracts the assistant text from a full provider response body.

```ts
export function parseResponse(
  provider: "openai" | "anthropic",
  responseText: string,
): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `provider` | `"openai" \| "anthropic"` | Yes | Resolved provider; selects the response shape to extract from. |
| `responseText` | `string` | Yes | The raw response body text (envelope-wrapped JSON). |

**Returns:** `string` — the extracted assistant text. For Anthropic, `String(content[0]?.text ?? "")`; for OpenAI, `String(choices[0]?.message?.content ?? "")`.

**Throws:** `Error` with message `"LLM response was not valid JSON: …"` if the body is not valid JSON (`llmRequest.ts:174`); `"Anthropic response had no content array."` if Anthropic's `content` is missing/empty; `"OpenAI response had no choices array."` if OpenAI's `choices` is missing/empty.

Source: `llmRequest.ts:165-189`. Extracts the assistant text from a full JSON response body. Throws if the body is not valid JSON (`"LLM response was not valid JSON: …"`, `llmRequest.ts:174`) or if the expected shape is missing:

- Anthropic: requires `data.content` to be a non-empty array; returns `String(content[0]?.text ?? "")` (`llmRequest.ts:177-183`).
- OpenAI: requires `data.choices` to be a non-empty array; returns `String(choices[0]?.message?.content ?? "")` (`llmRequest.ts:184-188`).

### `parseResponse` vs. direct-content (the streaming distinction)

This is a subtle but important point. There are **two different "extract the text" code paths**, and they are not interchangeable:

- **`parseResponse`** is for non-streaming responses. It parses `{"choices":[{"message":{"content":"…"}}]}` (OpenAI) or `{"content":[{"text":"…"}]}` (Anthropic) — i.e. the response is wrapped in an API envelope and the message content is nested under `message.content` / `content[0].text`.
- **`readSSEStream`** returns the **accumulated delta content directly**, with no envelope. Each SSE chunk is `{"choices":[{"delta":{"content":"…"}}]}` and the function concatenates the `delta.content` strings into one string. When `chatComplete` takes the streaming branch (`llmClient.ts:181-185`), the returned `content` is already the final assistant text — it must **not** be passed through `parseResponse` again.

The non-streaming branch (`llmClient.ts:197-202`) does call `parseResponse`, because the body is still envelope-wrapped JSON. Mixing the two would either double-decode or fail to find `choices`/`content`.

## Reading preferences — `getSettings` and friends (`llmClient.ts`)

### safeGetPref

Reads a string Zotero preference, returning `""` if the pref is missing or the read throws.

```ts
function safeGetPref(key: string): string
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `key` | `string` | Yes | Full preference key (including prefix). |

**Returns:** `string` — the preference value, or `""` if missing or thrown.

**Throws:** None — all errors are caught internally.

```ts
function safeGetPref(key: string): string {
  try {
    return (Zotero.Prefs.get(key, true) as string | undefined) || "";
  } catch {
    return "";
  }
}
```

Source: `llmClient.ts:67-73`. The comment at `llmClient.ts:62-66` explains the bug this guards against:

> Wraps each read in try/catch because `Zotero.Prefs.get` throws if the pref doesn't exist (the `|| ""` fallback only catches `undefined`, not thrown errors).

Without the try/catch, the very first call to `getSettings()` on a fresh install (where no prefs exist yet) would throw an unhandled exception. The `|| ""` only handles the case where `Zotero.Prefs.get` returns `undefined` for a missing pref, which is not what happens in practice — it throws.

### safeGetInt

Parses an integer Zotero preference with a default fallback.

```ts
function safeGetInt(key: string, defaultValue: number): number
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `key` | `string` | Yes | Full preference key (including prefix). |
| `defaultValue` | `number` | Yes | Value to return if the pref is missing, non-numeric, or non-positive. |

**Returns:** `number` — the parsed integer, or `defaultValue` if non-numeric/non-positive.

**Throws:** None.

```ts
function safeGetInt(key: string, defaultValue: number): number {
  const raw = safeGetPref(key);
  const n = parseInt(raw, 10);
  return isNaN(n) || n <= 0 ? defaultValue : n;
}
```

Source: `llmClient.ts:77-81`. Anything non-numeric or non-positive falls back to the default — this means a user who types `0` or `-1` into the timeout field gets the default rather than a broken value.

### getSettings

Reads the full LLM configuration from Zotero preferences and assembles an `LlmSettings` object.

```ts
export function getSettings(): LlmSettings
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| (none) | — | — | No parameters. |

**Returns:** `LlmSettings` — the assembled settings, with `provider` coerced via `normalizeProvider`.

**Throws:** None — preference reads are wrapped in `safeGetPref`/`safeGetInt`.

```ts
export function getSettings(): LlmSettings {
  const endpoint = safeGetPref(`${PREFS_PREFIX}.endpoint`);
  const apiKey = safeGetPref(`${PREFS_PREFIX}.apiKey`);
  const model = safeGetPref(`${PREFS_PREFIX}.model`);
  const providerPref = safeGetPref(`${PREFS_PREFIX}.provider`) || "auto";
  const maxTokens = safeGetInt(`${PREFS_PREFIX}.maxTokens`, 16384);
  const timeoutSeconds = safeGetInt(`${PREFS_PREFIX}.timeoutSeconds`, 300);
  const reasoningEffort = safeGetPref(`${PREFS_PREFIX}.reasoningEffort`) || "none";
  return { endpoint, apiKey, model, provider: normalizeProvider(providerPref),
           maxTokens, timeoutSeconds, reasoningEffort };
}
```

Source: `llmClient.ts:83-100`. `PREFS_PREFIX` comes from `package.json`'s `prefsPrefix` via `import { config } from "../../package.json"` (`llmClient.ts:24, 60`). Defaults:

| Pref                   | Default   | Notes                                            |
|------------------------|-----------|--------------------------------------------------|
| `endpoint`             | `""`      | No default; user must configure.                 |
| `apiKey`               | `""`      | No default; user must configure.                 |
| `model`                | `""`      | No default; user must configure.                 |
| `provider`             | `"auto"`  | Resolved at request time.                        |
| `maxTokens`            | `16384`   | Generous default for reasoning-model outputs.    |
| `timeoutSeconds`       | `300`     | 5 minutes; not currently enforced in `chatComplete`. |
| `reasoningEffort`      | `"none"`  | Omit `reasoning_effort` from the body by default.|

## `chatComplete` (`llmClient.ts:123-203`)

### chatComplete

Sends a chat completion request and returns the assistant message text. The main public entry point of the LLM client.

```ts
export async function chatComplete(
  messages: ChatMessage[],
  options?: ChatOptions,
  onChunk?: ChunkCallback,
): Promise<string>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `messages` | `ChatMessage[]` | Yes | Conversation messages to send. |
| `options` | `ChatOptions` | No | Per-call overrides (temperature, max_tokens, reasoning_effort). |
| `onChunk` | `ChunkCallback` | No | Streaming-delta callback; only invoked on the streaming branch. |

**Returns:** `Promise<string>` — the assistant message text. For streaming responses, the accumulated `delta.content` (or the Kimi-K3 reasoning fallback); for non-streaming, the result of `parseResponse`.

**Throws:** `Error("fetch() is not available in this environment.")` if no `fetch` implementation is found (`llmClient.ts:140`); `Error("LLM request failed (network error): …")` (truncated to 1000 chars) on a network failure (`llmClient.ts:154-156`); `Error("LLM endpoint returned HTTP <status>: <body>")` (body truncated to 500 chars) on a non-2xx response (`llmClient.ts:164-166`); `Error("LLM streaming response was empty.")` if a streaming response yields empty/whitespace content (`llmClient.ts:188`). Also re-throws any error from `parseResponse` on the non-streaming branch.

Source: `llmClient.ts:123-203`. Steps:

1. Read settings and build the prepared request (`llmClient.ts:128-129`).
2. Log the entry (`llmClient.ts:130-133`) with provider, model, and message count.
3. Resolve `fetch` and bail clearly if it is missing (`llmClient.ts:135-141`).
4. `await fetchFn(prepared.url, { method: "POST", headers, body })` (`llmClient.ts:145-149`). Network errors are caught, logged (truncated to 500 chars), and re-thrown as `"LLM request failed (network error): …"` (truncated to 1000 chars) — see `llmClient.ts:150-157`. The truncation is deliberate: some LLM error responses are multi-megabyte HTML pages.
5. If `!response.ok`, read the error body, log the first 300 chars, and throw `"LLM endpoint returned HTTP <status>: <body>"` (first 500 chars) — `llmClient.ts:159-167`.
6. Sniff the `Content-Type` (`llmClient.ts:170-173`). `isStreaming` is true if it contains `text/event-stream` **or** `octet-stream`. The `octet-stream` match handles providers that send SSE framing under a binary content type.
7. **Streaming branch** (`llmClient.ts:175-194`): call `readSSEStream(response.body, prepared.provider, onChunk)`. The returned `content` is the final assistant text directly. If it is empty or whitespace, throw `"LLM streaming response was empty."` (`llmClient.ts:188`) — this catches the failure mode where the connection succeeded but produced no usable output.
8. **Non-streaming branch** (`llmClient.ts:196-202`): `await response.text()`, then `parseResponse(prepared.provider, responseText)`.

The `onChunk` callback is only invoked on the streaming branch; non-streaming responses do not emit chunks.

### `ChunkCallback` (`llmClient.ts:48-58`)

```ts
export type ChunkCallback = (
  kind: "content" | "reasoning",
  text: string,
) => void;
```

The callback receives **per-chunk deltas**, not the accumulated text. `kind` discriminates between:

- `"content"` — normal assistant output (`delta.content` for OpenAI, `delta.text` for Anthropic).
- `"reasoning"` — a reasoning model's thinking trace. For OpenAI this is `delta.reasoning_content` or `delta.reasoning` (see below); for Anthropic it is a `thinking_delta` event.

The UI uses this to render a live "thinking…" indicator while the model works, without waiting for the full response. The callback is optional; if omitted, the streaming path still runs (it just does not invoke anything per chunk), because the point of streaming is also to keep the connection alive — not only to surface incremental output.

## `readSSEStream` (`llmClient.ts:209-353`)

### readSSEStream

Reads an SSE (Server-Sent Events) stream from an OpenAI-compatible or Anthropic endpoint and accumulates the assistant message content. Module-private (not exported).

```ts
async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  provider: "openai" | "anthropic",
  onChunk?: ChunkCallback,
): Promise<string>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `body` | `ReadableStream<Uint8Array>` | Yes | The `Response.body` readable stream to decode. |
| `provider` | `"openai" \| "anthropic"` | Yes | Resolved provider; selects the SSE event-shape parsing branch. |
| `onChunk` | `ChunkCallback` | No | Per-chunk delta callback for content/reasoning. |

**Returns:** `Promise<string>` — the accumulated assistant content. Falls back to `reasoningAccumulated` if content is empty but reasoning has data (Kimi-K3 fallback).

**Throws:** None — malformed JSON chunks are caught and logged; the reader lock is released in `finally`.

Source: `llmClient.ts:209-353`. The SSE decoder. It is module-private (not exported). Returns the accumulated assistant content as a string.

### State

```ts
const reader = body.getReader();
const decoder = new TextDecoder("utf-8");
let buffer = "";
let accumulated = "";          // delta.content (the real answer)
let chunkCount = 0;
let reasoningChars = 0;
let reasoningAccumulated = ""; // delta.reasoning_content (the thinking trace)
let lastYield = Date.now();
```

Two separate accumulators are kept: `accumulated` for content and `reasoningAccumulated` for the reasoning trace. This is what makes the reasoning/content split observable to the `onChunk` callback, and it is also the basis for the Kimi-K3 fallback described below.

### UI yielding (`llmClient.ts:231-239`)

```ts
if (Date.now() - lastYield > 16) {
  await new Promise<void>((r) => setTimeout(r, 0));
  lastYield = Date.now();
}
```

The comment at `llmClient.ts:232-235` is explicit about why this is a `setTimeout(0)` macrotask and not `Promise.resolve()`:

> A microtask (Promise.resolve) would not give the paint/input queue a turn and the Zotero window would still freeze on fast streams. Throttled to ~16ms (one frame) so fast streams aren't slowed.

So on fast streams the loop yields to the host roughly once per frame, keeping the Zotero window responsive. On slow reasoning streams (where chunks arrive seconds apart) the yield is a no-op because `lastYield` is already stale.

### Line splitting (`llmClient.ts:241-249`)

```ts
buffer += decoder.decode(value, { stream: true });
const lines = buffer.split("\n");
buffer = lines.pop() ?? ""; // Keep the last partial line in the buffer.
```

`{ stream: true }` tells `TextDecoder` to hold on to a partial multi-byte UTF-8 sequence at the end of the chunk rather than emitting a replacement character. Splitting on `"\n"` and popping the last element keeps any trailing partial line in `buffer` for the next iteration — SSE events are `\n`-delimited and a chunk boundary can fall in the middle of a line.

Empty lines and lines starting with `":"` (SSE comments, used as keep-alives) are skipped (`llmClient.ts:248-249`).

### `data: [DONE]` (`llmClient.ts:251-265`)

The OpenAI stream terminator. On encountering it, the reader is cancelled, totals are logged, and one of two values is returned:

```ts
if (accumulated.length === 0 && reasoningAccumulated.length > 0) {
  return reasoningAccumulated;
}
return accumulated;
```

This is the **Kimi-K3 fallback**. The comment at `llmClient.ts:258-263` explains:

> If content is empty but reasoning has data, use reasoning as the output. Some reasoning models (e.g. Kimi-K3) put their entire answer in `reasoning_content`.

Without this fallback, a Kimi-K3 call would return an empty string and the caller would throw `"LLM streaming response was empty."` even though the model actually produced a full answer — just in the wrong field. The same fallback is repeated at `llmClient.ts:348-351` for the case where the stream ends without an explicit `[DONE]`.

### Per-chunk parsing

#### Anthropic (`llmClient.ts:272-279`)

```ts
if (chunk?.delta?.type === "thinking_delta" && chunk?.delta?.thinking) {
  onChunk?.("reasoning", chunk.delta.thinking);
} else if (chunk?.delta?.text) {
  accumulated += chunk.delta.text;
  onChunk?.("content", chunk.delta.text);
}
```

Anthropic SSE events look like `{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}` or `{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"…"}}`. Only `text` accumulates into the return value; `thinking` is forwarded to `onChunk` only (it does not contribute to the returned content, which is the correct behaviour for Anthropic — the answer is in `text`, not in `thinking`).

Note the asymmetry with the OpenAI/Kimi path: for Anthropic the reasoning trace is **never** used as a fallback for the content. This matches the providers' actual contracts — Anthropic separates thinking from answer at the event level, while Kimi-K3 stuffs everything into `reasoning_content`.

#### OpenAI-compatible (`llmClient.ts:280-308`)

```ts
const delta = chunk?.choices?.[0]?.delta;
if (chunkCount === 1) {
  // log the first chunk's delta keys + content for diagnostics
}
if (delta?.reasoning_content) {
  onChunk?.("reasoning", delta.reasoning_content);
  reasoningAccumulated += delta.reasoning_content;
  reasoningChars += delta.reasoning_content.length;
} else if (delta?.reasoning) {
  onChunk?.("reasoning", delta.reasoning);
  reasoningAccumulated += delta.reasoning;
  reasoningChars += delta.reasoning.length;
}
if (delta?.content) {
  accumulated += delta.content;
  onChunk?.("content", delta.content);
}
```

Two reasoning field names are supported:
- `delta.reasoning_content` — used by Kimi-K3 and several OpenAI-compatible reasoning models.
- `delta.reasoning` — used by some other providers.

The `else if` between them is deliberate. The comment at `llmClient.ts:297-299` says:

> Some providers use `reasoning` instead of `reasoning_content`. Guarded with `else if` so a delta carrying both fields is not double-counted into the accumulated reasoning text.

The `delta.content` check is a separate `if` (not `else if`), because a single chunk can carry both reasoning and content — they are not mutually exclusive.

The first-chunk logging (`llmClient.ts:284-287`) is a diagnostic aid: it dumps the delta's keys and a 500-char preview so that when a new provider's reasoning field has an unexpected name, the developer can see it in the Zotero debug output without recompiling.

### Fallback for non-SSE responses (`llmClient.ts:315-340`)

Two related fallbacks exist because some servers **ignore `stream: true`** and return a plain JSON body, even though the request asked for streaming:

1. **Lines that are not `data:`-prefixed** (`llmClient.ts:315-320`): if no SSE chunks have been parsed yet and `accumulated` is empty, the line is appended to `accumulated` as raw text. This lets a non-SSE JSON body accumulate so it can be parsed after the loop.

2. **End of stream with zero SSE chunks** (`llmClient.ts:330-340`): try `JSON.parse(accumulated)` and extract `choices[0].message.content` (the OpenAI non-streaming shape). If that fails, return `accumulated` as-is and let the caller's downstream JSON parser handle it (or fail with a clearer error).

These fallbacks make `readSSEStream` resilient to misconfigured proxies that strip the `Content-Type: text/event-stream` header or unconditionally buffer the response.

### Cleanup (`llmClient.ts:323-325`)

```ts
} finally {
  reader.releaseLock();
}
```

The reader lock is released in `finally` so it is freed even if an exception escapes the loop. `reader.cancel()` is also called explicitly on `[DONE]` (`llmClient.ts:252`).

## `testConnection` (`llmClient.ts:359-386`)

### testConnection

Sends a trivial ping to verify connectivity and credentials. Used by the settings pane "Test connection" button.

```ts
export async function testConnection(): Promise<{
  ok: boolean;
  message: string;
}>
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| (none) | — | — | No parameters. Reads settings via `getSettings()`. |

**Returns:** `Promise<{ ok: boolean; message: string }>` — `{ ok: true, message: "Connection successful. Reply: <preview>" }` on success, or `{ ok: false, message: "…" }` for missing config or any thrown error.

**Throws:** None — all errors are caught and returned as `{ ok: false, message }`.

Source: `llmClient.ts:359-386`. Validates that `endpoint`, `apiKey`, and `model` are set (returning a clear `{ ok: false, message: "…" }` for each missing field), then sends a trivial `[{ role: "user", content: "ping" }]` request with `max_tokens: 16`. The reply is whitespace-collapsed and truncated to 120 chars for display:

```ts
const preview = reply.replace(/\s+/g, " ").trim().slice(0, 120);
return { ok: true, message: `Connection successful. Reply: ${preview || "(empty)"}` };
```

On any thrown error it returns `{ ok: false, message: (e as Error).message }`, so the underlying network/HTTP/parse error surfaces verbatim to the user.

## Module surface and re-exports

`llmClient.ts` re-exports the pure module's public surface so consumers can import everything from one path:

```ts
// llmClient.ts:38-46
export type { ChatMessage, ChatOptions, LlmSettings, PreparedRequest, Provider, ChatRole } from "./llmRequest";
export { buildRequestPure, normalizeProvider, parseResponse, resolveProvider } from "./llmRequest";
export { ANTHROPIC_API_VERSION };
```

Note `buildRequestPure` is exported under that aliased name (the pure module calls it `buildRequest`). The wrapper in `llmClient.ts` (`llmClient.ts:106-112`) re-exposes it as `buildRequest` for callers who want to build a request without sending it.

### buildRequest (re-export wrapper)

Builds the request object (URL, headers, JSON body) for a chat completion WITHOUT making any network call. Re-exported pure function wrapper.

```ts
export function buildRequest(
  messages: ChatMessage[],
  settings: LlmSettings,
  options?: ChatOptions,
): PreparedRequest
```

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `messages` | `ChatMessage[]` | Yes | Conversation messages to send. |
| `settings` | `LlmSettings` | Yes | LLM settings; `endpoint` and `model` must be non-empty. |
| `options` | `ChatOptions` | No | Per-call overrides. |

**Returns:** `PreparedRequest` — a fully-formed, ready-to-`fetch` request with the resolved provider.

**Throws:** `Error` if `settings.endpoint` or `settings.model` is empty (delegated to `buildRequestPure`).

Source: `llmClient.ts:106-112`. This is a thin pass-through to `buildRequestPure` (the pure module's `buildRequest`), re-exposed so consumers importing from `llmClient` get a `buildRequest` symbol.

`safeGetPref` is also exported (`llmClient.ts:75`) for use by other modules that need the same defensive pref-reading pattern.

## How to extend

### Add a new provider

1. Add the provider name to the `Provider` union in `llmRequest.ts:23` and to the `"openai" | "anthropic"` result type used by `resolveProvider`, `normalizeEndpoint`, `buildRequest`, `parseResponse`, and `readSSEStream`'s `provider` parameter. (Today these are all hard-coded to the two providers; a third would touch all of them.)
2. Add a branch in `resolveProvider` (or extend the `auto` heuristic).
3. Add a branch in `normalizeEndpoint` for the new provider's path convention.
4. Add a branch in `buildRequest` for the request body and auth headers.
5. Add a branch in `parseResponse` for the non-streaming response shape.
6. Add a branch in `readSSEStream` for the streaming event shape, including any reasoning-trace field name.

The cleanest refactor would be to introduce a `ProviderAdapter` interface with methods `normalizeEndpoint`, `buildBody`, `parseFullResponse`, `parseStreamChunk`, and dispatch through a registry rather than `if (provider === "anthropic")` chains — but the current two-provider world does not yet justify that indirection.

### Support a new reasoning field name

If a provider exposes its thinking trace under a different field (say `delta.thinking`), add it to the `else if` chain at `llmClient.ts:288-303`. The first-chunk debug log at `llmClient.ts:284-287` is the fastest way to discover the field name for a new provider — run one request and inspect the Zotero debug output.

### Enforce `timeoutSeconds`

`timeoutSeconds` is read into `LlmSettings` but not currently applied. To enforce it, wrap the `fetchFn(...)` call at `llmClient.ts:145-149` in a `Promise.race` against a `setTimeout`-driven rejection, or use `AbortController`:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), settings.timeoutSeconds * 1000);
try {
  response = await fetchFn(prepared.url, { ..., signal: controller.signal });
} finally {
  clearTimeout(timer);
}
```

`AbortController` is preferable because it also cancels the in-flight stream, where most reasoning-model time is actually spent.

### Capture reasoning in non-streaming mode

Today reasoning traces are only captured via `onChunk` on the streaming path. If a provider returns reasoning in non-streaming mode (e.g. `choices[0].message.reasoning_content`), `parseResponse` currently ignores it. To surface it, change `parseResponse`'s return type to `{ content: string; reasoning?: string }` and update `chatComplete`'s non-streaming branch accordingly — being careful not to break callers that expect a plain `string`. The Kimi-K3 fallback at `llmClient.ts:260-263` would then apply to non-streaming responses too.
