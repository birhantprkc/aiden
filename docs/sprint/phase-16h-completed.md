# Phase 16h — Multi-step task completion (diagnostic + fix)

Smoke-driven 2-step: diagnose then ship the smallest unblocking fix.

## Diagnostic ([`bb283b2`])
[`diag-multistep-findings.md`](diag-multistep-findings.md). Phase 16g
restored autonomy (model chains tools instead of asking). New smoke
exposed a downstream failure: "play me a popular song on youtube"
fired `open_url` twice with literal "popular song" search and ended
with no playback.

Root cause is **architectural**: Aiden's two browser surfaces don't
compose for "play"-style intents.

| Tool | Backend | Click after? |
|---|---|---|
| `open_url` (16f) | OS shell → user's real Chrome | ❌ no — fire-and-forget |
| `browser_navigate` | Playwright Chromium | ✅ but separate window |

Hermes solves this via the Spotify plugin (`skills/media/spotify` with
7 dedicated playback tools — `tools/browser_tool.py:1688/1925` shows
their browser_navigate + browser_click share a controlled session).
We don't have plugin architecture in v4.0, so the v4.0 fix is a
**teaching layer** that bridges the gap with existing tools.

Duplicate launch was downstream: `open_url` returns content-less
success → model has no signal step 1 worked → retries.

## Fix ([`d23521b`], [`7b8abc6`])

### Path 1 — bundled `media-search` skill
[`d23521b`] `skills/media-search/SKILL.md` teaches the workflow:
1. `web_search` for `<title> youtube watch`
2. Pick first `/watch?v=` URL (skip channels, playlists, results pages)
3. `open_url` that watch URL exactly **once** — autoplays
4. Report which video was picked + URL

Fuzzy intents get an explicit substitute step: "popular song" →
`Billboard Hot 100 #1 youtube watch`, "jazz" → "Take Five", etc. The
skill's "Cautions" section locks the anti-patterns (no double-launch,
no claiming "now playing" on a results page, no Spotify in v4.0).

Bundled-skill restore is already additive
(`skillBundledRestore.ts:149`) — users with 71 existing skills get
media-search auto-copied on next boot, taking them to 72.

### SOUL.md update
[`7b8abc6`] `<act_dont_ask>` example replaced:

| Before (16g) | After (16h) |
|---|---|
| "play me a popular song on youtube → open_url to youtube.com search, pick the top trending result" | "play me a popular song / play X on youtube → load skill_view(media-search) and follow it. NEVER search verbatim 'popular song'" |

`PREVIOUS_BUNDLED_SOULS` gains the 16g snapshot at index 1 so users
who got the 16g default at install silent-upgrade to 16h on next boot.
`BUNDLED_SOUL_VERSION` bumped `16g → 16h`.

## Suite + tsc
v4 unit **1120 / 1 skip / 0 fail** (was 1119 in 16g, +1). New test
in `soulSeed.test.ts` locks the 16g → 16h silent upgrade path.
`tsc --noEmit` clean.

## Manual smoke gate (for you)
1. Boot REPL. `[soul] …` notice should NOT fire (your 16g default
   silent-upgrades to 16h).
2. `/identity` shows the new media-search example in `<act_dont_ask>`.
3. `/skills` includes `media-search`.
4. "play me a popular song" → `skill_view(media-search)` → `web_search`
   for a chart-topper → ONE `open_url` to a `/watch?v=` URL → "Now
   playing: <title>" report.
5. "play despacito" → same flow with the specific title.

If gate 4 still asks for clarification or searches verbatim, the gap
is model temperament — not architecture. Path 2 (browser_navigate
returns body snippet) is the next escalation.

## Phase 16 series — closed
Series shipped: `16a` startup polish · `16b/c/d/e/f/g` moat + smart
approval + autonomy + planner + cooldown + memory · `16h.fix` media-
search teaching layer.

Phase 17 picks up plugin architecture (CDP browser, Spotify-style
playback tools, OAuth flows).

## Commits (chronological)
- `bb283b2` docs(v4): multi-step task incompletion diagnostic
- `d23521b` feat(skills): media-search skill for play/listen intents
- `7b8abc6` feat(soul): media-search guidance + 16h version bump
- `<this commit>` docs(v4): phase 16h summary

All on `backup/v4-rewrite`. Origin untouched.
