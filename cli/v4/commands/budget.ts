/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/budget.ts — v4.12 BE.1.
 *
 * `/budget` — show this session's token usage vs the per-session token cap
 * (config `budget.session_token_cap`). `/budget <n>` sets the cap for THIS
 * session (config.yaml persists the durable default). 0 / unset = no cap.
 *
 * The cap is enforced money-safely at the provider-call boundary (see
 * aidenAgent BE.1): a call that would exceed it is never made.
 */

import type { SlashCommand } from '../commandRegistry';

export const budget: SlashCommand = {
  name: 'budget',
  description: 'Show session token usage vs cap; `/budget <n>` sets it (0 = off).',
  category: 'system',
  icon: '💰',
  handler: async (ctx) => {
    const cap = ctx.config?.getValue<number>('budget.session_token_cap', 0) ?? 0;
    const arg = (ctx.args[0] ?? '').trim();

    // Set path — `/budget <n>` (or `/budget off`).
    if (arg) {
      const n = /^off$/i.test(arg) ? 0 : Number.parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 0) {
        ctx.display.printError('Usage: /budget [<max_tokens> | off]');
        return {};
      }
      try { ctx.config?.set('budget.session_token_cap', n); await ctx.config?.save(); } catch { /* best-effort */ }
      ctx.display.success(
        n === 0
          ? 'Session token cap disabled (no budget enforcement).'
          : `Session token cap set to ${n.toLocaleString()} tokens. Applies to new sessions (restart to re-arm the running agent).`,
      );
      return {};
    }

    // View path.
    const id = ctx.session?.getSessionId?.();
    const used = id && ctx.sessionManager ? ctx.sessionManager.getSessionTokens(id) : 0;
    if (cap > 0) {
      const pct = Math.min(100, Math.round((used / cap) * 100));
      ctx.display.info(`Budget: ${used.toLocaleString()} / ${cap.toLocaleString()} tokens (${pct}%) this session.`);
      if (pct >= 90) ctx.display.warn('  Near the cap — the agent will finalize gracefully rather than overspend.');
      ctx.display.info('  Set with `/budget <max_tokens>` or config `budget.session_token_cap`; `/budget off` to disable.');
    } else {
      ctx.display.info(`Budget: ${used.toLocaleString()} tokens used this session — no cap set.`);
      ctx.display.info('  Set a cap with `/budget <max_tokens>` (money-safety: stops before overspending).');
    }
    return {};
  },
};
