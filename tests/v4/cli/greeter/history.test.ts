/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.3 SLICE 1a — history read/write + reconcile coverage.
 *
 * Real fs against tmpdir, no fs mocks. (Slice 2 lesson: synthetic
 * harnesses hide real-filesystem failure modes — only the real fs path
 * proves write+rename atomicity behaves on this OS.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  readHistory,
  writeHistory,
  reconcilePending,
  historyPath,
} from '../../../../cli/v4/greeter/history';
import type { AidenPaths, GreeterHistory } from '../../../../cli/v4/greeter/types';

let root: string;
let paths: AidenPaths;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-greeter-hist-'));
  // Only `root` is read by history.ts; cast the rest as never to satisfy
  // the typed surface without mocking 23 unused fields.
  paths = { root } as unknown as AidenPaths;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function mkHistory(over: Partial<GreeterHistory> = {}): GreeterHistory {
  return {
    v:               1,
    firstLaunchAt:   '2026-05-23T16:30:00.000Z',
    lastGreetingAt:  '2026-05-24T09:14:00.000Z',
    offers:          [],
    disabled:        false,
    ...over,
  };
}

describe('readHistory', () => {
  it('returns null when the file does not exist (first launch)', async () => {
    expect(await readHistory(paths)).toBeNull();
  });

  it('returns the parsed history when the file is well-formed', async () => {
    await writeHistory(paths, mkHistory());
    const h = await readHistory(paths);
    expect(h).not.toBeNull();
    expect(h!.v).toBe(1);
    expect(h!.firstLaunchAt).toBe('2026-05-23T16:30:00.000Z');
    expect(h!.offers).toEqual([]);
    expect(h!.disabled).toBe(false);
  });

  it('returns null when the JSON is corrupt (treats as first launch — safer than crashing)', async () => {
    await fs.writeFile(historyPath(paths), '{not json', 'utf8');
    expect(await readHistory(paths)).toBeNull();
  });

  it('returns null when v !== 1 (forward-incompatible schema → safe ignore)', async () => {
    await fs.writeFile(historyPath(paths), JSON.stringify({ v: 99, offers: [] }), 'utf8');
    expect(await readHistory(paths)).toBeNull();
  });

  it('round-trips offer records including response field', async () => {
    await writeHistory(paths, mkHistory({
      offers: [
        { id: 'update-available-4.9.4', offeredAt: '2026-05-24T01:00:00Z', expectedAction: '/update install', response: 'accepted' },
        { id: 'welcome-back-2026-05-23', offeredAt: '2026-05-23T20:00:00Z', response: 'ignored' },
      ],
    }));
    const h = await readHistory(paths);
    expect(h!.offers).toHaveLength(2);
    expect(h!.offers[0].response).toBe('accepted');
    expect(h!.offers[1].response).toBe('ignored');
  });
});

describe('writeHistory — atomic write', () => {
  it('writes to a tmp file then renames into place (no half-written history visible)', async () => {
    await writeHistory(paths, mkHistory());
    const entries = await fs.readdir(root);
    // After successful write, the tmp shim must be gone — only the
    // final .greeter-history.json should remain.
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
    expect(entries).toContain('.greeter-history.json');
  });

  it('creates the root dir if missing (matches existing v4 upsert pattern)', async () => {
    await fs.rm(root, { recursive: true, force: true });
    // root no longer exists at this point
    await writeHistory(paths, mkHistory());
    const h = await readHistory(paths);
    expect(h).not.toBeNull();
  });

  it('overwrites a prior write idempotently', async () => {
    await writeHistory(paths, mkHistory({ disabled: false }));
    await writeHistory(paths, mkHistory({ disabled: true }));
    const h = await readHistory(paths);
    expect(h!.disabled).toBe(true);
  });
});

describe('reconcilePending', () => {
  const NOW = new Date('2026-05-25T12:00:00.000Z');

  it('leaves resolved offers alone (idempotent)', () => {
    const h = mkHistory({
      offers: [{ id: 'welcome-back-2026-05-20', offeredAt: '2026-05-20T20:00:00Z', response: 'ignored' }],
    });
    const r = reconcilePending({ history: h, scan: anyScan(), installedVersion: '4.9.3', now: NOW });
    expect(r.offers[0].response).toBe('ignored');
  });

  it('marks update-available-X as accepted when installed >= X', () => {
    const h = mkHistory({
      offers: [{ id: 'update-available-4.9.3', offeredAt: '2026-05-24T01:00:00Z', expectedAction: '/update install' }],
    });
    const r = reconcilePending({ history: h, scan: anyScan(), installedVersion: '4.9.3', now: NOW });
    expect(r.offers[0].response).toBe('accepted');
  });

  it('marks update-available-X as accepted when installed > X (e.g. user jumped two versions)', () => {
    const h = mkHistory({
      offers: [{ id: 'update-available-4.9.3', offeredAt: '2026-05-24T01:00:00Z', expectedAction: '/update install' }],
    });
    const r = reconcilePending({ history: h, scan: anyScan(), installedVersion: '4.10.0', now: NOW });
    expect(r.offers[0].response).toBe('accepted');
  });

  it('leaves update-available pending when installed < X and within 7-day window', () => {
    const h = mkHistory({
      offers: [{ id: 'update-available-4.9.4', offeredAt: '2026-05-24T01:00:00Z', expectedAction: '/update install' }],
    });
    const r = reconcilePending({ history: h, scan: anyScan(), installedVersion: '4.9.3', now: NOW });
    expect(r.offers[0].response).toBeUndefined();   // still pending
  });

  it('marks update-available as ignored when older than 7 days (decay)', () => {
    const oldAt = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const h = mkHistory({
      offers: [{ id: 'update-available-4.9.4', offeredAt: oldAt, expectedAction: '/update install' }],
    });
    const r = reconcilePending({ history: h, scan: anyScan(), installedVersion: '4.9.3', now: NOW });
    expect(r.offers[0].response).toBe('ignored');
  });

  it('marks greeting-only offers as ignored on first reconcile (no expectedAction = always close)', () => {
    const h = mkHistory({
      offers: [
        { id: 'welcome-back-2026-05-24',         offeredAt: '2026-05-24T08:00:00Z' },
        { id: 'time-of-day-evening-2026-05-24',  offeredAt: '2026-05-24T19:00:00Z' },
        { id: 'cwd-changed-2026-05-24',          offeredAt: '2026-05-24T19:00:00Z' },
      ],
    });
    const r = reconcilePending({ history: h, scan: anyScan(), installedVersion: '4.9.3', now: NOW });
    expect(r.offers.every((o) => o.response === 'ignored')).toBe(true);
  });
});

// Minimal ScanResult — every field reconcilePending doesn't actually read
// is zeroed/nulled. reconcilePending only needs the input semver math.
function anyScan() {
  return {
    hourOfDay:             12,
    cwdChanged:            false,
    cwd:                   '/tmp',
    hoursSinceLastSession: null,
    update:                null,
  } as const;
}
