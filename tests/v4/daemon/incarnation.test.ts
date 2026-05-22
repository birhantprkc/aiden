/**
 * tests/v4/daemon/incarnation.test.ts — v4.9.0 Slice 4.
 *
 * incarnationStore covers the three direct SQLite operations; this
 * file also exercises the bootstrap-driven lifecycle (boot inserts a
 * row; clean exit + crash both mark it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import {
  insertIncarnation,
  markEnded,
  lastForDaemon,
} from '../../../core/v4/daemon/incarnationStore';
import { newDaemonId, newIncarnationId } from '../../../core/v4/identity/ids';
import { loadOrCreateDaemonId, daemonIdFilePath } from '../../../core/v4/identity/daemonId';
import type { Db } from '../../../core/v4/daemon/db/connection';

let db: Db;

beforeEach(() => {
  db = new Database(':memory:') as unknown as Db;
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  try { db.close(); } catch { /* noop */ }
});

describe('daemon_incarnations schema (v8) — Slice 4', () => {
  it('runMigrations creates the daemon_incarnations table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('daemon_incarnations');
  });

  it('insertIncarnation writes a row with expected columns', () => {
    const dmn = newDaemonId();
    const inc = newIncarnationId();
    insertIncarnation(db, {
      incarnationId: inc,
      daemonId:      dmn,
      pid:           12345,
      aidenVersion:  '4.9.0-test',
      nodeVersion:   process.version,
      startedAt:     '2026-05-22T00:00:00.000Z',
    });
    const row = db
      .prepare('SELECT * FROM daemon_incarnations WHERE incarnation_id = ?')
      .get(inc) as Record<string, unknown>;
    expect(row.daemon_id).toBe(dmn);
    expect(row.pid).toBe(12345);
    expect(row.started_at).toBe('2026-05-22T00:00:00.000Z');
    expect(row.ended_at).toBeNull();
    expect(row.exit_reason).toBeNull();
    expect(row.aiden_version).toBe('4.9.0-test');
    expect(row.node_version).toBe(process.version);
  });

  it('insertIncarnation is idempotent on PK collision', () => {
    const inc = newIncarnationId();
    insertIncarnation(db, {
      incarnationId: inc, daemonId: newDaemonId(), pid: 1,
      aidenVersion: 'v', nodeVersion: 'v',
    });
    insertIncarnation(db, {
      incarnationId: inc, daemonId: newDaemonId(), pid: 2,
      aidenVersion: 'w', nodeVersion: 'w',
    });
    const row = db
      .prepare('SELECT pid FROM daemon_incarnations WHERE incarnation_id = ?')
      .get(inc) as { pid: number };
    expect(row.pid).toBe(1); // first insert wins
  });

  it('markEnded patches ended_at + exit_reason + exit_code', () => {
    const inc = newIncarnationId();
    insertIncarnation(db, {
      incarnationId: inc, daemonId: newDaemonId(), pid: 1,
      aidenVersion: 'v', nodeVersion: 'v',
    });
    markEnded(db, {
      incarnationId: inc,
      exitReason:    'clean',
      exitCode:      0,
      endedAt:       '2026-05-22T12:00:00.000Z',
    });
    const row = db
      .prepare('SELECT * FROM daemon_incarnations WHERE incarnation_id = ?')
      .get(inc) as Record<string, unknown>;
    expect(row.ended_at).toBe('2026-05-22T12:00:00.000Z');
    expect(row.exit_reason).toBe('clean');
    expect(row.exit_code).toBe(0);
  });

  it('markEnded handles crash exit reason', () => {
    const inc = newIncarnationId();
    insertIncarnation(db, {
      incarnationId: inc, daemonId: newDaemonId(), pid: 1,
      aidenVersion: 'v', nodeVersion: 'v',
    });
    markEnded(db, { incarnationId: inc, exitReason: 'crash', exitCode: 1 });
    const row = db
      .prepare('SELECT exit_reason, exit_code FROM daemon_incarnations WHERE incarnation_id = ?')
      .get(inc) as { exit_reason: string; exit_code: number };
    expect(row.exit_reason).toBe('crash');
    expect(row.exit_code).toBe(1);
  });

  it('markEnded is a no-op when the row is missing', () => {
    // Should not throw — defensive against e.g. SQLite died before insert.
    expect(() => markEnded(db, {
      incarnationId: 'inc_doesnotexist',
      exitReason:    'crash',
      exitCode:      1,
    })).not.toThrow();
  });

  it('markEnded preserves prior values via COALESCE', () => {
    const inc = newIncarnationId();
    insertIncarnation(db, {
      incarnationId: inc, daemonId: newDaemonId(), pid: 1,
      aidenVersion: 'v', nodeVersion: 'v',
    });
    markEnded(db, { incarnationId: inc, exitReason: 'sigterm', exitCode: 0, endedAt: '2026-01-01T00:00:00.000Z' });
    // Second markEnded with different reason should be ignored.
    markEnded(db, { incarnationId: inc, exitReason: 'crash', exitCode: 1, endedAt: '2099-01-01T00:00:00.000Z' });
    const row = db
      .prepare('SELECT * FROM daemon_incarnations WHERE incarnation_id = ?')
      .get(inc) as Record<string, unknown>;
    expect(row.exit_reason).toBe('sigterm');
    expect(row.exit_code).toBe(0);
    expect(row.ended_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('lastForDaemon returns the most-recent incarnation', () => {
    const dmn = newDaemonId();
    insertIncarnation(db, {
      incarnationId: newIncarnationId(), daemonId: dmn, pid: 1,
      aidenVersion: 'v', nodeVersion: 'v',
      startedAt: '2026-05-01T00:00:00.000Z',
    });
    const newest = newIncarnationId();
    insertIncarnation(db, {
      incarnationId: newest, daemonId: dmn, pid: 2,
      aidenVersion: 'v', nodeVersion: 'v',
      startedAt: '2026-05-22T00:00:00.000Z',
    });
    insertIncarnation(db, {
      incarnationId: newIncarnationId(), daemonId: newDaemonId(), pid: 99,
      aidenVersion: 'v', nodeVersion: 'v',
      startedAt: '2026-05-22T01:00:00.000Z',
    });
    const last = lastForDaemon(db, dmn);
    expect(last?.incarnation_id).toBe(newest);
  });

  it('lastForDaemon returns null when no rows', () => {
    expect(lastForDaemon(db, 'dmn_neverexisted00000000000000000000')).toBeNull();
  });
});

describe('daemon_id persistence — Slice 4', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'aiden-daemonid-'));
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('first call creates the file', () => {
    const id = loadOrCreateDaemonId(root);
    expect(id).toMatch(/^dmn_/);
    expect(existsSync(daemonIdFilePath(root))).toBe(true);
    expect(readFileSync(daemonIdFilePath(root), 'utf8').trim()).toBe(id);
  });

  it('second call returns the same id (persistence)', () => {
    const first  = loadOrCreateDaemonId(root);
    const second = loadOrCreateDaemonId(root);
    expect(first).toBe(second);
  });

  it('corrupted file is quarantined + regenerated', () => {
    // Seed with corrupted content.
    const fp = daemonIdFilePath(root);
    require('node:fs').mkdirSync(path.dirname(fp), { recursive: true });
    require('node:fs').writeFileSync(fp, 'not-a-real-id\n', 'utf8');
    const id = loadOrCreateDaemonId(root);
    expect(id).toMatch(/^dmn_/);
    expect(id).not.toBe('not-a-real-id');
    // Quarantine sibling should exist.
    const siblings = require('node:fs')
      .readdirSync(path.dirname(fp))
      .filter((f: string) => f.startsWith('daemon_id.broken-'));
    expect(siblings.length).toBe(1);
  });
});
