/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.3 SLICE 1a — /greeter slash command coverage.
 *
 * Real fs against tmpdir. ctx.confirm is a stub function (the unit
 * test for the confirm primitive itself lives in
 * confirmPrimitive.test.ts — here we just verify the command
 * branches correctly on accept/reject).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { greeter } from '../../../../cli/v4/commands/greeter';
import { readHistory, writeHistory } from '../../../../cli/v4/greeter/history';
import type { AidenPaths, GreeterHistory } from '../../../../cli/v4/greeter/types';
import type { SlashCommandContext } from '../../../../cli/v4/commandRegistry';

let root: string;
let paths: AidenPaths;
let writes: string[];
let errs:   string[];
let dims:   string[];
let successes: string[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-greeter-cmd-'));
  paths = { root } as unknown as AidenPaths;
  writes = []; errs = []; dims = []; successes = [];
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function mkCtx(over: {
  args?: string[];
  confirm?: (msg: string) => Promise<boolean>;
  paths?: AidenPaths | undefined;
} = {}): SlashCommandContext {
  // Distinguish "not supplied" (use the tmpdir default) from "explicitly
  // undefined" (the no-paths test) via key-presence check, since
  // `over.paths === undefined` is true for both in JS.
  const resolvedPaths = 'paths' in over ? over.paths : paths;
  return {
    args:    over.args ?? [],
    rawArgs: (over.args ?? []).join(' '),
    paths:   resolvedPaths,
    confirm: over.confirm,
    display: {
      write:       (s: string) => { writes.push(s); },
      dim:         (s: string) => { dims.push(s); },
      success:     (s: string) => { successes.push(s); },
      printError:  (s: string, hint?: string) => { errs.push(hint ? `${s} ${hint}` : s); },
    } as unknown as SlashCommandContext['display'],
    registry: {} as unknown as SlashCommandContext['registry'],
  } as SlashCommandContext;
}

describe('/greeter on', () => {
  it('initializes a fresh history with disabled:false on first invocation', async () => {
    await greeter.handler(mkCtx({ args: ['on'] }));
    const h = await readHistory(paths);
    expect(h).not.toBeNull();
    expect(h!.disabled).toBe(false);
    expect(successes[0]).toMatch(/Greeter on/);
  });

  it('flips an existing disabled:true history back to false', async () => {
    await writeHistory(paths, mkHistory({ disabled: true }));
    await greeter.handler(mkCtx({ args: ['on'] }));
    const h = await readHistory(paths);
    expect(h!.disabled).toBe(false);
  });
});

describe('/greeter off', () => {
  it('requires confirmation; on decline does NOT mutate state', async () => {
    await writeHistory(paths, mkHistory({ disabled: false }));
    const confirm = vi.fn(async () => false);   // user declined
    await greeter.handler(mkCtx({ args: ['off'], confirm }));
    expect(confirm).toHaveBeenCalledOnce();
    const h = await readHistory(paths);
    expect(h!.disabled).toBe(false);            // unchanged
    expect(successes).toEqual([]);               // no success line printed
  });

  it('sets disabled:true and prints success on confirmation', async () => {
    await writeHistory(paths, mkHistory({ disabled: false }));
    const confirm = vi.fn(async () => true);    // user confirmed
    await greeter.handler(mkCtx({ args: ['off'], confirm }));
    const h = await readHistory(paths);
    expect(h!.disabled).toBe(true);
    expect(successes[0]).toMatch(/Greeter off/);
  });

  it('initializes a fresh history if missing, then sets disabled:true', async () => {
    const confirm = vi.fn(async () => true);
    await greeter.handler(mkCtx({ args: ['off'], confirm }));
    const h = await readHistory(paths);
    expect(h).not.toBeNull();
    expect(h!.disabled).toBe(true);
  });

  it('refuses to proceed when ctx.confirm is not wired', async () => {
    await greeter.handler(mkCtx({ args: ['off'] }));   // confirm undefined
    expect(errs[0]).toMatch(/Cannot confirm/);
  });
});

describe('/greeter status', () => {
  it('prints a friendly "not initialized" dim line when history is missing', async () => {
    await greeter.handler(mkCtx({ args: ['status'] }));
    expect(dims[0]).toMatch(/not been initialized/);
  });

  it('prints state + first-launch + last-greeting + offer summary when history exists', async () => {
    await writeHistory(paths, mkHistory({
      firstLaunchAt:  '2026-05-20T10:00:00.000Z',
      lastGreetingAt: '2026-05-23T22:14:00.000Z',
      offers: [
        { id: 'a', offeredAt: 'x', response: 'accepted' },
        { id: 'b', offeredAt: 'y', response: 'ignored' },
        { id: 'c', offeredAt: 'z' },
      ],
    }));
    await greeter.handler(mkCtx({ args: ['status'] }));
    const out = writes.join('');
    expect(out).toMatch(/state:\s+on/);
    expect(out).toMatch(/first launch:\s+2026-05-20T10:00:00\.000Z/);
    expect(out).toMatch(/last greeting:\s+2026-05-23T22:14:00\.000Z/);
    expect(out).toMatch(/offers:\s+3 \(1 accepted · 1 ignored · 1 pending\)/);
  });

  it('shows state: off when disabled', async () => {
    await writeHistory(paths, mkHistory({ disabled: true }));
    await greeter.handler(mkCtx({ args: ['status'] }));
    const out = writes.join('');
    expect(out).toMatch(/state:\s+off/);
  });
});

describe('/greeter — usage', () => {
  it('defaults to status when no args', async () => {
    await writeHistory(paths, mkHistory());
    await greeter.handler(mkCtx({ args: [] }));
    expect(writes.some((w) => w.includes('Greeter status'))).toBe(true);
  });

  it('prints usage on unknown subcommand', async () => {
    await greeter.handler(mkCtx({ args: ['banana'] }));
    expect(errs[0]).toMatch(/Unknown greeter action 'banana'/);
    expect(errs[0]).toMatch(/Try: \/greeter on \| off \| status/);
  });
});

describe('/greeter — guards', () => {
  it('bails with printError when paths is undefined (test harness without paths wired)', async () => {
    await greeter.handler(mkCtx({ args: ['status'], paths: undefined }));
    expect(errs[0]).toMatch(/paths not wired/);
  });
});

// ─────────────────────────────────────────────────────────────────────

function mkHistory(over: Partial<GreeterHistory> = {}): GreeterHistory {
  return {
    v: 1,
    firstLaunchAt:  '2026-05-20T10:00:00.000Z',
    lastGreetingAt: '2026-05-23T22:14:00.000Z',
    offers: [], disabled: false,
    ...over,
  };
}
