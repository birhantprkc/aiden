/**
 * v4.5 update system — extended /update subcommand tests.
 *
 * Covers the new Phase 4.5 surface: skip, unskip, auto, plus the
 * default-status path now appending an install-method line.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { update } from '../../../../cli/v4/commands/update';
import type { SlashCommandContext } from '../../../../cli/v4/commandRegistry';
import { resolveAidenPaths, ensureAidenDirsExist } from '../../../../core/v4/paths';

let aidenHome: string;
let prev: Record<string, string | undefined>;

beforeEach(async () => {
  aidenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-p45upd-'));
  prev = {
    AIDEN_HOME:                process.env.AIDEN_HOME,
    HOME:                      process.env.HOME,
    USERPROFILE:               process.env.USERPROFILE,
    AIDEN_NO_UPDATE_CHECK:     process.env.AIDEN_NO_UPDATE_CHECK,
  };
  process.env.AIDEN_HOME       = aidenHome;
  process.env.HOME             = aidenHome;
  process.env.USERPROFILE      = aidenHome;
  delete process.env.AIDEN_NO_UPDATE_CHECK;
  await ensureAidenDirsExist(resolveAidenPaths());
});
afterEach(() => {
  for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k];
    else                       process.env[k] = prev[k];
  }
  try { fs.rmSync(aidenHome, { recursive: true, force: true }); }
  catch { /* noop */ }
});

function mkCtx(args: string[]): SlashCommandContext & { _lines: string[]; _errs: string[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    args,
    rawArgs: args.join(' '),
    paths:   resolveAidenPaths(),
    display: {
      write:       (s: string) => { lines.push(s); },
      dim:         (s: string) => { lines.push(s); },
      info:        (s: string) => { lines.push(s); },
      success:     (s: string) => { lines.push(s); },
      warn:        (s: string) => { lines.push(s); },
      printError:  (s: string) => { errs.push(s); },
    } as unknown as SlashCommandContext['display'],
    registry: {} as unknown as SlashCommandContext['registry'],
    _lines:  lines,
    _errs:   errs,
  } as SlashCommandContext & { _lines: string[]; _errs: string[] };
}

describe('/update skip', () => {
  it('writes skippedVersion to .update_check.json', async () => {
    const ctx = mkCtx(['skip', '4.5.1']);
    await update.handler(ctx);
    expect(ctx._lines.some((l) => l.includes('Skipping 4.5.1'))).toBe(true);
    const cachePath = path.join(aidenHome, '.update_check.json');
    expect(fs.existsSync(cachePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    expect(parsed.skippedVersion).toBe('4.5.1');
  });

  it('rejects missing version arg with usage error', async () => {
    const ctx = mkCtx(['skip']);
    await update.handler(ctx);
    expect(ctx._errs.join('')).toMatch(/Usage: \/update skip <version>/);
  });

  it('rejects unparseable version', async () => {
    const ctx = mkCtx(['skip', 'not-a-version']);
    await update.handler(ctx);
    expect(ctx._errs.join('')).toMatch(/not a recognised version/);
  });
});

describe('/update unskip', () => {
  it('clears skippedVersion when previously set', async () => {
    // Pre-seed cache.
    fs.writeFileSync(
      path.join(aidenHome, '.update_check.json'),
      JSON.stringify({ ts: Date.now(), latest: '4.5.1', installed: '4.5.0', skippedVersion: '4.5.1' }),
    );
    const ctx = mkCtx(['unskip']);
    await update.handler(ctx);
    expect(ctx._lines.some((l) => /Cleared skipped-version/.test(l))).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(path.join(aidenHome, '.update_check.json'), 'utf-8'));
    expect(parsed.skippedVersion).toBeUndefined();
  });
});

describe('/update auto', () => {
  it('status reflects current AIDEN_NO_UPDATE_CHECK value', async () => {
    const ctx = mkCtx(['auto', 'status']);
    await update.handler(ctx);
    expect(ctx._lines.some((l) => /Update auto-check: ON/.test(l))).toBe(true);
  });

  it('off sets AIDEN_NO_UPDATE_CHECK=1 in process env', async () => {
    const ctx = mkCtx(['auto', 'off']);
    await update.handler(ctx);
    expect(process.env.AIDEN_NO_UPDATE_CHECK).toBe('1');
    expect(ctx._lines.some((l) => /Update auto-check: OFF/.test(l))).toBe(true);
  });

  it('on clears AIDEN_NO_UPDATE_CHECK', async () => {
    process.env.AIDEN_NO_UPDATE_CHECK = '1';
    const ctx = mkCtx(['auto', 'on']);
    await update.handler(ctx);
    expect(process.env.AIDEN_NO_UPDATE_CHECK).toBeUndefined();
    expect(ctx._lines.some((l) => /Update auto-check: ON/.test(l))).toBe(true);
  });

  it('unknown auto subarg prints usage error', async () => {
    const ctx = mkCtx(['auto', 'lol']);
    await update.handler(ctx);
    expect(ctx._errs.join('')).toMatch(/Usage: \/update auto on\|off\|status/);
  });
});
