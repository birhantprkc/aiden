/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 BE.1 — per-session token cap + graceful finalization + resume-handoff.
 *
 * Money-safety (FULL-GATE): the cap is enforced BEFORE the provider call, total
 * spend never exceeds the cap (incl. the finalization summary via the reserve),
 * on cap-hit no new side-effects; unset cap → byte-identical to today.
 */
import { describe, it, expect } from 'vitest';
import { AidenAgent } from '../../core/v4/aidenAgent';
import { MockProviderAdapter } from '../../core/v4/__mocks__/mockProvider';
import type { ToolSchema, ToolCallRequest, Message } from '../../providers/v4/types';
import type { ToolExecutor } from '../../core/v4/aidenAgent';

const NOOP_TOOL: ToolSchema = { name: 'noop', description: 'no-op', inputSchema: { type: 'object', properties: { n: { type: 'number' } } } };
const okExecutor: ToolExecutor = async (call) => ({ id: call.id, name: call.name, result: { ok: true }, error: null });
const userMsg = (c: string): Message => ({ role: 'user', content: c });
// unique args each turn so TCE loop-detection doesn't trip before the budget does
const toolTurn = (i: number, usage: { inputTokens: number; outputTokens: number }) =>
  MockProviderAdapter.toolUse([{ id: `c${i}`, name: 'noop', arguments: { n: i } } as ToolCallRequest], usage);
const total = (u: { inputTokens: number; outputTokens: number }) => u.inputTokens + u.outputTokens;

describe('BE.1 — cap unset (byte-identical, no enforcement)', () => {
  it('runs normally with no sessionTokenCap', async () => {
    const provider = new MockProviderAdapter([MockProviderAdapter.stop('done')]);
    const agent = new AidenAgent({ provider, toolExecutor: okExecutor, tools: [] });
    const r = await agent.runConversation([userMsg('hi')]);
    expect(r.finishReason).toBe('stop');
    expect(r.finalContent).toBe('done');
    expect(r.resumeHandoff).toBeUndefined();
  });
});

describe('BE.1 — ★ enforce + graceful finalization + total ≤ cap', () => {
  it('stops before the cap, does ONE toolless summary within reserve, total ≤ cap, handoff present', async () => {
    const cap = 40_000;
    const use = { inputTokens: 4_000, outputTokens: 4_000 }; // 8k/call, output < maxOutput (realistic)
    const provider = new MockProviderAdapter([
      toolTurn(1, use), toolTurn(2, use), toolTurn(3, use), toolTurn(4, use),
      MockProviderAdapter.stop('Final summary: partial progress made.', { inputTokens: 500, outputTokens: 500 }),
    ]);
    const warns: Array<{ level: string; kind?: string }> = [];
    const agent = new AidenAgent({
      provider, toolExecutor: okExecutor, tools: [NOOP_TOOL],
      sessionTokenCap: cap,
      onBudgetWarning: (level, _c, _m, kind) => warns.push({ level, kind }),
    });
    const r = await agent.runConversation([userMsg('do a long task')]);

    expect(r.finishReason).toBe('budget_exhausted');
    expect(total(r.totalUsage)).toBeLessThanOrEqual(cap);          // ★ absolute money-safety
    expect(r.finalContent).toContain('Final summary');              // toolless summary landed
    expect(r.resumeHandoff).toBeDefined();
    expect(r.resumeHandoff!.partial_work).toContain('Final summary');
    expect(r.resumeHandoff!.next_steps).toMatch(/incomplete|budget/i);
    expect(r.resumeHandoff!.resume).toMatch(/budget|session/i);
    expect(warns.some((w) => w.kind === 'tokens')).toBe(true);      // token warn-ladder fired
  });
});

describe('BE.1 — ★ no reserve headroom → deterministic partial, ZERO further spend', () => {
  it('when already within reserve of the cap: no summary call, no spend, handoff returned', async () => {
    const cap = 40_000;
    // provider script is EMPTY — if any call is made, the mock throws.
    const provider = new MockProviderAdapter([]);
    const agent = new AidenAgent({
      provider, toolExecutor: okExecutor, tools: [NOOP_TOOL],
      sessionTokenCap: cap,
    });
    // seed the session already at the cap → first call would breach, no reserve for a summary
    const r = await agent.runConversation([userMsg('continue')], { sessionTokensSoFar: 39_800 });

    expect(r.finishReason).toBe('budget_exhausted');
    expect(total(r.totalUsage)).toBe(0);                            // ★ zero further spend this run
    expect(provider.capturedInputs.length).toBe(0);                 // ★ no provider call made
    expect(r.finalContent).toMatch(/paused|budget/i);              // deterministic partial
    expect(r.resumeHandoff).toBeDefined();
  });
});

describe('BE.1 — token warn-ladder fires at caution + warning (kind=tokens)', () => {
  it('crossing 80% and 90% both fire, surfaced as token warnings', async () => {
    const cap = 100_000;
    // one call jumps usage across both 80% (80k) and 90% (90k) thresholds
    const provider = new MockProviderAdapter([
      toolTurn(1, { inputTokens: 88_000, outputTokens: 4_000 }),
      MockProviderAdapter.stop('summary', { inputTokens: 500, outputTokens: 500 }),
    ]);
    const warns: Array<{ level: string; kind?: string }> = [];
    const agent = new AidenAgent({
      provider, toolExecutor: okExecutor, tools: [NOOP_TOOL],
      sessionTokenCap: cap,
      onBudgetWarning: (level, _c, _m, kind) => warns.push({ level, kind }),
    });
    const r = await agent.runConversation([userMsg('long')]);
    const tokenWarns = warns.filter((w) => w.kind === 'tokens');
    expect(tokenWarns.some((w) => w.level === 'caution')).toBe(true);
    expect(tokenWarns.some((w) => w.level === 'warning')).toBe(true);
    expect(total(r.totalUsage)).toBeLessThanOrEqual(cap);          // money-safe
  });
});
