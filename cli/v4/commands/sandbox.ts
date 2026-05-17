/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/sandbox.ts — v4.5 Phase 8a.
 *
 * `/sandbox on|off|status` — flip the v4.4 execution sandbox
 * (filesystem allow/deny + docker session backend + dryRun
 * preflight) without restart. Persists to config.yaml
 * (runtime_toggles.sandbox). Env var AIDEN_SANDBOX always wins
 * over both — see runtimeToggles.ts for precedence rules.
 *
 * Q-P8a-4(a): /sandbox off flips silently. User explicitly typed
 * the command and the status output makes the flip visible. The
 * sandbox denylist (fs.sensitive_path) remains in effect for
 * unmistakably dangerous paths regardless of the toggle —
 * disabling the sandbox does NOT remove the always-on denylist.
 */

import type { SlashCommand } from '../commandRegistry';
import { flip, printStatus, parseSubcommand } from './_runtimeToggleHelpers';

export const sandbox: SlashCommand = {
  name: 'sandbox',
  description: 'Toggle the v4.4 execution sandbox (file ACLs + docker tools).',
  category: 'system',
  icon: '🛡',
  handler: async (ctx) => {
    const sub = parseSubcommand(ctx.args[0]);
    if (sub === 'on')     { await flip('sandbox', true,  ctx); return {}; }
    if (sub === 'off')    { await flip('sandbox', false, ctx); return {}; }
    if (sub === 'status') { printStatus('sandbox', ctx);       return {}; }
    ctx.display.printError('Usage: /sandbox on|off|status');
    return {};
  },
};
