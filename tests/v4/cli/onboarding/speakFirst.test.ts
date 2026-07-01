/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 — speaks-first onboarding trigger guard + idempotency.
 *
 * The load-bearing rule (same bug class as the wizard config-detection fix):
 * onboard ONLY a brand-new user — marker absent AND USER.md empty — and
 * NEVER re-onboard an existing user (marker present OR non-empty USER.md).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  shouldOnboard,
  renderOnboardingIntro,
  isOnboardingShown,
  resetOnboarding,
} from '../../../../cli/v4/onboarding/speakFirst';
import { resolveAidenPaths, type AidenPaths } from '../../../../core/v4/paths';

let tmp: string;
let paths: AidenPaths;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-onboard-'));
  paths = resolveAidenPaths({ rootOverride: tmp });
  await fs.mkdir(path.dirname(paths.userMd), { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** TTY out stub capturing writes. */
function ttyOut(isTTY = true): { out: NodeJS.WriteStream; text: () => string } {
  const chunks: string[] = [];
  const out = {
    isTTY,
    write(s: string): boolean { chunks.push(s); return true; },
  } as unknown as NodeJS.WriteStream;
  return { out, text: () => chunks.join('') };
}

describe('shouldOnboard — trigger guard', () => {
  it('true for a brand-new user: no marker, no USER.md', async () => {
    expect(await shouldOnboard(paths)).toBe(true);
  });

  it('false once the marker exists (already onboarded)', async () => {
    await fs.writeFile(path.join(tmp, '.onboarding-shown'), '2026-01-01T00:00:00Z\n');
    expect(await shouldOnboard(paths)).toBe(false);
  });

  it('false when USER.md is non-empty (existing user — never re-onboard)', async () => {
    await fs.writeFile(paths.userMd, 'Name: Shiva\nWorks on: dev tools\n', 'utf8');
    expect(await shouldOnboard(paths)).toBe(false);
  });

  it('true when USER.md exists but is whitespace-only', async () => {
    await fs.writeFile(paths.userMd, '   \n\n', 'utf8');
    expect(await shouldOnboard(paths)).toBe(true);
  });
});

describe('renderOnboardingIntro', () => {
  it('brand-new + TTY: paints the utility-framed intro and writes the marker', async () => {
    const { out, text } = ttyOut(true);
    const fired = await renderOnboardingIntro({ paths, out });
    expect(fired).toBe(true);
    const t = text();
    expect(t).toMatch(/I'll work better if I know a bit about you/);
    expect(t).toMatch(/What should I call you, and what are you working on\?/);
    // Personalization, not companionship — no feelings/intimacy framing.
    expect(t).not.toMatch(/feel|miss you|love|lonely|friend/i);
    expect(await isOnboardingShown(paths)).toBe(true);
  });

  it('idempotent: second call does not fire (marker written on first)', async () => {
    const a = await renderOnboardingIntro({ paths, out: ttyOut().out });
    const b = await renderOnboardingIntro({ paths, out: ttyOut().out });
    expect(a).toBe(true);
    expect(b).toBe(false);
  });

  it('non-TTY: never paints (no interactive reply to extract)', async () => {
    const { out, text } = ttyOut(false);
    expect(await renderOnboardingIntro({ paths, out })).toBe(false);
    expect(text()).toBe('');
    // marker NOT written, so a later TTY boot can still onboard.
    expect(await isOnboardingShown(paths)).toBe(false);
  });

  it('existing user (non-empty USER.md): never paints', async () => {
    await fs.writeFile(paths.userMd, 'Name: Shiva\n', 'utf8');
    const { out, text } = ttyOut(true);
    expect(await renderOnboardingIntro({ paths, out })).toBe(false);
    expect(text()).toBe('');
  });

  it('resetOnboarding clears the marker so it can fire again', async () => {
    await renderOnboardingIntro({ paths, out: ttyOut().out });
    expect(await resetOnboarding(paths)).toBe(true);
    expect(await shouldOnboard(paths)).toBe(true);
  });
});
