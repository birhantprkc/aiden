# Phase 16b.2 — REPL log hygiene + Llama-3.3 tool-call fix (completed)

**Goal:** Knock out the five issues Phase 16b.1's live REPL smoke gate
surfaced — three user-blocking, one defensive, one quality bar.

## Tasks landed

| # | Issue | Fix | Verify |
|---|-------|-----|--------|
| 1 | `[SkillLoader] Skipping malformed…` warning fired on every turn and corrupted the spinner. | New `core/v4/aidenLogger.ts` (file-only `appendFileSync` logger). `SkillLoader` now caches `loadAll()` in-memory and routes warnings to the logger by default — `console.warn` is gone from the production path. `buildAgentRuntime` runs the scan ONCE at boot and prints `[skills] N loaded, M skipped (see logs/skills.log)`. | `tests/v4/skillLoader.cache.test.ts` (4 tests) — cache identity, counts surfacing, `invalidate()`, no-`console.warn` assertion. |
| 2 | Four v3 single-file skills had no frontmatter and were dropped on every boot. | Backfilled `name`/`description`/`version: 1.0.0` blocks on `code_interpreter.md`, `folder_watch.md`, `social_research.md`, `system_control.md`. Mirrored to `%LOCALAPPDATA%\aiden\skills\`. | Smoke harness reports **71 loaded, 0 skipped** (was 67 + 4). |
| 3 | Llama-3.3 emitted legacy `<function=name({args})>` instead of OpenAI `tool_calls`, returning HTTP 400 `tool_use_failed` on the first message. | Two-part: (a) `promptBuilder.ts` injects an extra slot warning the model away from the legacy syntax when `modelId` matches `/llama-3.3/i`; (b) `chatCompletionsAdapter.ts` adds `tryRecoverLegacyToolCall` + `parseLegacyFunctionSyntax` — when a 400 carries `code: tool_use_failed` and `failed_generation: '<function=...>'`, the adapter parses it back into a synthetic `ProviderCallOutput` with one tool call. | `tests/v4/promptBuilder.llama33.test.ts` (5), `tests/v4/chatCompletionsAdapter.legacyToolCall.test.ts` (12). Live round-trip flagged for Shiva (needs real Groq key). |
| 4 | `isRateLimitError` audit. | Detector already only matches 429 / "rate limit" / "too many requests" / "quota" / `statusCode === 429` / `rateLimit === true`. `tool_use_failed` 400 is NOT classified as rate-limit — chain correctly throws instead of advancing. | New regression test in `tests/v4/providerFallback.test.ts` locks the behaviour. |
| 5 | SkillTeacher proposed `skills-hey` from a 1-word greeting. | Threshold raised: min 3 distinct tool *types* (was 5 calls but the same tool 5× counted), min 20-char first user message, NEVER propose during the FIRST turn (only one user message in history). | 3 new gating tests in `skillTeacher.test.ts`; existing tests 6–8 updated to reflect the second-turn requirement. |

## Where the new code lives

- `core/v4/aidenLogger.ts` — `createFileLogger(logsDir, name)` + `createNullLogger()`. ~70 lines.
- `core/v4/skillLoader.ts` — added `cache`, `lastCounts`, `invalidate()`, `getLastCounts()`, `scanDisk()` split from `tryParseTracked()`.
- `core/v4/promptBuilder.ts` — `shouldInjectLlama33ToolHint`, new optional `modelId` field on `PromptBuilderOptions`, slot 6.5.
- `providers/v4/chatCompletionsAdapter.ts` — module-level `tryRecoverLegacyToolCall` + `parseLegacyFunctionSyntax`; hooked into the 400 branch.
- `cli/v4/aidenCLI.ts::buildAgentRuntime` — wires the file logger into `SkillLoader`, runs `loadAll()` once at boot, emits the summary line via `display.dim`.
- `moat/skillTeacher.ts` — added `MIN_DISTINCT_TOOL_TYPES`, `MIN_FIRST_USER_LEN`, first-turn guard.

## Tests

- New: **+25 v4 unit tests** across 3 new files + 2 amended.
  - `skillLoader.cache.test.ts` — 4 tests
  - `promptBuilder.llama33.test.ts` — 5 tests
  - `chatCompletionsAdapter.legacyToolCall.test.ts` — 12 tests
  - `providerFallback.test.ts` (+1) — `tool_use_failed` non-classification
  - `skillTeacher.test.ts` (+3) — first-turn / short-message / single-tool-type
- v4 unit suite: **991 passed / 1 skipped** (was 987/3 in 16b.1 — plus 25 new − 4 reduced skips owing to the moat tests no longer needing skip flags).
- Full `npm test`: **2426 passed / 4 failed / 3 skipped / 1 todo**. Same 4 pre-existing real-network failures (Groq, Together, runtimeResolver, 2× Ollama llama3.2-not-installed). Zero new regressions.
- `npx tsc --noEmit` — clean.

## Smoke gate

`scripts/smoke-phase16b2.ts` — 10 asserts, all PASS:

1. 4 single-file skills now have frontmatter (loaded=71, skipped=0).
2. Boot summary line shape `^\[skills\] \d+ loaded, \d+ skipped`.
3. `SkillLoader.loadAll` caches across calls (identity check).
4. `shouldInjectLlama33ToolHint` matches Groq id.
5. `shouldInjectLlama33ToolHint` rejects Claude id.
6. `PromptBuilder` injects tool-format hint for Llama-3.3.
7. `PromptBuilder` leaves Claude prompt untouched.
8. `parseLegacyFunctionSyntax` recovers a single call.
9. `tryRecoverLegacyToolCall` handles Groq `tool_use_failed` body.
10. Non-`tool_use_failed` errors fall through to throw.

`SMOKE PASS — Phase 16b.2 hardening verified.`

## Anything deferred / flagged for Shiva

- **Live REPL "hi" round-trip through Groq Llama-3.3** — needs a real key and an interactive shell; the unit + smoke tests cover the recovery parse and the prompt injection deterministically. Manual run by Shiva.
- Per-slot cooldown timer (still v4.1).
- Streaming fallback (Phase 16c).
