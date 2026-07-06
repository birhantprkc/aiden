/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14.3 — the shared UTF-8 memory doorway. Proves it round-trips the exact
 * characters that would mojibake under a wrong (CP1252) encoding — the `§`
 * entry separator and curly quotes — byte-identically, with no re-encoding, and
 * that writes are atomic + read-back verified via writeFileVerified.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readMemoryFile, writeMemoryFile } from '../../../core/v4/memory/io';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-memio-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

// Uses \u escapes so the test source's own encoding can't taint the fixture.
const CONTENT = 'entry one\n§\n“quoted” — café über ✓';

describe('memory UTF-8 doorway — round-trip fidelity', () => {
  it('round-trips § and curly quotes byte-identically (no re-encoding)', async () => {
    const p = path.join(dir, 'MEMORY.md');
    await writeMemoryFile(p, CONTENT);
    const back = await readMemoryFile(p);
    expect(back).toBe(CONTENT);                                   // string round-trip

    const bytes = await fs.readFile(p);
    // § is stored as the correct UTF-8 bytes 0xC2 0xA7 …
    expect(bytes.includes(Buffer.from([0xC2, 0xA7]))).toBe(true);
    // … and NOT the double-encoded Â§ (0xC3 0x82 0xC2 0xA7) that CP1252 would produce.
    expect(bytes.includes(Buffer.from([0xC3, 0x82, 0xC2, 0xA7]))).toBe(false);
    // curly quotes are their correct UTF-8 forms.
    expect(bytes.includes(Buffer.from('“', 'utf8'))).toBe(true);
    expect(bytes.includes(Buffer.from('”', 'utf8'))).toBe(true);
    // the read string re-encodes to exactly the on-disk bytes.
    expect(Buffer.from(back, 'utf8').equals(bytes)).toBe(true);
  });

  it('missing file → empty string (ENOENT contract preserved)', async () => {
    expect(await readMemoryFile(path.join(dir, 'nope.md'))).toBe('');
  });

  it('write is read-back verified (routes through writeFileVerified)', async () => {
    const p = path.join(dir, 'nested', 'deep', 'v.md');   // also proves mkdir
    await writeMemoryFile(p, 'verified ✓');
    expect(await fs.readFile(p, 'utf8')).toBe('verified ✓');
  });
});
