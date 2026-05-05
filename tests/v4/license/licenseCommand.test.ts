import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';
import {
  saveLicense,
  type LicenseCache,
} from '../../../core/v4/license/licenseStore';
import { license } from '../../../cli/v4/commands/license';
import {
  CommandRegistry,
  type SlashCommandContext,
} from '../../../cli/v4/commandRegistry';
import * as licClient from '../../../core/v4/license/licenseClient';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-lic-cmd-'));
  process.env.AIDEN_MACHINE_KEY = 'test-machine-key-license-cmd';
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.AIDEN_MACHINE_KEY;
  vi.restoreAllMocks();
});

function captured() {
  const o: any = { out: [], errs: [] };
  o.info = (m: string) => o.out.push('info:' + m);
  o.warn = (m: string) => o.out.push('warn:' + m);
  o.dim = (m: string) => o.out.push('dim:' + m);
  o.write = (m: string) => o.out.push(m);
  o.printError = (...m: string[]) => o.errs.push(m.join(' | '));
  o.success = (m: string) => o.out.push('ok:' + m);
  return o;
}

async function buildCtx(args: string[] = []) {
  const paths = resolveAidenPaths({ rootOverride: tmpRoot });
  await ensureAidenDirsExist(paths);
  const display = captured();
  const ctx: SlashCommandContext = {
    args,
    rawArgs: args.join(' '),
    display: display as any,
    registry: new CommandRegistry(),
    paths,
  };
  return { ctx, display, paths };
}

describe('/license', () => {
  it('1. status with no cache shows Free tier and upgrade hint', async () => {
    const { ctx, display } = await buildCtx([]);
    await license.handler(ctx);
    const text = display.out.join('\n');
    expect(text).toContain('Free tier');
    expect(text).toContain('aiden.taracod.com/pro');
  });

  it('2. activate rejects malformed key without contacting server', async () => {
    const spy = vi
      .spyOn(licClient.LicenseClient.prototype, 'activate')
      .mockResolvedValue({ ok: false, error: 'should-not-run' });
    const { ctx, display } = await buildCtx(['activate', 'not-a-key']);
    await license.handler(ctx);
    expect(display.errs[0]).toContain('Key format invalid');
    expect(spy).not.toHaveBeenCalled();
  });

  it('3. activate surfaces server error verbatim', async () => {
    vi.spyOn(licClient.LicenseClient.prototype, 'activate').mockResolvedValue({
      ok: false,
      error: 'Key revoked',
    });
    const { ctx, display } = await buildCtx(['activate', 'AIDEN-PRO-ABC12-DEF34-GHI56']);
    await license.handler(ctx);
    expect(display.errs.join(' ')).toContain('Activation failed');
    expect(display.errs.join(' ')).toContain('Key revoked');
  });

  it('4. status with valid Pro cache shows pro tier', async () => {
    const { ctx, display, paths } = await buildCtx([]);
    const cache: LicenseCache = {
      key: 'AIDEN-PRO-ABC12-DEF34-GHI56',
      valid: true,
      plan: 'pro_yearly',
      expiresAt: '2099-01-01T00:00:00Z',
      features: { multi_tool_approval: true },
      lastVerified: Date.now(),
    };
    await saveLicense(paths, cache);
    await license.handler(ctx);
    const text = display.out.join('\n');
    expect(text).toContain('Pro license active');
    expect(text).toContain('pro_yearly');
    // Key is masked, not raw
    expect(text).not.toContain('GHI56');
    expect(text).toContain('•••••');
  });
});
