/**
 * v4.5 update system — registry client (npm + GitHub) tests.
 */
import { describe, it, expect } from 'vitest';
import {
  fetchUpdateInfo,
  firstLineOf,
} from '../../../../core/v4/update/registryClient';

describe('fetchUpdateInfo — dual-source probe', () => {
  it('returns both probe + notes when both succeed', async () => {
    const r = await fetchUpdateInfo({
      npmFetch:    async () => ({ version: '4.5.1', tarballUrl: 'https://x' }),
      githubFetch: async () => ({ tag: 'v4.5.1', url: 'https://gh/r', blurb: 'shiny new bits' }),
    });
    expect(r.probe?.version).toBe('4.5.1');
    expect(r.notes?.tag).toBe('v4.5.1');
    expect(r.notes?.blurb).toBe('shiny new bits');
  });

  it('returns probe only when GitHub fails', async () => {
    const r = await fetchUpdateInfo({
      npmFetch:    async () => ({ version: '4.5.1' }),
      githubFetch: async () => { throw new Error('rate-limited'); },
    });
    expect(r.probe?.version).toBe('4.5.1');
    expect(r.notes).toBeNull();
  });

  it('returns notes only when npm fails (rare)', async () => {
    const r = await fetchUpdateInfo({
      npmFetch:    async () => { throw new Error('registry down'); },
      githubFetch: async () => ({ tag: 'v4.5.1', url: '', blurb: 'b' }),
    });
    expect(r.probe).toBeNull();
    expect(r.notes?.tag).toBe('v4.5.1');
  });

  it('returns both null when both fail (offline)', async () => {
    const r = await fetchUpdateInfo({
      npmFetch:    async () => { throw new Error('DNS fail'); },
      githubFetch: async () => { throw new Error('DNS fail'); },
    });
    expect(r.probe).toBeNull();
    expect(r.notes).toBeNull();
  });

  it('handles null-returning fetchers (non-throw failure shape)', async () => {
    const r = await fetchUpdateInfo({
      npmFetch:    async () => null,
      githubFetch: async () => null,
    });
    expect(r.probe).toBeNull();
    expect(r.notes).toBeNull();
  });
});

describe('firstLineOf — release-blurb extractor', () => {
  it('returns first non-blank, non-heading line', () => {
    expect(firstLineOf('## What\'s new\n\nFixed IMAP reconnect.\n\nDetails…', 120))
      .toBe('Fixed IMAP reconnect.');
  });

  it('truncates with ellipsis when over maxChars', () => {
    const long = 'x'.repeat(200);
    const out = firstLineOf(long, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty string when input is empty or all-headings', () => {
    expect(firstLineOf('', 120)).toBe('');
    expect(firstLineOf('# Heading only', 120)).toBe('');
  });
});
