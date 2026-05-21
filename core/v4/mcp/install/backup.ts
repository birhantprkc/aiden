/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/install/backup.ts — v4.9.0 Slice 2a.
 *
 * Timestamped backup of a third-party client config before Aiden's
 * `init` / `repair` writes to it. Backups are kept indefinitely so
 * a user can recover if Aiden's entry breaks something downstream.
 * Naming: `<configPath>.aiden-backup-YYYYMMDD-HHMMSS`.
 */

import { existsSync, copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Generate a timestamp suffix matching the YYYYMMDD-HHMMSS pattern. */
function nowStamp(date: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Create a backup of `configPath`. Returns the backup path on success,
 * or null if the source doesn't exist (first-time init — nothing to
 * back up). Re-throws fs errors so the caller can abort cleanly.
 */
export function backupConfig(configPath: string, now: Date = new Date()): string | null {
  if (!existsSync(configPath)) return null;
  const backupPath = `${configPath}.aiden-backup-${nowStamp(now)}`;
  copyFileSync(configPath, backupPath);
  return backupPath;
}

/**
 * Count existing backups for a given config path. Used by `doctor`
 * to report backup count + by tests.
 */
export function countBackups(configPath: string): number {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) =>
      f.startsWith(`${base}.aiden-backup-`),
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Find the newest backup matching `<configPath>.aiden-backup-*`.
 * Used by `repair` when restoring from a corrupted edit.
 */
export function findLatestBackup(configPath: string): string | null {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir).filter((f) =>
      f.startsWith(`${base}.aiden-backup-`),
    );
    if (files.length === 0) return null;
    files.sort(); // timestamp suffix sorts lexicographically = newest last
    return path.join(dir, files[files.length - 1]);
  } catch {
    return null;
  }
}
