# Zotero Smart Organizer

[![GitHub release](https://img.shields.io/github/v/release/Roller44/zotero-llm-categorizer?style=flat-square&logo=github)](https://github.com/Roller44/zotero-llm-categorizer/releases)
[![Zotero 7+](https://img.shields.io/badge/Zotero-7%2B-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

**LLM-powered library categorization for [Zotero](https://www.zotero.org/).** Zotero Smart Organizer reads your library, asks an LLM to propose a hierarchical taxonomy and classify every item into it, then lets you review the plan and apply or revert the changes — all from inside Zotero, with no data leaving your machine except the prompts sent to your configured LLM endpoint.

<!-- TODO: add screenshots -->

## Features

- **Two-stage categorization pipeline.** Stage 1 proposes a hierarchical taxonomy (8–15 top-level areas, max depth 3) from a sample of your library; Stage 2 classifies every item into that taxonomy in batches. See `src/modules/categorizer.ts:49`.
- **Streaming with reasoning display.** The LLM client reads SSE streams and surfaces the model's thinking trace (`reasoning_content` / `thinking_delta`) live in the review window while it works. See `src/modules/llmClient.ts:183` and `src/modules/organizerUI.ts:118`.
- **Review before you commit.** A dedicated review window shows the proposed taxonomy tree, per-collection item counts, and confidence badges (high/medium/low) for every assignment — nothing is written until you click **Apply**. See `src/modules/organizerUI.ts:301`.
- **One-click revert.** Before applying, a snapshot of every item's collection memberships is captured. **Revert** restores the library to its pre-apply state and deletes collections created by the apply (if now empty). See `src/modules/organizerUI.ts:559`.
- **Custom prompts.** Override the default taxonomy and classification system prompts from the settings pane — leave a field empty to use the built-in default. See `src/modules/promptBuilder.ts:77` and `addon/content/preferences.xhtml:127`.
- **OpenAI & Anthropic support.** Works with any OpenAI-compatible chat-completions endpoint (OpenAI, Kimi, local servers, etc.) and with Anthropic's `/v1/messages` API. Provider is auto-detected or set manually. See `src/modules/llmClient.ts:1`.
- **Zotero 7+.** Built on the modern Zotero 7 plugin architecture (`strict_min_version: 7.0`, `addon/manifest.json:16`).

## Installation

1. Download the latest `.xpi` from [GitHub Releases](https://github.com/Roller44/zotero-llm-categorizer/releases).
2. In Zotero, open **Tools → Add-ons**.
3. Click the **gear icon** (top-right of the Add-ons Manager) and choose **Install Add-on From File…**.
4. Select the downloaded `.xpi` and confirm the install.
5. Restart Zotero if prompted.

## Usage

1. **Configure LLM settings.** Open **Edit → Settings → Smart Organizer** (Zotero → Settings on macOS) and set your endpoint URL, API key, model name, and provider. Use the **Test connection** button to verify connectivity. See *Configuration* below.
2. **Run the organizer.** Choose **Tools → Smart Organizer: Organize Library**.
3. **Watch it think.** The review window opens in a "generating" state with a live activity log and reasoning trace streamed from the LLM.
4. **Review the plan.** When generation completes, browse the proposed taxonomy tree, click any collection to see its assigned items and confidence levels, and regenerate if you want a different taxonomy.
5. **Apply.** Click **Apply** to create the collections and refile your items. A pre-apply snapshot is captured automatically.
6. **Revert if needed.** Click **Revert** to restore the library to its pre-apply state.

## Configuration

All settings live in **Edit → Settings → Smart Organizer** (`addon/content/preferences.xhtml`).

| Setting | Description | Default |
| --- | --- | --- |
| **Endpoint** | Full chat-completions URL for OpenAI-compatible providers, or full `/v1/messages` URL for Anthropic. | — |
| **API key** | Bearer token (OpenAI) or `x-api-key` (Anthropic). Stored in Zotero prefs. | — |
| **Model** | Model name to send to the provider (e.g. `gpt-4o`, `claude-3-5-sonnet-latest`). | — |
| **Provider** | `openai`, `anthropic`, or auto-detect from the endpoint. | `auto` |
| **Max tokens** | Maximum tokens to request per call. | `16384` |
| **Timeout (seconds)** | Per-request timeout. Reasoning models may need 300s+. | `300` |
| **Reasoning effort** | `none`, `low`, `medium`, or `high`. Controls how much thinking the model does. | `none` |
| **Taxonomy system prompt** | Custom Stage 1 prompt. Empty = use the built-in default. | default |
| **Classification system prompt** | Custom Stage 2 prompt. Empty = use the built-in default. | default |

Defaults are read in `src/modules/llmClient.ts:78` (`getSettings()`).

## Supported LLM providers

- **OpenAI-compatible** — any endpoint that accepts `{ model, messages, temperature?, max_tokens? }` with `Authorization: Bearer <key>` and returns OpenAI-style SSE chunks. Includes OpenAI itself, Moonshot/Kimi, local servers (vLLM, Ollama's OpenAI-compatible mode), and other compatible APIs. The endpoint you set **is** the full chat-completions URL. See `src/modules/llmClient.ts:5`.
- **Anthropic** — the `/v1/messages` API with `x-api-key` and `anthropic-version` headers. Streaming `thinking_delta` chunks are surfaced as reasoning. See `src/modules/llmClient.ts:8`.

## Development

```bash
# Install dependencies
npm install

# Start a dev session (hot-reload into a running Zotero via the scaffold)
npm start

# Build the .xpi for release and type-check
npm run build

# Lint
npm run lint:check
npm run lint:fix

# Run tests
npm test
```

The project uses [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold) for serve/build/release and [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) for the Zotero API layer. The build output is a `.xpi` ready to upload to GitHub Releases.

## License

[MIT](LICENSE) © 2026 Roller44

## Acknowledgments

Built on the [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) and the wider [Zotero plugin ecosystem](https://github.com/windingwind/zotero-plugin-toolkit). The two-stage pipeline, SSE streaming, and review-window design were developed for this project.
