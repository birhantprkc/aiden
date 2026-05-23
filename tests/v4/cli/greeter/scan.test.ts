/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.3 SLICE 1a — scan.ts unit + integration coverage.
 *
 * Real fs against tmpdir for the disk-bound scanners (lastSessionEnd,
 * update cache). Pure-function tests for the in-memory scanners
 * (timeOfDay, cwd).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  scanCwd,
  scanLastSessionEnd,
  scanUpdate,
  runScans,
} from '../../../../cli/v4/greeter/scan';
import type { AidenPaths, GreeterHistory } from '../../../../cli/v4/greeter/types';

let root: string;
let paths: AidenPaths;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-greeter-scan-'));
  paths = { root } as unknown as AidenPaths;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function mkHistory(over: Partial<GreeterHistory> = {}): GreeterHistory {
  return {
    v: 1, firstLaunchAt: '2026-05-23T16:30:00Z', lastGreetingAt: '2026-05-23T16:30:00Z',
    offers: [], disabled: false, ...over,
  };
}

describe('scanCwd', () => {
  it('returns false when history has no prior cwd (first launch)', () => {
    expect(scanCwd('/some/dir', mkHistory())).toBe(false);
  });

  it('returns false when cwd matches lastCwd', () => {
    expect(scanCwd('/foo/bar', mkHistory({ lastCwd: '/foo/bar' }))).toBe(false);
  });

  it('returns true when cwd differs from lastCwd', () => {
    expect(scanCwd('/foo/bar', mkHistory({ lastCwd: '/baz/qux' }))).toBe(true);
  });

  it('normalises path separators (a/b/ === a/b)', () => {
    // Trailing slash difference should not register as a change.
    expect(scanCwd('/foo/bar/', mkHistory({ lastCwd: '/foo/bar' }))).toBe(false);
  });
});

describe('scanLastSessionEnd', () => {
  it('returns null when the distillations dir is missing', async () => {
    expect(await scanLastSessionEnd(paths, new Date())).toBeNull();
  });

  it('returns null when the distillations dir is empty', async () => {
    await fs.mkdir(path.join(root, 'distillations'), { recursive: true });
    expect(await scanLastSessionEnd(paths, new Date())).toBeNull();
  });

  it('returns hours elapsed since the most-recently-mtimed distillation', async () => {
    const dir = path.join(root, 'distillations');
    await fs.mkdir(dir, { recursive: true });
    const oldFile = path.join(dir, 'old.json');
    const newFile = path.join(dir, 'new.json');
    await fs.writeFile(oldFile, '{}');
    await fs.writeFile(newFile, '{}');
    // Force mtimes: old=72h ago, new=5h ago.
    const now = new Date('2026-05-25T12:00:00.000Z');
    const oldMtime = new Date(now.getTime() - 72 * 3600 * 1000);
    const newMtime = new Date(now.getTime() -  5 * 3600 * 1000);
    await fs.utimes(oldFile, oldMtime, oldMtime);
    await fs.utimes(newFile, newMtime, newMtime);
    const hours = await scanLastSessionEnd(paths, now);
    expect(hours).toBe(5);  // picks the newer mtime
  });

  it('rounds to nearest hour and never returns negative even if mtime is in the future (clock skew)', async () => {
    const dir = path.join(root, 'distillations');
    await fs.mkdir(dir, { recursive: true });
    const f = path.join(dir, 'future.json');
    await fs.writeFile(f, '{}');
    const now = new Date('2026-05-25T12:00:00.000Z');
    const future = new Date(now.getTime() + 3600 * 1000);
    await fs.utimes(f, future, future);
    expect(await scanLastSessionEnd(paths, now)).toBe(0);
  });
});

describe('scanUpdate', () => {
  it('returns null when no cache file exists', async () => {
    expect(await scanUpdate(paths, '4.9.3')).toBeNull();
  });

  it('returns null when cache JSON is corrupt', async () => {
    await fs.writeFile(path.join(root, '.update_check.json'), '{not json', 'utf8');
    expect(await scanUpdate(paths, '4.9.3')).toBeNull();
  });

  it('returns null when latest <= installed (no update)', async () => {
    await fs.writeFile(
      path.join(root, '.update_check.json'),
      JSON.stringify({ latest: '4.9.3', installed: '4.9.3' }),
      'utf8',
    );
    expect(await scanUpdate(paths, '4.9.3')).toBeNull();
  });

  it('returns { latest, installed } when latest > installed', async () => {
    await fs.writeFile(
      path.join(root, '.update_check.json'),
      JSON.stringify({ latest: '4.9.4', installed: '4.9.3' }),
      'utf8',
    );
    expect(await scanUpdate(paths, '4.9.3')).toEqual({ latest: '4.9.4', installed: '4.9.3' });
  });

  it('does NOT hit the network — cache absence simply returns null', async () => {
    // Nothing to assert beyond the cache-miss path returning null.
    // Network suppression is structural: scanUpdate never imports
    // anything that could fetch. The unit test demonstrates the
    // miss-as-silence contract that the orchestrator relies on.
    expect(await scanUpdate(paths, '4.9.3')).toBeNull();
  });
});

describe('runScans — aggregator', () => {
  it('aggregates all four scanners into a single ScanResult', async () => {
    await fs.mkdir(path.join(root, 'distillations'), { recursive: true });
    const distFile = path.join(root, 'distillations', 'd.json');
    await fs.writeFile(distFile, '{}');
    // Use local-time constructor so getHours() returns 19 regardless of
    // the test machine's timezone — the scanner reads local hour (we
    // want "good evening" to fire at the user's local 6pm, not UTC).
    const now = new Date(2026, 4, 25, 19, 30, 0);
    const fiveHoursAgo = new Date(now.getTime() - 5 * 3600 * 1000);
    await fs.utimes(distFile, fiveHoursAgo, fiveHoursAgo);
    await fs.writeFile(path.join(root, '.update_check.json'),
      JSON.stringify({ latest: '4.9.4' }), 'utf8');

    const result = await runScans({
      paths,
      cwd:     '/somewhere/new',
      now,
      version: '4.9.3',
      history: mkHistory({ lastCwd: '/somewhere/old' }),
    });

    expect(result.hourOfDay).toBe(19);
    expect(result.cwdChanged).toBe(true);
    expect(result.cwd).toBe('/somewhere/new');
    expect(result.hoursSinceLastSession).toBe(5);
    expect(result.update).toEqual({ latest: '4.9.4', installed: '4.9.3' });
  });

  it('returns a sensible result when nothing is observable', async () => {
    const result = await runScans({
      paths,
      cwd:     '/x',
      now:     new Date(2026, 4, 25, 9, 0, 0),  // local-time 9am
      version: '4.9.3',
      history: mkHistory(),
    });
    expect(result.hourOfDay).toBe(9);
    expect(result.cwdChanged).toBe(false);
    expect(result.hoursSinceLastSession).toBeNull();
    expect(result.update).toBeNull();
  });
});
