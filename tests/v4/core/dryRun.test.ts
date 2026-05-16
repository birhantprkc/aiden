/**
 * v4.4 Phase 4 — dryRun.ts unit tests.
 *
 * Coverage:
 *   1. withDryRun passes read-only tools through unchanged
 *   2. AIDEN_DRYRUN=0 (default): wrapped mutating tool executes
 *      normally — no preview path triggered
 *   3. AIDEN_DRYRUN=1: wrapped mutating tool returns
 *      { success: true, dryRun: true, wouldExecute: {...} }
 *      and never calls the underlying `execute`
 *   4. Tool without `buildPreview` gets `genericPreview` envelope
 *      (no crash; coverage sentinel test in dryRunCoverage.test.ts
 *      catches missing real previews at gate time)
 *   5. Orthogonality with AIDEN_SANDBOX (dry-run works whether
 *      sandbox is on or off)
 *   6. truncatePreview / makeWouldExecute helpers
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  withDryRun,
  genericPreview,
  truncatePreview,
  makeWouldExecute,
  type DryRunPreview,
} from '../../../core/v4/dryRun';
import {
  _resetSandboxConfigForTests,
} from '../../../core/v4/sandboxConfig';
import type { ToolHandler, ToolContext } from '../../../core/v4/toolRegistry';
import { resolveAidenPaths } from '../../../core/v4/paths';
import path from 'node:path';
import os from 'node:os';

function makeCtx(): ToolContext {
  return {
    cwd:   os.tmpdir(),
    paths: resolveAidenPaths({ rootOverride: path.join(os.tmpdir(), '.aiden-dryrun-test') }),
  };
}

function makeReadTool(): ToolHandler {
  return {
    schema:  { name: 'fake_read', description: '', inputSchema: { type: 'object', properties: {} } },
    category: 'read',
    mutates: false,
    toolset: 'test',
    riskTier: 'safe',
    async execute() { return { success: true, ran: true }; },
  };
}

function makeWriteTool(opts: { withPreview: boolean }): { handler: ToolHandler; calls: { execute: number; preview: number } } {
  const calls = { execute: 0, preview: 0 };
  const handler: ToolHandler = {
    schema:  { name: 'fake_write', description: '', inputSchema: { type: 'object', properties: {} } },
    category: 'write',
    mutates: true,
    toolset: 'test',
    riskTier: 'caution',
    async execute() { calls.execute++; return { success: true, ran: true }; },
    ...(opts.withPreview
      ? { buildPreview: (args: Record<string, unknown>) => {
            calls.preview++;
            return {
              tool: 'fake_write', args, riskTier: 'caution',
              sideEffects: [{ type: 'create_file', path: '/tmp/x', bytes: 1 }],
              detectedRisks: [], summary: 'fake preview',
            };
          } }
      : {}),
  };
  return { handler, calls };
}

beforeEach(() => { _resetSandboxConfigForTests(); });
afterEach(() => {
  if (process.env.AIDEN_DRYRUN !== undefined) delete process.env.AIDEN_DRYRUN;
  if (process.env.AIDEN_SANDBOX !== undefined) delete process.env.AIDEN_SANDBOX;
  _resetSandboxConfigForTests();
});

describe('withDryRun — read-only tools', () => {
  it('passes read tools through unchanged (mutates=false)', () => {
    const read = makeReadTool();
    const wrapped = withDryRun(read);
    expect(wrapped).toBe(read);
  });
});

describe('withDryRun — AIDEN_DRYRUN=0 (default)', () => {
  it('mutating tool: executes normally, no preview', async () => {
    const { handler, calls } = makeWriteTool({ withPreview: true });
    const wrapped = withDryRun(handler);
    const r = await wrapped.execute({}, makeCtx()) as { success: boolean; dryRun?: boolean };
    expect(r.success).toBe(true);
    expect(r.dryRun).toBeUndefined();
    expect(calls.execute).toBe(1);
    expect(calls.preview).toBe(0);
  });
});

describe('withDryRun — AIDEN_DRYRUN=1', () => {
  it('mutating tool: returns preview envelope, never calls execute', async () => {
    process.env.AIDEN_DRYRUN = '1';
    _resetSandboxConfigForTests();
    const { handler, calls } = makeWriteTool({ withPreview: true });
    const wrapped = withDryRun(handler);
    const r = await wrapped.execute({ key: 'val' }, makeCtx()) as DryRunPreview;
    expect(r.success).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.wouldExecute.tool).toBe('fake_write');
    expect(r.wouldExecute.sideEffects).toHaveLength(1);
    expect(calls.execute).toBe(0);
    expect(calls.preview).toBe(1);
  });

  it('mutating tool without buildPreview: returns genericPreview envelope', async () => {
    process.env.AIDEN_DRYRUN = '1';
    _resetSandboxConfigForTests();
    const { handler, calls } = makeWriteTool({ withPreview: false });
    const wrapped = withDryRun(handler);
    const r = await wrapped.execute({}, makeCtx()) as DryRunPreview;
    expect(r.success).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.wouldExecute.tool).toBe('fake_write');
    expect(r.wouldExecute.sideEffects).toEqual([]);
    expect(r.wouldExecute.summary).toMatch(/no detailed preview/i);
    expect(calls.execute).toBe(0);
  });
});

describe('withDryRun — orthogonality with AIDEN_SANDBOX', () => {
  it('AIDEN_DRYRUN=1 + AIDEN_SANDBOX=0: preview works', async () => {
    process.env.AIDEN_DRYRUN = '1';
    _resetSandboxConfigForTests();
    const { handler } = makeWriteTool({ withPreview: true });
    const wrapped = withDryRun(handler);
    const r = await wrapped.execute({}, makeCtx()) as DryRunPreview;
    expect(r.dryRun).toBe(true);
  });

  it('AIDEN_DRYRUN=1 + AIDEN_SANDBOX=1: preview works', async () => {
    process.env.AIDEN_DRYRUN = '1';
    process.env.AIDEN_SANDBOX = '1';
    _resetSandboxConfigForTests();
    const { handler } = makeWriteTool({ withPreview: true });
    const wrapped = withDryRun(handler);
    const r = await wrapped.execute({}, makeCtx()) as DryRunPreview;
    expect(r.dryRun).toBe(true);
  });

  it('AIDEN_DRYRUN=0 + AIDEN_SANDBOX=1: no preview (execute runs)', async () => {
    process.env.AIDEN_SANDBOX = '1';
    _resetSandboxConfigForTests();
    const { handler, calls } = makeWriteTool({ withPreview: true });
    const wrapped = withDryRun(handler);
    const r = await wrapped.execute({}, makeCtx()) as { dryRun?: boolean };
    expect(r.dryRun).toBeUndefined();
    expect(calls.execute).toBe(1);
  });
});

describe('helpers', () => {
  it('truncatePreview pass-through under limit', () => {
    expect(truncatePreview('hi', 10)).toBe('hi');
  });

  it('truncatePreview truncates with annotation over limit', () => {
    const r = truncatePreview('a'.repeat(50), 10);
    expect(r.startsWith('aaaaaaaaaa')).toBe(true);
    expect(r).toMatch(/40 more chars/);
  });

  it('genericPreview produces a valid envelope', () => {
    const { handler } = makeWriteTool({ withPreview: false });
    const w = genericPreview(handler, { a: 1 });
    expect(w.tool).toBe('fake_write');
    expect(w.sideEffects).toEqual([]);
    expect(w.detectedRisks).toEqual([]);
  });

  it('makeWouldExecute composes a WouldExecute', () => {
    const { handler } = makeWriteTool({ withPreview: false });
    const w = makeWouldExecute({
      handler,
      args: { k: 'v' },
      sideEffects: [{ type: 'create_file', path: '/x', bytes: 0 }],
      summary: 'test',
    });
    expect(w.tool).toBe('fake_write');
    expect(w.sideEffects).toHaveLength(1);
    expect(w.summary).toBe('test');
  });
});
