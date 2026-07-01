/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 /commands slice — /home working-directory show/change.
 *
 * Contract: no-arg shows cwd; a valid dir resolves-absolute + calls the
 * setWorkingDir seam (so the change actually takes effect); an invalid path
 * or a non-directory errors clearly and NEVER calls the seam (no bad cwd);
 * a missing seam degrades honestly rather than pretending.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { home } from '../../../../cli/v4/commands/home';

function mkCtx(rawArgs: string, over: Partial<Record<string, unknown>> = {}) {
  const out: string[] = [];
  const errs: string[] = [];
  const ctx = {
    args: rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [],
    rawArgs,
    display: {
      info:       (m: string) => out.push(m),
      success:    (m: string) => out.push(m),
      dim:        (m: string) => out.push(m),
      warn:       (m: string) => out.push(m),
      printError: (m: string, s?: string) => errs.push(s ? `${m} :: ${s}` : m),
    },
    ...over,
  } as any;
  return { ctx, out, errs };
}

describe('/home', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-home-')));
    file = path.join(dir, 'a-file.txt');
    fs.writeFileSync(file, 'x');
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });

  it('no arg → shows the current working directory (no mutation)', async () => {
    const setWorkingDir = vi.fn();
    const { ctx, out } = mkCtx('', { setWorkingDir });
    await home.handler(ctx);
    expect(out.some((l) => l.includes('Working directory:') && l.includes(process.cwd()))).toBe(true);
    expect(setWorkingDir).not.toHaveBeenCalled();
  });

  it('★ valid dir → resolves absolute + calls setWorkingDir (change takes effect)', async () => {
    const setWorkingDir = vi.fn();
    const { ctx, out } = mkCtx(dir, { setWorkingDir });
    await home.handler(ctx);
    expect(setWorkingDir).toHaveBeenCalledTimes(1);
    expect(setWorkingDir).toHaveBeenCalledWith(path.resolve(dir));
    expect(out.some((l) => l.includes('Working directory →') && l.includes(path.resolve(dir)))).toBe(true);
  });

  it('resolves a RELATIVE path against process.cwd() before switching', async () => {
    // Use the temp dir's basename resolved from its parent as cwd-relative.
    const setWorkingDir = vi.fn();
    const rel = path.relative(process.cwd(), dir);
    const { ctx } = mkCtx(rel, { setWorkingDir });
    await home.handler(ctx);
    expect(setWorkingDir).toHaveBeenCalledWith(path.resolve(process.cwd(), rel));
  });

  it('★ invalid path → clear error, NEVER calls setWorkingDir (no bad cwd)', async () => {
    const setWorkingDir = vi.fn();
    const bogus = path.join(dir, 'does', 'not', 'exist');
    const { ctx, errs } = mkCtx(bogus, { setWorkingDir });
    await home.handler(ctx);
    expect(setWorkingDir).not.toHaveBeenCalled();
    expect(errs.some((e) => /No such path/i.test(e))).toBe(true);
  });

  it('★ path is a FILE not a directory → clear error, no seam call', async () => {
    const setWorkingDir = vi.fn();
    const { ctx, errs } = mkCtx(file, { setWorkingDir });
    await home.handler(ctx);
    expect(setWorkingDir).not.toHaveBeenCalled();
    expect(errs.some((e) => /Not a directory/i.test(e))).toBe(true);
  });

  it('missing seam (context can\'t change cwd) → honest warning, no throw', async () => {
    const { ctx, out } = mkCtx(dir, { setWorkingDir: undefined });
    await expect(home.handler(ctx)).resolves.toBeDefined();
    expect(out.some((l) => /not available in this context/i.test(l))).toBe(true);
  });
});
