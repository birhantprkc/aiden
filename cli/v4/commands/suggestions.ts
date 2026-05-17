/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/suggestions.ts — v4.5 Phase 8b.
 *
 * `/suggestions on|off|status` — flip the contextual capability
 * suggestions surfaced by the suggestionEngine (Phase 8b). Reuses
 * the Phase 8a `_runtimeToggleHelpers` since 'suggestions' is now
 * a fourth ToggleKey on the runtimeToggles singleton.
 *
 *   /suggestions on      — re-enable tips (default).
 *   /suggestions off     — silence tips for this REPL + persist to
 *                          config.yaml (runtime_toggles.suggestions
 *                          = false). Subsequent boots stay quiet
 *                          until /suggestions on flips it back.
 *   /suggestions status  — single-line state with source +
 *                          fired-this-session count + budget remaining.
 */

import type { SlashCommand } from '../commandRegistry';
import { flip, parseSubcommand } from './_runtimeToggleHelpers';
import { getRuntimeToggles } from '../../../core/v4/runtimeToggles';
import { getSuggestionEngine } from '../../../core/v4/suggestionEngine';

export const suggestions: SlashCommand = {
  name: 'suggestions',
  description: 'Toggle contextual one-line capability tips.',
  category: 'system',
  icon: '💡',
  handler: async (ctx) => {
    const sub = parseSubcommand(ctx.args[0]);
    if (sub === 'on')  { await flip('suggestions', true,  ctx); return {}; }
    if (sub === 'off') {
      await flip('suggestions', false, ctx);
      // Also session-dismiss so the in-process engine stops firing
      // immediately, not just after the next REPL restart picks up
      // the new config value.
      try { getSuggestionEngine().dismissAll(); } catch { /* defensive */ }
      return {};
    }
    if (sub === 'status') {
      const tog  = getRuntimeToggles().snapshot().suggestions;
      const snap = getSuggestionEngine().snapshot();
      const state = tog.value ? 'ON' : 'OFF';
      const dismissTag = snap.dismissedSession && tog.value ? ' (dismissed this session)' : '';
      ctx.display.write(`Suggestions: ${state}   (source: ${tog.source})${dismissTag}\n`);
      if (snap.firedSlots.length > 0) {
        ctx.display.write(
          `  fired this session: ${snap.firedSlots.join(', ')} · budget remaining: ${snap.budgetRemaining}\n`,
        );
      } else {
        ctx.display.write(`  fired this session: (none) · budget remaining: ${snap.budgetRemaining}\n`);
      }
      return {};
    }
    ctx.display.printError('Usage: /suggestions on|off|status');
    return {};
  },
};
