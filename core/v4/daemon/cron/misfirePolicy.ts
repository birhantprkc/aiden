/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/cron/misfirePolicy.ts — v4.5 Phase 5b.
 *
 * What to do when a scheduled workflow's `next_fire_at` is in the
 * past at tick time. Four policies, configurable per workflow.
 *
 * Default `skip_stale` per Q-P5-6(a) — matches the prior-systems
 * lesson that "missing one run beats firing dozens of stale runs"
 * after a long suspend or laptop sleep.
 *
 *   skip_stale          — skip the run when scheduled > graceMs ago.
 *                         Fire ONLY when scheduledFor is within the
 *                         grace window (or in the future).
 *   run_once_if_late    — fire ONCE if missed, regardless of how
 *                         stale. Useful for one-shots that MUST run.
 *   catch_up_with_limit — fire N times (capped at catchUpLimit) to
 *                         walk forward through the missed schedule.
 *                         For interval jobs that want to backfill.
 *   manual_review       — DON'T fire. Log + leave next_fire_at in
 *                         the past so the operator notices and
 *                         decides via the upcoming CLI surface.
 *
 * Pure module — no I/O, no Date.now(). Both `now` and `scheduledFor`
 * are passed by the caller. Returns a deterministic decision so
 * unit tests can assert exact firing behaviour.
 */

export type MisfirePolicy =
  | 'skip_stale'
  | 'run_once_if_late'
  | 'catch_up_with_limit'
  | 'manual_review';

/** Result of applying the misfire policy. */
export interface MisfireDecision {
  /** Whether to fire at all this tick. */
  fire:      boolean;
  /**
   * When `fire=true`, how many fires the caller should emit (most
   * commonly 1; only `catch_up_with_limit` ever returns > 1).
   */
  fireCount: number;
  /** Diagnostic — short reason string for logs / cron status. */
  reason:    string;
}

export interface ApplyMisfirePolicyInput {
  policy:        MisfirePolicy;
  /** When the workflow was originally scheduled to fire (ms epoch). */
  scheduledFor:  number;
  /** Current time (ms epoch). */
  now:           number;
  /**
   * Grace window in ms: if `now - scheduledFor <= graceMs`, the run
   * is considered "on-time enough" for every policy (always fires
   * with count=1). Default 60_000 ms (one heartbeat interval).
   */
  graceMs?:      number;
  /**
   * Required when policy === 'catch_up_with_limit'. Caps the
   * fireCount returned so a job that missed 1000 ticks doesn't
   * emit 1000 trigger events.
   */
  catchUpLimit?: number;
  /**
   * Required when policy === 'catch_up_with_limit'. The recurrence
   * period in ms — used to compute how many missed slots fall
   * between scheduledFor and now.
   */
  periodMs?:     number;
}

const DEFAULT_GRACE_MS    = 60_000;
const DEFAULT_CATCH_UP_LIMIT = 10;

/**
 * Pure policy resolver. The caller owns the side-effects (insert
 * trigger_event, advance next_fire_at, log).
 *
 * Edge cases handled:
 *   - scheduledFor in the FUTURE → always `fire:false` ("not yet").
 *   - scheduledFor within graceMs of now → always fires once.
 *   - catch_up_with_limit with missing periodMs/limit → safe
 *     fallback to single fire.
 */
export function applyMisfirePolicy(
  input: ApplyMisfirePolicyInput,
): MisfireDecision {
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  const lateBy  = input.now - input.scheduledFor;

  // Future-scheduled — never fire this tick (the heartbeat will
  // come back around when the time arrives).
  if (lateBy < 0) {
    return { fire: false, fireCount: 0, reason: 'not_yet_due' };
  }

  // Within grace window — every policy honours the standard fire.
  if (lateBy <= graceMs) {
    return { fire: true, fireCount: 1, reason: 'on_time' };
  }

  // Past the grace window → policy decides.
  switch (input.policy) {
    case 'skip_stale':
      return {
        fire:      false,
        fireCount: 0,
        reason:    `skip_stale: late by ${Math.round(lateBy / 1000)}s`,
      };

    case 'run_once_if_late':
      return {
        fire:      true,
        fireCount: 1,
        reason:    `run_once_if_late: late by ${Math.round(lateBy / 1000)}s`,
      };

    case 'catch_up_with_limit': {
      const limit = input.catchUpLimit ?? DEFAULT_CATCH_UP_LIMIT;
      const period = input.periodMs;
      if (!period || period <= 0) {
        // No period info — safe fallback: single fire.
        return { fire: true, fireCount: 1, reason: 'catch_up: no period info, firing once' };
      }
      // Number of full periods between scheduledFor and now, plus one
      // for the original missed slot. Capped at `limit`.
      const missed   = Math.floor(lateBy / period) + 1;
      const fireCount = Math.min(missed, limit);
      return {
        fire:      true,
        fireCount,
        reason:    fireCount === missed
          ? `catch_up: ${fireCount} missed slot${fireCount === 1 ? '' : 's'}`
          : `catch_up: ${missed} missed, capped at ${limit}`,
      };
    }

    case 'manual_review':
      return {
        fire:      false,
        fireCount: 0,
        reason:    `manual_review: late by ${Math.round(lateBy / 1000)}s, awaiting operator action`,
      };

    default:
      // Defensive — unknown policy. Be conservative: don't fire.
      return {
        fire:      false,
        fireCount: 0,
        reason:    `unknown_policy: ${input.policy}`,
      };
  }
}

/** Type guard for runtime spec validation. */
export function isMisfirePolicy(s: string): s is MisfirePolicy {
  return s === 'skip_stale'
      || s === 'run_once_if_late'
      || s === 'catch_up_with_limit'
      || s === 'manual_review';
}
