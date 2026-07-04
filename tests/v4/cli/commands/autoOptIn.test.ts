/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14 — `/auto` is the one-command opt-in to Partner ("auto"), and the
 * choice PERSISTS across restarts. This proves the round-trip:
 *   1. `/auto` sets the live engine level to Partner AND writes
 *      `agent.autonomy: Partner` to config (set + save).
 *   2. On the "next boot", `resolveConfiguredAutonomyLevel` reads that back
 *      → Partner. So the opt-in survives a restart.
 *   3. `/auto off` returns to the safe default (Assistant), also persisted.
 *   4. No ConfigManager wired → session-only switch with a visible note
 *      (never silently non-durable).
 *   5. `/autonomy <level>` shares the SAME apply+persist helper.
 */
import { describe, it, expect, vi } from 'vitest';

import { auto } from '../../../../cli/v4/commands/auto';
import { autonomy } from '../../../../cli/v4/commands/autonomy';
import { ApprovalEngine } from '../../../../moat/approvalEngine';
import { resolveConfiguredAutonomyLevel } from '../../../../core/v4/config';
import type { SlashCommandContext } from '../../../../cli/v4/commandRegistry';

/** A config double that records dotted writes and reads them back (as boot would). */
function fakeConfig() {
  const store: Record<string, unknown> = {};
  return {
    store,
    set: (k: string, v: unknown) => { store[k] = v; },
    save: vi.fn(async () => {}),
    getValue: <T,>(k: string, fb?: T): T => (k in store ? (store[k] as T) : (fb as T)),
  };
}
function captured() {
  const out: string[] = [];
  return {
    out,
    info: (m: string) => out.push(`info:${m}`),
    warn: (m: string) => out.push(`warn:${m}`),
    success: (m: string) => out.push(`ok:${m}`),
    dim: (m: string) => out.push(`dim:${m}`),
    write: (m: string) => out.push(m),
    printError: (m: string) => out.push(`err:${m}`),
  };
}
function buildCtx(
  args: string[],
  opts: { engine?: ApprovalEngine; config?: ReturnType<typeof fakeConfig> } = {},
) {
  const display = captured();
  const ctx = {
    args,
    rawArgs: args.join(' '),
    display,
    approvalEngine: opts.engine,
    config: opts.config,
  } as unknown as SlashCommandContext;
  return { ctx, display };
}
const text = (d: ReturnType<typeof captured>) => d.out.join('\n');

describe('/auto — one-command opt-in to Partner, persisted', () => {
  it('/auto sets the live level to Partner AND persists agent.autonomy=Partner', async () => {
    const engine = new ApprovalEngine('smart');
    const config = fakeConfig();
    const { ctx, display } = buildCtx([], { engine, config });

    await auto.handler(ctx);

    expect(engine.getAutonomyPolicy()?.level).toBe('Partner');   // live session flipped
    expect(config.store['agent.autonomy']).toBe('Partner');       // written to config
    expect(config.save).toHaveBeenCalledOnce();                   // flushed to disk
    expect(text(display)).toMatch(/Auto ON \(Partner\)/);
    expect(text(display)).toMatch(/Persisted/);
  });

  it('the persisted opt-in SURVIVES A RESTART (boot re-reads it → Partner)', async () => {
    const engine = new ApprovalEngine('smart');
    const config = fakeConfig();
    const { ctx } = buildCtx([], { engine, config });
    await auto.handler(ctx);

    // Simulate the next boot: a fresh resolver reading the persisted config.
    expect(resolveConfiguredAutonomyLevel(config)).toBe('Partner');
  });

  it('/auto off returns to the safe default (Assistant), also persisted', async () => {
    const engine = new ApprovalEngine('smart');
    const config = fakeConfig();
    config.set('agent.autonomy', 'Partner');                      // start opted-in

    const { ctx, display } = buildCtx(['off'], { engine, config });
    await auto.handler(ctx);

    expect(engine.getAutonomyPolicy()?.level).toBe('Assistant');
    expect(config.store['agent.autonomy']).toBe('Assistant');     // opt-in cleared
    expect(resolveConfiguredAutonomyLevel(config)).toBe('Assistant'); // safe on next boot
    expect(text(display)).toMatch(/Auto OFF/);
  });

  it('no ConfigManager wired → session-only switch, with a visible note (not silent)', async () => {
    const engine = new ApprovalEngine('smart');
    const { ctx, display } = buildCtx([], { engine });            // no config
    await auto.handler(ctx);

    expect(engine.getAutonomyPolicy()?.level).toBe('Partner');    // live switch still works
    expect(text(display)).toMatch(/Session only/);                // durability surfaced
  });

  it('no approval engine → a clear warning, no crash', async () => {
    const { ctx, display } = buildCtx([]);                        // nothing wired
    await auto.handler(ctx);
    expect(text(display)).toMatch(/Approval engine not wired/);
  });
});

describe('/autonomy <level> — shares the same persist helper', () => {
  it('/autonomy Partner persists agent.autonomy=Partner (survives restart)', async () => {
    const engine = new ApprovalEngine('smart');
    const config = fakeConfig();
    const { ctx, display } = buildCtx(['Partner'], { engine, config });

    await autonomy.handler(ctx);

    expect(engine.getAutonomyPolicy()?.level).toBe('Partner');
    expect(config.store['agent.autonomy']).toBe('Partner');
    expect(resolveConfiguredAutonomyLevel(config)).toBe('Partner');
    expect(text(display)).toMatch(/Persisted/);
  });

  it('/autonomy Observer persists too (any explicit level is durable)', async () => {
    const engine = new ApprovalEngine('smart');
    const config = fakeConfig();
    const { ctx } = buildCtx(['observer'], { engine, config });   // case-insensitive
    await autonomy.handler(ctx);
    expect(config.store['agent.autonomy']).toBe('Observer');
  });
});
