/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/tce.ts — v4.5 Phase 8a.
 *
 * `/tce on|off|status` — flip the v4.2 Tool-Call Effort recovery
 * pipeline (verifier + failure classifier + recovery report)
 * without restart. Persists to config.yaml. Env var AIDEN_TCE
 * always wins.
 */

import type { SlashCommand } from '../commandRegistry';
import { flip, printStatus, parseSubcommand } from './_runtimeToggleHelpers';

export const tce: SlashCommand = {
  name: 'tce',
  description: 'Toggle the v4.2 Tool-Call Effort recovery pipeline.',
  category: 'system',
  icon: '🔁',
  handler: async (ctx) => {
    const sub = parseSubcommand(ctx.args[0]);
    if (sub === 'on')     { await flip('tce', true,  ctx); return {}; }
    if (sub === 'off')    { await flip('tce', false, ctx); return {}; }
    if (sub === 'status') { printStatus('tce', ctx);       return {}; }
    ctx.display.printError('Usage: /tce on|off|status');
    return {};
  },
};
