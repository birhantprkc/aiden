# Phase 16g — Restore agency for fuzzy intents

Three small fixes from the autonomy diagnostic
([`diag-autonomy-findings.md`](diag-autonomy-findings.md) /
[`hermes-autonomy-audit.md`](hermes-autonomy-audit.md)).

## Task 1 — PlannerGuard fallback opens to full inventory
[`0664f21`] `moat/plannerGuard.ts::decideRuleBased`: when no keyword
rule matches, return all registered tools instead of the 3-tool
`CORE_TOOL_NAMES`. New reason code `no_rule_match_open`. Keyword-narrow
path stays intact for explicit single-domain intents.

**Diagnostic before**: `selectedTools: 3, excluded: 37`.
**After**: `selectedTools: 40, excluded: 0` for "play me a popular song
on youtube".

## Task 2 — SOUL.md autonomy directives + version-aware upgrade
[`9e6f8bf`] Four Hermes-aligned blocks ported into the bundled
default at `cli/v4/defaultSoul.ts`:

- `<act_dont_ask>` — pick sensible defaults instead of asking
- `<prerequisite_checks>` — verify state before acting
- `<missing_context>` — use lookup tools, don't ask user
- `<keep_going>` — chain multi-step tasks within a turn

Seed logic gains version-awareness via `PREVIOUS_BUNDLED_SOULS`:
- File matches a prior bundled default verbatim → silent upgrade
- File looks user-edited → preserve + emit one-time `[soul] …` boot
  notice pointing the user at `/identity` to review

`BUNDLED_SOUL_VERSION` bumped `16b.3 → 16g`.

## Task 3 — Skills slot: mandatory framing + drop slice cap
[`5ae69c5`] Two changes:
- `cli/v4/aidenCLI.ts` — removed `.slice(0, 32)`. All 71 installed
  skills surface to the prompt builder.
- `core/v4/promptBuilder.ts` — header rewritten from
  `## Available skills` to `## Skills (mandatory) — … if any skill is
  even partially relevant … you MUST load it first via skill_view(name)`
  with `<available_skills>` tag wrapper.

## Suite + tsc
v4 unit **1119 / 1 skip / 0 fail** (was 1113 in 16f, +6 net).
- planner: tests 6, 7, 8 rewritten + new test 8a (explicit narrow path
  preserved)
- soulSeed: +3 tests (silent-upgrade, preserve-with-notice, unchanged)
- promptBuilder: +2 tests (mandatory framing locked, empty-list omits)

`tsc --noEmit` clean throughout.

## Smoke gate flagged for manual REPL
After boot:
1. `/identity` — should show the new SOUL with `<act_dont_ask>` etc.
   (your existing 16b.3 default file silently upgrades on next boot)
2. "play me a popular song on youtube" → Aiden should chain
   `open_url(https://www.youtube.com/results?search_query=…)` (or
   browser_navigate then click) instead of asking for clarification
3. "search the web for npm news" → still narrows to web tools
   (rule_match path preserved)
4. "list files" → still narrows to file tools

## Commits
- `0664f21` feat(planner): no-rule-match fallback returns full tool inventory
- `9e6f8bf` feat(soul): autonomy directives + version-aware silent upgrade
- `5ae69c5` feat(prompt): mandatory skills framing + drop slice cap
- `<this commit>` docs(v4): phase 16g summary

All on `backup/v4-rewrite`. Origin untouched.
