/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 B2.2b — browser_see: screenshot → askVision → text. Vision call is
 * mocked (the real round-trip is the in-app live smoke); these cover the tool
 * wiring: capture+ask+return, the vision-unavailable error, and that browser_see
 * is model-invoked only (never in the stale-ref retry set).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  pwScreenshotBuffer: vi.fn(async () => ({ ok: true, base64: 'QUJD' })),
  askVision: vi.fn(async () => ({ ok: true, text: 'a login form with email and password fields' })),
  visionAvailable: vi.fn(() => ({ ok: true })),
  // observer bridge calls (no-op):
  pwSnapshot: vi.fn(async () => ({ ok: false })),
  pwSnapshotHash: vi.fn(async () => ({ ok: false })),
  pwSnapshotTabs: vi.fn(async () => ({ ok: false })),
}));
vi.mock('../../../core/playwrightBridge', () => ({
  pwScreenshotBuffer: m.pwScreenshotBuffer,
  pwSnapshot: m.pwSnapshot, pwSnapshotHash: m.pwSnapshotHash, pwSnapshotTabs: m.pwSnapshotTabs,
}));
vi.mock('../../../core/v4/visionClient', () => ({ askVision: m.askVision, visionAvailable: m.visionAvailable }));

import { browserSeeTool } from '../../../tools/v4/browser/browserSee';
import { STALE_REF_RETRYABLE } from '../../../tools/v4/browser/_observer';

beforeEach(() => {
  m.pwScreenshotBuffer.mockClear(); m.askVision.mockClear();
  m.visionAvailable.mockReturnValue({ ok: true });
});

describe('browser_see', () => {
  it('captures a screenshot and asks the vision model, returning its text answer', async () => {
    const r = await browserSeeTool.execute!({ question: 'what do you see?' }, {} as never);
    expect(r.success).toBe(true);
    expect(r.answer).toMatch(/login form/);
    expect(m.pwScreenshotBuffer).toHaveBeenCalledTimes(1);
    expect(m.askVision).toHaveBeenCalledTimes(1);
    expect(m.askVision.mock.calls[0][0]).toEqual({ imageDataUrl: 'data:image/png;base64,QUJD', question: 'what do you see?' });
  });

  it('vision unavailable → clear error, no screenshot, no vision call', async () => {
    m.visionAvailable.mockReturnValue({ ok: false, reason: "the current model (gpt-x) can't see images" });
    const r = await browserSeeTool.execute!({ question: 'x' }, {} as never);
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/can't see images|vision-capable/i);
    expect(m.pwScreenshotBuffer).not.toHaveBeenCalled();
    expect(m.askVision).not.toHaveBeenCalled();
  });

  it('screenshot failure → clear error, no vision call', async () => {
    m.pwScreenshotBuffer.mockResolvedValueOnce({ ok: false, error: 'browser is closed' } as never);
    const r = await browserSeeTool.execute!({ question: 'x' }, {} as never);
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/browser is closed/);
    expect(m.askVision).not.toHaveBeenCalled();
  });

  it('missing question → usage error', async () => {
    const r = await browserSeeTool.execute!({}, {} as never);
    expect(r.success).toBe(false);
    expect(m.pwScreenshotBuffer).not.toHaveBeenCalled();
  });

  it('is model-invoked only — NOT in the stale-ref retry set (no auto-loop)', () => {
    expect(STALE_REF_RETRYABLE.has('browser_see')).toBe(false);
  });
});
