/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Phase v4.1.2-slice4 — SkillOutcomeTracker unit + persistence coverage.
 *
 * Verifies the slice4 attribution semantics:
 *   - skill_view opens a 5-tool-call window for that skill
 *   - downstream tool calls in the window attribute success/failure
 *   - skill_view itself does NOT attribute back to itself
 *   - another skill_view supersedes (last-write-wins)
 *   - window closes after 5 calls
 *   - persistence round-trips via the sidecar JSON
 *   - failure classification matches the slice4 rules
 *     (success===false, error truthy, otherwise success)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SkillOutcomeTracker,
  ATTRIBUTION_WINDOW,
  isFailure,
} from '../../../core/v4/skillOutcomeTracker';
import type {
  ToolCallRequest,
  ToolCallResult,
} from '../../../providers/v4/types';

const okCall = (name: string, args: Record<string, unknown> = {}): ToolCallRequest => ({
  id: `${name}-${Math.random().toString(36).slice(2, 8)}`,
  name,
  arguments: args,
});
const okResult = (name: string, payload: unknown = { ok: true }): ToolCallResult => ({
  id:     'r-' + Math.random().toString(36).slice(2, 8),
  name,
  result: payload,
});
const errResult = (name: string, error = 'boom'): ToolCallResult => ({
  id:     'r-' + Math.random().toString(36).slice(2, 8),
  name,
  result: { error, success: false },
});

let tmpDir: string;
let persistPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-skill-outcome-'));
  persistPath = path.join(tmpDir, '.skill-outcomes.json');
});

afterEach(async () => {
  // maxRetries handles the rare case where a fire-and-forget persist
  // is still resolving when cleanup runs (Windows holds the file
  // briefly even after the JS side resolves).
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// Tracker exposes flush() — wait for the in-flight persist queue to drain.

describe('SkillOutcomeTracker', () => {
  it('skill_view opens an attribution window and records load', async () => {
    const t = new SkillOutcomeTracker(persistPath);
    t.onTool(okCall('skill_view', { name: 'foo' }), 'before');
    t.onTool(okCall('skill_view', { name: 'foo' }), 'after', okResult('skill_view'));
    const snap = t.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].skillName).toBe('foo');
    expect(snap[0].loaded).toBe(1);
    expect(snap[0].toolSuccesses).toBe(0);
    expect(snap[0].toolFailures).toBe(0);
    expect(snap[0].lastUsed).toBeTypeOf('string');
  });

  it('attributes downstream tool successes within the window', async () => {
    const t = new SkillOutcomeTracker(persistPath);
    t.onTool(okCall('skill_view', { name: 'foo' }), 'before');
    t.onTool(okCall('skill_view', { name: 'foo' }), 'after', okResult('skill_view'));
    for (let i = 0; i < 3; i += 1) {
      t.onTool(okCall('file_read', { path: `/tmp/${i}` }), 'before');
      t.onTool(okCall('file_read', { path: `/tmp/${i}` }), 'after', okResult('file_read'));
    }
    const s = t.snapshot()[0];
    expect(s.toolSuccesses).toBe(3);
    expect(s.toolFailures).toBe(0);
  });

  it('attributes downstream tool failures within the window', async () => {
    const t = new SkillOutcomeTracker(persistPath);
    t.onTool(okCall('skill_view', { name: 'foo' }), 'before');
    t.onTool(okCall('skill_view', { name: 'foo' }), 'after', okResult('skill_view'));
    t.onTool(okCall('file_read'), 'before');
    t.onTool(okCall('file_read'), 'after', errResult('file_read', 'ENOENT'));
    const s = t.snapshot()[0];
    expect(s.toolSuccesses).toBe(0);
    expect(s.toolFailures).toBe(1);
    expect(s.lastError?.message).toBe('ENOENT');
  });

  it('does NOT attribute the skill_view call itself', () => {
    const t = new SkillOutcomeTracker(persistPath);
    t.onTool(okCall('skill_view', { name: 'foo' }), 'before');
    t.onTool(okCall('skill_view', { name: 'foo' }), 'after', okResult('skill_view'));
    const s = t.snapshot()[0];
    expect(s.toolSuccesses).toBe(0);
    expect(s.toolFailures).toBe(0);
    // load counter incremented but no attribution on the view itself.
    expect(s.loaded).toBe(1);
  });

  it('closes the window after ATTRIBUTION_WINDOW tool calls', () => {
    const t = new SkillOutcomeTracker(persistPath);
    t.onTool(okCall('skill_view', { name: 'foo' }), 'before');
    t.onTool(okCall('skill_view', { name: 'foo' }), 'after', okResult('skill_view'));
    // Window = 5. Fire 7 tool calls — only the first 5 should attribute.
    for (let i = 0; i < 7; i += 1) {
      t.onTool(okCall('file_read'), 'before');
      t.onTool(okCall('file_read'), 'after', okResult('file_read'));
    }
    const s = t.snapshot()[0];
    expect(s.toolSuccesses).toBe(ATTRIBUTION_WINDOW);
  });

  it('another skill_view supersedes the window (last-write-wins)', () => {
    const t = new SkillOutcomeTracker(persistPath);
    // Open window for foo, then 2 successful tool calls...
    t.onTool(okCall('skill_view', { name: 'foo' }), 'before');
    t.onTool(okCall('skill_view', { name: 'foo' }), 'after', okResult('skill_view'));
    t.onTool(okCall('file_read'), 'before');
    t.onTool(okCall('file_read'), 'after', okResult('file_read'));
    t.onTool(okCall('file_read'), 'before');
    t.onTool(okCall('file_read'), 'after', okResult('file_read'));
    // ...then bar takes over. The next 3 calls attribute to bar.
    t.onTool(okCall('skill_view', { name: 'bar' }), 'before');
    t.onTool(okCall('skill_view', { name: 'bar' }), 'after', okResult('skill_view'));
    for (let i = 0; i < 3; i += 1) {
      t.onTool(okCall('file_read'), 'before');
      t.onTool(okCall('file_read'), 'after', okResult('file_read'));
    }
    const snaps = t.snapshot();
    const foo = snaps.find((s) => s.skillName === 'foo')!;
    const bar = snaps.find((s) => s.skillName === 'bar')!;
    expect(foo.toolSuccesses).toBe(2);
    expect(bar.toolSuccesses).toBe(3);
  });

  it('skill_view with empty name is ignored (does not open a window)', () => {
    const t = new SkillOutcomeTracker(persistPath);
    t.onTool(okCall('skill_view', { name: '' }), 'before');
    t.onTool(okCall('skill_view', { name: '   ' }), 'before');
    // Subsequent tool call should NOT be attributed to anything.
    t.onTool(okCall('file_read'), 'before');
    t.onTool(okCall('file_read'), 'after', okResult('file_read'));
    expect(t.snapshot()).toHaveLength(0);
  });

  it('snapshot is sorted by load count descending', () => {
    const t = new SkillOutcomeTracker(persistPath);
    for (let i = 0; i < 3; i += 1) {
      t.onTool(okCall('skill_view', { name: 'rare' }), 'before');
      t.onTool(okCall('skill_view', { name: 'rare' }), 'after', okResult('skill_view'));
    }
    for (let i = 0; i < 5; i += 1) {
      t.onTool(okCall('skill_view', { name: 'common' }), 'before');
      t.onTool(okCall('skill_view', { name: 'common' }), 'after', okResult('skill_view'));
    }
    const snaps = t.snapshot();
    expect(snaps[0].skillName).toBe('common');
    expect(snaps[1].skillName).toBe('rare');
  });

  it('persists outcomes to disk and a fresh tracker hydrates them', async () => {
    const t = new SkillOutcomeTracker(persistPath);
    t.onTool(okCall('skill_view', { name: 'persist-me' }), 'before');
    t.onTool(okCall('skill_view', { name: 'persist-me' }), 'after', okResult('skill_view'));
    t.onTool(okCall('file_read'), 'before');
    t.onTool(okCall('file_read'), 'after', okResult('file_read'));
    await t.flush();

    // Construct a fresh tracker over the same path. The first
    // skill_view triggers synchronous hydration before its bump.
    const t2 = new SkillOutcomeTracker(persistPath);
    t2.onTool(okCall('skill_view', { name: 'persist-me' }), 'before');
    const s = t2.snapshot().find((x) => x.skillName === 'persist-me')!;
    // Original record had loaded=1 + 1 success; the new view bumps to loaded=2.
    expect(s.loaded).toBe(2);
    expect(s.toolSuccesses).toBe(1);
    await t2.flush();
  });

  it('survives a corrupt sidecar file (parse failure → empty start)', async () => {
    await fs.writeFile(persistPath, 'not valid json {{{', 'utf-8');
    const t = new SkillOutcomeTracker(persistPath);
    t.onTool(okCall('skill_view', { name: 'recover' }), 'before');
    expect(t.snapshot()[0].skillName).toBe('recover');
    await t.flush();
  });
});

describe('isFailure (failure classification)', () => {
  it('treats undefined result as success (no signal)', () => {
    expect(isFailure(undefined)).toBe(false);
  });
  it('treats top-level success===false as failure', () => {
    expect(isFailure({ id: 'x', name: 'x', result: { success: false } } as unknown as ToolCallResult)).toBe(true);
  });
  it('treats inner success===false as failure', () => {
    expect(isFailure({ id: 'x', name: 'x', result: { success: false, foo: 1 } } as unknown as ToolCallResult)).toBe(true);
  });
  it('treats truthy error string as failure', () => {
    expect(isFailure({ id: 'x', name: 'x', result: { error: 'ENOENT' } } as unknown as ToolCallResult)).toBe(true);
  });
  it('treats {error: {message}} as failure', () => {
    expect(isFailure({ id: 'x', name: 'x', result: { error: { message: 'bad' } } } as unknown as ToolCallResult))
      .toBe(true);
  });
  it('treats {ok: true} as success', () => {
    expect(isFailure({ id: 'x', name: 'x', result: { ok: true } })).toBe(false);
  });
  it('treats {success: true, content: ...} as success', () => {
    expect(isFailure({ id: 'x', name: 'x', result: { success: true, content: 'hi' } })).toBe(false);
  });
});
