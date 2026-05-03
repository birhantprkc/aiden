# Phase 4 — Completed

**Date:** 2026-05-03
**Branch:** `v4-rewrite`
**Commits:**
- `b7bd8d5` — feat(v4): anthropic + codex + ollama adapters + credential resolver
- `18b3b4e` — test(v4): unit + integration tests for phase 4 providers
- (this file) — docs(v4): phase 4 summary

## Goal

Complete the provider layer. After Phase 4, all four `ApiMode`s in
`providers/v4/types.ts` have working adapters: `chat_completions` (Phase 3),
`anthropic_messages`, `codex_responses`, and `ollama_prompt_tools` (this
phase). Plus `CredentialResolver` for the OAuth-capable modes (refresh
logic stubbed; real OAuth wiring lands Phase 13).

## Hermes pattern summary

**Anthropic Messages.** `POST /v1/messages`. API-key mode → `x-api-key`;
OAuth → `Authorization: Bearer` + `anthropic-beta:
claude-code-20250219,oauth-2025-04-20`. Always `anthropic-version:
2023-06-01`. Top-level `system` (NOT in messages); tool schema uses
`input_schema`. Response `content[]` carries `text` + `tool_use` blocks
(parsed `input`, no JSON.parse). `stop_reason` map: `end_turn|stop_sequence
→ stop`, `tool_use → tool_use`, `max_tokens|model_context_window_exceeded
→ length`. **Empty `content[]` with `stop_reason='end_turn'` is legal** —
adapter returns `''`. Usage carries `cache_creation_input_tokens` /
`cache_read_input_tokens` (→ `cacheWriteTokens` / `cacheReadTokens`).

**Codex Responses.** `POST /v1/responses`. Top-level `instructions`;
`input[]` items: `{type:'message', role, content:[{type:'input_text'|
'output_text'}]}` / `{type:'function_call', name, arguments, call_id}` /
`{type:'function_call_output', call_id, output}`. Flat tools:
`{type:'function', name, description, strict:false, parameters}`. Response
`output[]` mixes `message`, `reasoning`, `function_call`.
`response.status` map: `completed → stop`, `incomplete → length` (when
`incomplete_details.reason === 'max_output_tokens'`), `failed|cancelled →
throw`. **Empty `output[]` + `output_text` backfill** → synthesize message.
Phase 4 skips: reasoning-item replay, prompt_cache_key, ChatGPT OAuth,
backend variants, preflight sanitization.

**Ollama prompt-tools.** Hermes itself has no such mode (Ollama runs
chat_completions). Format adopted verbatim from
`environments/tool_call_parsers/hermes_parser.py` — VLLM/Hermes-2-Pro
`<tool_call>{"name":"...","arguments":{...}}</tool_call>`, proven across
Hermes / Qwen / Llama tool-trained checkpoints. Adapter POSTs to
`/api/chat` with no `tools` field; injects catalog into system prompt;
parses tags from `response.message.content` (regex matches closed +
unclosed/truncated). Multiple blocks → multiple toolCalls; malformed JSON
→ warn + skip. Usage: `prompt_eval_count` / `eval_count`. Tool replies
wrap as `<tool_response id="…">…</tool_response>` user messages.

**Credential resolver.** Single `auth.json` at
`%LOCALAPPDATA%\aiden\auth.json` (Windows) / `~/.aiden/auth.json` (POSIX,
`chmod 600`). Schema keyed by ApiMode with `{type, apiKey?, oauthToken?,
refreshToken?, expiresAt?}`. `chat_completions` + `ollama_prompt_tools`
bypass the resolver. **Preflight refresh** at 5 min before expiry; Phase 4
stubs the HTTP call (logs + returns unchanged) — a `setRefreshHook(...)`
test seam lets unit tests simulate success/failure. Malformed `auth.json`
throws a clear error (no silent fallthrough — auth bugs must surface).

## Public APIs

```ts
// providers/v4/anthropicAdapter.ts (455 lines)
new AnthropicAdapter({ baseUrl?, apiKey, authMode: 'api_key'|'oauth',
  model, providerName, timeoutMs?, maxRetries?, extraHeaders? });

// providers/v4/codexResponsesAdapter.ts (500 lines)
new CodexResponsesAdapter({ baseUrl?, apiKey, model, providerName,
  timeoutMs?, maxRetries?, extraHeaders? });

// providers/v4/ollamaPromptToolsAdapter.ts (388 lines)
new OllamaPromptToolsAdapter({ baseUrl?, model, providerName,
  timeoutMs?, maxRetries? });

// providers/v4/credentialResolver.ts (297 lines)
new CredentialResolver(authJsonPath?);
  loadCredentials(apiMode), saveCredentials(apiMode, credentials),
  getCredentialsForMode(apiMode), refreshIfNeeded(source),
  setRefreshHook(hook), initiateOAuthFlow(apiMode) /* Phase 13 stub */,
  getAuthJsonPath()
```

All three adapters implement `ProviderAdapter` and reuse the Phase 3
retry/backoff pattern (max 2 retries, 1s × attempt backoff, AbortController
timeouts, 4xx-non-429 fail-fast).

## Test coverage

| File | Cases | Pass |
|---|---:|:---:|
| `tests/v4/anthropicAdapter.test.ts` | 14 | ✅ |
| `tests/v4/codexResponsesAdapter.test.ts` | 12 | ✅ |
| `tests/v4/ollamaPromptToolsAdapter.test.ts` | 11 | ✅ |
| `tests/v4/credentialResolver.test.ts` | 15 | ✅ |
| **Phase 4 unit total** | **52** | **52/52** |

Edge cases explicitly covered (per request from Phase 4 prompt + addendum):
- Anthropic empty `content[]` + `stop_reason='end_turn'` → `content=''`,
  `finishReason='stop'`, no throw.
- Codex empty `output[]` + `output_text` backfill → synthetic message item;
  `incomplete` + `max_output_tokens` reason → `finishReason='length'`.
- Ollama malformed `<tool_call>` JSON → warn + skip, doesn't crash.
- CredentialResolver malformed `auth.json` → throws clear error.

## Integration tests

| File | Status this run | Notes |
|---|---|---|
| `tests/v4/integration/anthropicAdapter.real.test.ts` | ⏭️ skipped | `ANTHROPIC_API_KEY` not visible to test runner. |
| `tests/v4/integration/ollamaPromptTools.real.test.ts` | ⏭️ skipped | Ollama not running on localhost:11434 in this env. |
| `tests/v4/integration/chatCompletionsAdapter.together.test.ts` | ⏭️ skipped | `TOGETHER_API_KEY` not visible to test runner. |
| `tests/v4/integration/chatCompletionsAdapter.groq.test.ts` | ⏭️ skipped | `GROQ_API_KEY` not visible to test runner. |
| Codex Responses real-network | ⛔ deferred | No OpenAI Responses-API key + `gpt-5-codex` is gated. Re-evaluate Phase 13 when ChatGPT OAuth ships. |

**Honest note:** Together/Groq/Anthropic keys were not visible to the
vitest subprocess (`process.env.*` undefined). Most likely set after
Claude Code launched or in a separate shell namespace. To run integration
tests, export keys in the same shell that launches `npx vitest`.

## Verification

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx vitest run tests/v4/` | ✅ 82 passed, 6 skipped (3 integration files) |
| `npm test` (full regression) | ✅ **1497 passed**, 6 skipped, 1 todo. 16 file failures all pre-existing in `native-modules/` (vendored puppeteer/zod with missing dev deps — same set Phase 3 reported). |
| Zero v3 regressions | ✅ |

## Cost spent

- Together AI: $0 — no integration runs in this session (keys not visible to runner).
- Anthropic: $0 — same reason.
- Groq: $0 — free tier anyway.

To validate end-to-end against real providers, export the keys in the
launching shell and re-run `npx vitest run tests/v4/integration/`.

## Graphify

| Metric | Pre-Phase 4 | Post-Phase 4 | Δ |
|---|---:|---:|---:|
| Nodes | 1882 | **1931** | +49 |
| Edges | 3406 | 3497 | +91 |
| Communities | 151 | 148 | -3 |

Hook fired on `b7bd8d5`; rebuild ran inline.

## Skipped / deferred (by design)

- **Anthropic OAuth identity spoofing** beyond headers + minimal Claude Code
  system prefix (mcp_ tool prefixing, "Hermes Agent" → "Claude Code"
  sanitization) — Phase 13 polish.
- **Codex Responses** reasoning-item replay (`encrypted_content`),
  `prompt_cache_key`, ChatGPT OAuth, xAI / GitHub / chatgpt.com backend
  variants, `_preflight_codex_api_kwargs` sanitization, real-network
  integration test — Phase 13.
- **CredentialResolver** real OAuth refresh HTTP calls + browser-flow
  initiation — Phase 13.
- **Streaming** for all adapters — Phase 13.
- **Anthropic prompt caching breakpoints** (`cache_control` blocks) — Phase 12.
- **Vision / multimodal content** for Anthropic + Codex — Phase 12.

## What Phase 5 needs to know

**Phase 5 mission:** the provider registry catalog, runtime resolver, and
model catalog with all 18+ providers wired (Groq, OpenRouter, Together,
Cerebras, NVIDIA NIM, DeepSeek, xAI, Kimi, Together, Nous, Anthropic
direct, ChatGPT/Codex, Ollama local, etc.).

**Surfaces ready to plug into:**
- All four `ApiMode`s now have a working adapter constructor.
- `RuntimeResolution` shape from `types.ts` is the contract Phase 5 must
  produce: `{provider, apiMode, baseUrl, apiKey, oauthRefreshable?, source}`.
- `CredentialResolver.getCredentialsForMode()` is the lookup the runtime
  resolver delegates to for OAuth-capable modes.
- Adapter constructors take primitives — no DI / factory yet. Phase 5's
  registry can build adapters with one line per `(provider, model)` row.

**Token-efficient pattern for Phase 5:** start with `graphify query
"runtime provider catalog model registry"` against Hermes (file is
`hermes_cli/runtime_provider.py`). Don't re-read this file.

## Acceptance check (Phase 4)

- [x] Task 1 4-section Hermes summary reported (in this doc + pre-code reply)
- [x] Three adapters implement `ProviderAdapter` correctly
- [x] `CredentialResolver` implements all 4 public methods + extras
- [x] All unit tests pass — **52 new, all 52 green**
- [x] Integration tests run when creds available, skip cleanly when not
- [x] Codex Responses integration explicitly deferred to Phase 13
- [x] `npx tsc --noEmit` zero errors
- [x] Full regression: 1497 passing, zero v3 regressions
- [x] Three commits on `v4-rewrite`, all pushed to `backup`
- [x] Graphify hook fired; **1882 → 1931 nodes**
- [x] `docs/sprint/phase-4-completed.md` written, under 200 lines
