/**
 * v4.5 update system — skipState pure logic tests.
 */
import { describe, it, expect } from 'vitest';
import {
  isVersionSkipped,
  applySkip,
  clearSkip,
  type SkipAwareCache,
} from '../../../../core/v4/update/skipState';

function mkCache(over: Partial<SkipAwareCache> = {}): SkipAwareCache {
  return { ts: 0, latest: null, installed: '4.5.0', ...over };
}

describe('isVersionSkipped — semver-aware suppression', () => {
  it('returns false when skipped is empty/undefined', () => {
    expect(isVersionSkipped(undefined, '4.5.1')).toBe(false);
    expect(isVersionSkipped('', '4.5.1')).toBe(false);
  });

  it('returns false when latest is empty/null', () => {
    expect(isVersionSkipped('4.5.1', null)).toBe(false);
    expect(isVersionSkipped('4.5.1', undefined)).toBe(false);
  });

  it('returns true when skipped >= latest (exact match)', () => {
    expect(isVersionSkipped('4.5.1', '4.5.1')).toBe(true);
  });

  it('returns true when skipped > latest (defensive)', () => {
    expect(isVersionSkipped('4.5.2', '4.5.1')).toBe(true);
  });

  it('returns false when skipped < latest (newer version available)', () => {
    expect(isVersionSkipped('4.5.0', '4.5.1')).toBe(false);
    expect(isVersionSkipped('4.5.1', '4.6.0')).toBe(false);
  });

  it('returns false on unparseable input (fail safe to prompt)', () => {
    expect(isVersionSkipped('not-a-version', '4.5.1')).toBe(false);
    expect(isVersionSkipped('4.5.1', 'also-bad')).toBe(false);
  });
});

describe('applySkip + clearSkip — cache mutators', () => {
  it('applySkip sets skippedVersion without touching other fields', () => {
    const before = mkCache({ ts: 123, latest: '4.5.1', releaseNotes: 'note' });
    const after  = applySkip(before, '4.5.1');
    expect(after.skippedVersion).toBe('4.5.1');
    expect(after.ts).toBe(123);
    expect(after.latest).toBe('4.5.1');
    expect(after.releaseNotes).toBe('note');
  });

  it('clearSkip removes the field entirely', () => {
    const before = mkCache({ skippedVersion: '4.5.1', releaseUrl: 'http://x' });
    const after  = clearSkip(before);
    expect(after.skippedVersion).toBeUndefined();
    expect(after.releaseUrl).toBe('http://x');
  });

  it('applySkip is pure — does not mutate the input', () => {
    const before = mkCache();
    const after  = applySkip(before, '4.5.1');
    expect(before.skippedVersion).toBeUndefined();
    expect(after.skippedVersion).toBe('4.5.1');
    expect(before).not.toBe(after);
  });
});
