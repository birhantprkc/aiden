/**
 * v4.5 Phase 5b — cron migration tests.
 *
 * Covers:
 *   1. Full migration: cron_jobs.json → scheduled_workflows
 *   2. Backup file created with .pre-v5-migration.<ts>.bak suffix
 *   3. Idempotent: re-running with rows present is a no-op
 *   4. Empty cron_jobs.json: no rows inserted but ran=true
 *   5. Malformed JSON: read_failed reason; daemon boot continues
 *   6. Missing source file: skipped with reason='no_source_file'
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { runCronMigration } from '../../../../core/v4/daemon/cron/migration';

let db: Database.Database;
let tmp: string;
let sourcePath: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-cron-mig-'));
  sourcePath = path.join(tmp, 'cron_jobs.json');
});
afterEach(() => {
  try { db.close(); } catch { /* noop */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); }
  catch { /* noop */ }
});

function writeJobsJson(jobs: object[]): void {
  fs.writeFileSync(sourcePath, JSON.stringify({
    schemaVersion: 2,
    updatedAt:     new Date().toISOString(),
    jobs,
  }, null, 2));
}

describe('runCronMigration — full path', () => {
  it('migrates each CronJobV2 to a scheduled_workflows row + backs up source', () => {
    writeJobsJson([
      {
        id: '1', description: 'morning email', schedule: '0 9 * * *',
        kind: 'cron', cronExpr: '0 9 * * *', action: 'echo hi',
        enabled: true, state: 'scheduled',
        createdAt: '2026-05-01T00:00:00Z', runCount: 0,
      },
      {
        id: '2', description: 'every 5min', schedule: 'every 5 minutes',
        kind: 'interval', intervalMs: 5 * 60_000, action: 'curl ...',
        enabled: false, state: 'paused',
        createdAt: '2026-05-02T00:00:00Z', runCount: 7,
      },
    ]);
    const res = runCronMigration({ db, sourcePath });
    expect(res.ran).toBe(true);
    expect(res.migrated).toBe(2);
    expect(res.skipped).toBe(0);
    expect(res.backupPath).not.toBeNull();
    expect(fs.existsSync(res.backupPath!)).toBe(true);
    expect(path.basename(res.backupPath!)).toMatch(/\.pre-v5-migration\.\d+\.bak$/);

    const rows = db.prepare(`SELECT id, name, schedule_expression, enabled, misfire_policy FROM scheduled_workflows ORDER BY id`).all() as Array<{
      id: string; name: string; schedule_expression: string; enabled: number; misfire_policy: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('1');
    expect(rows[0].schedule_expression).toBe('cron:0 9 * * *');
    expect(rows[0].enabled).toBe(1);
    expect(rows[0].misfire_policy).toBe('skip_stale');
    expect(rows[1].schedule_expression).toBe('interval:300000');
    expect(rows[1].enabled).toBe(0);
  });

  it('leaves the source file in place (backward compat for AIDEN_DAEMON=0)', () => {
    writeJobsJson([{
      id: 'x', description: 'd', schedule: 's', kind: 'interval', intervalMs: 1_000,
      action: 'a', enabled: true, state: 'scheduled',
      createdAt: '2026-05-01T00:00:00Z', runCount: 0,
    }]);
    runCronMigration({ db, sourcePath });
    expect(fs.existsSync(sourcePath)).toBe(true);
  });
});

describe('runCronMigration — idempotency', () => {
  it('second invocation is a no-op when scheduled_workflows already populated', () => {
    writeJobsJson([{
      id: '1', description: 'd', schedule: 's', kind: 'interval', intervalMs: 60_000,
      action: 'a', enabled: true, state: 'scheduled',
      createdAt: '2026-05-01T00:00:00Z', runCount: 0,
    }]);
    const r1 = runCronMigration({ db, sourcePath });
    expect(r1.migrated).toBe(1);
    const r2 = runCronMigration({ db, sourcePath });
    expect(r2.ran).toBe(false);
    expect(r2.reason).toBe('already_migrated');
    expect(r2.skipped).toBe(1);
    // No duplicate row.
    const count = (db.prepare('SELECT COUNT(*) AS c FROM scheduled_workflows').get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe('runCronMigration — empty + malformed', () => {
  it('empty jobs array → ran:true, migrated:0', () => {
    writeJobsJson([]);
    const res = runCronMigration({ db, sourcePath });
    expect(res.ran).toBe(true);
    expect(res.migrated).toBe(0);
  });

  it('malformed JSON → ran:false with read_failed (daemon must still boot)', () => {
    fs.writeFileSync(sourcePath, '{ not valid json at all');
    const res = runCronMigration({ db, sourcePath });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe('read_failed');
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('missing source file → skipped with reason=no_source_file', () => {
    const res = runCronMigration({ db, sourcePath: path.join(tmp, 'does-not-exist.json') });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe('no_source_file');
  });
});
