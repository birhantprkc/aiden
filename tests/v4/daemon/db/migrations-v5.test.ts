/**
 * v4.5 Phase 5b — schema v5 migration tests.
 *
 * Covers:
 *   1. v5 migration applies cleanly on a fresh db
 *   2. Re-running migrations on a v5 db is idempotent
 *   3. scheduled_workflows table accepts INSERT + idx_scheduled_workflows_next_fire works
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, LATEST_SCHEMA_VERSION } from '../../../../core/v4/daemon/db/migrations';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

describe('schema v5 migration', () => {
  it('LATEST_SCHEMA_VERSION is 5 (or greater)', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
  });

  it('applies v1→v5 in one pass', () => {
    const r = runMigrations(db);
    expect(r.from).toBe(0);
    expect(r.to).toBe(LATEST_SCHEMA_VERSION);
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_workflows'`).get() as { name?: string };
    expect(row?.name).toBe('scheduled_workflows');
  });

  it('idempotent: re-running is a no-op', () => {
    const r1 = runMigrations(db);
    const r2 = runMigrations(db);
    expect(r2.from).toBe(r1.to);
    expect(r2.to).toBe(r1.to);
  });

  it('scheduled_workflows accepts a full insert with default misfire_policy', () => {
    runMigrations(db);
    db.prepare(`INSERT INTO scheduled_workflows
      (id, name, schedule_expression, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('wf-1', 'morning', 'cron:0 9 * * *', '{}', Date.now(), Date.now());
    const row = db.prepare(`SELECT id, misfire_policy, timezone, enabled, deliver_only FROM scheduled_workflows WHERE id = ?`).get('wf-1') as {
      id: string; misfire_policy: string; timezone: string; enabled: number; deliver_only: number;
    };
    expect(row.misfire_policy).toBe('skip_stale');
    expect(row.timezone).toBe('UTC');
    expect(row.enabled).toBe(1);
    expect(row.deliver_only).toBe(0);
  });

  it('partial-index on next_fire_at exists', () => {
    runMigrations(db);
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_scheduled_workflows_next_fire'`).get() as { name?: string };
    expect(idx?.name).toBe('idx_scheduled_workflows_next_fire');
  });
});
