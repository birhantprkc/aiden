/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/greeter.ts — v4.9.3 SLICE 1a.
 *
 * `/greeter on | off | status` — REPL controls for the boot greeter.
 *   - on     → set disabled: false; init the file if missing
 *   - off    → confirm-gated (uses v4.9.2 Slice 3 ctx.confirm), set
 *              disabled: true
 *   - status → print current state + last greeting + offer summary
 *
 * Slice 1a: the slash command operates on the history file even
 * though the greeter doesn't fire on boot yet (Slice 1b wires that).
 * `/greeter off` BEFORE Slice 1b still durably disables, so when
 * Slice 1b lands the user's choice is already honored.
 */

import type { SlashCommand } from '../commandRegistry';
import {
  readHistory,
  writeHistory,
} from '../greeter/history';
import type { GreeterHistory } from '../greeter/types';

export const greeter: SlashCommand = {
  name:        'greeter',
  description: 'Manage the boot greeter. Actions: on, off, status.',
  category:    'system',
  icon:        '👋',
  handler:     async (ctx) => {
    if (!ctx.paths) {
      ctx.display.printError('Cannot read greeter state — paths not wired in this session.');
      return;
    }
    const sub = (ctx.args[0] ?? 'status').toLowerCase();

    if (sub === 'on') {
      const h = (await readHistory(ctx.paths)) ?? initial();
      h.disabled = false;
      await writeHistory(ctx.paths, h);
      ctx.display.success('Greeter on. Next boot will check for noticeable changes.');
      return;
    }

    if (sub === 'off') {
      if (!ctx.confirm) {
        ctx.display.printError('Cannot confirm in this context.');
        return;
      }
      const proceed = await ctx.confirm(
        'Turn the boot greeter off? You can re-enable with /greeter on.',
      );
      if (!proceed) return;       // confirm() already printed the rejection reason
      const h = (await readHistory(ctx.paths)) ?? initial();
      h.disabled = true;
      await writeHistory(ctx.paths, h);
      ctx.display.success('Greeter off. No greeting on boot until /greeter on.');
      return;
    }

    if (sub === 'status') {
      const h = await readHistory(ctx.paths);
      if (!h) {
        ctx.display.dim('Greeter has not been initialized yet (no boots since v4.9.3).');
        return;
      }
      const state = h.disabled ? 'off' : 'on';
      const accepted = h.offers.filter((o) => o.response === 'accepted').length;
      const ignored  = h.offers.filter((o) => o.response === 'ignored').length;
      const pending  = h.offers.filter((o) => !o.response).length;
      ctx.display.write('\n  Greeter status:\n');
      ctx.display.write(`    state:         ${state}\n`);
      ctx.display.write(`    first launch:  ${h.firstLaunchAt}\n`);
      ctx.display.write(`    last greeting: ${h.lastGreetingAt}\n`);
      ctx.display.write(`    offers:        ${h.offers.length} (${accepted} accepted · ${ignored} ignored · ${pending} pending)\n\n`);
      return;
    }

    ctx.display.printError(`Unknown greeter action '${sub}'.`, 'Try: /greeter on | off | status');
  },
};

function initial(): GreeterHistory {
  const now = new Date().toISOString();
  return {
    v:               1,
    firstLaunchAt:   now,
    lastGreetingAt:  now,
    offers:          [],
    disabled:        false,
  };
}
