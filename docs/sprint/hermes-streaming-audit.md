# Hermes audit — streaming token responses (Phase 16c)

Pre-code audit per the standing AGENTS.md rule. Inspects how Hermes streams
LLM tokens end-to-end so Aiden v4 doesn't reinvent solved problems
(buffering, tool-call interleaving, mid-stream error recovery, spinner-stop
on first delta, `<think>` suppression).

Hermes has no graphify graph — searched raw files. DevOS GRAPH_REPORT was
consulted; `Display` is a god node (34 edges) which guides where the v4
display wiring will land.

## Scope

Phase 16c needs streaming wired into:

1. Provider adapters (chat_completions, anthropic_messages,
   ollama_prompt_tools).
2. The agent loop (`AidenAgent.runConversation`), including tool-call
   interleaving.
3. The fallback chain (`runFallbackChainStream`) with mid-stream 429 handling.
4. The CLI display layer (token-by-token render, spinner stop, ANSI safety).
5. A `/streaming` slash command + persisted `display.streaming` config.

The Hermes audit informs each layer.

## Hermes — single unified streaming entry point

`run_agent.py:6636` `_interruptible_streaming_api_call(api_kwargs, *, on_first_delta)`
is **the** dispatch site. Branches by `self.api_mode`:

- `chat_completions` → `_call_chat_completions()` at `run_agent.py:6753`.
  Sets `stream=True` + `stream_options={"include_usage": True}`, iterates the
  OpenAI SDK's `Stream` object chunk-by-chunk, accumulates content, builds a
  mock non-streaming response (`SimpleNamespace`) so the rest of the loop is
  unchanged.
- `anthropic_messages` → `_call_anthropic()` at `run_agent.py:7009`. Uses
  `client.messages.stream(**api_kwargs)` context manager, dispatches on
  `event.type == "content_block_start" | "content_block_delta"`,
  returns `stream.get_final_message()` (native shape).
- `bedrock_converse` → `stream_converse_with_callbacks(...)` at
  `run_agent.py:6716` (handled by `agent/bedrock_adapter.py`).
- `codex_responses` → already-streaming `_run_codex_stream` at
  `run_agent.py:5829`.

There is **no separate `agent/anthropic_adapter.py` streaming function** —
it's the unified loop body that decides per `api_mode`. Hermes does not
abstract `callStream(input) -> AsyncIterable<Event>`; it ties streaming
to the agent loop directly via callbacks (`stream_delta_callback`,
`tool_gen_callback`, `reasoning_callback`).

## Tool-call interleaving — buffer-and-suppress, not finish-and-flush

`run_agent.py:6849-6873`. The chat_completions branch:

- Accumulates `delta.content` into `content_parts`.
- **Only fires `_fire_stream_delta(delta.content)` when `tool_calls_acc` is
  empty.** Once any tool call appears in the same response, subsequent
  text deltas are suppressed from the display stream (still saved into
  `content_parts` for the final message). Comment at line 6857-6867
  spells out the rationale: avoids "I'll use the tool…" preamble being
  shown alongside the actual tool feed.
- `_fire_tool_gen_started(name)` fires once per tool when its full name is
  available, so the TUI can show "preparing write_file…" instead of a
  frozen screen during long argument generation (45 KB writes).
- After the stream completes, `mock_tool_calls` is built from
  `tool_calls_acc` and the response shape mimics non-streaming so the
  outer loop dispatches tools and recurses normally.

Anthropic does this differently (`run_agent.py:7038-7056`): on
`content_block_start` with `type == "tool_use"` it sets `has_tool_use = True`
and from then on text deltas inside the response are not streamed. Same
philosophy: text + tool_use in one assistant turn → suppress text from
the visible stream so the tool call lands cleanly.

## Mid-stream failure handling — silent retry only when a tool was in flight

`run_agent.py:7066-7211`. The retry loop logic:

1. Stream died **before** any token was delivered → retry
   transparently (`HERMES_STREAM_RETRIES`, default 2).
2. Stream died **after** text was delivered AND a tool call was being
   generated → silent retry, fire a `"\n\n⚠ Connection dropped mid
   tool-call; reconnecting…\n\n"` marker, reset
   `_current_streamed_assistant_text`, drop the dead httpx client, replace
   the primary OpenAI client (`_replace_primary_openai_client`). User
   sees re-streamed preamble + duplicated text — preferable to a silently
   discarded action.
3. Stream died **after** text was delivered but no tool was in flight →
   stub the partial text into the conversation as the assistant turn,
   surface the error. No retry (would duplicate visible tokens).

Transient errors are detected by httpx exception types **plus** OpenAI SDK
`APIError` with no `status_code` whose message matches
`("connection lost", "connection reset", "network error", …)` — this is
how OpenRouter's SSE error frames get classified.

## Display layer — line-buffered with reasoning-tag suppression

`cli.py:3005` `ChatConsole._stream_delta(text)`:

- Receives text deltas. `text=None` is a turn boundary signal (tools
  about to fire) → flush + reset state.
- Maintains a **pre-filter buffer** `_stream_prefilt` so split tags
  (`<REASONING_SCRATCH` + `PAD>`) don't leak.
- Routes `<think>`/`<REASONING_SCRATCHPAD>`/etc. block contents to a
  separate dim "Reasoning" box (or discards if `show_reasoning=False`).
- Emits to `_emit_stream_text(safe)` which opens a "⚕ Hermes" boxed
  region on first visible token and prints via `_cprint` (prompt_toolkit
  `print_formatted_text(ANSI(...))`). Raw `print()` is swallowed by
  prompt_toolkit's `patch_stdout` StdoutProxy — must route through
  `print_formatted_text(ANSI(...))` to render colors.
- Streaming gated on `self.streaming_enabled` (`cli.py:2033`,
  `CLI_CONFIG["display"].get("streaming", False)` — **default OFF**).
- Wired via `stream_delta_callback=self._stream_delta if
  self.streaming_enabled else None` at `cli.py:3624`.

`on_first_delta` callback (`run_agent.py:6745`) stops the spinner before
the first visible token. The same hook fires for `tool_gen` events, so
the spinner clears even on tool-call-only turns.

## Stateful `<memory-context>` scrubber

`run_agent.py:1298` `_stream_context_scrubber = StreamingContextScrubber()`.
`<memory-context>...</memory-context>` spans split across SSE chunks would
otherwise leak verbatim memory data to the user. Aiden v4 doesn't inject
those tags into model responses, so this stays a pure Hermes concern.

## Decisions per task

| Topic | Decision | Reason |
|-------|----------|--------|
| Adapter shape | **Adapt** — declare `callStream(input): AsyncGenerator<StreamEvent>` per the spec's discriminated union (`delta`/`tool_call`/`done`) instead of Hermes's callbacks. | TS idiomatic; avoids passing closures through 4 layers. Keeps adapter self-contained vs Hermes's "agent loop holds the callbacks". |
| Tool-call interleaving | **Copy** Hermes — accumulate text + tool calls in parallel; suppress visible deltas from the moment a `tool_call` event appears in this turn. Emit `tool_call` event downstream so display can show indicator. | Solves the "I'll use write_file…" prefix-text problem cleanly; spec already calls for this ("Hermes likely buffers deltas until a tool_call appears, then flushes…" — actually Hermes just *suppresses*, doesn't flush, so the spec's hint is slightly off; we follow Hermes). |
| Mid-stream 429 | **Diverge for v4.0** — cancel + per-turn fallback to non-streaming on the **same** slot first, then if that fails, advance to next slot per existing `runFallbackChain` rules. Don't replicate Hermes's silent-retry-with-marker (it's complex and depends on the partial-tool-name buffer). Per the spec's stop condition "Per-turn fallback to non-streaming is acceptable; partial-token loss is not." | Keeps the integration small. Re-streaming a duplicated preamble is a worse UX for a launch than a brief stall. |
| First-delta hook | **Copy** — pass `onFirstDelta?: () => void` through `runConversation` so the CLI can stop the spinner the instant the first delta event fires. | Direct copy — works the same in async-iterator land. |
| `<think>` tag suppression | **Adapt** — port the prefix/suffix tag detector but only for `<think>`. The other tags (`REASONING_SCRATCHPAD`, etc.) are Hermes-specific. | Keep the surface area small. |
| Display layer | **Adapt** — Aiden v4 uses prompt_toolkit-equivalent `cli/v4/display.ts` (god-node `Display` per GRAPH_REPORT). Add `streamPartial(text)` and `streamComplete()`; Hermes's "open a boxed region on first token" pattern translates 1:1 to opening a styled prefix line. |
| `<memory-context>` scrubber | **Skip** — Aiden doesn't emit those tags. |
| Default state | **Copy** — `display.streaming: false` for v4.0 launch. Opt-in via `/streaming on`. | Matches Phase 16a discipline; matches Hermes default. |
| Retry-on-mid-tool-error | **Defer** to v4.1 — too entangled with partial-tool-arg repair. Stop condition: "if mid-stream 429 cancellation is racy / loses tokens — fall back to non-streaming for that turn". | The spec explicitly permits the simpler fallback. |
| `tool_gen_started` event | **Adapt** — fire `{type:'tool_call', toolCall}` on first appearance of the tool *name* (not the full args) so display can show "preparing read_file…". |
| Codex streaming | **Defer** to v4.1 per spec. |
| Anthropic extended-thinking blocks | **Defer** to v4.1 per spec. |

## Files to touch

- `providers/v4/types.ts` — add `StreamEvent` discriminated union; widen
  `ProviderAdapter.callStream` return type.
- `providers/v4/chatCompletionsAdapter.ts` — implement `callStream` using
  `fetch`'s streaming `body.getReader()` + SSE line parser. (Hermes uses
  the OpenAI SDK; v4 uses raw `fetch`, so we hand-roll SSE.)
- `providers/v4/anthropicAdapter.ts` — implement `callStream` parsing
  Anthropic's SSE event types (`content_block_start`,
  `content_block_delta` text_delta, `message_stop`).
- `providers/v4/ollamaPromptToolsAdapter.ts` — Ollama's `/api/chat` with
  `stream: true` returns NDJSON, not SSE; one JSON object per line.
- `core/v4/aidenAgent.ts` — accept `stream` + `onDelta` + `onFirstDelta` +
  `onToolCallStart`; iterate adapter's async generator; suppress text
  deltas after first `tool_call` event in the same turn.
- `core/v4/providerFallback.ts` — add `runFallbackChainStream`; on 429
  during stream, cancel reader and fall back to non-streaming on same
  slot (then advance per existing logic).
- `cli/v4/display.ts` — `streamPartial(text)`, `streamComplete()`.
- `cli/v4/chatSession.ts` — wire `streaming_enabled` from config; pass
  `onDelta`/`onFirstDelta`/`onToolCallStart` into `runConversation`.
- `cli/v4/commands/streaming.ts` — `/streaming` toggle.
- Tests + Phase 16c doc.
