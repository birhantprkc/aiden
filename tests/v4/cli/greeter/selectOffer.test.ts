/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.3 SLICE 1a — selectOffer priority + decay coverage.
 *
 * Pure function. Drive with synthetic ScanResult + GreeterHistory
 * fixtures; assert which Offer.id wins (or null). No mocks.
 */
import { describe, it, expect } from 'vitest';

import { selectOffer } from '../../../../cli/v4/greeter/selectOffer';
import type {
  GreeterHistory, GreeterOfferRecord, ScanResult,
} from '../../../../cli/v4/greeter/types';

const NOW = new Date(2026, 4, 25, 19, 30, 0);  // local 7:30pm
const TODAY = '2026-05-25';

const mkHistory = (over: Partial<GreeterHistory> = {}): GreeterHistory => ({
  v: 1, firstLaunchAt: 'x', lastGreetingAt: 'y',
  offers: [], disabled: false, ...over,
});

const mkScan = (over: Partial<ScanResult> = {}): ScanResult => ({
  hourOfDay:             19,
  cwdChanged:            false,
  cwd:                   '/dev/null',
  hoursSinceLastSession: null,
  update:                null,
  ...over,
});

const paint = {
  paintMuted:  (s: string) => `<m>${s}</m>`,
  paintAccent: (s: string) => `<a>${s}</a>`,
};

describe('selectOffer — kill switch', () => {
  it('returns null when history.disabled === true (no matter what scanners say)', () => {
    const r = selectOffer({
      scan: mkScan({ update: { latest: '4.9.4', installed: '4.9.3' }, hoursSinceLastSession: 100 }),
      history: mkHistory({ disabled: true }),
      now: NOW, ...paint,
    });
    expect(r).toBeNull();
  });
});

describe('selectOffer — Tier 2 priority (continuity)', () => {
  it('open-item beats decision beats welcome-back when all qualify', () => {
    const r = selectOffer({
      scan: mkScan({ hoursSinceLastSession: 50 }),
      history: mkHistory(),
      now: NOW, ...paint,
      openItem: 'decide redis-vs-postgres',
      lastDecision: 'shipped v4.9.2',
    });
    expect(r?.templateId).toBe('continuity-open-item');
  });

  it('falls through to decision when open-item missing', () => {
    const r = selectOffer({
      scan: mkScan({ hoursSinceLastSession: 50 }),
      history: mkHistory(),
      now: NOW, ...paint,
      openItem: null,
      lastDecision: 'shipped v4.9.2',
    });
    expect(r?.templateId).toBe('continuity-decision');
  });

  it('falls through to welcome-back when continuity missing AND hoursSinceLastSession >= 24', () => {
    const r = selectOffer({
      scan: mkScan({ hoursSinceLastSession: 30 }),
      history: mkHistory(),
      now: NOW, ...paint,
    });
    expect(r?.templateId).toBe('welcome-back');
  });

  it('skips welcome-back when hoursSinceLastSession < 24', () => {
    const r = selectOffer({
      scan: mkScan({ hoursSinceLastSession: 8 }),
      history: mkHistory(),
      now: NOW, ...paint,
    });
    // No tier-2 candidate; with hour 19 (≥18) and no tier-2, time-of-day fires.
    expect(r?.templateId).toBe('time-of-day-evening');
  });

  it('skips welcome-back when no prior session (hoursSinceLastSession === null)', () => {
    const r = selectOffer({
      scan: mkScan({ hoursSinceLastSession: null }),
      history: mkHistory(),
      now: NOW, ...paint,
    });
    // Falls through to time-of-day (hour 19 ≥ 18).
    expect(r?.templateId).toBe('time-of-day-evening');
  });
});

describe('selectOffer — Tier 3 environment', () => {
  it('time-of-day-evening fires when hour >= 18 and no tier 2', () => {
    const r = selectOffer({
      scan: mkScan({ hourOfDay: 20 }),
      history: mkHistory(),
      now: NOW, ...paint,
    });
    expect(r?.templateId).toBe('time-of-day-evening');
  });

  it('time-of-day-evening does NOT fire when hour < 18', () => {
    const NOON = new Date(2026, 4, 25, 12, 0, 0);
    const r = selectOffer({
      scan: mkScan({ hourOfDay: 12 }),
      history: mkHistory(),
      now: NOON, ...paint,
    });
    expect(r).toBeNull();
  });

  it('time-of-day-evening is suppressed by recent ignored entry (3-day decay)', () => {
    const offered: GreeterOfferRecord = {
      id: `time-of-day-evening-${TODAY}`,
      offeredAt: NOW.toISOString(),       // today
      response: 'ignored',
    };
    const r = selectOffer({
      scan: mkScan({ hourOfDay: 20 }),
      history: mkHistory({ offers: [offered] }),
      now: NOW, ...paint,
    });
    // Suppressed → falls through to next tier; nothing else matches → null.
    expect(r).toBeNull();
  });

  it('cwd-changed fires when cwd differs AND no tier 2 AND no time-of-day (e.g. morning)', () => {
    const MORN = new Date(2026, 4, 25, 9, 0, 0);
    const r = selectOffer({
      scan: mkScan({ hourOfDay: 9, cwdChanged: true, cwd: '/new', }),
      history: mkHistory({ lastCwd: '/old' }),
      now: MORN, ...paint,
    });
    expect(r?.templateId).toBe('cwd-changed');
  });

  it('cwd-changed loses to time-of-day-evening when both qualify (eve takes earlier tier slot)', () => {
    const r = selectOffer({
      scan: mkScan({ hourOfDay: 20, cwdChanged: true, cwd: '/new' }),
      history: mkHistory({ lastCwd: '/old' }),
      now: NOW, ...paint,
    });
    // time-of-day-evening is earlier in the if-ladder → wins
    expect(r?.templateId).toBe('time-of-day-evening');
  });
});

describe('selectOffer — Tier 4 update', () => {
  it('update-available fires when scan.update is set AND no higher tier qualifies', () => {
    const MORN = new Date(2026, 4, 25, 9, 0, 0);
    const r = selectOffer({
      scan: mkScan({ hourOfDay: 9, update: { latest: '4.9.4', installed: '4.9.3' } }),
      history: mkHistory(),
      now: MORN, ...paint,
    });
    expect(r?.templateId).toBe('update-available');
    expect(r?.expectedAction).toBe('/update install');
    expect(r?.id).toBe('update-available-4.9.4');
  });

  it('update-available is suppressed by ignored entry within 7-day decay', () => {
    const MORN = new Date(2026, 4, 25, 9, 0, 0);
    const offered: GreeterOfferRecord = {
      id: 'update-available-4.9.4',
      offeredAt: new Date(MORN.getTime() - 2 * 24 * 3600 * 1000).toISOString(),  // 2d ago
      response: 'ignored',
      expectedAction: '/update install',
    };
    const r = selectOffer({
      scan: mkScan({ hourOfDay: 9, update: { latest: '4.9.4', installed: '4.9.3' } }),
      history: mkHistory({ offers: [offered] }),
      now: MORN, ...paint,
    });
    expect(r).toBeNull();
  });

  it('update-available fires AGAIN after the 7-day decay window passes', () => {
    const MORN = new Date(2026, 4, 25, 9, 0, 0);
    const offered: GreeterOfferRecord = {
      id: 'update-available-4.9.4',
      offeredAt: new Date(MORN.getTime() - 8 * 24 * 3600 * 1000).toISOString(),  // 8d ago
      response: 'ignored',
      expectedAction: '/update install',
    };
    const r = selectOffer({
      scan: mkScan({ hourOfDay: 9, update: { latest: '4.9.4', installed: '4.9.3' } }),
      history: mkHistory({ offers: [offered] }),
      now: MORN, ...paint,
    });
    expect(r?.templateId).toBe('update-available');
  });

  it('update-available fires for a NEW version even if a previous version was ignored', () => {
    const MORN = new Date(2026, 4, 25, 9, 0, 0);
    const oldIgnored: GreeterOfferRecord = {
      id: 'update-available-4.9.4',
      offeredAt: MORN.toISOString(),
      response: 'ignored',
    };
    const r = selectOffer({
      // npm now serves 4.9.5 — different id, so the previous ignore doesn't apply
      scan: mkScan({ hourOfDay: 9, update: { latest: '4.9.5', installed: '4.9.3' } }),
      history: mkHistory({ offers: [oldIgnored] }),
      now: MORN, ...paint,
    });
    expect(r?.id).toBe('update-available-4.9.5');
  });
});

describe('selectOffer — silence rule', () => {
  it('returns null when nothing is observable', () => {
    const MORN = new Date(2026, 4, 25, 9, 0, 0);
    const r = selectOffer({
      scan: mkScan({ hourOfDay: 9 }),
      history: mkHistory(),
      now: MORN, ...paint,
    });
    expect(r).toBeNull();
  });
});

describe('selectOffer — Offer.speech is the templated text', () => {
  it('continuity-open-item produces the expected speech string', () => {
    const r = selectOffer({
      scan: mkScan(),
      history: mkHistory(),
      now: NOW, ...paint,
      openItem: 'sql migration',
    });
    expect(r?.speech).toBe('Last session left this open: <m>"sql migration"</m>.');
  });

  it('welcome-back produces the expected speech string', () => {
    const r = selectOffer({
      scan: mkScan({ hoursSinceLastSession: 31 }),
      history: mkHistory(),
      now: NOW, ...paint,
    });
    expect(r?.speech).toBe('Welcome back. Last session ended 31h ago.');
  });
});
