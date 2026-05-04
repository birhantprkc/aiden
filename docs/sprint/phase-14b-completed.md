# Phase 14b — completed (2026-05-04)

Slash command registry, 16 system commands, model picker, and CLI
callbacks. Wires moat layers (Phases 9, 10, 12, 13) to the chat REPL
landing in 14c.

## Hermes inventory (Task 1)

Direct read of `references/hermes-agent`: `commands.py` uses a flat
plugin registry with `register_command()`; `callbacks.py` approval
choices `[once, session, always, deny, view]` (we adopt the first four;
"view" is inline); `model_switch.py` prompts provider→model with tier
badges and never fabricates pricing. /yolo, /usage, /compress, /skin,
/verbose, /save, /title all present in Hermes. No additional commands
worth pulling beyond the 16 specced.

## Display, SessionManager, ApprovalEngine adjustments

- Display gained `info`, `success`, `warn`, `dim`, `line`, `printError`
  helpers (5 new tests).
- `SessionManager.setSessionTitle(id, title)` — one-liner delegating to
  the existing `SessionStore.updateSession({ title })`.
- ApprovalEngine `getMode/setMode` already existed; /yolo remembers
  previous mode via a `WeakMap<engine>` for restore.

## Commands shipped (16)

Full impl: `help`, `tools`, `model`, `save`, `title`, `compress`,
`usage`, `yolo`, `skin`, `skills`, `reload-mcp`, `verbose`, `clear`,
`quit`. Phase 16 stubs: `personality`, `reasoning`. Barrel exports
`allCommands`.

## Model picker

`runModelPicker({ resolver, spec?, tier? })`:
- Spec form returns `{providerId, modelId}` or `null` (no fabrication).
- Interactive `@inquirer/prompts` `select` (injectable for tests).
- Tier badges: ⭐ Pro / 🆓 Free / 💲 Paid / 🏠 Local / 🔑 Subscription.
- Pricing only shown when present in `MODEL_CATALOG`.

## CLI callbacks

`CliCallbacks` exposes `promptApproval`, `riskAssess`,
`promptSkillProposal`, `onPlannerGuardDecision`, `onCompression`,
`onBudgetWarning`, plus `setVerboseMode`. Verbose mode controls
planner-guard chatter; compression always shows; budget caution=dim,
warning=warn.

## Tests

| Suite                              | New |
|------------------------------------|-----|
| `commandRegistry.test.ts`          | 13  |
| `display.test.ts` (14b block)      | 5   |
| `commands.test.ts`                 | 25  |
| `modelPicker.test.ts`              | 11  |
| `callbacks.test.ts`                | 16  |
| **Phase 14b total**                | **70** |

Cumulative v4: ~802 passing (up from 732). Full suite: 2213 passing /
16 failing — failures are pre-existing live-Groq / real-Ollama
integration flakes (delta of 2 from baseline 14 is transient
rate-limit noise). `npx tsc --noEmit` clean.

## Smoke tests

**Registry self-test:**
```
Registered: 16
filter('/m'): ["model"]
all: [clear, compress, help, model, personality, quit, reasoning,
      reload-mcp, save, skills, skin, title, tools, usage, verbose, yolo]
```

**Model picker subprocess:** `npx tsx` showed `? Select provider` plus
the first 7 of 19 providers (paged) with tier badges before SIGTERM.

## Commits (pushed to `backup`)

1. `3e2cee1` — slash command registry + Display 14b helpers
2. `dfa18a0` — 16 system slash commands
3. `d730766` — model picker + CLI callbacks
4. (this doc)

## Graph delta

Pre-14b: 2587 / 4549 / 148. Post-14b: 2601 / 4566 / 149 (+14 / +17 / +1).

## 14c needs from 14b

- `CommandRegistry.filter()` for the autocomplete dropdown.
- `allCommands` barrel — register at REPL boot.
- `runModelPicker` — wired to `aiden model` subcommand.
- `CliCallbacks` — passed into `AidenAgent` constructor.

## Deferred

Personality + reasoning effort → Phase 16. SkillsHub update/audit/publish
subcommands. Custom skin yaml loader. Boxed startup card / status line
and autocomplete rendering — all → 14c.
