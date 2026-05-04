/**
 * core/v4/soulSeed.ts — Phase 16b.3
 *
 * First-run seed for `<aiden-home>/SOUL.md`. Idempotent: only writes when the
 * file is missing or empty so user edits are never overwritten.
 *
 * Hermes reference: `hermes_cli/config.py::_ensure_default_soul_md`. Same
 * shape: read path → bail if exists → write the bundled default. We add an
 * explicit empty-file check (zero bytes / whitespace) because some test
 * setups create the file as a placeholder.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AidenPaths } from './paths';
import { DEFAULT_SOUL_MD } from '../../cli/v4/defaultSoul';

export interface SoulSeedResult {
  /** True when the seeder wrote the file; false when it left an existing one alone. */
  seeded: boolean;
  /** Path that was checked / written. Always set, regardless of seeded outcome. */
  soulPath: string;
}

/**
 * Seed `<root>/SOUL.md` with the bundled default identity if and only if the
 * file does not already exist or is whitespace-only. Never overwrites a
 * user's edited SOUL.md. Safe to call on every boot.
 */
export async function ensureSoulMdSeeded(
  paths: AidenPaths,
): Promise<SoulSeedResult> {
  const soulPath = paths.soulMd;
  let needSeed = false;
  try {
    const buf = await fs.readFile(soulPath, 'utf8');
    if (!buf.trim()) needSeed = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      needSeed = true;
    } else {
      // Permission errors etc. — bail without seeding; promptBuilder will
      // still fall back to DEFAULT_IDENTITY in-process.
      return { seeded: false, soulPath };
    }
  }
  if (!needSeed) return { seeded: false, soulPath };

  await fs.mkdir(path.dirname(soulPath), { recursive: true });
  await fs.writeFile(soulPath, DEFAULT_SOUL_MD, { encoding: 'utf8' });
  return { seeded: true, soulPath };
}
