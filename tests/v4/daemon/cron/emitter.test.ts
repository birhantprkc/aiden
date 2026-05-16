/**
 * v4.5 Phase 5b — cron emitter (daemon-mode runAction) tests.
 *
 * Covers:
 *   1. Daemon mode: cron tick inserts trigger_event with source='schedule'
 *   2. misfire policy skip_stale prevents insert (event not added)
 *   3. run_once_if_late forces a fire even when stale
 *   4. last_fired_at updated atomically on the workflow row
 *   5. Missing workflow row → fallback single-fire emit (defensive)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../../core/v4/daemon/triggerBus';
import { createCronEmitter } from '../../../../core/v4/daemon/cron/cronEmitter';
import type { CronJobV2 } from '../../../../core/v4/cron/cronState';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

function seedWorkflow(over: Partial<{
  id: string; name: string; schedule_expression: string;
  next_fire_at: number | null; misfire_policy: string;
  grace_ms: number | null; catch_up_limit: number | null;
}> = {}): string {
  const id = over.id ?? 'job-1';
  db.prepare(`INSERT INTO scheduled_workflows
    (id, name, schedule_expression, timezone, enabled, payload_json,
     misfire_policy, next_fire_at, created_at, updated_at, grace_ms, catch_up_limit)
    VALUES (?, ?, ?, 'UTC', 1, '{}', ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      over.name ?? 'job',
      over.schedule_expression ?? 'interval:60000',
      over.misfire_policy ?? 'skip_stale',
      over.next_fire_at ?? Date.now(),
      Date.now(),
      Date.now(),
      over.grace_ms ?? null,
      over.catch_up_limit ?? null,
    );
  return id;
}

function mkJob(over: Partial<CronJobV2> = {}): CronJobV2 {
  return {
    id:          'job-1',
    description: 'desc',
    schedule:    's',
    kind:        'interval',
    intervalMs:  60_000,
    action:      'echo hi',
    enabled:     true,
    state:       'scheduled',
    createdAt:   new Date().toISOString(),
    runCount:    0,
    ...over,
  };
}

describe('createCronEmitter — happy path', () => {
  it('inserts a trigger_event with source=schedule when due', async () => {
    const bus = createTriggerBus({ db });
    const now = 1_700_000_000_000;
    const id = seedWorkflow({ next_fire_at: now });
    const emitter = createCronEmitter({ triggerBus: bus, db, now: () => now });
    const result = await emitter(mkJob({ id }), new AbortController().signal);
    expect(result.failed).toBeFalsy();
    expect(result.output).toMatch(/enqueued 1 event/);
    const ev = db.prepare(`SELECT source, source_key, idempotency_key FROM trigger_events`).get() as { source: string; source_key: string; idempotency_key: string };
    expect(ev.source).toBe('schedule');
    expect(ev.source_key).toBe(id);
    expect(ev.idempotency_key).toBe(new Date(now).toISOString());
  });

  it('updates last_fired_at on the workflow row', async () => {
    const bus = createTriggerBus({ db });
    const now = 1_700_000_000_000;
    const id = seedWorkflow({ next_fire_at: now });
    const emitter = createCronEmitter({ triggerBus: bus, db, now: () => now });
    await emitter(mkJob({ id }), new AbortController().signal);
    const row = db.prepare(`SELECT last_fired_at FROM scheduled_workflows WHERE id = ?`).get(id) as { last_fired_at: number };
    expect(row.last_fired_at).toBe(now);
  });
});

describe('createCronEmitter — misfire policy', () => {
  it('skip_stale: stale event does NOT produce a trigger_event', async () => {
    const bus = createTriggerBus({ db });
    const scheduled = 1_700_000_000_000;
    const now = scheduled + 10 * 60_000;   // 10 minutes late
    const id = seedWorkflow({
      next_fire_at:   scheduled,
      misfire_policy: 'skip_stale',
      grace_ms:       60_000,
    });
    const emitter = createCronEmitter({ triggerBus: bus, db, now: () => now });
    const result = await emitter(mkJob({ id }), new AbortController().signal);
    expect(result.failed).toBeFalsy();
    expect(result.output).toMatch(/skipped/);
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM trigger_events`).get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('run_once_if_late: stale event still produces exactly one trigger_event', async () => {
    const bus = createTriggerBus({ db });
    const scheduled = 1_700_000_000_000;
    const now = scheduled + 60 * 60_000;  // 1 hour late
    const id = seedWorkflow({
      next_fire_at:   scheduled,
      misfire_policy: 'run_once_if_late',
      grace_ms:       60_000,
    });
    const emitter = createCronEmitter({ triggerBus: bus, db, now: () => now });
    await emitter(mkJob({ id }), new AbortController().signal);
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM trigger_events`).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('catch_up_with_limit: emits N events with distinct idempotency keys', async () => {
    const bus = createTriggerBus({ db });
    const scheduled = 1_700_000_000_000;
    const now = scheduled + 5 * 60_000;   // 5 minutes late
    const id = seedWorkflow({
      schedule_expression: 'interval:60000',
      next_fire_at:        scheduled,
      misfire_policy:      'catch_up_with_limit',
      grace_ms:            30_000,
      catch_up_limit:      3,
    });
    const emitter = createCronEmitter({ triggerBus: bus, db, now: () => now });
    await emitter(mkJob({ id }), new AbortController().signal);
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM trigger_events`).get() as { c: number }).c;
    expect(count).toBe(3);
    // All three have distinct idempotency keys.
    const keys = (db.prepare(`SELECT idempotency_key FROM trigger_events ORDER BY id`).all() as Array<{ idempotency_key: string }>)
      .map((r) => r.idempotency_key);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('createCronEmitter — defensive fallbacks', () => {
  it('missing workflow row → fallback single fire (so we never silently drop work)', async () => {
    const bus = createTriggerBus({ db });
    const emitter = createCronEmitter({ triggerBus: bus, db });
    await emitter(mkJob({ id: 'unknown-job-id' }), new AbortController().signal);
    const ev = db.prepare(`SELECT source, source_key, payload_json FROM trigger_events`).get() as { source: string; source_key: string; payload_json: string };
    expect(ev.source).toBe('schedule');
    expect(ev.source_key).toBe('unknown-job-id');
    const payload = JSON.parse(ev.payload_json);
    expect(payload.fireReason).toBe('workflow_row_missing');
  });
});
