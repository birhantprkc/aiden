/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/onboarding/speakFirst.ts — v4.12 speaks-first onboarding.
 *
 * For a BRAND-NEW user, Aiden opens the first REPL session with a short,
 * utility-framed intro asking their name + what they're working on. The
 * user's reply is then honestly extracted into the existing USER.md store
 * (the model saves ONLY stated facts via memory_add(file:'user'); the
 * extraction nudge lives in core/v4/promptBuilder.ts, gated on an empty
 * USER.md). USER.md is already injected into context every turn, so from
 * the next session on, Aiden knows the user.
 *
 * Personalization, NOT companionship: the copy is warm-but-professional —
 * a good colleague's first hello — framed around working better together,
 * never emotional/intimacy framing. Stored facts are work-relevant
 * (name, projects, conventions), never feelings.
 *
 * Trigger guard (same bug class as the wizard config-detection fix):
 * onboard ONLY when the marker is absent AND USER.md is empty. An existing
 * user (marker present OR a non-empty USER.md) is NEVER re-onboarded.
 * Mirrors the firstRunHint marker-idempotency pattern.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { c } from '../../../core/v4/ui/theme';
import type { AidenPaths } from '../../../core/v4/paths';

const MARKER_NAME = '.onboarding-shown';

export interface OnboardingOptions {
  paths:  AidenPaths;
  out?:   NodeJS.WriteStream;
  /** Injectable fs for tests. */
  fsImpl?: typeof fs;
}

function markerPath(paths: AidenPaths): string {
  return path.join(paths.root, MARKER_NAME);
}

/** True when the onboarding marker exists (already onboarded). */
export async function isOnboardingShown(paths: AidenPaths, fsImpl: typeof fs = fs): Promise<boolean> {
  try {
    await fsImpl.access(markerPath(paths));
    return true;
  } catch {
    return false;
  }
}

/** USER.md empty or missing → the user has no stored profile yet. */
async function isUserProfileEmpty(paths: AidenPaths, fsImpl: typeof fs = fs): Promise<boolean> {
  try {
    const txt = await fsImpl.readFile(paths.userMd, 'utf8');
    return txt.trim().length === 0;
  } catch {
    return true;   // missing file = empty profile
  }
}

/**
 * Onboard ONLY a brand-new user: marker absent AND USER.md empty. Never
 * re-onboards (marker present) and never onboards a user who already has a
 * profile (non-empty USER.md) — the trigger guard that keeps this off the
 * config-detection-bug class.
 */
export async function shouldOnboard(paths: AidenPaths, fsImpl: typeof fs = fs): Promise<boolean> {
  if (await isOnboardingShown(paths, fsImpl)) return false;
  return isUserProfileEmpty(paths, fsImpl);
}

/** Write the marker so onboarding fires exactly once. Best-effort. */
export async function markOnboardingShown(paths: AidenPaths, fsImpl: typeof fs = fs): Promise<void> {
  try {
    await fsImpl.mkdir(paths.root, { recursive: true });
    await fsImpl.writeFile(markerPath(paths), new Date().toISOString() + '\n', { encoding: 'utf8' });
  } catch {
    // best-effort — a missed write only means the intro may show once more.
  }
}

/**
 * Aiden speaks first for a brand-new user. Returns true when the intro was
 * painted (so the caller can skip the /walkthrough tip to avoid clutter).
 * Mark-on-render + idempotent: paints at most once, never for an existing
 * user, and never on a non-TTY caller (no interactive reply to extract).
 */
export async function renderOnboardingIntro(opts: OnboardingOptions): Promise<boolean> {
  const out    = opts.out ?? process.stdout;
  const fsImpl = opts.fsImpl ?? fs;
  if (!out.isTTY) return false;
  if (!(await shouldOnboard(opts.paths, fsImpl))) return false;

  // Utility-framed, warm-but-professional. No feelings/intimacy framing.
  const intro = [
    '',
    `  ${c.accent("Hi — I'm Aiden.")} ${c.muted("I'll work better if I know a bit about you.")}`,
    `  ${c.muted('What should I call you, and what are you working on?')}`,
    '',
  ].join('\n');
  out.write(intro + '\n');
  await markOnboardingShown(opts.paths, fsImpl);
  return true;
}

/** Test/debug — remove the marker so onboarding can fire again. */
export async function resetOnboarding(paths: AidenPaths, fsImpl: typeof fs = fs): Promise<boolean> {
  try {
    await fsImpl.unlink(markerPath(paths));
    return true;
  } catch {
    return false;
  }
}
