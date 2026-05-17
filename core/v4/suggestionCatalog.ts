/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/suggestionCatalog.ts — v4.5 Phase 8b.
 *
 * Pre-rendered user-facing copy for each contextual suggestion slot.
 * Centralised here so future tone tuning / i18n can change one file
 * without touching the engine.
 *
 * Style guide (approved tone Q-P8b-5(b)):
 *   - One line per tip.
 *   - ≤ 90 visible chars (room for indentation + emoji).
 *   - "💡 tip:" prefix, lowercase command + brief why.
 *   - No trailing punctuation gymnastics.
 *   - No second-person preaching ("you should" → drop).
 */

import type { SuggestionSlot } from './suggestionEngine';

/**
 * Slot → message map. The engine resolves the slot and the
 * catalog renders the matching copy.
 */
export const SUGGESTION_COPY: Readonly<Record<SuggestionSlot, string>> = Object.freeze({
  sandbox:
    '💡 tip: enable /sandbox on for a safer guardrail against destructive ops.',
  browser_depth:
    '💡 tip: enable /browser-depth on to capture page state + auto-retry stale refs.',
  daemon_scheduling:
    '💡 tip: this looks like a recurring task — `aiden cron add` or `aiden trigger add file` can run it on a schedule.',
  tce_recovery:
    '💡 tip: enable /tce on so Aiden classifies tool failures + auto-recovers.',
});

/**
 * Look up the rendered tip string for a slot. Pure — caller decides
 * when to display (`display.dim()` is the conventional sink).
 */
export function suggestionMessageFor(slot: SuggestionSlot): string {
  return SUGGESTION_COPY[slot];
}
