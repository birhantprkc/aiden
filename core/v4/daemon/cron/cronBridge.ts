/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/cron/cronBridge.ts — v4.5 Phase 5b.
 *
 * Bidirectional converter between the existing `CronJobV2` shape
 * (JSON-backed, see core/v4/cron/cronState.ts) and the SQLite
 * `scheduled_workflows` row shape introduced in schema v5.
 *
 * Used in two places:
 *   1. cron migration (one-shot on first v5 boot) — CronJobV2 →
 *      ScheduledWorkflowRow → INSERT.
 *   2. cron emitter — when the cron heartbeat ticks, reads
 *      scheduled_workflows rows + maps back to CronJobV2-ish
 *      shape for the existing fire pipeline (until cron's storage
 *      layer fully migrates).
 *
 * Schedule expression encoding:
 *   - interval → "interval:<intervalMs>" (e.g. "interval:300000")
 *   - cron     → "cron:<expr>"           (e.g. "cron:0 9 * * *")
 *   - oneshot  → "oneshot:<isoTimestamp>"
 *
 * This keeps `schedule_expression` a single text column that's
 * round-trippable + greppable.
 *
 * Pure conversion — no I/O.
 */

import type { CronJobV2 } from '../../cron/cronState';
import type { MisfirePolicy } from './misfirePolicy';

// ── Public row shape ───────────────────────────────────────────────────────

export interface ScheduledWorkflowRow {
  id:                  string;
  name:                string;
  schedule_expression: string;
  timezone:            string;
  enabled:             number;       // 0/1
  payload_json:        string;
  prompt_template:     string | null;
  deliver_only:        number;       // 0/1
  misfire_policy:      MisfirePolicy;
  fire_rate_limit:     number | null;
  catch_up_limit:      number | null;
  grace_ms:            number | null;
  last_fired_at:       number | null;
  next_fire_at:        number | null;
  created_at:          number;
  updated_at:          number;
}

// ── Encoders ───────────────────────────────────────────────────────────────

/**
 * CronJobV2 → ScheduledWorkflowRow. Used by the one-shot migration
 * from cron_jobs.json. The action string lands in payload_json as
 * `{ action: "<cmd>" }` so the existing fire pipeline can recover
 * it; future phases may add structured payload fields without
 * breaking the round-trip.
 */
export function jobToRow(job: CronJobV2, nowMs: number = Date.now()): ScheduledWorkflowRow {
  const scheduleExpression = encodeScheduleExpression(job);
  const payloadJson = JSON.stringify({
    action:       job.action,
    description:  job.description,
    runCount:     job.runCount,
    legacyState:  job.state,
    pausedAt:     job.pausedAt ?? null,
    pausedReason: job.pausedReason ?? null,
  });
  const createdAt = parseIsoToMs(job.createdAt) ?? nowMs;
  const lastFiredAt = job.lastRun ? parseIsoToMs(job.lastRun) : null;
  const nextFireAt  = job.nextRun ? parseIsoToMs(job.nextRun) : null;
  return {
    id:                  job.id,
    name:                job.description || `cron-${job.id}`,
    schedule_expression: scheduleExpression,
    timezone:            'UTC',
    enabled:             job.enabled ? 1 : 0,
    payload_json:        payloadJson,
    prompt_template:     null,
    deliver_only:        0,
    misfire_policy:      'skip_stale',
    fire_rate_limit:     null,
    catch_up_limit:      null,
    grace_ms:            null,
    last_fired_at:       lastFiredAt,
    next_fire_at:        nextFireAt,
    created_at:          createdAt,
    updated_at:          nowMs,
  };
}

/**
 * Encode the schedule into a single text column. The decoder
 * recovers kind + ms / expr / iso.
 */
export function encodeScheduleExpression(job: CronJobV2): string {
  if (job.kind === 'interval' && typeof job.intervalMs === 'number') {
    return `interval:${job.intervalMs}`;
  }
  if (job.kind === 'cron' && typeof job.cronExpr === 'string' && job.cronExpr.length > 0) {
    return `cron:${job.cronExpr}`;
  }
  if (job.kind === 'oneshot' && typeof job.oneshotIso === 'string') {
    return `oneshot:${job.oneshotIso}`;
  }
  // Defensive — should never hit when migrating valid jobs.
  return job.schedule || 'interval:0';
}

/**
 * Inverse — `schedule_expression` → `{kind, ...}` discriminated
 * union. Returns null for un-decodable strings; the caller should
 * skip the row + log a warning.
 */
export type DecodedSchedule =
  | { kind: 'interval'; intervalMs: number }
  | { kind: 'cron';     cronExpr:   string }
  | { kind: 'oneshot';  iso:        string };

export function decodeScheduleExpression(expr: string): DecodedSchedule | null {
  if (typeof expr !== 'string' || expr.length === 0) return null;
  const colon = expr.indexOf(':');
  if (colon <= 0) return null;
  const kind = expr.slice(0, colon);
  const rest = expr.slice(colon + 1);
  if (kind === 'interval') {
    const ms = Number.parseInt(rest, 10);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return { kind: 'interval', intervalMs: ms };
  }
  if (kind === 'cron') {
    if (rest.length === 0) return null;
    return { kind: 'cron', cronExpr: rest };
  }
  if (kind === 'oneshot') {
    if (rest.length === 0) return null;
    return { kind: 'oneshot', iso: rest };
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseIsoToMs(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
