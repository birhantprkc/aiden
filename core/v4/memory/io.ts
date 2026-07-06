/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/memory/io.ts — the single UTF-8 doorway for memory-file I/O.
 *
 * Every read/write of a memory file (MEMORY.md / USER.md / PROJECT.md, their
 * backups, the pending-review block, and the Obsidian vault export) goes through
 * here so the encoding is ALWAYS explicit UTF-8 and can never silently drift to
 * the platform default (CP1252 on Windows), which is what would double-encode
 * `§` → `Â§` and smart quotes → `â€œ`. This is preventive: no current caller was
 * wrong, but this makes it impossible for a future one to be.
 *
 * Writes route through `writeFileVerified` (the shared atomic + read-back
 * verified choke-point), so a memory write is crash-safe AND confirmed on disk.
 */

import { promises as fs } from 'node:fs';
import { writeFileVerified } from '../writeFileVerified';

/**
 * Read a memory file as UTF-8. A missing file resolves to '' (the contract every
 * memory reader already relied on); any other error propagates.
 */
export async function readMemoryFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Write a memory file as UTF-8, atomically and read-back verified via the shared
 * `writeFileVerified` choke-point. Throws if the write cannot be verified.
 */
export async function writeMemoryFile(filePath: string, content: string): Promise<void> {
  await writeFileVerified(filePath, content);
}
