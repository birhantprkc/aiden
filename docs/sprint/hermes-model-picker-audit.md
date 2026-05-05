# Hermes audit — /model picker UI (Phase 16f)

**Question:** Aiden's existing `/model` picker is functional but lacks the
visual polish of Hermes. What's the pattern to copy?

## Sources
- `cli.py:5410-5423` — `_open_model_picker(providers, current_model, current_provider, …)`
  opens a prompt_toolkit-native modal. Two-stage state machine:
  - `stage: "provider"` — pick provider first
  - `stage: "model"` — then pick model within that provider
- `cli.py:5413` — `default_idx = next((i for i, p in enumerate(providers) if p.get("is_current")), 0)`
  cursor starts on the currently-active provider.
- `cli.py:5430-5456` — `_compute_model_picker_viewport(selected, scroll_offset, n, term_rows, …)`
  scrollable viewport math. Reserves rows for input area + status bar +
  panel chrome; slides scroll offset to keep the cursor on screen.
- `cli.py:5458-5495` — `_apply_model_switch_result(result, persist_global)`
  swaps `agent.switch_model(...)` and emits a "[Note: model was just
  switched from X to Y]" message into the conversation so the model
  knows its new identity.

## Findings
1. **Two-stage modal**: provider list → model list. Default cursor lands
   on the current selection (provider stage cursors on current provider).
2. **Scrollable viewport** — handles long lists (Hermes has 20+ providers
   each with 5-10 models) without overflowing terminal.
3. **Live agent swap** — picking a new model swaps `agent.switch_model()`
   immediately, no restart needed. Posts a system note into the
   conversation.
4. **Persistence flag** — `persist_global: bool` controls whether the
   choice writes to config.yaml (permanent default) or just for this
   session.
5. **Escape cancels, Enter selects** — standard prompt_toolkit modal
   conventions.

## Decision: **copy** (two-stage + scrollable + agent swap pattern)

Aiden's current `/model` already has a basic picker (`commands/modelPicker.ts`).
For Phase 16f the fix is mostly ergonomic — adopting the visual structure
without rewriting the engine.

**Plan (mostly polish):**
1. Two-stage flow already present — verify cursor defaults to current
   provider/model.
2. Add scrollable viewport math when list exceeds available rows
   (Hermes formula). Currently we just dump the full list.
3. Add the "[Note: model was just switched...]" injection into the
   conversation. Aiden has `aidenAgent.switchModel`-style API but
   doesn't post the note.
4. Persistence: add `persist` toggle in the picker (Y to save permanent,
   N for session-only) — Hermes pattern.

## What we're NOT copying
- prompt_toolkit specifically — Aiden uses its own renderer in
  `cli/v4/display.ts`. The state machine + math port; the rendering
  primitives don't.

This audit is mostly informational — Aiden's picker already has the
bones; we just polish toward the Hermes visual pattern in a future
phase if needed. **For Phase 16f we don't ship picker changes** —
recommendation is to leave existing picker as-is and revisit in 17.
