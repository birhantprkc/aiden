/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 B5.3 — local-first SSRF/navigation guard: secret-bearing-URL redaction +
 * external-secret-URL exfil flag. NOT private-IP blocking — localhost/LAN/dev
 * stay legitimate.
 */
import { describe, it, expect, vi } from 'vitest';
import { isLocalUrl, isSecretBearingUrl, classifyBrowserAction } from '../../../core/v4/browserState';
import { redactBrowserContent } from '../../../tools/v4/browser/redactContent';

describe('isLocalUrl — local-first allowlist (never blocked)', () => {
  it('treats localhost / loopback / LAN / .local / file as local', () => {
    for (const u of [
      'http://localhost:3000/', 'http://127.0.0.1:8080/app', 'http://[::1]/', 'http://dev.local/',
      'http://10.0.0.5/', 'http://192.168.1.20/', 'http://172.16.4.4/', 'http://169.254.1.1/',
      'file:///home/u/page.html', 'http://app.localhost/',
    ]) expect(isLocalUrl(u)).toBe(true);
  });
  it('external hosts are not local', () => {
    for (const u of ['https://example.com/', 'https://evil.attacker.net/?x=1', 'http://8.8.8.8/'])
      expect(isLocalUrl(u)).toBe(false);
  });
});

describe('isSecretBearingUrl', () => {
  it('flags userinfo / cred query params / sk- / Bearer', () => {
    for (const u of [
      'https://x.com/?api_key=ABCDEFGHIJ', 'https://x.com/?access_token=zzz', 'https://x.com/?token=t',
      'https://user:pass@x.com/', 'https://x.com/cb?sig=abc', 'https://x.com/#sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
    ]) expect(isSecretBearingUrl(u)).toBe(true);
  });
  it('plain URLs are not secret-bearing', () => {
    for (const u of ['https://x.com/page', 'https://x.com/?q=hello&page=2', 'http://localhost/?id=5'])
      expect(isSecretBearingUrl(u)).toBe(false);
  });
});

describe('classifyBrowserAction(browser_navigate) — exfil flag, local exempt', () => {
  it('external secret-bearing URL → dangerous (confirm)', () => {
    expect(classifyBrowserAction('browser_navigate', { url: 'https://evil.net/?access_token=stolen123' })?.tier).toBe('dangerous');
  });
  it('LOCAL secret-bearing URL → NOT flagged (dev is legitimate)', () => {
    expect(classifyBrowserAction('browser_navigate', { url: 'http://localhost:3000/?api_key=devkey12345' })).toBeUndefined();
  });
  it('normal external URL → NOT flagged (ordinary browsing)', () => {
    expect(classifyBrowserAction('browser_navigate', { url: 'https://example.com/docs' })).toBeUndefined();
  });
});

describe('redactBrowserContent — secret-bearing URLs', () => {
  it('redacts api_key / access_token / userinfo in URLs', () => {
    expect(redactBrowserContent('see https://x.com/?api_key=secret123abc here')).not.toContain('secret123abc');
    const at = redactBrowserContent('go https://x.com/?access_token=longsecretvalue999');
    expect(at).not.toContain('longsecretvalue999');
    expect(at).toContain('access_token=[REDACTED]');
    expect(redactBrowserContent('https://user:hunter2pass@x.com/')).not.toContain('hunter2pass');
  });
  it('leaves non-secret URLs readable', () => {
    const u = 'Visit https://example.com/?q=balance&page=2 for details';
    expect(redactBrowserContent(u)).toBe(u);
  });
});

// ── Executor + tool integration ──────────────────────────────────────────────

const m = vi.hoisted(() => ({
  pwNavigate: vi.fn(async (url: string) => ({ ok: true, url })),
  pwSnapshot: vi.fn(async () => ({ ok: true, text: 'normal page' })),
  pwSnapshotHash: vi.fn(async () => ({ ok: false })),
  pwSnapshotTabs: vi.fn(async () => ({ ok: false })),
}));
vi.mock('../../../core/playwrightBridge', () => ({
  pwNavigate: m.pwNavigate, pwSnapshot: m.pwSnapshot,
  pwSnapshotHash: m.pwSnapshotHash, pwSnapshotTabs: m.pwSnapshotTabs,
}));
import { browserNavigateTool } from '../../../tools/v4/browser/browserNavigate';

describe('browser_navigate — local-first behaviour', () => {
  it('localhost navigates fine (NOT blocked)', async () => {
    const r = await browserNavigateTool.execute!({ url: 'http://localhost:3000/app' }, {} as never);
    expect(r.success).toBe(true);
    expect(r.url).toBe('http://localhost:3000/app');
  });
  it('secret in the result URL is redacted', async () => {
    m.pwNavigate.mockResolvedValueOnce({ ok: true, url: 'https://x.com/cb?api_key=secret123abc' });
    const r = await browserNavigateTool.execute!({ url: 'https://x.com/cb?api_key=secret123abc' }, {} as never);
    expect(r.success).toBe(true);
    expect(String(r.url)).not.toContain('secret123abc');
  });
});
