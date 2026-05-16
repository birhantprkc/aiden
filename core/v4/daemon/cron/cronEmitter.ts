/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/cron/cronEmitter.ts — v4.5 Phase 5b.
 *
 * The cron-mode trigger producer.
 *
 * When `AIDEN_DAEMON=1`, the existing cron heartbeat fires through
 * a daemon-mode action runner that DOESN'T shell-out. Instead, it
 * inserts a `trigger_event` into the bus + updates last_fired_at
 * on the corresponding `scheduled_workflows` row. The Phase 5a
 * dispatcher consumes the event and routes it through the agent
 * loop (or the deliverOnly stub) just like every other trigger
 * source.
 *
 * The misfire policy fires HERE, not in the dispatcher — the
 * dispatcher should never see a stale event for a cron that the
 * policy said to skip.
 *
 * Backward compat: `AIDEN_DAEMON=0` keeps the legacy
 * `defaultRunAction` shell-exec path untouched. This module is a
 * separate emitter the bootstrap installs as `cronManager`'s
 * runAction override.
 *
 * Public API:
 *   - `createCronEmitter({triggerBus, db, log})` → RunActionFn
 *     compatible with `core/v4/cron/cronExecute.ts::RunActionFn`.
 */

import type { TriggerBus } from '../triggerBus';
import type { Db } from '../db/connection';
import type { ActionResult, RunActionFn } from '../../cron/cronExecute';
import type { CronJobV2 } from '../../cron/cronState';
import { applyMisfirePolicy, isMisfirePolicy } from './misfirePolicy';
import type { MisfirePolicy } from './misfirePolicy';
import type { ScheduledWorkflowRow } from './cronBridge';

export interface CreateCronEmitterOptions {
  triggerBus: TriggerBus;
  db:         Db;
  /** Override clock for deterministic tests. */
  now?:       () => number;
  log?:       (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * Build a daemon-mode runAction. Returns a function with the same
 * signature as `core/v4/cron/cronExecute.ts::RunActionFn` so the
 * existing cron firing pipeline (`fireJob`) can swap it in.
 *
 * Logic per fire:
 *   1. Resolve the scheduled_workflows row by job.id.
 *   2. Read misfire policy + scheduled-for instant.
 *   3. Apply the policy. When fire=false → return immediately
 *      (the cron tick will not record an output but also won't
 *      treat it as a fire).
 *   4. When fire=true, emit `fireCount` trigger_events into the
 *      bus (each with a distinct idempotency key so the dispatcher
 *      processes them as separate runs).
 *   5. Update last_fired_at on the row.
 *
 * The cron pipeline records `last_status='ok'` when the action
 * resolves without throwing. Daemon-mode insertion is fast (one
 * SQL statement per fire) and synchronous — no actual work
 * happens here.
 */
export function createCronEmitter(opts: CreateCronEmitterOptions): RunActionFn {
  const log = opts.log ?? (() => { /* silent */ });
  const now = opts.now ?? Date.now;

  return async (job: CronJobV2, _signal: AbortSignal): Promise<ActionResult> => {
    void _signal;       // cron emitter is fast + sync; no cancellation needed
    try {
      const row = readWorkflowRow(opts.db, job.id);
      if (!row) {
        // Workflow missing from SQLite — fall back to a single-fire emit so
        // operations that ran during the migration window aren't lost.
        emitSingle(opts.triggerBus, job, now(), 'workflow_row_missing');
        log('warn', `[cron-emitter] no scheduled_workflows row for job ${job.id} — falling back to single fire`);
        return { output: 'enqueued (workflow row missing — single fire)', failed: false };
      }

      const policy = isMisfirePolicy(row.misfire_policy) ? row.misfire_policy : 'skip_stale';
      const scheduledFor = row.next_fire_at ?? now();

      // Decode interval (for catch_up_with_limit period math).
      const periodMs = decodePeriodMs(row.schedule_expression);

      const decision = applyMisfirePolicy({
        policy:        policy as MisfirePolicy,
        scheduledFor,
        now:           now(),
        graceMs:       row.grace_ms ?? undefined,
        catchUpLimit:  row.catch_up_limit ?? undefined,
        periodMs:      periodMs ?? undefined,
      });

      if (!decision.fire) {
        log('info', `[cron-emitter] job ${job.id} ${decision.reason}`);
        return { output: `skipped (${decision.reason})`, failed: false };
      }

      // Emit `fireCount` events. For catch_up_with_limit > 1, the
      // idempotency key encodes the iteration index so each fire
      // produces a distinct trigger_event row.
      let inserted = 0;
      for (let i = 0; i < decision.fireCount; i++) {
        const idemKey = decision.fireCount === 1
          ? new Date(scheduledFor).toISOString()
          : `${new Date(scheduledFor).toISOString()}#${i}`;
        const r = opts.triggerBus.insert({
          source:         'schedule',
          sourceKey:      job.id,
          idempotencyKey: idemKey,
          payload: {
            workflowId:    job.id,
            name:          row.name,
            scheduledFor,
            scheduledForIso: new Date(scheduledFor).toISOString(),
            action:        job.action,
            description:   job.description,
            misfirePolicy: policy,
            iteration:     i,
            fireCount:     decision.fireCount,
            fireReason:    decision.reason,
            promptTemplate: row.prompt_template,
            deliverOnly:   row.deliver_only === 1,
          },
        });
        if (r.inserted) inserted += 1;
      }

      // Update last_fired_at. next_fire_at is recomputed by the
      // existing cron pipeline (`computeNextFire` in cronExecute.ts)
      // before this runAction is called, so we don't touch it here.
      try {
        opts.db.prepare(
          `UPDATE scheduled_workflows SET last_fired_at = ?, updated_at = ? WHERE id = ?`,
        ).run(now(), now(), job.id);
      } catch (e) {
        log('warn', `[cron-emitter] failed to update last_fired_at for ${job.id}: ${e instanceof Error ? e.message : String(e)}`);
      }

      const msg = decision.fireCount === 1
        ? `enqueued 1 event for job ${job.id}`
        : `enqueued ${inserted}/${decision.fireCount} events for job ${job.id} (catch_up)`;
      log('info', `[cron-emitter] ${msg}`);
      return { output: msg, failed: false };
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      log('error', `[cron-emitter] job ${job.id} emit failed: ${msg}`);
      return { output: msg, failed: true };
    }
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function readWorkflowRow(db: Db, jobId: string): ScheduledWorkflowRow | null {
  try {
    const row = db
      .prepare('SELECT * FROM scheduled_workflows WHERE id = ?')
      .get(jobId) as ScheduledWorkflowRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function emitSingle(
  bus: TriggerBus,
  job: CronJobV2,
  scheduledFor: number,
  reason: string,
): void {
  bus.insert({
    source:         'schedule',
    sourceKey:      job.id,
    idempotencyKey: new Date(scheduledFor).toISOString(),
    payload: {
      workflowId:    job.id,
      scheduledFor,
      scheduledForIso: new Date(scheduledFor).toISOString(),
      action:        job.action,
      description:   job.description,
      fireReason:    reason,
    },
  });
}

/** Decode `interval:<ms>` → number. Returns null for other kinds. */
function decodePeriodMs(scheduleExpression: string): number | null {
  if (!scheduleExpression.startsWith('interval:')) return null;
  const n = Number.parseInt(scheduleExpression.slice('interval:'.length), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
