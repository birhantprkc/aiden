# Hermes audit — approval modes + session allowlist (Phase 16f)

**Question:** approval prompts on every browser sub-action break flow. What
does Hermes do for "smart" approval, allowlists, and persistence?

## Sources
- `cli.py:7333-7350` — `_toggle_yolo()`. Global yolo via `HERMES_YOLO_MODE`
  env var; flips between "all approved" and "dangerous commands prompt."
  No "smart" config tier — just yolo on/off.
- `cli.py:8712-8745` — `_approval_callback(command, description, *, allow_permanent)`.
  Prompt UI returns `once / session / always / deny`. 60s timeout.
  `allow_permanent=False` hides the "always" option (used when Tirith
  flagged the command as dangerous).
- `agent/shell_hooks.py:538-596` — disk allowlist:
  `~/.hermes/.allowlist.json` storing `[{event, command}]` tuples.
  `_is_allowlisted(event, command)` matches by exact tuple. "always"
  choice writes here; "session" stays in-memory.
- `agent/shell_hooks.py:599-627` — `_locked_update_approvals()` — flock
  serialised read-modify-write so concurrent writers don't clobber.
- `cli.py:7868-7872` — pattern for "Always" persisting a config key:
  `save_config_value("approvals.mcp_reload_confirm", False)`. Same
  pattern reusable for any approvals.* config.

## Findings
1. **No LLM-based "smart classifier."** Hermes uses rule-based + user-
   recorded allowlist. Any new command prompts; matching past approval
   silently passes. This is the cheapest "smart": the user *is* the
   classifier, and their decisions accumulate.
2. **4-choice prompt with timeout.** `once / session / always / deny`,
   60s default. `always` writes to disk, `session` in-memory map,
   `once` returns true without recording.
3. **`allow_permanent=False` flag** hides "always" when Tirith /
   security pre-check flagged the command. Forces user to re-prompt
   each session for sensitive ops.
4. **Yolo is one bit, not a mode tier.** `HERMES_YOLO_MODE=1` env var
   skips prompts globally. No middle mode; either prompt-on-unseen or
   approve-everything.
5. **Allowlist is exact-match (event, command).** No glob/regex/domain
   patterns at the tool-args level. For things like browser_navigate to
   different URLs, every URL would re-prompt. This is a weakness Aiden
   should improve on.

## Decision: **adapt** (rule-based + tool/domain patterns + recorded allowlist)

Aiden's interactive REPL UX is a single user, not Hermes's multi-platform
gateway. We can be more permissive without adding LLM cost:

1. **Built-in low-risk allowlist** (no prompt ever): `file_read`, `file_list`,
   `fetch_url`, `web_search`, `session_search`, `memory_*`, `system_info`,
   `now_playing`, `browser_screenshot`, `browser_get_url`. Hermes-equivalent
   "the user already trusted these by installing".
2. **Domain allowlist for `browser_navigate`** — built-in safe set (google,
   wikipedia, github, stackoverflow, npmjs, taracod, common docs sites).
   Hermes lacks this; their per-URL prompts are a known friction point.
3. **Recorded allowlist** for everything else, copying Hermes's pattern:
   `~/.aiden/approvals.json` with `[{tool, args_pattern, scope: session|always}]`.
   "always" persists, "session" in-memory.
4. **4-choice prompt** copy verbatim: `once / session / always / deny`,
   60s timeout.
5. **Hard-block** dangerous patterns (rm -rf, fork bombs, etc.) via Phase 9
   Tirith — these never reach the prompt.
6. **`/yolo` global toggle** — copy Hermes one-bit env model.

`approvals.mode` config key (was `manual` only): now accepts
`smart | manual | yolo`. Default flips from `manual` to `smart`.
- `smart` = built-in rules + recorded allowlist, prompt on unseen
- `manual` = always prompt (current 16e default, kept for paranoid users)
- `yolo` = approve everything (Hermes parity)

## What we're NOT copying

- LLM-call risk classifier — adds latency per tool call, no measurable
  win over rule-based + recorded.
- Per-process flock allowlist locking — Aiden is single-process REPL;
  in-process lock + atomic file write suffices.
- `allow_permanent=False` Tirith flag — for v4.0 we just don't show
  "always" if Tirith pre-flagged. Same effect, simpler plumbing.
