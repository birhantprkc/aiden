/**
 * v4.4 Phase 4 — sampled buildPreview integration tests.
 *
 * Verifies a representative subset of the 27 mutating tools'
 * `buildPreview` methods produce sensible envelopes. We don't test
 * every tool exhaustively — the coverage sentinel
 * (dryRunCoverage.test.ts) catches missing methods at gate time;
 * here we just want confidence the wire shape works end-to-end for
 * a few categories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { registerAllTools } from '../../../tools/v4';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { _resetSandboxConfigForTests } from '../../../core/v4/sandboxConfig';
import type { ToolContext } from '../../../core/v4/toolRegistry';
import type { DryRunPreview } from '../../../core/v4/dryRun';

let tmp: string;
let ctx: ToolContext;
let reg: ToolRegistry;

beforeEach(async () => {
  process.env.AIDEN_DRYRUN = '1';
  _resetSandboxConfigForTests();
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiden-dryrun-int-'));
  ctx = {
    cwd: tmp,
    paths: resolveAidenPaths({ rootOverride: path.join(tmp, '.aiden') }),
  };
  reg = new ToolRegistry();
  registerAllTools(reg);
});

afterEach(async () => {
  delete process.env.AIDEN_DRYRUN;
  _resetSandboxConfigForTests();
  try { await fsp.rm(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

async function callPreview(name: string, args: Record<string, unknown>): Promise<DryRunPreview> {
  const h = reg.get(name);
  if (!h) throw new Error(`tool not registered: ${name}`);
  return h.execute(args, ctx) as Promise<DryRunPreview>;
}

describe('file_write preview', () => {
  it('creates a preview envelope with create_file side effect', async () => {
    const target = path.join(tmp, 'new.txt');
    const r = await callPreview('file_write', { path: target, content: 'hello' });
    expect(r.success).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.wouldExecute.tool).toBe('file_write');
    const se = r.wouldExecute.sideEffects[0];
    expect(se.type).toBe('create_file');
    if (se.type === 'create_file') {
      expect(se.path).toContain('new.txt');
      expect(se.bytes).toBe(5);
    }
  });

  it('overwrite case: surfaces overwrite_file with prev_bytes', async () => {
    const target = path.join(tmp, 'existing.txt');
    await fsp.writeFile(target, 'old content');
    const r = await callPreview('file_write', { path: target, content: 'new!' });
    const se = r.wouldExecute.sideEffects[0];
    expect(se.type).toBe('overwrite_file');
    if (se.type === 'overwrite_file') {
      expect(se.prev_bytes).toBe(11);
      expect(se.new_bytes).toBe(4);
    }
  });

  it('file_write is never actually written to disk in dry-run', async () => {
    const target = path.join(tmp, 'should-not-exist.txt');
    await callPreview('file_write', { path: target, content: 'x' });
    await expect(fsp.stat(target)).rejects.toThrow();
  });
});

describe('shell_exec preview', () => {
  it('surfaces command + backend + detected risks', async () => {
    const r = await callPreview('shell_exec', { command: 'rm -rf /tmp/foo' });
    expect(r.wouldExecute.tool).toBe('shell_exec');
    expect(r.wouldExecute.riskTier).toBe('dangerous');
    expect(r.wouldExecute.detectedRisks).toContain('rm -rf');
    const se = r.wouldExecute.sideEffects[0];
    expect(se.type).toBe('shell_command');
    if (se.type === 'shell_command') {
      expect(se.command).toBe('rm -rf /tmp/foo');
      expect(['local', 'docker']).toContain(se.backend);
    }
  });

  it('benign command: no detected risks', async () => {
    const r = await callPreview('shell_exec', { command: 'echo hi' });
    expect(r.wouldExecute.detectedRisks).toEqual([]);
  });
});

describe('memory_add preview', () => {
  it('surfaces bullet + target file', async () => {
    const r = await callPreview('memory_add', { file: 'memory', content: 'remember this' });
    expect(r.wouldExecute.tool).toBe('memory_add');
    const se = r.wouldExecute.sideEffects[0];
    expect(se.type).toBe('memory_write');
    if (se.type === 'memory_write') {
      expect(se.op).toBe('add');
      expect(se.bullet).toBe('remember this');
    }
  });
});

describe('browser_click preview (intent-only)', () => {
  it('emits a single browser_action side effect', async () => {
    const r = await callPreview('browser_click', { target: 'a.signin' });
    expect(r.wouldExecute.tool).toBe('browser_click');
    const se = r.wouldExecute.sideEffects[0];
    expect(se.type).toBe('browser_action');
    if (se.type === 'browser_action') {
      expect(se.action).toBe('click');
      expect(se.target).toBe('a.signin');
    }
  });
});

describe('aiden_self_update preview (refuses)', () => {
  it('emits a refuse side-effect — does not preview real install', async () => {
    const r = await callPreview('aiden_self_update', { confirm: false });
    expect(r.wouldExecute.tool).toBe('aiden_self_update');
    const se = r.wouldExecute.sideEffects[0];
    expect(se.type).toBe('refuse');
    if (se.type === 'refuse') {
      expect(se.reason).toMatch(/not safe to preview/i);
    }
    expect(r.wouldExecute.summary).toMatch(/Refused/i);
  });
});

describe('file_delete preview', () => {
  it('reports existence + recursive flag', async () => {
    const target = path.join(tmp, 'delme.txt');
    await fsp.writeFile(target, 'x');
    const r = await callPreview('file_delete', { path: target, recursive: false });
    const se = r.wouldExecute.sideEffects[0];
    expect(se.type).toBe('delete_file');
    if (se.type === 'delete_file') {
      expect(se.exists).toBe(true);
      expect(se.recursive).toBe(false);
    }
    // Confirm not actually deleted
    await expect(fsp.stat(target)).resolves.toBeDefined();
  });
});
