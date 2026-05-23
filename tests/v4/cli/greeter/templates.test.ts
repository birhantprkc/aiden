/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.3 SLICE 1a — templates.ts unit coverage.
 *
 * Pure-function tests: given identical TemplateContext, identical
 * string out. Paint helpers are stub functions that wrap the input
 * in recognisable markers so we can assert which spans got which
 * color tier (same pattern as the v4.9.2 Slice 3 confirm primitive
 * paint marker assertion).
 */
import { describe, it, expect } from 'vitest';
import { TEMPLATES } from '../../../../cli/v4/greeter/templates';
import type { TemplateContext } from '../../../../cli/v4/greeter/types';
import path from 'node:path';

function mkCtx(over: Partial<TemplateContext> = {}): TemplateContext {
  return {
    paintMuted:  (s) => `<m>${s}</m>`,
    paintAccent: (s) => `<a>${s}</a>`,
    ...over,
  };
}

describe('TEMPLATES — Tier 1 (stubs, never selected in Slice 1 but typed-API-declared)', () => {
  it('daemon-crashed wraps /daemon doctor in accent', () => {
    expect(TEMPLATES['daemon-crashed'](mkCtx()))
      .toBe('Daemon crashed mid-session. <a>/daemon doctor</a> for the postmortem.');
  });

  it('hook-auto-disabled wraps /hooks audit in accent', () => {
    expect(TEMPLATES['hook-auto-disabled'](mkCtx()))
      .toBe('A hook auto-disabled after repeated failures. <a>/hooks audit</a> for details.');
  });
});

describe('TEMPLATES — Tier 2 (continuity)', () => {
  it('continuity-open-item quotes the item in muted', () => {
    expect(TEMPLATES['continuity-open-item'](mkCtx({ openItem: 'decide redis vs postgres' })))
      .toBe('Last session left this open: <m>"decide redis vs postgres"</m>.');
  });

  it('continuity-open-item degrades gracefully when item missing', () => {
    expect(TEMPLATES['continuity-open-item'](mkCtx()))
      .toBe('Last session left this open: <m>""</m>.');
  });

  it('continuity-decision dims the decision text', () => {
    expect(TEMPLATES['continuity-decision'](mkCtx({ decision: 'shipped v4.9.2' })))
      .toBe('Last session: <m>shipped v4.9.2</m>.');
  });

  it('welcome-back interpolates hoursAgo as a plain integer', () => {
    expect(TEMPLATES['welcome-back'](mkCtx({ hoursAgo: 31 })))
      .toBe('Welcome back. Last session ended 31h ago.');
  });

  it('welcome-back falls back to 0h when hoursAgo missing (defensive — caller should always supply)', () => {
    expect(TEMPLATES['welcome-back'](mkCtx()))
      .toBe('Welcome back. Last session ended 0h ago.');
  });
});

describe('TEMPLATES — Tier 3 (environment)', () => {
  it('time-of-day-evening is a single bare line — no paint, no interpolation', () => {
    expect(TEMPLATES['time-of-day-evening'](mkCtx()))
      .toBe('Good evening.');
  });

  it('cwd-changed uses basenames + dimmed previous + accent current (no awkward "now" wording)', () => {
    const text = TEMPLATES['cwd-changed'](mkCtx({
      cwd:         path.join('home', 'shiva', 'DevOS'),
      previousCwd: path.join('home', 'shiva', 'BacktestPro'),
    }));
    // Per Phase B prose refinement: "In <basename> this time (last session: <previous>)."
    expect(text).toBe('In <a>DevOS</a> this time (last session: <m>BacktestPro</m>).');
  });

  it('cwd-changed handles empty cwds without throwing', () => {
    const text = TEMPLATES['cwd-changed'](mkCtx({}));
    expect(text).toBe('In <a></a> this time (last session: <m></m>).');
  });
});

describe('TEMPLATES — Tier 4 (update)', () => {
  it('update-available shows installed → latest with /update install in accent', () => {
    expect(TEMPLATES['update-available'](mkCtx({ installed: '4.9.3', latest: '4.9.4' })))
      .toBe('aiden-runtime 4.9.3 → 4.9.4 available. <a>/update install</a> to ship.');
  });

  it('update-available falls back to "?" on missing versions (defensive)', () => {
    expect(TEMPLATES['update-available'](mkCtx()))
      .toBe('aiden-runtime ? → ? available. <a>/update install</a> to ship.');
  });
});

describe('TEMPLATES — purity invariant', () => {
  it('identical ctx ⇒ identical output (every template, called twice)', () => {
    const ctx = mkCtx({
      installed: '4.9.3', latest: '4.9.4',
      hoursAgo: 31, openItem: 'x', decision: 'y',
      cwd: '/a/b', previousCwd: '/c/d',
    });
    for (const id of Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>) {
      const a = TEMPLATES[id](ctx);
      const b = TEMPLATES[id](ctx);
      expect(a).toBe(b);
    }
  });
});
