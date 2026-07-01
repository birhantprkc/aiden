/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 B2.1 — semantic re-resolution + the destructive-action guard.
 * Pure decision logic (isDestructiveAction / matchLeaseBySignature) is unit-
 * tested directly; the orchestration (reResolveAndRetry) is driven with DI'd
 * snapshot/act fns so the order — outcome-check → destructive guard →
 * unique-match → retry-once — is exercised without a real browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isDestructiveAction,
  matchLeaseBySignature,
  getLeaseStore,
  type ElementLease,
  type AxRawDescriptor,
} from '../../../core/v4/browserState';
import { reResolveAndRetry } from '../../../tools/v4/browser/reResolve';

function lease(over: Partial<ElementLease> = {}): ElementLease {
  return {
    ref: '@e1', snapshot_id: 1, url: 'u', frame_id: 'main', role: 'button', name: 'Go',
    css_path: '#go', bbox: { x: 0, y: 0, w: 10, h: 10 }, visible_text_hash: 'h', submit: false, ...over,
  };
}
function descOf(l: ElementLease): AxRawDescriptor {
  return {
    tag: 'button', roleAttr: l.role, inputType: '', ariaLabel: l.name, labelledByText: '',
    textContent: '', placeholder: '', alt: '', title: '',
    css_path: l.css_path, bbox: l.bbox, frame_id: l.frame_id, submit: l.submit,
  };
}

describe('isDestructiveAction', () => {
  it('type/fill are never destructive', () => {
    expect(isDestructiveAction({ name: 'Delete account', submit: true }, 'fill')).toBe(false);
  });
  it('submit-like clicks are destructive even with no name', () => {
    expect(isDestructiveAction({ name: '', submit: true }, 'click')).toBe(true);
  });
  it('destructive verbs in the name (whole-word, case-insensitive)', () => {
    for (const n of ['Buy now', 'Place order', 'PAY', 'Delete', 'Send message', 'Confirm purchase', 'Continue to payment']) {
      expect(isDestructiveAction({ name: n, submit: false }, 'click')).toBe(true);
    }
  });
  it('non-committing clicks are not destructive', () => {
    for (const n of ['Home', 'Next page', 'Read more', 'Open menu', 'Account settings']) {
      expect(isDestructiveAction({ name: n, submit: false }, 'click')).toBe(false);
    }
  });
  it('word-aware: substring inside another word does not trigger', () => {
    expect(isDestructiveAction({ name: 'Paypal balance', submit: false }, 'click')).toBe(false); // "pay" not whole-word
    expect(isDestructiveAction({ name: 'Postcode', submit: false }, 'click')).toBe(false);       // "post" not whole-word
  });
});

describe('matchLeaseBySignature', () => {
  const old = lease({ ref: '@e1', role: 'button', name: 'Save', frame_id: 'main', visible_text_hash: 'x', bbox: { x: 0, y: 0, w: 5, h: 5 } });
  it('unique role+name+frame → confident match', () => {
    const r = matchLeaseBySignature(old, [lease({ ref: '@e7', name: 'Save' }), lease({ ref: '@e8', name: 'Cancel' })]);
    expect(r.status).toBe('unique');
    if (r.status === 'unique') expect(r.match.ref).toBe('@e7');
  });
  it('no match → gone', () => {
    expect(matchLeaseBySignature(old, [lease({ name: 'Cancel' })]).status).toBe('gone');
  });
  it('frame mismatch is not a match', () => {
    expect(matchLeaseBySignature(old, [lease({ name: 'Save', frame_id: 'frame-1' })]).status).toBe('gone');
  });
  it('two same role+name+frame → text-hash breaks the tie', () => {
    const r = matchLeaseBySignature(old, [
      lease({ ref: '@e2', name: 'Save', visible_text_hash: 'x' }),
      lease({ ref: '@e3', name: 'Save', visible_text_hash: 'y' }),
    ]);
    expect(r.status).toBe('unique');
    if (r.status === 'unique') expect(r.match.ref).toBe('@e2');
  });
  it('truly indistinguishable (same hash, same bbox) → ambiguous', () => {
    const r = matchLeaseBySignature(old, [
      lease({ ref: '@e2', name: 'Save', visible_text_hash: 'x', bbox: { x: 0, y: 0, w: 5, h: 5 } }),
      lease({ ref: '@e3', name: 'Save', visible_text_hash: 'x', bbox: { x: 0, y: 0, w: 5, h: 5 } }),
    ]);
    expect(r.status).toBe('ambiguous');
  });
});

describe('reResolveAndRetry — order is the safety design', () => {
  beforeEach(() => { getLeaseStore().refresh(1, 'u', [descOf(lease({ name: 'Next' }))]); }); // @e1 = non-destructive

  it('(1) outcome already happened → success, no re-snapshot, no act', async () => {
    const snapshotFn = vi.fn();
    const actFn = vi.fn();
    const rr = await reResolveAndRetry({ ref: '@e1', actionKind: 'click', staleReason: 'timeout', state_delta: ['url_changed'], snapshotFn: snapshotFn as never, actFn: actFn as never });
    expect(rr.result?.success).toBe(true);
    expect(rr.sidecar).toMatchObject({ attempted: false, succeeded: true, suppressed: 'already-done' });
    expect(snapshotFn).not.toHaveBeenCalled();
    expect(actFn).not.toHaveBeenCalled();
  });

  it('(2) destructive stale click → NOT retried (surfaced, suppressed:destructive)', async () => {
    getLeaseStore().refresh(1, 'u', [descOf(lease({ name: 'Place order', submit: true }))]);
    const snapshotFn = vi.fn();
    const actFn = vi.fn();
    const rr = await reResolveAndRetry({ ref: '@e1', actionKind: 'click', staleReason: 'not visible', state_delta: [], snapshotFn: snapshotFn as never, actFn: actFn as never });
    expect(rr.sidecar).toMatchObject({ attempted: false, suppressed: 'destructive' });
    expect(rr.result?.success).toBe(false);
    expect(String(rr.result?.error)).toMatch(/may have ALREADY succeeded|browser_snapshot/i);
    expect(snapshotFn).not.toHaveBeenCalled(); // never even re-snapshots a destructive stale
    expect(actFn).not.toHaveBeenCalled();
  });

  it('(3) non-destructive stale → re-snapshot, unique match → retry once (acts)', async () => {
    const snapshotFn = vi.fn(async () => ({ ok: true, url: 'u', elements: [descOf(lease({ ref: '@e1', name: 'Next', css_path: '#next2' }))] }));
    const actFn = vi.fn(async () => ({ ok: true }));
    const rr = await reResolveAndRetry({ ref: '@e1', actionKind: 'click', staleReason: 'not attached', state_delta: ['dom_hash_changed'], snapshotFn: snapshotFn as never, actFn: actFn as never });
    expect(snapshotFn).toHaveBeenCalledTimes(1);
    expect(actFn).toHaveBeenCalledTimes(1); // retry-once
    expect(rr.sidecar).toMatchObject({ attempted: true, succeeded: true, reResolved: true });
    expect(rr.result?.success).toBe(true);
  });

  it('(3) re-snapshot finds nothing → gone, surfaced, no act', async () => {
    const snapshotFn = vi.fn(async () => ({ ok: true, url: 'u', elements: [descOf(lease({ name: 'Cancel' }))] }));
    const actFn = vi.fn();
    const rr = await reResolveAndRetry({ ref: '@e1', actionKind: 'click', staleReason: 'timeout', state_delta: [], snapshotFn: snapshotFn as never, actFn: actFn as never });
    expect(rr.sidecar).toMatchObject({ attempted: false, suppressed: 'gone' });
    expect(actFn).not.toHaveBeenCalled();
  });

  it('one-retry cap: a failing re-resolved act is not retried again', async () => {
    const snapshotFn = vi.fn(async () => ({ ok: true, url: 'u', elements: [descOf(lease({ name: 'Next' }))] }));
    const actFn = vi.fn(async () => ({ ok: false, error: 'still failing' }));
    const rr = await reResolveAndRetry({ ref: '@e1', actionKind: 'click', staleReason: 'timeout', state_delta: [], snapshotFn: snapshotFn as never, actFn: actFn as never });
    expect(actFn).toHaveBeenCalledTimes(1); // exactly once
    expect(rr.sidecar).toMatchObject({ attempted: true, succeeded: false });
    expect(rr.result).toBeNull(); // keep the original failure
  });
});
