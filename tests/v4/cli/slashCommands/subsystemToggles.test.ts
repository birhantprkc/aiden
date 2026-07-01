/**
 * v4.5 Phase 8a — /sandbox, /tce, /browser-depth slash command tests.
 *
 * Each command shares the helper-driven shape, so we test all three
 * here. Covers: on/off flip prints status, on/off persists when
 * ConfigManager is wired, status subcommand prints current state,
 * unknown subarg prints usage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildRuntimeToggles,
  initRuntimeToggles,
  _resetRuntimeTogglesForTests,
} from '../../../../core/v4/runtimeToggles';
import { sandbox } from '../../../../cli/v4/commands/sandbox';
import { tce } from '../../../../cli/v4/commands/tce';
import { browserDepth } from '../../../../cli/v4/commands/browserDepth';
import type { SlashCommandContext } from '../../../../cli/v4/commandRegistry';

beforeEach(() => { _resetRuntimeTogglesForTests(); });

function mkCtx(args: string[], opts: { config?: { saved: Array<[string, unknown]> } } = {}): SlashCommandContext {
  const lines: string[] = [];
  const errs: string[] = [];
  const saved = opts.config?.saved ?? [];
  return {
    args,
    rawArgs: args.join(' '),
    display: {
      write: (m: string) => { lines.push(m); },
      info: (m: string) => { lines.push(m); },
      dim:  (m: string) => { lines.push(m); },
      success: (m: string) => { lines.push(m); },
      warn: (m: string) => { lines.push(m); },
      printError: (m: string) => { errs.push(m); },
      // Other display methods unused in this test
    } as unknown as SlashCommandContext['display'],
    registry: {} as unknown as SlashCommandContext['registry'],
    config: opts.config ? {
      set: (k: string, v: unknown) => { saved.push([k, v]); },
      save: async () => { /* fake save */ },
      getValue: () => undefined,
      load: async () => ({}) as unknown,
      reload: async () => false,
      snapshot: () => ({}) as unknown,
      get: () => undefined,
    } as unknown as SlashCommandContext['config'] : undefined,
    _lines: lines,
    _errs: errs,
  } as SlashCommandContext & { _lines: string[]; _errs: string[] };
}

describe('/sandbox', () => {
  it('on flips state + prints status', async () => {
    initRuntimeToggles({ env: {} });
    const ctx = mkCtx(['on']);
    await sandbox.handler(ctx);
    const lines = (ctx as unknown as { _lines: string[] })._lines;
    // v4.12 SH.1 — honest relabel: 'Sandbox' → 'File guardrails'.
    expect(lines.some((l) => l.includes('File guardrails: ON'))).toBe(true);
  });

  it('off flips state + prints status', async () => {
    initRuntimeToggles({ env: {} });
    const ctx = mkCtx(['off']);
    await sandbox.handler(ctx);
    const lines = (ctx as unknown as { _lines: string[] })._lines;
    expect(lines.some((l) => l.includes('File guardrails: OFF'))).toBe(true);
  });

  it('status prints current state without mutating', async () => {
    initRuntimeToggles({ env: {} });
    const ctx = mkCtx(['status']);
    await sandbox.handler(ctx);
    const lines = (ctx as unknown as { _lines: string[] })._lines;
    expect(lines.some((l) => l.includes('File guardrails:') && l.includes('source:'))).toBe(true);
  });

  it('persists to config.yaml when ConfigManager wired', async () => {
    initRuntimeToggles({ env: {} });
    const saved: Array<[string, unknown]> = [];
    const ctx = mkCtx(['off'], { config: { saved } });
    await sandbox.handler(ctx);
    expect(saved).toEqual([['runtime_toggles.sandbox', false]]);
  });

  it('unknown subarg prints usage error', async () => {
    initRuntimeToggles({ env: {} });
    const ctx = mkCtx(['lol']);
    await sandbox.handler(ctx);
    const errs = (ctx as unknown as { _errs: string[] })._errs;
    expect(errs.join('\n')).toMatch(/Usage: \/sandbox/);
  });
});

describe('/tce', () => {
  it('on/off/status work via the shared helper', async () => {
    initRuntimeToggles({ env: {} });
    const onCtx = mkCtx(['on']);
    await tce.handler(onCtx);
    expect((onCtx as unknown as { _lines: string[] })._lines.some((l) => l.includes('TCE: ON'))).toBe(true);

    const offCtx = mkCtx(['off']);
    await tce.handler(offCtx);
    expect((offCtx as unknown as { _lines: string[] })._lines.some((l) => l.includes('TCE: OFF'))).toBe(true);

    const stCtx = mkCtx(['status']);
    await tce.handler(stCtx);
    expect((stCtx as unknown as { _lines: string[] })._lines.some((l) => l.includes('TCE:'))).toBe(true);
  });
});

describe('/browser-depth', () => {
  it('on/off/status work via the shared helper + name matches env var', async () => {
    expect(browserDepth.name).toBe('browser-depth');
    initRuntimeToggles({ env: {} });
    const onCtx = mkCtx(['on']);
    await browserDepth.handler(onCtx);
    expect((onCtx as unknown as { _lines: string[] })._lines.some((l) => l.includes('Browser depth: ON'))).toBe(true);

    const offCtx = mkCtx(['off']);
    await browserDepth.handler(offCtx);
    expect((offCtx as unknown as { _lines: string[] })._lines.some((l) => l.includes('Browser depth: OFF'))).toBe(true);
  });
});

describe('env precedence visible in status', () => {
  it('env override shows source=env in status output', async () => {
    initRuntimeToggles({ env: { AIDEN_SANDBOX: '0' } });
    const ctx = mkCtx(['status']);
    await sandbox.handler(ctx);
    const lines = (ctx as unknown as { _lines: string[] })._lines;
    const status = lines.find((l) => l.includes('File guardrails:'));
    expect(status).toMatch(/File guardrails: OFF\s+\(source: env\)/);
  });
});

// Keep linter happy.
void buildRuntimeToggles;
