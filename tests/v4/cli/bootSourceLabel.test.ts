import { describe, it, expect } from 'vitest';
import { bootSourceLabel } from '../../../cli/v4/chatSession';

/**
 * v4.1.3-prebump: bootSourceLabel renders the dim source-annotation
 * line under the boot card's status pills. Maps providerBootSelector
 * precedence-case labels to human-readable text — null for the cases
 * where the source isn't surprising (explicit CLI override).
 */

describe('bootSourceLabel', () => {
  it('persisted-config: surfaces a /model hint so users know they can change it', () => {
    const s = bootSourceLabel('persisted-config');
    expect(s).toBeTruthy();
    expect(s!).toMatch(/persisted/i);
    expect(s!).toContain('/model');
  });

  it('auto-priority: labels as "auto-picked"', () => {
    const s = bootSourceLabel('auto-priority');
    expect(s).toBeTruthy();
    expect(s!).toMatch(/auto/i);
  });

  it('config-partial: documents that the companion was auto-resolved', () => {
    const s = bootSourceLabel('config-partial');
    expect(s).toBeTruthy();
    expect(s!).toMatch(/partial|auto.?resolved/i);
  });

  it('hardcoded-fallback: clearly states no authed providers', () => {
    const s = bootSourceLabel('hardcoded-fallback');
    expect(s).toBeTruthy();
    expect(s!).toMatch(/no authed/i);
  });

  it('cli-flag: returns null (explicit override needs no annotation)', () => {
    expect(bootSourceLabel('cli-flag')).toBeNull();
  });

  it('cli-flag-partial: returns null (still an explicit user choice)', () => {
    expect(bootSourceLabel('cli-flag-partial')).toBeNull();
  });

  it('undefined source: returns null gracefully', () => {
    expect(bootSourceLabel(undefined)).toBeNull();
  });
});
