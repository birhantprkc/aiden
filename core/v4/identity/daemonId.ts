/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/identity/daemonId.ts — v4.9.0 Slice 4.
 *
 * The `daemonId` is the *persistent* identity of an Aiden install. It
 * survives daemon restarts, schema migrations, and crashes — only a
 * hard reset (deleting the file) gives a new identity. Each daemon
 * process gets a fresh `incarnationId` per boot; the pair (daemon,
 * incarnation) is what callers correlate against.
 *
 * Storage: a single-line file at `<aidenRoot>/daemon/daemon_id`. The
 * file's content is exactly the ID string (e.g. `dmn_<32-hex>\n`).
 *
 * Atomic write semantics: tmp + rename. SQLite-style — if the rename
 * crashes mid-flight the prior file is untouched. We don't fsync the
 * containing directory (Windows doesn't support directory fsync via
 * Node, and our acceptable failure mode is "one boot might generate a
 * new id"; the next boot picks up the persisted one).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, fsyncSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';

import { newDaemonId, parseId } from './ids';

/** Filesystem path the daemon id lives at, given an aiden root. */
export function daemonIdFilePath(aidenRoot: string): string {
  return path.join(aidenRoot, 'daemon', 'daemon_id');
}

/**
 * Read the persisted daemon id, or generate + write a fresh one on
 * first boot. Returns the canonical `dmn_<hex>` string.
 *
 * Defensive: if the file exists but is unparseable (corrupted /
 * truncated), we treat it as missing and write a new one. The old
 * content is saved to `daemon_id.broken-<ts>` for postmortem.
 */
export function loadOrCreateDaemonId(aidenRoot: string): string {
  const filePath = daemonIdFilePath(aidenRoot);
  const dir = path.dirname(filePath);
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8').trim();
      const parsed = parseId(raw);
      if (parsed && parsed.prefix === 'dmn') {
        return raw;
      }
      // Corrupted — quarantine + fall through to regenerate.
      try { renameSync(filePath, `${filePath}.broken-${Date.now()}`); }
      catch { /* best effort */ }
    } catch {
      /* permission / IO — fall through to regenerate */
    }
  }
  // Generate + persist atomically.
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const id = newDaemonId();
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* fsync best-effort */ }
  renameSync(tmp, filePath);
  return id;
}
