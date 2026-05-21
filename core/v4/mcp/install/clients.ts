/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/install/clients.ts — v4.9.0 Slice 2a.
 *
 * Single per-client adapter exposing read / write / install /
 * uninstall helpers above the path + JSONC primitives. Claude Desktop
 * and Cursor share most of the install flow; only the on-disk format
 * (`json` vs `jsonc`) and the per-OS path differ — both already
 * captured in `clientPaths.ts`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  resolveClientPath,
  type ClientId,
  type ClientPathResolution,
} from './clientPaths';
import {
  mergeAidenEntry,
  readAidenEntry,
  buildAidenEntryObject,
  emptyConfig,
  type AidenEntry,
} from './jsoncMerge';
import { backupConfig } from './backup';

export interface InstallOptions {
  /** Command to spawn (e.g. `aiden`, or `wsl.exe`). */
  command: string;
  /** Args to pass (e.g. `['mcp','serve']`). */
  args: string[];
  /** Env vars to forward (will be `${VAR}` placeholders). */
  envKeys?: string[];
  /** Path-resolution overrides (tests). */
  pathOverride?: ClientPathResolution;
}

export interface InstallResult {
  /** Outcome: 'written' (file changed), 'noop' (already correct), 'error'. */
  outcome: 'written' | 'noop' | 'error';
  /** Resolved config path. */
  configPath: string;
  /** Backup file path created before the write, or null. */
  backupPath: string | null;
  /** Error message when outcome === 'error'. */
  error?: string;
}

/**
 * Read the current Aiden entry from a client's config. Returns null
 * when the file doesn't exist OR the entry is absent.
 */
export function readClient(clientId: ClientId, override?: ClientPathResolution): {
  resolution: ClientPathResolution;
  entry:      AidenEntry | null;
  exists:     boolean;
  text:       string | null;
} {
  const resolution = override ?? resolveClientPath(clientId);
  if (!existsSync(resolution.configPath)) {
    return { resolution, entry: null, exists: false, text: null };
  }
  const text = readFileSync(resolution.configPath, 'utf8');
  return { resolution, entry: readAidenEntry(text), exists: true, text };
}

/**
 * Compute the new file content without writing. Used by `--dry-run`.
 * Returns null when the parent directory doesn't exist (client not
 * installed); caller surfaces this as a user-facing error.
 */
export function planInstall(
  clientId: ClientId,
  opts:     InstallOptions,
): { resolution: ClientPathResolution; newText: string; parentMissing: boolean } | null {
  const resolution = opts.pathOverride ?? resolveClientPath(clientId);
  if (!existsSync(resolution.parentDir)) {
    return { resolution, newText: '', parentMissing: true };
  }
  const existingText = existsSync(resolution.configPath)
    ? readFileSync(resolution.configPath, 'utf8')
    : emptyConfig(resolution.format);
  const entry = buildAidenEntryObject({
    command:  opts.command,
    args:     opts.args,
    envKeys:  opts.envKeys,
  });
  const newText = mergeAidenEntry(existingText, entry, resolution.format);
  return { resolution, newText, parentMissing: false };
}

/**
 * Atomic write: tmp file → rename. Caller has already backed up the
 * original via `backupConfig`.
 */
function atomicWrite(filepath: string, content: string): void {
  const dir = path.dirname(filepath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filepath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filepath);
}

/**
 * Full install flow: backup → merge → atomic write. Skips the write
 * (and skips creating a backup) when the existing entry already
 * matches the canonical form.
 */
export function installClient(clientId: ClientId, opts: InstallOptions): InstallResult {
  const planned = planInstall(clientId, opts);
  if (!planned) {
    return {
      outcome:    'error',
      configPath: '',
      backupPath: null,
      error:      `Could not resolve config path for ${clientId}`,
    };
  }
  if (planned.parentMissing) {
    return {
      outcome:    'error',
      configPath: planned.resolution.configPath,
      backupPath: null,
      error:      `${planned.resolution.displayName} not installed (parent dir ${planned.resolution.parentDir} missing).`,
    };
  }
  // Idempotency: if the file already exists and its content is byte-
  // identical to what we'd write, skip with no backup churn.
  if (existsSync(planned.resolution.configPath)) {
    const currentText = readFileSync(planned.resolution.configPath, 'utf8');
    if (currentText === planned.newText) {
      return {
        outcome:    'noop',
        configPath: planned.resolution.configPath,
        backupPath: null,
      };
    }
  }
  let backupPath: string | null = null;
  try {
    backupPath = backupConfig(planned.resolution.configPath);
    atomicWrite(planned.resolution.configPath, planned.newText);
    return {
      outcome:    'written',
      configPath: planned.resolution.configPath,
      backupPath,
    };
  } catch (err) {
    return {
      outcome:    'error',
      configPath: planned.resolution.configPath,
      backupPath,
      error:      (err as Error).message,
    };
  }
}
