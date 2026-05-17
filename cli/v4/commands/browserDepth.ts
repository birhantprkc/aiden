/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/browserDepth.ts — v4.5 Phase 8a.
 *
 * `/browser-depth on|off|status` — flip the v4.3 state-aware
 * browser observer (URL/DOM/iframe-tree capture, stale-ref retry,
 * manual-blocker detection) without restart. Persists to
 * config.yaml. Env var AIDEN_BROWSER_DEPTH always wins.
 *
 * Q-P8a-5(a): named `/browser-depth` to mirror the env var
 * exactly. Reserves `/browser` for future browser-navigation
 * commands so the namespace stays unambiguous.
 */

import type { SlashCommand } from '../commandRegistry';
import { flip, printStatus, parseSubcommand } from './_runtimeToggleHelpers';

export const browserDepth: SlashCommand = {
  name: 'browser-depth',
  description: 'Toggle the v4.3 state-aware browser observer.',
  category: 'system',
  icon: '🌐',
  handler: async (ctx) => {
    const sub = parseSubcommand(ctx.args[0]);
    if (sub === 'on')     { await flip('browser_depth', true,  ctx); return {}; }
    if (sub === 'off')    { await flip('browser_depth', false, ctx); return {}; }
    if (sub === 'status') { printStatus('browser_depth', ctx);       return {}; }
    ctx.display.printError('Usage: /browser-depth on|off|status');
    return {};
  },
};
