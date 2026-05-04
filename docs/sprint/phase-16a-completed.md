# Phase 16a — Personalities + skin yaml + slash polish + bracketed paste + reasoning (completed)

**Goal:** Land six small subsystems from the Phase 16 prompt that don't
touch the agent loop or provider adapter signatures. Phase 16b will wire
the moat layers at REPL boot; Phase 16c will land streaming.

## Task 1 inventory (Hermes graphify)

| Topic | Hermes location | Aiden adoption |
|---|---|---|
| Personality | `agent/prompt_builder.py` overlays | New `core/v4/personality.ts` — slot 2 already wired |
| Skin yaml | `hermes_cli/skin_engine.py:_load_skin_from_yaml` | `cli/v4/skinEngine.ts` already had loader; extended with discover/reload |
| Streaming | `cli.py:_stream_delta`, `_emit_stream_text`, `_flush_stream` | Deferred to Phase 16c |
| Bracketed paste | `ui-tui/src/lib/terminalModes.ts` | New `cli/v4/bracketedPaste.ts` — CSI 2004 markers |
| Reasoning effort | `models.py:github_model_reasoning_efforts`, `_supports_reasoning_extra_body` | Config-only toggle (per stop-condition #7) |
| Slash autocomplete | `commands.py:_iter_plugin_command_entries` | 3-tier filter + recent commands |

## Subsystems delivered

### 1. PersonalityManager (`core/v4/personality.ts`)

`loadAll`, `get`, `list`, `getCurrent`, `setCurrent`, `getActiveOverlay`,
`invalidate`. Bundled overlays at `<repo>/personalities/*.md`; user
overlays at `<aiden-home>/personalities/`. User shadows bundled.

Bundled set (5): `default` (no overlay), `concise`, `terse`,
`senior-engineer`, `code-review`.

`paths.ts` gains `personalitiesDir`, `skinsDir`, `recentCommandsFile`.

### 2. SkinEngine yaml (`cli/v4/skinEngine.ts`)

New methods: `discover()` (scans both bundled + user dirs and merges),
`reload()` (re-reads active skin from disk), `list()` (rich summary
with source labels). Existing `loadSkin/setActive/listSkins` unchanged.

Bundled yaml set (3): `default.yaml`, `light.yaml`, `monochrome.yaml`.
Same colour values as the in-memory built-ins, so fresh installs see
identical behaviour.

### 3. Slash commands

`/personality`, `/skin`, `/reasoning` graduate from Phase 14b stubs to
full impls. `/skin reload` is the new live-iteration path.
`SlashCommandContext` gains `personalityManager?` so handlers can reach
the manager.

### 4. CommandRegistry filter polish

3-tier matching (prefix → substring → description). Within each tier,
results sort alphabetically. Empty prefix surfaces recent commands first.

`recordRecent` / `getRecent` / `setRecent` / `serializeRecent` track
the most-recent-first command list (capped to 8). `execute()` records
on success.

### 5. Bracketed paste (`cli/v4/bracketedPaste.ts`)

CSI 2004 escape-sequence detection — `\x1b[200~` … `\x1b[201~` markers
mark a paste payload. Six pure helpers (`isCompletePaste`,
`stripPasteMarkers`, `hasPasteMarkers`, `enable/disable`, plus the
constants). `chatSession.run()` enables on entry, disables on exit.
`readUserInput()` strips markers before any other parsing. Phase 15's
timing heuristic remains the fallback for older Console hosts.

### 6. Reasoning effort

`/reasoning [show|low|medium|high]`. Persists to
`agent.reasoning_effort` via ConfigManager. Adapters that support
effort (Anthropic thinking, OpenAI o-series) will read it in 16c;
adapters that don't, ignore it.

## Test counts

| File | New tests | Total |
|---|---|---|
| `tests/v4/personality.test.ts` | +12 | 12 |
| `tests/v4/cli/skinEngine.yaml.test.ts` | +9 | 9 |
| `tests/v4/cli/bracketedPaste.test.ts` | +15 | 15 |
| `tests/v4/cli/commandRegistry.test.ts` | +9 | 25 |
| `tests/v4/cli/commands.test.ts` | +17 | 37 |
| **Net new** | **+62** | |

**v4 unit suite: 945 passed / 1 skipped / 0 failures.**
Pre-existing 4 real-network integration failures (Ollama llama3.2 not
loaded, Groq rate-limit) are unchanged from Phase 15 — none touch
Phase 16a code paths.

`npx tsc --noEmit` — clean (zero errors).

## Smoke gate

`scripts/smoke-phase16a.ts` exercises all four user-facing flows in a
real PowerShell process with a temp `AIDEN_HOME`:

```
✓ Personality: concise            (switch)
error: Unknown personality 'ghost' (graceful)
✓ Skin: light                     (switch)
✓ Skin reloaded: light            (live reload)
✓ Reasoning effort set to high.   (persist)
error: Invalid effort 'extreme'.  (graceful)
SMOKE PASS — all four commands functional.
```

## Commits + push

5 feat/test commits + 1 doc commit, all pushed to `backup/v4-rewrite`:

1. `feat(v4): personality manager + 5 bundled overlays`
2. `feat(v4): skin engine yaml loader + 3 bundled skins`
3. `feat(v4): /personality + /skin + /reasoning + slash polish`
4. `feat(v4): bracketed paste polish for chat REPL`
5. `test(v4): smoke gate for Phase 16a slash commands`
6. `docs(v4): phase 16a summary` (this file)

## Graph delta

Pre-Phase 16a (post-15): 2691 nodes / 4759 edges / 65 communities.
Post-Phase 16a: **2746 nodes / 4874 edges / 151 communities** (graphify
post-commit hook rebuilt automatically).

## What Phase 16b needs

- Wire `PlannerGuard`, `HonestyEnforcement`, `SkillTeacher` from Phase 12
  + `MemoryGuard`, `SSRFProtection`, `TirithScanner` from Phase 9 into
  `runInteractiveChat()` in `cli/v4/aidenCLI.ts`.
- Confirm Phase 12 hook callback signatures match the agent's option
  surface (`onPlannerGuardDecision`, `onCompression`, `onBudgetWarning`,
  `skillTeacherCallbacks`).
- Smoke gate: real chat session boots with all 6 layers, verified=false
  memory detection works end-to-end.

## What Phase 16c needs

- Add `streaming` + `onToken` + `reasoningEffort` to `ProviderCallInput`.
- SSE parsing per adapter (Anthropic, ChatCompletions, Ollama JSONL,
  Codex). Codex optional per the prompt.
- `Display.streamPartial` / `streamComplete`. ChatSession token flow.
- `/streaming on|off` slash command persisting to config.
- Anthropic thinking-budget mapping for `/reasoning`.

## Deferred to v4.1

- OpenAI o-series reasoning effort wiring
- Personality LLM-classified routing
- Skin file-watch hot reload (only `/skin reload` ships in 16a)
- Vision/multimodal in chat REPL
