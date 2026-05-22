/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/incarnationStore.ts — v4.9.0 Slice 4.
 *
 * Thin DDL wrapper around the `daemon_incarnations` table (schema v8).
 * Three operations:
 *
 *   1. `insertIncarnation()` — boot. Writes one row with `started_at`
 *      = now ISO. Idempotent on PRIMARY KEY collision (safe re-call).
 *   2. `markEnded()` — clean shutdown. Patches `ended_at`, `exit_reason`,
 *      `exit_code` for this incarnation. No-op when the row is missing
 *      (defensive — e.g. SQLite died before insert).
 *   3. `lastForDaemon()` — diagnostic. Returns the most recent row for
 *      a given daemon_id. Used by `aiden doctor`-style surfaces (not
 *      wired in this slice).
 */

import type { Db } from './db/connection';

export type IncarnationExitReason = 'clean' | 'sigterm' | 'sigint' | 'crash' | 'unknown';

export interface IncarnationRow {
  incarnation_id: string;
  daemon_id:      string;
  pid:            number;
  started_at:     string;
  ended_at:       string | null;
  exit_reason:    IncarnationExitReason | null;
  exit_code:      number | null;
  aiden_version:  string | null;
  node_version:   string | null;
}

export interface InsertIncarnationOptions {
  incarnationId: string;
  daemonId:      string;
  pid:           number;
  aidenVersion:  string;
  nodeVersion:   string;
  /** Test seam — defaults to `new Date().toISOString()`. */
  startedAt?:    string;
}

export function insertIncarnation(db: Db, opts: InsertIncarnationOptions): void {
  const started = opts.startedAt ?? new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO daemon_incarnations
       (incarnation_id, daemon_id, pid, started_at, aiden_version, node_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.incarnationId,
    opts.daemonId,
    opts.pid,
    started,
    opts.aidenVersion,
    opts.nodeVersion,
  );
}

export interface MarkEndedOptions {
  incarnationId: string;
  exitReason:    IncarnationExitReason;
  exitCode:      number;
  /** Test seam. */
  endedAt?:      string;
}

export function markEnded(db: Db, opts: MarkEndedOptions): void {
  const ended = opts.endedAt ?? new Date().toISOString();
  db.prepare(
    `UPDATE daemon_incarnations
        SET ended_at    = COALESCE(ended_at, ?),
            exit_reason = COALESCE(exit_reason, ?),
            exit_code   = COALESCE(exit_code, ?)
      WHERE incarnation_id = ?`,
  ).run(ended, opts.exitReason, opts.exitCode, opts.incarnationId);
}

export function lastForDaemon(db: Db, daemonId: string): IncarnationRow | null {
  const r = db.prepare(
    `SELECT * FROM daemon_incarnations
      WHERE daemon_id = ?
      ORDER BY started_at DESC
      LIMIT 1`,
  ).get(daemonId) as IncarnationRow | undefined;
  return r ?? null;
}
