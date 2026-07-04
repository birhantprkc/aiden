/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/auto.ts — v4.14 the one-command autonomy opt-in.
 *
 * The SHIPPED default is the safe level (Assistant — asks at each write
 * boundary). `/auto` is the single, memorable opt-in to Partner ("auto"):
 * workspace-internal writes act WITHOUT asking, while every floor still gates
 * (destructive / external-send / spend / shell / out-of-workspace all still
 * ASK; the hard-block set still DENIES). `/auto off` (or `safe`) returns to
 * the safe default.
 *
 * Both directions PERSIST via `applyAndPersistAutonomy` (writes
 * `agent.autonomy` to config.yaml), so the choice survives a restart — the
 * boot path re-reads it through `resolveConfiguredAutonomyLevel`.
 *
 * This is a thin, friendly alias over `/autonomy Partner|Assistant`; it shares
 * the SAME apply+persist helper so the two can never drift, and it uses the
 * SAME `userInitiated` raise path (never bypasses the SH.1 freeze or any floor).
 */
import type { SlashCommand } from '../commandRegistry';
import type { AutonomyLevel } from '../../../moat/autonomy';
import { applyAndPersistAutonomy } from './autonomy';

const OFF_WORDS = new Set(['off', 'safe', 'stop', 'no', 'disable']);

export const auto: SlashCommand = {
  name: 'auto',
  description: 'Toggle Auto mode (Partner): workspace writes auto-apply; floors still ask.',
  category: 'system',
  icon: '⚡',
  handler: async (ctx) => {
    if (!ctx.approvalEngine) {
      ctx.display.warn('Approval engine not wired in this context.');
      return {};
    }
    const arg = (ctx.args[0] ?? '').trim().toLowerCase();
    const turnOff = OFF_WORDS.has(arg);
    const target: AutonomyLevel = turnOff ? 'Assistant' : 'Partner';

    const { applied, persisted } = await applyAndPersistAutonomy(ctx, target);
    if (!applied) {
      ctx.display.warn('Auto change was not applied (blocked by the approval floor).');
      return {};
    }

    const durability = persisted
      ? (turnOff ? ' Persisted across restarts.' : ' Persisted — stays on across restarts (/auto off to disable).')
      : ' Session only (config not writable here).';

    if (target === 'Partner') {
      ctx.display.success(
        `⚡ Auto ON (Partner) — acts freely under ${process.cwd()}; ` +
        `destructive / external / spend / out-of-scope still ask.${durability}`,
      );
    } else {
      ctx.display.success(
        `Auto OFF — safe mode (Assistant): asks at each write boundary.${durability}`,
      );
    }
    return {};
  },
};
