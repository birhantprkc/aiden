/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/skills/lookupToolSchema.test.ts — v4.6 Phase 1.
 *
 * Guards `lookup_tool_schema` behaviour. Pre-v4.6 it hardcoded
 * `riskTier: 'safe'` in the return value regardless of the queried
 * tool's actual tier — see Dispatch 2H diagnostic. v4.6 reads
 * `handler.riskTier ?? 'safe'` so callers get accurate risk
 * information.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { makeLookupToolSchema } from '../../../tools/v4/skills/lookupToolSchema';

function makeHandler(opts: {
  name: string;
  toolset?: string;
  riskTier?: 'safe' | 'caution' | 'dangerous';
}): ToolHandler {
  return {
    schema: {
      name: opts.name,
      description: `Test tool ${opts.name}`,
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    execute:  async () => ({ ok: true }),
    category: 'read',
    mutates:  false,
    toolset:  opts.toolset,
    ...(opts.riskTier ? { riskTier: opts.riskTier } : {}),
  };
}

describe('lookup_tool_schema (v4.6 Phase 1 — riskTier pass-through)', () => {
  it('returns the queried tool\'s actual riskTier (caution case)', async () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler({ name: 'cautious_tool', toolset: 'subagent', riskTier: 'caution' }));
    reg.register(makeLookupToolSchema(reg));

    const lookup = reg.get('lookup_tool_schema');
    expect(lookup).toBeDefined();
    const result = await lookup!.execute(
      { toolName: 'cautious_tool' },
      { cwd: process.cwd(), paths: {} as never },
    ) as { success: boolean; riskTier?: string };
    expect(result.success).toBe(true);
    expect(result.riskTier).toBe('caution');  // NOT hardcoded 'safe'
  });

  it('returns "dangerous" for dangerous-tier tools', async () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler({ name: 'rm_rf_tool', toolset: 'terminal', riskTier: 'dangerous' }));
    reg.register(makeLookupToolSchema(reg));

    const result = await reg.get('lookup_tool_schema')!.execute(
      { toolName: 'rm_rf_tool' },
      { cwd: process.cwd(), paths: {} as never },
    ) as { riskTier: string };
    expect(result.riskTier).toBe('dangerous');
  });

  it('defaults to "safe" when handler has no riskTier annotation', async () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler({ name: 'legacy_tool', toolset: 'web' }));  // no riskTier
    reg.register(makeLookupToolSchema(reg));

    const result = await reg.get('lookup_tool_schema')!.execute(
      { toolName: 'legacy_tool' },
      { cwd: process.cwd(), paths: {} as never },
    ) as { riskTier: string };
    expect(result.riskTier).toBe('safe');
  });

  it('returns success:false for unknown tool with availableTools list', async () => {
    const reg = new ToolRegistry();
    reg.register(makeHandler({ name: 'known_tool', toolset: 'web' }));
    reg.register(makeLookupToolSchema(reg));

    const result = await reg.get('lookup_tool_schema')!.execute(
      { toolName: 'does_not_exist' },
      { cwd: process.cwd(), paths: {} as never },
    ) as { success: boolean; error: string; availableTools: string[] };
    expect(result.success).toBe(false);
    expect(result.error).toContain('not registered');
    expect(result.availableTools).toContain('known_tool');
    expect(result.availableTools).toContain('lookup_tool_schema');
  });
});
