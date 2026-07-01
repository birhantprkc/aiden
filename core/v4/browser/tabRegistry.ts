/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/browser/tabRegistry.ts — v4.12 B4.1 (first-class tab registry).
 *
 * Promotes the data-only `pwSnapshotTabs` into a LIVE registry fed by the
 * bridge's `context.on('page')` / `page.on('close')` events. Each tracked Page
 * carries metadata + a `createdBy` classification that drives the multi-tab
 * SAFETY policy:
 *
 *   - Aiden-created  = Aiden's own newPage tabs + any popup whose opener chain
 *                      roots at an Aiden tab (OAuth/payment/login popups).
 *                      → fully controllable AND closeable.
 *   - User-created   = present-at-attach OR user-opened (no Aiden-rooted opener).
 *                      → listable but NEVER closeable; controlling one needs an
 *                        explicit, user-initiated designation (tier 2).
 *
 * This module is pure state — the bridge owns the Playwright Pages and feeds
 * events in. It never imports Playwright or the bridge (no cycle).
 */

export interface TabMeta {
  tab_id: string;
  url: string;
  title: string;
  origin: string;
  opener_id: string | null;
  createdBy: 'aiden' | 'user';
  controlled: boolean;
  lastSnapshotHash: string | null;
  dirtyForm: boolean;
}

class TabRegistry {
  private byPage = new Map<unknown, TabMeta>();
  private counter = 0;

  /**
   * Track (or override) a page. Idempotent: a second call with createdBy
   * 'aiden' upgrades an event-classified entry — this is how the bridge's
   * explicit Aiden-newPage registration wins regardless of event ordering.
   */
  track(page: unknown, createdBy: 'aiden' | 'user', openerId: string | null): TabMeta {
    let meta = this.byPage.get(page);
    if (!meta) {
      this.counter += 1;
      meta = {
        tab_id: `tab-${this.counter}`,
        url: '', title: '', origin: '',
        opener_id: openerId,
        createdBy,
        controlled: false,
        lastSnapshotHash: null,
        dirtyForm: false,
      };
      this.byPage.set(page, meta);
    } else {
      if (createdBy === 'aiden') meta.createdBy = 'aiden'; // upgrade only
      if (openerId !== null) meta.opener_id = openerId;
    }
    return meta;
  }

  get(page: unknown): TabMeta | undefined { return this.byPage.get(page); }
  has(page: unknown): boolean { return this.byPage.has(page); }
  remove(page: unknown): void { this.byPage.delete(page); }
  clear(): void { this.byPage.clear(); this.counter = 0; }

  pageById(tabId: string): unknown | undefined {
    for (const [pg, m] of this.byPage) if (m.tab_id === tabId) return pg;
    return undefined;
  }
  idOf(page: unknown): string | null { return this.byPage.get(page)?.tab_id ?? null; }

  /** Mark exactly one page as the controlled tab (the rest cleared). */
  markControlled(page: unknown): void {
    for (const [pg, m] of this.byPage) m.controlled = pg === page;
  }

  isAidenCreated(page: unknown): boolean { return this.byPage.get(page)?.createdBy === 'aiden'; }

  /** Aiden-created tabs are closeable; user tabs NEVER are (even when controlled). */
  canClose(page: unknown): boolean { return this.isAidenCreated(page); }

  entries(): Array<[unknown, TabMeta]> { return [...this.byPage.entries()]; }
  list(): TabMeta[] { return [...this.byPage.values()]; }
}

let _registry: TabRegistry | null = null;
export function getTabRegistry(): TabRegistry {
  if (!_registry) _registry = new TabRegistry();
  return _registry;
}
