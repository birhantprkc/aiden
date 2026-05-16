/**
 * v4.5 Phase 5b — misfire policy tests.
 *
 * Covers:
 *   1. skip_stale: returns fire:false when scheduled > graceMs ago
 *   2. run_once_if_late: returns fire:true, fireCount:1 regardless of staleness
 *   3. catch_up_with_limit: returns fire:true with bounded fireCount
 *   4. manual_review: returns fire:false, reason set
 *   5. Future-scheduled returns fire:false ("not yet")
 *   6. Within grace window: always fires once, every policy
 */
import { describe, it, expect } from 'vitest';
import {
  applyMisfirePolicy,
  isMisfirePolicy,
} from '../../../../core/v4/daemon/cron/misfirePolicy';

describe('applyMisfirePolicy — skip_stale', () => {
  it('fires when within grace window', () => {
    const r = applyMisfirePolicy({
      policy: 'skip_stale', scheduledFor: 1000, now: 1500, graceMs: 60_000,
    });
    expect(r.fire).toBe(true);
    expect(r.fireCount).toBe(1);
    expect(r.reason).toBe('on_time');
  });

  it('skips when past grace window', () => {
    const r = applyMisfirePolicy({
      policy: 'skip_stale', scheduledFor: 1000, now: 1000 + 5 * 60_000, graceMs: 60_000,
    });
    expect(r.fire).toBe(false);
    expect(r.fireCount).toBe(0);
    expect(r.reason).toMatch(/skip_stale: late by/);
  });
});

describe('applyMisfirePolicy — run_once_if_late', () => {
  it('fires once even when very stale', () => {
    const r = applyMisfirePolicy({
      policy: 'run_once_if_late', scheduledFor: 1000, now: 1000 + 24 * 3600_000, graceMs: 60_000,
    });
    expect(r.fire).toBe(true);
    expect(r.fireCount).toBe(1);
    expect(r.reason).toMatch(/run_once_if_late/);
  });
});

describe('applyMisfirePolicy — catch_up_with_limit', () => {
  it('emits N fires bounded by catchUpLimit', () => {
    const r = applyMisfirePolicy({
      policy: 'catch_up_with_limit',
      scheduledFor: 1000,
      now: 1000 + 5 * 60_000,   // 5 minutes late
      graceMs: 60_000,
      periodMs: 60_000,         // every minute
      catchUpLimit: 3,
    });
    expect(r.fire).toBe(true);
    expect(r.fireCount).toBe(3);
    expect(r.reason).toMatch(/capped/);
  });

  it('emits exactly missed slots when under the cap', () => {
    const r = applyMisfirePolicy({
      policy: 'catch_up_with_limit',
      scheduledFor: 1000,
      now: 1000 + 3 * 60_000,   // 3 minutes late
      graceMs: 60_000,
      periodMs: 60_000,
      catchUpLimit: 10,
    });
    expect(r.fire).toBe(true);
    // floor(3*60_000 / 60_000) + 1 = 4
    expect(r.fireCount).toBe(4);
  });

  it('falls back to single fire when periodMs missing', () => {
    const r = applyMisfirePolicy({
      policy: 'catch_up_with_limit',
      scheduledFor: 1000,
      now: 1000 + 30 * 60_000,
      graceMs: 60_000,
    });
    expect(r.fire).toBe(true);
    expect(r.fireCount).toBe(1);
  });
});

describe('applyMisfirePolicy — manual_review', () => {
  it('returns fire:false + reason when past grace', () => {
    const r = applyMisfirePolicy({
      policy: 'manual_review', scheduledFor: 1000, now: 1000 + 10 * 60_000, graceMs: 60_000,
    });
    expect(r.fire).toBe(false);
    expect(r.reason).toMatch(/manual_review.*awaiting operator/);
  });

  it('still fires within grace (operator gets the on-time fire)', () => {
    const r = applyMisfirePolicy({
      policy: 'manual_review', scheduledFor: 1000, now: 1500, graceMs: 60_000,
    });
    expect(r.fire).toBe(true);
    expect(r.fireCount).toBe(1);
  });
});

describe('applyMisfirePolicy — universal edges', () => {
  it('future-scheduled never fires', () => {
    for (const policy of ['skip_stale', 'run_once_if_late', 'catch_up_with_limit', 'manual_review'] as const) {
      const r = applyMisfirePolicy({ policy, scheduledFor: 1_000_000, now: 500_000 });
      expect(r.fire).toBe(false);
      expect(r.reason).toBe('not_yet_due');
    }
  });
});

describe('isMisfirePolicy', () => {
  it('accepts the 4 valid policies', () => {
    expect(isMisfirePolicy('skip_stale')).toBe(true);
    expect(isMisfirePolicy('run_once_if_late')).toBe(true);
    expect(isMisfirePolicy('catch_up_with_limit')).toBe(true);
    expect(isMisfirePolicy('manual_review')).toBe(true);
  });
  it('rejects unknown strings', () => {
    expect(isMisfirePolicy('lol')).toBe(false);
    expect(isMisfirePolicy('')).toBe(false);
  });
});
