/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/core/loopTrace.test.ts — Phase v4.1.5+ Path A.
 *
 * LoopTracer is the env-var-gated per-turn diagnostic logger added
 * for capturing the user-reported "30+ skill_view loop" failure
 * mode (non-reproducible in fresh-history A/B harness, so we need
 * to capture context the next time it happens in live use).
 *
 * Coverage:
 *   - Disabled (default): zero side effects, no file writes
 *   - Tool-count threshold: 10+ calls → snapshot emitted
 *   - Consecutive-same threshold: 5+ same-name → snapshot emitted
 *   - Warning callback fires at consec-8 threshold
 *   - Snapshot shape: schema version + fingerprints + tool sequence
 *   - Hashing: memory + user hashes computed correctly
 *   - Recent-skills capture: skill_view + lookup_tool_schema targets
 *   - finalize() idempotent (subsequent calls no-op)
 *   - Defensive: file-write failures don't throw
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LoopTracer } from '../../../core/v4/loopTrace';
import { resolveAidenPaths } from '../../../core/v4/paths';

async function makeTempPaths(): Promise<ReturnType<typeof resolveAidenPaths>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-loop-trace-'));
  const paths = resolveAidenPaths({ rootOverride: root });
  await fs.mkdir(paths.logsDir, { recursive: true });
  return paths;
}

async function listLogFiles(logsDir: string): Promise<string[]> {
  try {
    const all = await fs.readdir(logsDir);
    return all.filter((f) => f.startsWith('loop-trace-')).sort();
  } catch {
    return [];
  }
}

describe('LoopTracer (v4.1.5+ Path A)', () => {
  beforeEach(() => {
    delete process.env.AIDEN_DEBUG_LOOP;
  });

  afterEach(() => {
    delete process.env.AIDEN_DEBUG_LOOP;
  });

  it('disabled by default (env var unset): all methods are no-ops', async () => {
    const paths = await makeTempPaths();
    const tracer = new LoopTracer({
      paths, providerId: 'p', modelId: 'm',
    });
    expect(tracer.isEnabled()).toBe(false);
    // Fire a synthetic loop that WOULD trip thresholds if enabled.
    for (let i = 0; i < 15; i += 1) {
      tracer.startTool(`id${i}`, 'skill_view');
      tracer.endTool(`id${i}`, 'skill_view', { name: 'demo' });
    }
    expect(tracer.shouldEmit()).toBe(false);
    const writtenPath = await tracer.finalize();
    expect(writtenPath).toBeNull();
    expect(await listLogFiles(paths.logsDir)).toEqual([]);
  });

  it('enabled via env var: tool-count threshold trips → snapshot written', async () => {
    process.env.AIDEN_DEBUG_LOOP = '1';
    const paths = await makeTempPaths();
    const tracer = new LoopTracer({
      paths, providerId: 'chatgpt-plus', modelId: 'gpt-5.5',
    });
    expect(tracer.isEnabled()).toBe(true);
    // 10 unique tool calls — alternate names so consec-same doesn't trip.
    for (let i = 0; i < 10; i += 1) {
      const name = i % 2 === 0 ? 'web_search' : 'fetch_page';
      tracer.startTool(`id${i}`, name);
      tracer.endTool(`id${i}`, name, { q: `query ${i}` });
    }
    expect(tracer.shouldEmit()).toBe(true);
    const writtenPath = await tracer.finalize();
    expect(writtenPath).not.toBeNull();
    expect(await listLogFiles(paths.logsDir)).toHaveLength(1);
    // Snapshot content sanity.
    const content = JSON.parse(await fs.readFile(writtenPath!, 'utf8'));
    expect(content.schemaVersion).toBe(1);
    expect(content.toolCallCount).toBe(10);
    expect(content.toolSequence).toHaveLength(10);
    expect(content.envHints.provider).toBe('chatgpt-plus');
    expect(content.envHints.model).toBe('gpt-5.5');
  });

  it('consec-same threshold trips → snapshot written, reason flagged', async () => {
    process.env.AIDEN_DEBUG_LOOP = '1';
    const paths = await makeTempPaths();
    const tracer = new LoopTracer({
      paths, providerId: 'p', modelId: 'm',
    });
    // 5 calls of skill_view (default threshold).
    for (let i = 0; i < 5; i += 1) {
      tracer.startTool(`id${i}`, 'skill_view');
      tracer.endTool(`id${i}`, 'skill_view', { name: `skill_${i}` });
    }
    expect(tracer.getMaxConsecutive()).toBe(5);
    expect(tracer.shouldEmit()).toBe(true);
    const writtenPath = await tracer.finalize();
    expect(writtenPath).not.toBeNull();
    const content = JSON.parse(await fs.readFile(writtenPath!, 'utf8'));
    expect(content.reason).toBe('consecutive_same');
    expect(content.maxConsecSame).toBe(5);
    expect(content.consecSameName).toBe('skill_view');
  });

  it('warn callback fires at consec-8 threshold (default)', async () => {
    process.env.AIDEN_DEBUG_LOOP = '1';
    const paths = await makeTempPaths();
    const warnings: string[] = [];
    const tracer = new LoopTracer({
      paths, providerId: 'p', modelId: 'm',
      onLoopWarning: (line) => warnings.push(line),
    });
    // 7 same-name calls — warn should NOT fire yet (threshold 8).
    for (let i = 0; i < 7; i += 1) {
      tracer.startTool(`id${i}`, 'lookup_tool_schema');
      tracer.endTool(`id${i}`, 'lookup_tool_schema', { toolName: 'x' });
    }
    expect(warnings).toEqual([]);
    // 8th call → warn fires.
    tracer.startTool('id7', 'lookup_tool_schema');
    tracer.endTool('id7', 'lookup_tool_schema', { toolName: 'x' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/lookup_tool_schema/);
    expect(warnings[0]).toMatch(/Ctrl\+C/);
    // 9th call → warn should NOT re-fire (one-shot).
    tracer.startTool('id8', 'lookup_tool_schema');
    tracer.endTool('id8', 'lookup_tool_schema', { toolName: 'x' });
    expect(warnings).toHaveLength(1);
  });

  it('recent-skills capture: skill_view + lookup_tool_schema targets only', async () => {
    process.env.AIDEN_DEBUG_LOOP = '1';
    const paths = await makeTempPaths();
    const tracer = new LoopTracer({
      paths, providerId: 'p', modelId: 'm',
    });
    tracer.startTool('a', 'skill_view');
    tracer.endTool('a', 'skill_view', { name: 'nse-scanner' });
    tracer.startTool('b', 'lookup_tool_schema');
    tracer.endTool('b', 'lookup_tool_schema', { toolName: 'execute_code' });
    tracer.startTool('c', 'web_search');
    tracer.endTool('c', 'web_search', { query: 'noise' });  // NOT captured
    tracer.startTool('d', 'skill_view');
    tracer.endTool('d', 'skill_view', { name: 'media-search' });
    // Force snapshot.
    for (let i = 0; i < 10; i += 1) {
      tracer.startTool(`x${i}`, 'web_search');
      tracer.endTool(`x${i}`, 'web_search', {});
    }
    const writtenPath = await tracer.finalize();
    const content = JSON.parse(await fs.readFile(writtenPath!, 'utf8'));
    expect(content.recentSkills).toEqual(['nse-scanner', 'execute_code', 'media-search']);
  });

  it('memory/user hashes captured when files exist', async () => {
    process.env.AIDEN_DEBUG_LOOP = '1';
    const paths = await makeTempPaths();
    await fs.mkdir(path.dirname(paths.memoryMd), { recursive: true });
    await fs.writeFile(paths.memoryMd, '# memory\n- fact 1', 'utf8');
    await fs.writeFile(paths.userMd,   '# user\n- pref 1',   'utf8');
    const tracer = new LoopTracer({
      paths, providerId: 'p', modelId: 'm',
    });
    for (let i = 0; i < 10; i += 1) {
      tracer.startTool(`i${i}`, 'web_search');
      tracer.endTool(`i${i}`, 'web_search', {});
    }
    const writtenPath = await tracer.finalize();
    const content = JSON.parse(await fs.readFile(writtenPath!, 'utf8'));
    expect(content.memoryMdHash).toMatch(/^[0-9a-f]{12}$/);
    expect(content.userMdHash).toMatch(/^[0-9a-f]{12}$/);
    expect(content.memoryMdHash).not.toBe(content.userMdHash);
  });

  it('memory hashes null when files absent', async () => {
    process.env.AIDEN_DEBUG_LOOP = '1';
    const paths = await makeTempPaths();
    // Don't write memoryMd / userMd.
    const tracer = new LoopTracer({
      paths, providerId: 'p', modelId: 'm',
    });
    for (let i = 0; i < 10; i += 1) {
      tracer.startTool(`i${i}`, 'web_search');
      tracer.endTool(`i${i}`, 'web_search', {});
    }
    const writtenPath = await tracer.finalize();
    const content = JSON.parse(await fs.readFile(writtenPath!, 'utf8'));
    expect(content.memoryMdHash).toBeNull();
    expect(content.userMdHash).toBeNull();
  });

  it('finalize() is idempotent — second call returns null, no double write', async () => {
    process.env.AIDEN_DEBUG_LOOP = '1';
    const paths = await makeTempPaths();
    const tracer = new LoopTracer({
      paths, providerId: 'p', modelId: 'm',
    });
    for (let i = 0; i < 10; i += 1) {
      tracer.startTool(`i${i}`, 'web_search');
      tracer.endTool(`i${i}`, 'web_search', {});
    }
    const first  = await tracer.finalize();
    const second = await tracer.finalize();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await listLogFiles(paths.logsDir)).toHaveLength(1);
  });

  it('does NOT emit when neither threshold trips', async () => {
    process.env.AIDEN_DEBUG_LOOP = '1';
    const paths = await makeTempPaths();
    const tracer = new LoopTracer({
      paths, providerId: 'p', modelId: 'm',
    });
    // 3 tool calls, mixed names → consec=1, count=3. Neither trips.
    tracer.startTool('a', 'web_search');
    tracer.endTool('a', 'web_search', {});
    tracer.startTool('b', 'execute_code');
    tracer.endTool('b', 'execute_code', {});
    tracer.startTool('c', 'web_search');
    tracer.endTool('c', 'web_search', {});
    expect(tracer.shouldEmit()).toBe(false);
    const written = await tracer.finalize();
    expect(written).toBeNull();
    expect(await listLogFiles(paths.logsDir)).toEqual([]);
  });

  it('explicit enabled:false overrides env var', async () => {
    process.env.AIDEN_DEBUG_LOOP = '1';
    const paths = await makeTempPaths();
    const tracer = new LoopTracer({
      paths, providerId: 'p', modelId: 'm',
      enabled: false,  // explicit off, beats env
    });
    expect(tracer.isEnabled()).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      tracer.startTool(`i${i}`, 'web_search');
      tracer.endTool(`i${i}`, 'web_search', {});
    }
    expect(await tracer.finalize()).toBeNull();
  });

  it('tool args preview is capped at 200 chars', async () => {
    process.env.AIDEN_DEBUG_LOOP = '1';
    const paths = await makeTempPaths();
    const tracer = new LoopTracer({
      paths, providerId: 'p', modelId: 'm',
    });
    const longArgs = { code: 'x'.repeat(500) };
    for (let i = 0; i < 10; i += 1) {
      tracer.startTool(`i${i}`, 'execute_code');
      tracer.endTool(`i${i}`, 'execute_code', longArgs);
    }
    const writtenPath = await tracer.finalize();
    const content = JSON.parse(await fs.readFile(writtenPath!, 'utf8'));
    for (const call of content.toolSequence) {
      expect(call.argsPreview.length).toBeLessThanOrEqual(200);
    }
  });

  it('history tail limited to last 5 messages', async () => {
    process.env.AIDEN_DEBUG_LOOP = '1';
    const paths = await makeTempPaths();
    const tracer = new LoopTracer({
      paths, providerId: 'p', modelId: 'm',
    });
    tracer.setHistory(
      Array.from({ length: 12 }, (_, i) => ({
        role:    i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `turn ${i}`,
      })),
    );
    for (let i = 0; i < 10; i += 1) {
      tracer.startTool(`i${i}`, 'web_search');
      tracer.endTool(`i${i}`, 'web_search', {});
    }
    const writtenPath = await tracer.finalize();
    const content = JSON.parse(await fs.readFile(writtenPath!, 'utf8'));
    expect(content.historyTail).toHaveLength(5);
    // Tail = messages 7..11.
    expect(content.historyTail[0].contentPreview).toBe('turn 7');
    expect(content.historyTail[4].contentPreview).toBe('turn 11');
  });

  it('configurable thresholds: lower toolCount fires earlier', async () => {
    process.env.AIDEN_DEBUG_LOOP = '1';
    const paths = await makeTempPaths();
    const tracer = new LoopTracer({
      paths, providerId: 'p', modelId: 'm',
      toolCountThreshold: 3,
    });
    tracer.startTool('a', 'web_search');
    tracer.endTool('a', 'web_search', {});
    tracer.startTool('b', 'execute_code');
    tracer.endTool('b', 'execute_code', {});
    tracer.startTool('c', 'fetch_page');
    tracer.endTool('c', 'fetch_page', {});
    expect(tracer.shouldEmit()).toBe(true);
  });
});
