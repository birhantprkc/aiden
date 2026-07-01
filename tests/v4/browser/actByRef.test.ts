/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 B1.2 — act-by-ref routing in browser_click / browser_type / browser_fill.
 * The actual locator resolution (getByRole primary, css fallback, frame scope)
 * is Playwright-level → live-smoked; these tests cover the tool-side routing:
 * @eN → lease lookup → pwActByLease; stale ref → re-snapshot error; the
 * existing CSS/text path stays unchanged when no ref is given.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factory (also hoisted) can reference them.
const m = vi.hoisted(() => ({
  pwClick: vi.fn(async () => ({ ok: true })),
  pwClickFirstResult: vi.fn(async () => ({ ok: true, url: 'u' })),
  pwType: vi.fn(async () => ({ ok: true })),
  pwActByLease: vi.fn(async () => ({ ok: true })),
  pwSnapshotHash: vi.fn(async () => ({ ok: false })),
  pwSnapshotTabs: vi.fn(async () => ({ ok: false })),
}));
vi.mock('../../../core/playwrightBridge', () => m);
const { pwClick, pwClickFirstResult, pwType, pwActByLease } = m;

import { browserClickTool } from '../../../tools/v4/browser/browserClick';
import { browserTypeTool } from '../../../tools/v4/browser/browserType';
import { browserFillTool } from '../../../tools/v4/browser/browserFill';
import { getLeaseStore, type AxRawDescriptor } from '../../../core/v4/browserState';

function desc(over: Partial<AxRawDescriptor> = {}): AxRawDescriptor {
  return {
    tag: 'button', roleAttr: '', inputType: '', ariaLabel: '', labelledByText: '',
    textContent: 'Go', placeholder: '', alt: '', title: '',
    css_path: '#go', bbox: { x: 0, y: 0, w: 1, h: 1 }, frame_id: 'main', ...over,
  };
}

beforeEach(() => {
  pwClick.mockClear(); pwClickFirstResult.mockClear(); pwType.mockClear(); pwActByLease.mockClear();
  getLeaseStore().refresh(1, 'https://ex.com', [
    desc({ tag: 'button', textContent: 'Go', css_path: '#go' }),          // @e1
    desc({ tag: 'input', inputType: 'text', placeholder: 'Email', css_path: '#email', frame_id: 'frame-1' }), // @e2
  ]);
});

describe('browser_click — act by ref', () => {
  it('ref @eN → resolves the lease → pwActByLease(click), not pwClick', async () => {
    const r = await browserClickTool.execute!({ ref: '@e1' }, {} as never);
    expect(r.success).toBe(true);
    expect(pwActByLease).toHaveBeenCalledTimes(1);
    expect(pwActByLease.mock.calls[0][0]).toMatchObject({ ref: '@e1', role: 'button', name: 'Go', css_path: '#go', frame_id: 'main' });
    expect(pwActByLease.mock.calls[0][1]).toEqual({ kind: 'click' });
    expect(pwClick).not.toHaveBeenCalled();
  });

  it('ref not in store → clear re-snapshot error, no bridge call', async () => {
    const r = await browserClickTool.execute!({ ref: '@e99' }, {} as never);
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/not in the current snapshot.*browser_snapshot/i);
    expect(pwActByLease).not.toHaveBeenCalled();
  });

  it('no ref → existing CSS/text path unchanged (pwClick)', async () => {
    const r = await browserClickTool.execute!({ target: '#foo' }, {} as never);
    expect(r.success).toBe(true);
    expect(pwClick).toHaveBeenCalledWith('#foo');
    expect(pwActByLease).not.toHaveBeenCalled();
  });

  it('no ref + first_result → existing shortcut path', async () => {
    await browserClickTool.execute!({ target: 'first_result' }, {} as never);
    expect(pwClickFirstResult).toHaveBeenCalledTimes(1);
  });
});

describe('browser_type — act by ref', () => {
  it('ref @eN → pwActByLease(fill, text); passes the frame-scoped lease through', async () => {
    const r = await browserTypeTool.execute!({ ref: '@e2', text: 'hi@x.com' }, {} as never);
    expect(r.success).toBe(true);
    expect(pwActByLease).toHaveBeenCalledTimes(1);
    expect(pwActByLease.mock.calls[0][0]).toMatchObject({ ref: '@e2', frame_id: 'frame-1', css_path: '#email' });
    expect(pwActByLease.mock.calls[0][1]).toEqual({ kind: 'fill', text: 'hi@x.com' });
    expect(pwType).not.toHaveBeenCalled();
  });

  it('stale ref → re-snapshot error', async () => {
    const r = await browserTypeTool.execute!({ ref: '@e7', text: 'x' }, {} as never);
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/browser_snapshot/);
  });

  it('no ref → existing selector path (pwType)', async () => {
    await browserTypeTool.execute!({ selector: '#s', text: 'x' }, {} as never);
    expect(pwType).toHaveBeenCalledWith('#s', 'x');
    expect(pwActByLease).not.toHaveBeenCalled();
  });
});

describe('browser_fill — mixed @eN and CSS keys', () => {
  it('@eN keys route through the lease; CSS keys use the old path', async () => {
    const r = await browserFillTool.execute!({ fields: { '@e2': 'a@b.com', '#name': 'Ann' } }, {} as never);
    expect(r.success).toBe(true);
    expect(pwActByLease).toHaveBeenCalledTimes(1);
    expect(pwActByLease.mock.calls[0][0]).toMatchObject({ ref: '@e2' });
    expect(pwType).toHaveBeenCalledWith('#name', 'Ann');
  });

  it('stale @eN key → re-snapshot error, reports what filled so far', async () => {
    const r = await browserFillTool.execute!({ fields: { '#name': 'Ann', '@e9': 'x' } }, {} as never);
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/browser_snapshot/);
    expect(r.filled).toEqual(['#name']); // first field done before the bad ref
  });
});
