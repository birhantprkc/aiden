/**
 * v4.3 Phase 5 — RecoveryReport browser-context tests.
 *
 * Coverage:
 *   1. buildRecoveryReport populates browserContext when browserState
 *      has tabs
 *   2. browserContext absent when no browserState passed
 *   3. browserContext absent when browserState reports no tabs
 *   4. activeBlocker kind surfaces from active tab's last_blocker
 *   5. otherTabCount counts non-active tabs correctly
 *   6. staleRefRetries counts stale_ref classifications in the snapshot
 *   7. enrichCardWithReport populates CapabilityCardData.browserContext
 *      with formatted string when browserContext present
 *   8. enrichCardWithReport omits browserContext when absent on report
 */
import { describe, it, expect } from 'vitest';
import {
  buildRecoveryReport,
  enrichCardWithReport,
  type BrowserStateLike,
} from '../../../core/v4/recoveryReport';
import type { TurnStateDiagnosticSnapshot } from '../../../core/v4/turnState';
import type { CapabilityCardData } from '../../../providers/v4/types';

function mkSnapshot(over: Partial<TurnStateDiagnosticSnapshot> = {}): TurnStateDiagnosticSnapshot {
  return {
    enabled:         true,
    stage:           'surfaced',
    consecName:      { name: null, count: 0 },
    consecSignature: { signature: null, count: 0 },
    consecFailed:    { name: null, count: 0 },
    cooledDownTools: [],
    toolCalls:       [],
    successfulTools: [],
    recoveryEvents:  [],
    verifications:   [],
    classifications: [],
    thresholds: { hintConsec: 5, cooldownConsec: 8, surfaceConsec: 11, cooldownIters: 3, failedConsec: 3 },
    ...over,
  };
}

function mkBrowserState(over: Partial<{
  tabs:      Array<{ is_active: boolean }>;
  activeTab: { url?: string; title?: string; last_blocker?: { kind: 'captcha' | 'login' | '2fa' | 'verification' | 'consent' } } | null;
}> = {}): BrowserStateLike {
  return {
    getTabs:      () => over.tabs      ?? [],
    getActiveTab: () => over.activeTab ?? null,
  };
}

const BASE_INPUT = {
  snapshot:   mkSnapshot(),
  goal:       'do thing',
  exitReason: 'tool_loop' as const,
  durationMs: 1000,
};

// ── browserContext population ──────────────────────────────────────────────

describe('buildRecoveryReport — browserContext population', () => {
  it('absent when no browserState passed', () => {
    const r = buildRecoveryReport(BASE_INPUT);
    expect(r.browserContext).toBeUndefined();
  });

  it('absent when browserState reports zero tabs', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      browserState: mkBrowserState({ tabs: [] }),
    });
    expect(r.browserContext).toBeUndefined();
  });

  it('present when browserState has tabs', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      browserState: mkBrowserState({
        tabs: [{ is_active: true }],
        activeTab: { url: 'https://example.com/page', title: 'Page' },
      }),
    });
    expect(r.browserContext).toBeDefined();
    expect(r.browserContext!.activeTabUrl).toBe('https://example.com/page');
    expect(r.browserContext!.activeTabTitle).toBe('Page');
  });

  it('otherTabCount counts non-active tabs', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      browserState: mkBrowserState({
        tabs: [
          { is_active: true },
          { is_active: false },
          { is_active: false },
        ],
        activeTab: { url: 'https://a.com/' },
      }),
    });
    expect(r.browserContext!.otherTabCount).toBe(2);
  });

  it('otherTabCount equals total tabs when no active tab', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      browserState: mkBrowserState({
        tabs: [{ is_active: false }, { is_active: false }],
        activeTab: null,
      }),
    });
    expect(r.browserContext!.otherTabCount).toBe(2);
  });

  it('activeBlocker surfaces from active tab last_blocker', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      browserState: mkBrowserState({
        tabs: [{ is_active: true }],
        activeTab: {
          url: 'https://x.com/',
          last_blocker: { kind: '2fa' },
        },
      }),
    });
    expect(r.browserContext!.activeBlocker).toBe('2fa');
  });

  it('activeBlocker absent when active tab has no last_blocker', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      browserState: mkBrowserState({
        tabs: [{ is_active: true }],
        activeTab: { url: 'https://x.com/' },
      }),
    });
    expect(r.browserContext!.activeBlocker).toBeUndefined();
  });

  it('staleRefRetries counts stale_ref classifications', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      snapshot: mkSnapshot({
        classifications: [
          { name: 'browser_click', ts: 100, classification: { category: 'stale_ref', confidence: 0.9, recoverable: true } },
          { name: 'browser_click', ts: 200, classification: { category: 'stale_ref', confidence: 0.9, recoverable: true } },
          { name: 'browser_click', ts: 300, classification: { category: 'timeout',   confidence: 0.9, recoverable: true } },
        ],
      }),
      browserState: mkBrowserState({
        tabs: [{ is_active: true }],
        activeTab: { url: 'https://x.com/' },
      }),
    });
    expect(r.browserContext!.staleRefRetries).toBe(2);
  });

  it('staleRefRetries=0 when no stale_ref classifications', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      browserState: mkBrowserState({
        tabs: [{ is_active: true }],
        activeTab: { url: 'https://x.com/' },
      }),
    });
    expect(r.browserContext!.staleRefRetries).toBe(0);
  });
});

// ── enrichCardWithReport — browserContext line ─────────────────────────────

describe('enrichCardWithReport — browserContext rendering', () => {
  const BASE_CARD: CapabilityCardData = {
    title:          'Stuck',
    canStill:       [],
    cannotReliably: [],
    fix:            '',
  };

  it('omits browserContext when report.browserContext absent', () => {
    const r = buildRecoveryReport(BASE_INPUT);
    const card = enrichCardWithReport(BASE_CARD, r);
    expect(card.browserContext).toBeUndefined();
  });

  it('populates browserContext line with active hostname', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      browserState: mkBrowserState({
        tabs: [{ is_active: true }],
        activeTab: { url: 'https://www.example.com/page' },
      }),
    });
    const card = enrichCardWithReport(BASE_CARD, r);
    expect(card.browserContext).toContain('Browser:');
    expect(card.browserContext).toContain('active=www.example.com');
  });

  it('includes activeBlocker kind when present', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      browserState: mkBrowserState({
        tabs: [{ is_active: true }],
        activeTab: { url: 'https://x.com/', last_blocker: { kind: 'login' } },
      }),
    });
    const card = enrichCardWithReport(BASE_CARD, r);
    expect(card.browserContext).toContain('login blocker');
  });

  it('includes otherTabCount when non-zero', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      browserState: mkBrowserState({
        tabs: [{ is_active: true }, { is_active: false }, { is_active: false }],
        activeTab: { url: 'https://x.com/' },
      }),
    });
    const card = enrichCardWithReport(BASE_CARD, r);
    expect(card.browserContext).toContain('2 other tabs');
  });

  it('singular "tab" when otherTabCount === 1', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      browserState: mkBrowserState({
        tabs: [{ is_active: true }, { is_active: false }],
        activeTab: { url: 'https://x.com/' },
      }),
    });
    const card = enrichCardWithReport(BASE_CARD, r);
    expect(card.browserContext).toContain('1 other tab');
    expect(card.browserContext).not.toContain('1 other tabs');
  });

  it('includes staleRefRetries with correct singular/plural', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      snapshot: mkSnapshot({
        classifications: [
          { name: 'browser_click', ts: 100, classification: { category: 'stale_ref', confidence: 0.9, recoverable: true } },
        ],
      }),
      browserState: mkBrowserState({
        tabs: [{ is_active: true }],
        activeTab: { url: 'https://x.com/' },
      }),
    });
    const card = enrichCardWithReport(BASE_CARD, r);
    expect(card.browserContext).toContain('1 stale-ref retry');
  });

  it('malformed URL falls back to raw value', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      browserState: mkBrowserState({
        tabs: [{ is_active: true }],
        activeTab: { url: 'not a url' },
      }),
    });
    const card = enrichCardWithReport(BASE_CARD, r);
    expect(card.browserContext).toContain('not a url');
  });
});

// ── New guidance text ──────────────────────────────────────────────────────

describe('Phase 5 guidance text', () => {
  it('stale_ref dominant → routes to stale_ref guidance', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      snapshot: mkSnapshot({
        classifications: [
          { name: 'browser_click', ts: 100, classification: { category: 'stale_ref', confidence: 0.9, recoverable: true } },
          { name: 'browser_click', ts: 200, classification: { category: 'stale_ref', confidence: 0.9, recoverable: true } },
        ],
      }),
    });
    expect(r.guidance.toLowerCase()).toContain('snapshot');
  });

  it('manual_blocker dominant → routes to manual_blocker guidance', () => {
    const r = buildRecoveryReport({
      ...BASE_INPUT,
      snapshot: mkSnapshot({
        classifications: [
          { name: 'browser_click', ts: 100, classification: { category: 'manual_blocker', confidence: 0.95, recoverable: false } },
        ],
      }),
    });
    expect(r.guidance.toLowerCase()).toContain('human action');
  });
});
