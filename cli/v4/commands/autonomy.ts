/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/autonomy.ts — v4.12.1 Pillar 2.
 *
 * `/autonomy <level>` — set the session's autonomy dial:
 *
 *   Observer  — read-only, never mutates.
 *   Assistant — acts, asks at risk boundaries (the default).
 *   Partner   — acts freely inside the workspace; destructive / external /
 *               out-of-scope still ask.
 *
 * This is the ONLY user-facing raise path: it calls `setAutonomyPolicy` with
 * `{ userInitiated: true }`, so it works after the SH.1 freeze — but
 * in-process / prompt-injected code (no userInitiated) can NEVER raise the
 * level. `--yolo` stays a separate dev bypass, not a dial level.
 */
import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import {
  type AutonomyLevel,
  isAutonomyLevel,
  resolveAutonomyPolicy,
  AUTONOMY_LEVELS,
} from '../../../moat/autonomy';

/**
 * Apply an autonomy level to the LIVE session AND persist it so the choice
 * SURVIVES A RESTART. The engine change uses `userInitiated: true` — the ONLY
 * sanctioned raise path (respects the SH.1 freeze; in-process / prompt-injected
 * code can never raise the level). Persistence writes `agent.autonomy` to
 * config.yaml, which `resolveConfiguredAutonomyLevel` reads back at the next
 * boot (aidenCLI wires the boot default from it).
 *
 * Returns `{ applied, persisted }`:
 *   • applied=false   → no engine, or the approval floor blocked the change.
 *   • persisted=false → no ConfigManager wired (session-only switch); the
 *     caller MUST surface this so a change is never silently non-durable.
 *
 * Shared by `/autonomy <level>` and `/auto` so the two can never drift.
 */
export async function applyAndPersistAutonomy(
  ctx: SlashCommandContext,
  level: AutonomyLevel,
): Promise<{ applied: boolean; persisted: boolean }> {
  const engine = ctx.approvalEngine;
  if (!engine) return { applied: false, persisted: false };
  const policy = resolveAutonomyPolicy(level, { workspaceRoots: [process.cwd()] });
  const applied = engine.setAutonomyPolicy(policy, { userInitiated: true });
  if (!applied) return { applied: false, persisted: false };
  let persisted = false;
  if (ctx.config) {
    ctx.config.set('agent.autonomy', level);
    await ctx.config.save();
    persisted = true;
  }
  return { applied: true, persisted };
}

/** Human note for a level, appended to the confirmation line. */
function levelNote(level: AutonomyLevel): string {
  return level === 'Observer'  ? 'read-only — no mutations will run.'
    : level === 'Partner' ? `acts freely under ${process.cwd()} — destructive / external / spend / out-of-scope still ask.`
    : 'acts, asks at each risk boundary.';
}

export const autonomy: SlashCommand = {
  name: 'autonomy',
  description: 'Set the autonomy dial: Observer | Assistant | Partner (persisted).',
  category: 'system',
  icon: '🎚️',
  handler: async (ctx) => {
    const engine = ctx.approvalEngine;
    if (!engine) {
      ctx.display.warn('Approval engine not wired in this context.');
      return {};
    }
    const current = engine.getAutonomyPolicy()?.level ?? 'Assistant';

    const arg = (ctx.args[0] ?? '').trim();
    if (!arg) {
      ctx.display.info(
        `Autonomy: ${current}. Levels: ${AUTONOMY_LEVELS.join(' | ')}. ` +
        `Usage: /autonomy <level>  (or /auto to toggle Partner).`,
      );
      return {};
    }
    // Case-insensitive match to the canonical capitalised level.
    const level = AUTONOMY_LEVELS.find((l) => l.toLowerCase() === arg.toLowerCase());
    if (!level || !isAutonomyLevel(level)) {
      ctx.display.warn(
        `Unknown level "${arg}". Choose one of: ${AUTONOMY_LEVELS.join(', ')}.`,
      );
      return {};
    }

    const { applied, persisted } = await applyAndPersistAutonomy(ctx, level);
    if (!applied) {
      ctx.display.warn('Autonomy change was not applied (blocked by the approval floor).');
      return {};
    }
    const durability = persisted
      ? ' Persisted — survives restart.'
      : ' Session only (config not writable here).';
    ctx.display.success(`Autonomy set to ${level} — ${levelNote(level)}${durability}`);
    return {};
  },
};
