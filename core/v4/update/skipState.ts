/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/update/skipState.ts — v4.5 update system.
 *
 * Persistent "user said no thanks to this update" memory. Q-U7(b)
 * semantics: a single `skippedVersion` slot meaning "stop nagging
 * about THIS version; resume when something newer ships."
 *
 *   Store: 4.5.1     → prompt for 4.5.1 suppressed
 *                       prompt for 4.5.2 fires (4.5.2 > 4.5.1)
 *
 * Per-version-list (skip multiple specific versions) is v4.6
 * polish if real usage shows people want it.
 *
 * Storage: piggyback on the existing `.update_check.json` cache so
 * we don't add a second dotfile. The cache file already lives at
 * `<aiden-home>/.update_check.json` (created by checkUpdate.ts).
 *
 * Pure module — every function takes the cache content as input
 * and returns the new content. The actual disk read/write stays
 * inside checkUpdate.ts to keep one source of truth for the cache
 * lifecycle.
 */

import { compareVersions } from './checkUpdate';

/** Cache shape augmented with the v4.5 skipped-version slot. */
export interface SkipAwareCache {
  ts:              number;
  latest:          string | null;
  installed:       string;
  releaseUrl?:     string;
  releaseNotes?:   string;
  /** v4.5 — user typed 'n' on this version → suppress until newer ships. */
  skippedVersion?: string;
}

/**
 * Is `latest` suppressed by the user's prior skip choice?
 *
 *   skip empty           → never suppress
 *   skip = latest        → suppress
 *   skip < latest        → don't suppress (newer version available)
 *   skip > latest        → suppress (defensive — user already passed
 *                          this version; treat as still-skipped)
 *
 * Returns false when either input is empty/unparseable — never
 * silently swallow a "should-have-prompted".
 */
export function isVersionSkipped(
  skippedVersion: string | undefined | null,
  latest:         string | null | undefined,
): boolean {
  if (!skippedVersion || !latest) return false;
  try {
    const cmp = compareVersions(skippedVersion, latest);
    return cmp >= 0;
  } catch {
    // Unparseable version on either side → fail safe to "not skipped"
    // so the user gets the prompt rather than silent suppression.
    return false;
  }
}

/**
 * Update the cache content with a fresh skipped version. Pure —
 * caller persists.
 */
export function applySkip(
  cache:   SkipAwareCache,
  version: string,
): SkipAwareCache {
  return { ...cache, skippedVersion: version };
}

/**
 * Clear the skipped-version slot — user typed `/update auto on` or
 * explicitly opted back in. Pure.
 */
export function clearSkip(cache: SkipAwareCache): SkipAwareCache {
  const next: SkipAwareCache = { ...cache };
  delete next.skippedVersion;
  return next;
}
