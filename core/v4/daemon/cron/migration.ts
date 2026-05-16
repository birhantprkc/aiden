/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/cron/migration.ts — v4.5 Phase 5b.
 *
 * One-shot data migration: read `cron_jobs.json` (existing JSON-
 * backed cron store) → `scheduled_workflows` table (SQLite, schema
 * v5). Runs on first daemon boot AFTER the v5 DDL migration applies.
 *
 * Behaviour (Q-P5-3a — automatic):
 *   1. Skip if `scheduled_workflows` already has rows (idempotent).
 *   2. Skip if `cron_jobs.json` doesn't exist (first boot, no cron).
 *   3. Read the JSON via the existing `readCronState` reader (handles
 *      v1/v2 schema + corruption auto-repair).
 *   4. Map each `CronJobV2` to a `scheduled_workflows` row via
 *      `cronBridge.jobToRow`.
 *   5. Insert all rows in a single transaction.
 *   6. Back up the source file: `cron_jobs.json.pre-v5-migration.<ts>.bak`.
 *      ORIGINAL FILE LEFT IN PLACE — non-daemon mode keeps working.
 *   7. Log: `[cron] migrated <N> jobs to SQLite, backup at <path>`.
 *
 * Never throws. Migration failures log loudly but the daemon
 * continues booting (cron will be empty in daemon mode; the
 * operator can re-run the migration manually via a CLI command
 * shipped in Phase 6).
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Db } from '../db/connection';
import { defaultCronPaths } from '../../cron/cronState';
import type { CronJobV2, CronStateV2 } from '../../cron/cronState';
import { migrateToV2 } from '../../cron/cronState';
import { jobToRow } from './cronBridge';
import type { ScheduledWorkflowRow } from './cronBridge';

export interface MigrationResult {
  ran:         boolean;      // false when idempotent skip / no JSON
  migrated:    number;
  skipped:     number;
  backupPath:  string | null;
  reason?:     string;       // populated when ran=false
  errors:      string[];
}

export interface RunCronMigrationOptions {
  db:          Db;
  /** Override the cron_jobs.json path. Defaults to ~/.aiden/cron_jobs.json. */
  sourcePath?: string;
  /** Override clock for deterministic tests. */
  now?:        () => number;
  log?:        (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * Run the one-shot migration. Returns a structured result so the
 * caller can surface the outcome via daemon health endpoints.
 *
 * Synchronous by design — the bootstrap path is already sync and
 * the migration touches one small JSON file + one batched SQL
 * insert transaction. Keeping it sync avoids an async-edge in the
 * daemon's deterministic boot ordering.
 */
export function runCronMigration(
  opts: RunCronMigrationOptions,
): MigrationResult {
  const log = opts.log ?? (() => { /* silent */ });
  const now = opts.now ?? Date.now;
  const errors: string[] = [];

  // ── Step 1: idempotency check on the SQLite side ──────────────────────
  let existingCount: number;
  try {
    existingCount = (opts.db
      .prepare('SELECT COUNT(*) AS c FROM scheduled_workflows')
      .get() as { c: number }).c;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', `[cron-migration] count check failed: ${msg}`);
    return {
      ran:        false,
      migrated:   0,
      skipped:    0,
      backupPath: null,
      reason:     'sqlite_count_failed',
      errors:     [msg],
    };
  }
  if (existingCount > 0) {
    log('info', `[cron-migration] skipped — scheduled_workflows already has ${existingCount} rows`);
    return {
      ran:        false,
      migrated:   0,
      skipped:    existingCount,
      backupPath: null,
      reason:     'already_migrated',
      errors,
    };
  }

  // ── Step 2: source-file existence ─────────────────────────────────────
  const sourcePath = opts.sourcePath ?? defaultCronPaths().stateFile;
  if (!fs.existsSync(sourcePath)) {
    log('info', `[cron-migration] skipped — no cron_jobs.json at ${sourcePath}`);
    return {
      ran:        false,
      migrated:   0,
      skipped:    0,
      backupPath: null,
      reason:     'no_source_file',
      errors,
    };
  }

  // ── Step 3: read existing JSON (sync — small file) ────────────────────
  let jobs: CronJobV2[];
  try {
    const raw = fs.readFileSync(sourcePath, 'utf-8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch {
      // Same auto-repair fallback as readCronState: strip trailing commas.
      const stripped = raw
        .replace(/,(\s*[}\]])/g, '$1')
        .replace(/^\s*\/\/.*$/gm, '');
      parsed = JSON.parse(stripped);
    }
    const state: CronStateV2 = migrateToV2(parsed);
    jobs = state.jobs;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', `[cron-migration] failed to read ${sourcePath}: ${msg}`);
    return {
      ran:        false,
      migrated:   0,
      skipped:    0,
      backupPath: null,
      reason:     'read_failed',
      errors:     [msg],
    };
  }

  if (jobs.length === 0) {
    log('info', `[cron-migration] no jobs in ${sourcePath} — nothing to migrate`);
    // Still create a backup so the operator has a clear "migration
    // ran" signal (zero-row migrations are still events).
    return {
      ran:        true,
      migrated:   0,
      skipped:    0,
      backupPath: null,
      errors,
    };
  }

  // ── Step 4 + 5: map + insert in one transaction ───────────────────────
  const rows: ScheduledWorkflowRow[] = [];
  for (const job of jobs) {
    try { rows.push(jobToRow(job, now())); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`job ${job.id}: ${msg}`);
      log('warn', `[cron-migration] skipping malformed job ${job.id}: ${msg}`);
    }
  }
  let migrated = 0;
  try {
    const insert = opts.db.prepare(`INSERT INTO scheduled_workflows
      (id, name, schedule_expression, timezone, enabled, payload_json,
       prompt_template, deliver_only, misfire_policy, fire_rate_limit,
       catch_up_limit, grace_ms, last_fired_at, next_fire_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = opts.db.transaction((batch: ScheduledWorkflowRow[]): void => {
      for (const r of batch) {
        insert.run(
          r.id, r.name, r.schedule_expression, r.timezone, r.enabled,
          r.payload_json, r.prompt_template, r.deliver_only,
          r.misfire_policy, r.fire_rate_limit, r.catch_up_limit,
          r.grace_ms, r.last_fired_at, r.next_fire_at,
          r.created_at, r.updated_at,
        );
        migrated += 1;
      }
    });
    tx(rows);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', `[cron-migration] SQL insert failed: ${msg}`);
    return {
      ran:        false,
      migrated:   0,
      skipped:    rows.length,
      backupPath: null,
      reason:     'insert_failed',
      errors:     [...errors, msg],
    };
  }

  // ── Step 6: backup ────────────────────────────────────────────────────
  const backupPath = `${sourcePath}.pre-v5-migration.${now()}.bak`;
  try {
    fs.copyFileSync(sourcePath, backupPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('warn', `[cron-migration] backup copy failed (migration still applied): ${msg}`);
    errors.push(`backup: ${msg}`);
  }

  // ── Step 7: log ───────────────────────────────────────────────────────
  log('info', `[cron-migration] migrated ${migrated} job${migrated === 1 ? '' : 's'} to SQLite, backup at ${path.basename(backupPath)}`);

  return {
    ran:        true,
    migrated,
    skipped:    rows.length - migrated,
    backupPath: backupPath,
    errors,
  };
}
