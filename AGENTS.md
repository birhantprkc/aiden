# Aiden v4.0.0 — AGENTS.md

## Sprint context
- Branch: `v4-rewrite` (NEVER push to main during this sprint)
- v3.19.9 stays live on npm/GitHub. `main` branch frozen.
- Reference architecture: `docs/v4.0.0-architecture.md` (READ FIRST)
- Sprint progress: `docs/sprint/phase-N-completed.md` (read previous phase before starting next)

## Mission
Aiden v4.0.0 = Hermes-grade everything (architecture, tooling, skills, memory, security, UX) + Aiden's unique layer (honesty enforcement, Pro tier, OAuth subscriptions, native Windows, npm distribution).

Single-loop agent replaces planner+responder split. ONE LLM. Tools called inside loop. Architecture prevents fabrication by design.

## Key paths
- Aiden repo: `C:\Users\shiva\DevOS`
- Aiden user data (runtime): `%LOCALAPPDATA%\aiden\`
- Hermes reference (read-only): `C:\Users\shiva\references\hermes-agent` (branch `aiden-v4-reference`)
- Architecture doc: `docs/v4.0.0-architecture.md`
- Sprint progress: `docs/sprint/`

## Working style
- Author all commits as Shiva Deore. NO Co-Authored-By Claude. NO "Generated with Claude Code" trailers.
- Conventional commit format: `type(scope): description`
- Phased delivery. Each phase leaves runnable build. Stop and ask if uncertain.
- No fabrication. No silent workarounds. Stop and report.

### Hermes-first rule (non-negotiable)

When anything in Aiden doesn't work as expected or needs new functionality —
UX, prompts, identity, errors, onboarding, tool behavior, browser automation,
memory, sessions, MCP, providers, fallback chains, streaming, security gates,
plugins, OAuth, cron, gateway, voice, ACP, delegation, ANY functional surface —
the agent MUST audit how Hermes solves it before writing code.

Reference: `C:\Users\shiva\references\hermes-agent` (read-only, graphify-mapped).

Process for every fix or new feature:
1. Reproduce/scope the problem in Aiden.
2. Find the equivalent surface in Hermes:
   - `graphify query "<topic keywords>"`
   - Read the relevant Hermes source
3. Output a 1-page audit at `docs/sprint/hermes-<topic>-audit.md`:
   - File refs (`path:line`) for each Hermes pattern
   - 2–3 line summary of Hermes's approach
   - Decision: copy / adapt / diverge with explicit reason
4. Only then implement.

If Hermes does NOT solve the problem, document that in the audit and proceed
with original design.

Never reinvent a wheel Hermes already shipped. Every divergence requires a
written reason. Phases that skip the audit must be redone.

## Token-efficient working pattern (every phase)
1. Read previous phase summary: `docs/sprint/phase-N-1-completed.md`
2. Use `graphify query "..."` BEFORE reading files (200 tokens vs 5000+ for file reads)
3. Read only files explicitly listed as needed in the phase prompt
4. Commit after each subtask (forces context cleanup, hook updates graph)
5. Write `docs/sprint/phase-N-completed.md` at end of phase (under 200 lines)
6. Run `/clear` between phases when Shiva says so

## Graphify usage
- Aiden graph: `cd C:\Users\shiva\DevOS && graphify query "..."`
- Hermes graph: `cd C:\Users\shiva\references\hermes-agent && graphify query "..."`
- Hooks fire on every commit; graph stays fresh automatically.
- Windows hook patch: `.git/hooks/post-commit` + `post-checkout` use uv-managed python at `/c/Users/shiva/AppData/Roaming/uv/tools/graphifyy/Scripts/python.exe`. Re-apply if `graphify hook install` is rerun.

## What v4 KEEPS from v3.19.x
86 tool implementations, Pro license + Cloudflare KV (`devos-license-server`), npm dual-package (`aiden-runtime` + `aiden-os`), plugin system, 40 bundled skills, provider chain (4 Groq + 4 Gemini + 3 OR + Ollama), C7/C8 safety, PlannerGuard concept, MemoryGuard concept, SkillTeacher concept, all 12 fixes from v3.19.5–v3.19.9, SOUL.md, native Windows support.

## What v4 DELETES
- `planWithLLM()` in `core/agentLoop.ts` (~1500 LOC) — confirmed via graphify (community 0, L838)
- `respondWithResults()` in `core/agentLoop.ts` (~800 LOC) — confirmed via graphify (community 0, L2681)
- Glue between them (~2700 LOC)
- `direct_response` fast-path
- Replan logic, multi-Q parallel handling
- C20/C21 fabrication band-aids (architecture replaces them)
- `workspace/semantic.json` (replaced by SQLite + FTS5)

## Testing requirements (every phase)
- Each phase has acceptance criteria — verify them, don't claim completion without tests passing.
- Run `npm test` (or equivalent) before committing.
- New code requires new tests where applicable.
- No phase advances with known regressions.

### Integration test provider fallback

Integration tests that need a real LLM use `getTestProvider()` from
`tests/v4/_helpers/testProvider.ts` instead of hardcoding `GROQ_API_KEY`.
The fallback chain is:

1. `GROQ_API_KEY`     — primary, free tier, fast
2. `GROQ_API_KEY_2`   — secondary Groq account
3. `GROQ_API_KEY_3`   — tertiary Groq account
4. `TOGETHER_API_KEY` — paid fallback (~$10 sprint budget — use sparingly)

Tests skip cleanly only when **all four** are missing. Wrap test bodies
with `withRateLimitFallback(fn, initialProvider)` to auto-retry on 429s
across the chain — non-rate-limit errors propagate immediately so real
bugs aren't hidden.

Provider-specific adapter tests (`chatCompletionsAdapter.groq`,
`chatCompletionsAdapter.together`, `runtimeResolver.real`) intentionally
do NOT use the helper — they pin a specific provider on purpose.

Optional model overrides: `GROQ_TEST_MODEL`, `TOGETHER_TEST_MODEL`.

## Common gotchas
- `PACKAGE_ROOT` (npm install dir) vs `WORKSPACE_ROOT` (user data dir) — conflating these caused 3 failed releases.
- npm dual-package atomic publish: `npm run release:npm` (`scripts/release-npm.ps1`).
- `AIDEN_CLI_MODE=1` set by `bin/aiden.js` auto-suppresses bracket-prefixed `console.log` when level >= warn.
- Together-1 provider disabled (HTTP 400 cascade since v3.19.5).
- Windows graphify hooks need patched python path (see above).
- Setup wizard validates API keys against provider endpoints before saving. Smoke-test mode (`--smoke-test`) and `--skip-validation` flag both bypass.

## Git remotes (CRITICAL — read before pushing)
- `origin` = public repo, FROZEN at v3.19.9 during this sprint. Never push to origin.
- `backup` = private repo (taracodlabs/Aiden-v4), ALL v4 work pushes here.
- `v4-rewrite` branch is configured to default-push to `backup` only.
- Public release happens later by merging backup/v4-rewrite into origin/main as one big release.

## v4 CLI UX — design targets for Phase 14c

The chat REPL in 14c implements three signature UX elements. These were locked in after reviewing Hermes's interface and choosing what's worth adopting:

### 1. Boxed startup card (rendered once when chat session opens)

```
█████╗  ██╗██████╗ ███████╗███╗   ██╗
██╔══██╗██║██╔══██╗██╔════╝████╗  ██║
███████║██║██║  ██║█████╗  ██╔██╗ ██║
██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║
██║  ██║██║██████╔╝███████╗██║ ╚████║
╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝

╭─────────────────────────────────────────────────────────────────╮
│  Aiden v4.0.0 · Taracod                                         │
│                                                                 │
│  Available Tools                                                │
│   files: read, write, patch, delete, move, copy                 │
│   web: search, fetch, deep_research                             │
│   browser: navigate, click, type, screenshot, ...               │
│   terminal: shell_exec (local + docker)                         │
│   memory: add, replace, remove                                  │
│   sessions: search, list                                        │
│   process: spawn, kill, log_read, list, wait                    │
│   skills: list, view, manage                                    │
│   (and N more toolsets...)                                      │
│                                                                 │
│  Available Skills                                               │
│   <category>: <skill1>, <skill2>, ... (truncated to fit)        │
│   ... <total> skills across <category-count> categories         │
│                                                                 │
│  <provider> · <model>                                           │
│  Session: <session-id>                                          │
│                                                                 │
│  <tool-count> tools · <skill-count> skills · /help for commands │
╰─────────────────────────────────────────────────────────────────╯
```

Banner in brand orange `#FF6B35`. Box border in dim gray. Tool/skill names in default. Headers ("Available Tools", "Available Skills") in bold orange.

### 2. Status line (bottom of input area, always visible)

Format:
```
$ <provider>:<model>  ctx <used>/<max>  [<progress-bar>]  budget <used>/<max>  <session-age>
```

Example:
```
$ groq:llama-3.3-70b-versatile  ctx 4.2k/200k  [▓░░░░░░░░░] 2%  budget 3/90  3m
```

Updates after each turn. Renders below user input prompt, above the next available input line. Use box-drawing chars for separator.

### 3. Slash command autocomplete dropdown

When user types `/` in the chat input, show a filterable dropdown:

```
/provider                                                         _
─────────────────────────────────────────────────────────────────
/profile          Show active profile name and home directory
/provider         Show available providers and current provider
/personality      Set a predefined personality (usage: /personality [name])
/plugins          List installed plugins and their status
/paste            Check clipboard for an image and attach it
⚡ /trading-alert  NSE swing trading alert workflow
⚡ /research       Multi-source web research with summary
```

System slash commands: no icon, default color.
Skill slash commands: `⚡` prefix in orange, name in default. (Skill commands come from Phase 10's `skillCommands.buildCommandMap()`.)

Filter as user types. Arrow keys navigate. Enter selects. Esc dismisses.

### 4. Inline error display

Errors render with actionable suggestion below:
```
Unknown provider 'groq'. Run aiden model to pick a valid provider,
or aiden doctor to diagnose config issues.
```

Red text for the error line, dim gray for the suggestion. No stack traces shown to user (logged separately).

### Implementation notes for Phase 14c agent

- Boxed card uses live data from RuntimeResolver (provider/model), SessionManager (session ID), ToolRegistry (tool count), SkillLoader (skill count)
- Status line updates via callback hooks already wired in Phase 13 (onCompression, onBudgetWarning, totalUsage tracking)
- Autocomplete dropdown can use `@inquirer/prompts` `search` prompt OR a custom prompt-toolkit-style overlay — agent's call based on what renders cleanly on Windows Terminal
- Skill slash commands list comes from `core/v4/skillCommands.ts` `buildCommandMap()`
