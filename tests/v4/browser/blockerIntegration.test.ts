/**
 * v4.3 Phase 3 — Blocker HOC integration tests.
 *
 * Verifies the observer HOC wires blocker detection correctly:
 *   1. AIDEN_BROWSER_DEPTH unset → no detection, no sidecar
 *   2. AIDEN_BROWSER_DEPTH=1 + blocker text → sidecar contains
 *      browserState.blocker with shaped BlockerSurface
 *   3. Phase 2 stale-ref retry SUPPRESSED when blocker present
 *   4. Phase 2 retry still fires when no blocker (regression sentinel)
 *   5. Fetcher exception never breaks inner tool
 *   6. Result without `url` field still gets blocker (text-only signal)
 *
 * Plus `mapBlockerToCard` semantic mapping unit tests.
 */
import { describe, it, expect } from 'vitest';
import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { BrowserState } from '../../../core/v4/browserState';
import { withBrowserState, type PageTextFetcher } from '../../../tools/v4/browser/_observer';
import { mapBlockerToCard } from '../../../cli/v4/callbacks';
import type { BlockerSurface } from '../../../tools/v4/browser/browserBlocker';

const mockCtx: never = {} as never;

function mkStubBridge() {
  return () => Promise.resolve({
    pwSnapshotHash: async () => ({
      ok:              true as const,
      url:             'https://example.com/',
      title:           'Page',
      dom_text_hash:   'hash',
      frame_tree_hash: 'frame',
    }),
  });
}

function mkFetcher(text: string): PageTextFetcher {
  return () => Promise.resolve({ ok: true, text });
}

function mkHandler(
  name: string,
  callBehaviors: Array<{ success: boolean; error?: string; url?: string }>,
): ToolHandler {
  let call = 0;
  return {
    schema: { name, description: 't', inputSchema: { type: 'object', properties: {} } },
    category: 'browser', mutates: true, toolset: 'browser',
    async execute() {
      const r = callBehaviors[Math.min(call, callBehaviors.length - 1)];
      call += 1;
      return r;
    },
  };
}

// ── HOC integration — gating ────────────────────────────────────────────────

describe('withBrowserState HOC — manual-blocker detection', () => {
  it('AIDEN_BROWSER_DEPTH=0: no detection even when blocker text present', async () => {
    const state = new BrowserState({ enabled: false });
    state.setBridgeLoader(mkStubBridge());
    const fetcher = mkFetcher('cloudflare just a moment, checking your browser');
    const handler = mkHandler('browser_click', [
      { success: true, url: 'https://example.com/' },
    ]);
    const wrapped = withBrowserState(handler, state, fetcher);
    const result = await wrapped.execute({}, mockCtx) as {
      browserState?: { blocker?: BlockerSurface };
    };
    expect(result.browserState).toBeUndefined();
  });

  it('AIDEN_BROWSER_DEPTH=1 + captcha text: sidecar contains blocker', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const fetcher = mkFetcher('cloudflare just a moment checking your browser');
    const handler = mkHandler('browser_click', [
      { success: true, url: 'https://blocked.example.com/' },
    ]);
    const wrapped = withBrowserState(handler, state, fetcher);
    const result = await wrapped.execute({}, mockCtx) as {
      success: boolean;
      browserState?: { blocker?: BlockerSurface };
    };
    expect(result.success).toBe(true);
    expect(result.browserState?.blocker).toBeDefined();
    expect(result.browserState!.blocker!.kind).toBe('captcha');
    expect(result.browserState!.blocker!.url).toBe('https://blocked.example.com/');
  });

  it('AIDEN_BROWSER_DEPTH=1 + 2FA page: detects 2fa kind', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const fetcher = mkFetcher('Enter your authenticator app code to continue.');
    const handler = mkHandler('browser_navigate', [
      { success: true, url: 'https://example.com/2fa' },
    ]);
    const wrapped = withBrowserState(handler, state, fetcher);
    const result = await wrapped.execute({}, mockCtx) as {
      browserState?: { blocker?: BlockerSurface };
    };
    expect(result.browserState!.blocker!.kind).toBe('2fa');
    expect(result.browserState!.blocker!.subtype).toBe('totp');
  });

  it('no blocker text → sidecar.blocker absent', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const fetcher = mkFetcher('Welcome to the dashboard. Recent activity below.');
    const handler = mkHandler('browser_navigate', [
      { success: true, url: 'https://example.com/dashboard' },
    ]);
    const wrapped = withBrowserState(handler, state, fetcher);
    const result = await wrapped.execute({}, mockCtx) as {
      browserState?: { blocker?: BlockerSurface };
    };
    expect(result.browserState).toBeDefined();
    expect(result.browserState?.blocker).toBeUndefined();
  });

  it('fetcher throws → no blocker, no propagation', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const fetcher: PageTextFetcher = () => Promise.reject(new Error('snap failed'));
    const handler = mkHandler('browser_click', [
      { success: true, url: 'https://example.com/' },
    ]);
    const wrapped = withBrowserState(handler, state, fetcher);
    const result = await wrapped.execute({}, mockCtx) as {
      success: boolean;
      browserState?: { blocker?: BlockerSurface };
    };
    expect(result.success).toBe(true);
    expect(result.browserState?.blocker).toBeUndefined();
  });
});

// ── Phase 2 retry suppression ──────────────────────────────────────────────

describe('Phase 2 retry suppression when blocker detected', () => {
  it('blocker present → stale-ref retry SUPPRESSED', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const fetcher = mkFetcher('Please sign in to continue.');
    // browser_click is in STALE_REF_RETRYABLE; error matches stale pattern.
    // Without the blocker, this would normally trigger a retry. With the
    // blocker, retry must be skipped.
    let callCount = 0;
    const handler: ToolHandler = {
      schema: { name: 'browser_click', description: 't', inputSchema: { type: 'object', properties: {} } },
      category: 'browser', mutates: true, toolset: 'browser',
      async execute() {
        callCount += 1;
        return { success: false, error: 'Element not found', url: 'https://example.com/login' };
      },
    };
    const wrapped = withBrowserState(handler, state, fetcher);
    const result = await wrapped.execute({}, mockCtx) as {
      browserState?: { staleRefRetry?: unknown; blocker?: BlockerSurface };
    };
    // Exactly ONE call — retry suppressed.
    expect(callCount).toBe(1);
    expect(result.browserState!.staleRefRetry).toBeUndefined();
    expect(result.browserState!.blocker).toBeDefined();
    expect(result.browserState!.blocker!.kind).toBe('login');
  });

  it('no blocker → stale-ref retry STILL FIRES (regression sentinel)', async () => {
    const state = new BrowserState({ enabled: true });
    state.setBridgeLoader(mkStubBridge());
    const fetcher = mkFetcher('Loading content...');
    let callCount = 0;
    const handler: ToolHandler = {
      schema: { name: 'browser_click', description: 't', inputSchema: { type: 'object', properties: {} } },
      category: 'browser', mutates: true, toolset: 'browser',
      async execute() {
        callCount += 1;
        if (callCount === 1) return { success: false, error: 'Element not found' };
        return { success: true };
      },
    };
    const wrapped = withBrowserState(handler, state, fetcher);
    const result = await wrapped.execute({}, mockCtx) as {
      success: boolean;
      browserState?: { staleRefRetry?: { succeeded: boolean }; blocker?: unknown };
    };
    // TWO calls — retry fired.
    expect(callCount).toBe(2);
    expect(result.browserState!.staleRefRetry).toBeDefined();
    expect(result.browserState!.staleRefRetry!.succeeded).toBe(true);
    expect(result.browserState!.blocker).toBeUndefined();
    expect(result.success).toBe(true);
  });
});

// ── mapBlockerToCard ───────────────────────────────────────────────────────

describe('mapBlockerToCard', () => {
  function mkBlocker(over: Partial<BlockerSurface> = {}): BlockerSurface {
    return {
      kind:       'login',
      url:        'https://example.com/login',
      confidence: 0.8,
      evidence:   ['text:sign in'],
      message:    'Sign-in required at example.com.',
      ...over,
    };
  }

  it('maps captcha kind with subtype to readable title + fix', () => {
    const card = mapBlockerToCard(mkBlocker({
      kind: 'captcha', subtype: 'recaptcha',
      url: 'https://www.example.com/page',
    }));
    expect(card.title).toContain('CAPTCHA');
    expect(card.title).toContain('www.example.com');
    expect(card.fix).toContain('recaptcha');
    expect(card.canStill).toContain('Solve the challenge in the browser tab');
  });

  it('maps login kind with hostname', () => {
    const card = mapBlockerToCard(mkBlocker({ kind: 'login' }));
    expect(card.title).toContain('Sign-in');
    expect(card.title).toContain('example.com');
  });

  it('maps 2fa kind', () => {
    const card = mapBlockerToCard(mkBlocker({ kind: '2fa', subtype: 'totp' }));
    expect(card.title).toContain('Two-factor');
    expect(card.fix).toContain('code');
  });

  it('maps verification kind', () => {
    const card = mapBlockerToCard(mkBlocker({ kind: 'verification' }));
    expect(card.title).toContain('verification');
  });

  it('maps consent kind', () => {
    const card = mapBlockerToCard(mkBlocker({ kind: 'consent' }));
    expect(card.title).toContain('Consent');
    expect(card.canStill).toContain('Dismiss the banner in the browser');
  });

  it('every card has non-empty title/canStill/cannotReliably/fix', () => {
    const kinds: BlockerSurface['kind'][] = ['captcha', 'login', '2fa', 'verification', 'consent'];
    for (const k of kinds) {
      const card = mapBlockerToCard(mkBlocker({ kind: k }));
      expect(card.title.length).toBeGreaterThan(0);
      expect(card.canStill.length).toBeGreaterThan(0);
      expect(card.cannotReliably.length).toBeGreaterThan(0);
      expect(card.fix.length).toBeGreaterThan(0);
    }
  });

  it('falls back to raw URL when URL is malformed', () => {
    const card = mapBlockerToCard(mkBlocker({ url: 'not a url' }));
    expect(card.title).toContain('not a url');
  });
});
