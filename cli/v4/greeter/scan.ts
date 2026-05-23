/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/greeter/scan.ts — v4.9.3 SLICE 1a.
 *
 * Four scanners feed `ScanResult`. None spawn subprocesses, none hit
 * the network, none scan large files. Total cost target: < 20ms on
 * a warm cache, < 50ms cold.
 *
 *   • scanTimeOfDay      — local hour from `now` (cheapest; no IO)
 *   • scanCwd            — cwd vs history.lastCwd (no IO)
 *   • scanLastSessionEnd — mtime of newest distillation file
 *   • scanUpdate         — reads existing `.update_check.json` cache
 *                          (populated by core/v4/update/checkUpdate.ts);
 *                          DOES NOT hit the npm registry itself —
 *                          consumes the existing background check.
 *
 * Git observations are deferred to v4.10 per Phase A decision.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AidenPaths } from '../../../core/v4/paths';
import type { GreeterHistory, ScanResult } from './types';

export interface ScanInput {
  paths:    AidenPaths;
  cwd:      string;
  now:      Date;
  /** Currently-running Aiden version (for the update comparison). */
  version:  string;
  history:  GreeterHistory;
  /** Test seam — defaults to node:fs.promises. */
  fsImpl?:  typeof fs;
}

/**
 * Run all four scanners and aggregate. Pure with respect to its
 * `now` / `cwd` / `version` parameters — given identical inputs and
 * identical disk state, produces identical output. The orchestrator
 * supplies these explicitly so tests can drive them deterministically.
 */
export async function runScans(input: ScanInput): Promise<ScanResult> {
  const fsImpl = input.fsImpl ?? fs;
  const [hoursSinceLastSession, update] = await Promise.all([
    scanLastSessionEnd(input.paths, input.now, fsImpl),
    scanUpdate(input.paths, input.version, fsImpl),
  ]);
  return {
    hourOfDay:             input.now.getHours(),
    cwdChanged:            scanCwd(input.cwd, input.history),
    cwd:                   input.cwd,
    hoursSinceLastSession,
    update,
  };
}

// ── Individual scanners — exported for fine-grained unit tests --------

/** True iff cwd differs from history.lastCwd. False when history has no
 *  prior cwd (treats first-seen-cwd as "not changed"). */
export function scanCwd(cwd: string, history: GreeterHistory): boolean {
  if (!history.lastCwd) return false;
  return path.resolve(history.lastCwd) !== path.resolve(cwd);
}

/**
 * Hours since the most recent distillation file (mtime). Returns null
 * when the distillations directory is missing or empty — caller treats
 * null as "no prior session to remember".
 *
 * Reads directory entries, takes the newest mtime, returns elapsed
 * hours rounded to nearest int. Hard-caps at 100 entries scanned —
 * if the user has thousands of distillations the cost stays bounded
 * (we only care about the newest; sorting is fine on 100 entries).
 */
export async function scanLastSessionEnd(
  paths:  AidenPaths,
  now:    Date,
  fsImpl: typeof fs = fs,
): Promise<number | null> {
  const dir = path.join(paths.root, 'distillations');
  let entries: string[];
  try {
    entries = await fsImpl.readdir(dir);
  } catch {
    return null;  // dir missing → no prior session
  }
  if (entries.length === 0) return null;
  // Cap at 100 — newest-mtime extraction; we only need the max.
  const scanList = entries.slice(0, 100);
  let newest = 0;
  for (const e of scanList) {
    try {
      const st = await fsImpl.stat(path.join(dir, e));
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch { /* skip unreadable entry */ }
  }
  if (newest === 0) return null;
  const elapsedMs = now.getTime() - newest;
  return Math.max(0, Math.round(elapsedMs / (1000 * 60 * 60)));
}

/**
 * Read the existing update-status cache (written by the background
 * checkUpdate flow). Returns the update info when `latest > installed`,
 * null otherwise. NEVER hits the network — the greeter consumes
 * whatever the boot-time update-check already cached.
 *
 * Cache shape (per core/v4/update/checkUpdate.ts contract):
 *   { latest: string, lastCheckedAt: string, ... }
 * We read minimally — just `latest`. If parsing fails, return null
 * (don't speculate about an update we can't confirm).
 */
export async function scanUpdate(
  paths:   AidenPaths,
  version: string,
  fsImpl:  typeof fs = fs,
): Promise<{ latest: string; installed: string } | null> {
  const cachePath = path.join(paths.root, '.update_check.json');
  try {
    const raw = await fsImpl.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as { latest?: string };
    if (!parsed.latest || typeof parsed.latest !== 'string') return null;
    if (!isNewer(parsed.latest, version)) return null;
    return { latest: parsed.latest, installed: version };
  } catch {
    return null;
  }
}

/** Returns true iff `a > b` under dot-numeric semver. Local copy so
 *  scan has no dependency on history's identical helper. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((s) => Number(s) || 0);
  const pb = b.split('.').map((s) => Number(s) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}
