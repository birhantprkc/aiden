/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 B5.1 — secrets-never-in-model: browser-content redaction (reusing the
 * existing redactors) + untrusted-content fencing, applied at the browser_extract
 * and browser_snapshot egress boundaries.
 */
import { describe, it, expect, vi } from 'vitest';
import { redactBrowserContent, fenceUntrusted, sanitizeExtracted } from '../../../tools/v4/browser/redactContent';

describe('redactBrowserContent — reuses existing patterns', () => {
  it('redacts credential-shaped substrings (sk-ant / Bearer / api_key= / password=)', () => {
    const inp = 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA and Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 and api_key=ABCDEFGHIJKLMNOPQRSTUV and password=SuperSecretValue1234';
    const out = redactBrowserContent(inp);
    expect(out).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(out).not.toMatch(/Bearer abcdefghijklmnopqrstuvwxyz0123/);
    expect(out).not.toContain('ABCDEFGHIJKLMNOPQRSTUV');
    expect(out).not.toContain('SuperSecretValue1234');
    expect(out).toMatch(/REDACTED/);
  });
  it('also catches AWS / GitHub keys (logger/redact patterns)', () => {
    const out = redactBrowserContent('aws AKIAIOSFODNN7EXAMPLE and gh ghp_0123456789012345678901234567890123456');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('ghp_0123456789012345678901234567890123456');
  });
  it('leaves normal prose untouched and readable', () => {
    const prose = 'Welcome to Acme Bank. Sign in to view your account balance and recent transactions.';
    expect(redactBrowserContent(prose)).toBe(prose);
  });
  it('empty string is a no-op', () => {
    expect(redactBrowserContent('')).toBe('');
  });
});

describe('fenceUntrusted', () => {
  it('wraps content with data-not-instructions markers', () => {
    const out = fenceUntrusted('hello world');
    expect(out).toMatch(/untrusted page content/i);
    expect(out).toMatch(/DATA, not instructions/i);
    expect(out).toContain('hello world');
    expect(out).toMatch(/end of untrusted page content/i);
  });
});

describe('sanitizeExtracted — redact then fence', () => {
  it('redacts secrets AND fences, keeping normal text readable', () => {
    const out = sanitizeExtracted('Balance page. Token: sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(out).not.toContain('sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(out).toMatch(/untrusted page content/i);
    expect(out).toContain('Balance page.'); // prose preserved
  });
});

// ── Egress boundary: the tools apply sanitizeExtracted before returning ──────

const m = vi.hoisted(() => ({
  pwSnapshot: vi.fn(async () => ({ ok: true, text: 'Hello. Secret sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQ here.' })),
  pwAxSnapshot: vi.fn(async () => ({ ok: true, url: 'http://x', elements: [
    { tag: 'button', roleAttr: '', inputType: '', ariaLabel: 'token sk-ant-api03-WWWWWWWWWWWWWWWWWWWWWWWW', labelledByText: '', textContent: '', placeholder: '', alt: '', title: '', css_path: '#b', bbox: { x: 0, y: 0, w: 1, h: 1 }, frame_id: 'main', submit: false },
  ] })),
  pwSnapshotHash: vi.fn(async () => ({ ok: false })),
  pwSnapshotTabs: vi.fn(async () => ({ ok: false })),
}));
vi.mock('../../../core/playwrightBridge', () => ({
  pwSnapshot: m.pwSnapshot, pwAxSnapshot: m.pwAxSnapshot,
  pwSnapshotHash: m.pwSnapshotHash, pwSnapshotTabs: m.pwSnapshotTabs,
  // B4.2a — browser_snapshot now surfaces dialog/file-event state.
  pwDialogPending: () => null, pwDialogRecent: () => [], pwFileEvents: () => [],
}));

import { browserExtractTool } from '../../../tools/v4/browser/browserExtract';
import { browserSnapshotTool } from '../../../tools/v4/browser/browserSnapshot';

describe('browser_extract — sanitized egress', () => {
  it('redacts secrets + fences the extracted text in the tool result', async () => {
    const r = await browserExtractTool.execute!({}, {} as never);
    expect(r.success).toBe(true);
    expect(r.text).not.toContain('sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQ'); // redacted
    expect(r.text).toMatch(/untrusted page content/i);                    // fenced
    expect(r.text).toContain('Hello.');                                    // prose kept
  });
});

describe('browser_snapshot — sanitized egress (names redacted, refs intact)', () => {
  it('redacts secret-bearing element names but keeps the @eN ref usable', async () => {
    const r = await browserSnapshotTool.execute!({}, {} as never);
    expect(r.success).toBe(true);
    expect(r.snapshot).not.toContain('sk-ant-api03-WWWWWWWWWWWWWWWWWWWWWWWW'); // name redacted
    expect(r.snapshot).toContain('@e1');                                        // ref preserved for acting
    expect(r.snapshot).toMatch(/untrusted page content/i);                      // fenced
  });
});
