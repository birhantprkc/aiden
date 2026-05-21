/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/version.ts — runtime version reader.
 *
 * v4.8.1 Slice 2 — switched from build-time injection to a runtime
 * `package.json` walk. The previous design relied on
 * `scripts/inject-version.js` (a `prebuild:cli` / `prebuild:api` hook)
 * to write a hardcoded VERSION constant into this file. That design
 * had a subtle ordering bug:
 *
 *   `npm run build` ran `tsc --outDir dist` BEFORE `inject-version.js`.
 *   tsc compiled `core/version.ts` (still at the previously-committed
 *   value) into `dist/core/version.js`. Inject then mutated the
 *   source, but only the esbuild bundle (`dist-bundle/cli.js`) picked
 *   up the fresh value. The `bin` entry uses the tsc tree
 *   (`dist/cli/v4/aidenCLI.js`), so the globally-installed CLI
 *   reported the stale version.
 *
 * Fix: read the version at module-load time by walking up from
 * `__dirname` and parsing the first `package.json` we find whose
 * `name` is `aiden-runtime`. This works for:
 *
 *   - the tsc tree   (`dist/core/version.js` → walk to `<install>/package.json`)
 *   - the esbuild bundle (`dist-bundle/cli.js` → walk to root)
 *   - source / tsx dev runs (`core/version.ts` → walk to repo root)
 *   - tests (any `__dirname` inside the repo lands on the right pkg)
 *
 * Failure mode: returns `'0.0.0-unknown'` if no aiden-runtime
 * package.json is found within 6 parent directories. End-user
 * deployments always have one within 3 levels; the 6-level budget
 * keeps the function defensive without scanning the whole filesystem.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function readVersion(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === 'aiden-runtime' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      } catch {
        /* unreadable / non-JSON → keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0-unknown';
}

/**
 * Resolved at module-load time. Idempotent — multiple imports share
 * the cached value. Re-reading on every access would be wasteful;
 * the package.json version doesn't change during a process lifetime.
 */
export const VERSION = readVersion();
