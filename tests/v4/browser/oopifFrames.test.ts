/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 B4.2b — OOPIF coverage + unified frame addressing.
 *
 * The snapshot extracts EVERY frame in page.frames() via Frame.evaluate (works
 * cross-origin → OOPIF content visible), tagging frame_id by the frame's index.
 * scopeForFrame resolves the SAME index, so a lease generated in frame N acts in
 * frame N — the correctness-critical coupling tested here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const mk = (descs: any[], parent: any) => {
    const loc = { first: () => loc, count: vi.fn(async () => 1), click: vi.fn(async () => {}), fill: vi.fn(async () => {}) };
    return {
      evaluate: vi.fn(async () => descs),     // this frame's descriptors (no frame_id yet)
      parentFrame: () => parent ?? null,
      getByRole: vi.fn(() => loc), locator: vi.fn(() => loc),
      _loc: loc,
    };
  };
  const mainDescs = [{ tag: 'button', roleAttr: '', inputType: '', submit: false, ariaLabel: 'Main Btn', labelledByText: '', textContent: 'Main Btn', placeholder: '', alt: '', title: '', css_path: '#mb', bbox: { x: 0, y: 0, w: 1, h: 1 } }];
  const oopifDescs = [{ tag: 'button', roleAttr: '', inputType: '', submit: false, ariaLabel: 'OOPIF Btn', labelledByText: '', textContent: 'OOPIF Btn', placeholder: '', alt: '', title: '', css_path: '#ob', bbox: { x: 0, y: 0, w: 1, h: 1 } }];
  const mainFrame = mk(mainDescs, null);
  const oopifFrame = mk(oopifDescs, mainFrame); // cross-origin child → depth 1
  let framesList: any[] = [mainFrame, oopifFrame];
  const page: any = {
    url: () => 'https://top.example.com/', isClosed: () => false,
    frames: () => framesList,
    getByRole: mainFrame.getByRole, locator: mainFrame.locator, // page proxies its main frame
    on: vi.fn(),
  };
  const context = { pages: () => [page], newPage: vi.fn(async () => page), on: vi.fn(), close: vi.fn(async () => {}) };
  const chromium = { launchPersistentContext: vi.fn(async () => context) };
  return { chromium, page, mainFrame, oopifFrame, mk, setFrames: (a: any[]) => { framesList = a; } };
});
vi.mock('playwright', () => ({ chromium: h.chromium }));

import { pwAxSnapshot, pwActByLease } from '../../../core/playwrightBridge';

beforeEach(() => { vi.clearAllMocks(); h.setFrames([h.mainFrame, h.oopifFrame]); });

describe('B4.2b — OOPIF snapshot coverage', () => {
  it('emits descriptors for a CROSS-ORIGIN OOPIF (previously invisible)', async () => {
    const r = await pwAxSnapshot();
    expect(r.ok).toBe(true);
    const names = (r.elements ?? []).map((e: any) => e.ariaLabel);
    expect(names).toContain('Main Btn');
    expect(names).toContain('OOPIF Btn');                 // the OOPIF content is now visible
    expect(h.oopifFrame.evaluate).toHaveBeenCalled();     // extracted via Frame.evaluate
  });

  it('tags frame_id by page.frames() index (main → "main", others → "frame-N")', async () => {
    const r = await pwAxSnapshot();
    const main = (r.elements ?? []).find((e: any) => e.ariaLabel === 'Main Btn');
    const oopif = (r.elements ?? []).find((e: any) => e.ariaLabel === 'OOPIF Btn');
    expect(main.frame_id).toBe('main');                   // index 0
    expect(oopif.frame_id).toBe('frame-1');               // index 1
  });
});

describe('B4.2b — ★ unified addressing (lease in frame N acts in frame N)', () => {
  it('a lease from the OOPIF acts in THAT OOPIF, not top-level', async () => {
    await pwActByLease({ role: 'button', name: 'OOPIF Btn', css_path: '#ob', frame_id: 'frame-1' } as never, { kind: 'click' });
    expect(h.oopifFrame.getByRole).toHaveBeenCalledWith('button', { name: 'OOPIF Btn', exact: true });
    expect(h.oopifFrame._loc.click).toHaveBeenCalled();   // acted inside the OOPIF
    expect(h.mainFrame.getByRole).not.toHaveBeenCalled(); // NOT the wrong frame / top-level
  });

  it('a main-frame lease acts on the page (main frame), not a sub-frame', async () => {
    await pwActByLease({ role: 'button', name: 'Main Btn', css_path: '#mb', frame_id: 'main' } as never, { kind: 'click' });
    expect(h.mainFrame.getByRole).toHaveBeenCalledWith('button', { name: 'Main Btn', exact: true });
    expect(h.oopifFrame.getByRole).not.toHaveBeenCalled();
  });

  it('frame_id from the snapshot resolves to the same frame at act time (no divergence)', async () => {
    const r = await pwAxSnapshot();
    const oopif = (r.elements ?? []).find((e: any) => e.ariaLabel === 'OOPIF Btn');
    // act using the EXACT frame_id the snapshot produced:
    await pwActByLease({ role: 'button', name: 'OOPIF Btn', css_path: '#ob', frame_id: oopif.frame_id } as never, { kind: 'click' });
    expect(h.oopifFrame._loc.click).toHaveBeenCalled();
  });
});

describe('B4.2b — bounded DAG', () => {
  it('caps the number of frames scanned on a wide tree', async () => {
    const many = Array.from({ length: 40 }, () => h.mk([{ tag: 'button', roleAttr: '', inputType: '', submit: false, ariaLabel: 'x', labelledByText: '', textContent: 'x', placeholder: '', alt: '', title: '', css_path: '#x', bbox: { x: 0, y: 0, w: 1, h: 1 } }], null));
    h.setFrames(many);
    await pwAxSnapshot();
    const scanned = many.filter((f) => (f.evaluate as any).mock.calls.length > 0).length;
    expect(scanned).toBeLessThanOrEqual(30);              // MAX_FRAMES
  });

  it('skips frames nested deeper than the depth cap', async () => {
    const f0 = h.mk([], null);
    const f1 = h.mk([], f0);
    const f2 = h.mk([], f1);
    const f3deep = h.mk([{ tag: 'button', roleAttr: '', inputType: '', submit: false, ariaLabel: 'TooDeep', labelledByText: '', textContent: 'TooDeep', placeholder: '', alt: '', title: '', css_path: '#d', bbox: { x: 0, y: 0, w: 1, h: 1 } }], f2); // depth 3
    h.setFrames([f0, f1, f2, f3deep]);
    const r = await pwAxSnapshot();
    expect((r.elements ?? []).some((e: any) => e.ariaLabel === 'TooDeep')).toBe(false);
    expect(f3deep.evaluate).not.toHaveBeenCalled();       // depth-3 frame skipped
  });
});
