/**
 * v4.5 Phase 8b — /suggestions slash command tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { suggestions } from '../../../../cli/v4/commands/suggestions';
import {
  initRuntimeToggles,
  _resetRuntimeTogglesForTests,
} from '../../../../core/v4/runtimeToggles';
import { _resetSuggestionEngineForTests } from '../../../../core/v4/suggestionEngine';
import type { SlashCommandContext } from '../../../../cli/v4/commandRegistry';

beforeEach(() => {
  _resetRuntimeTogglesForTests();
  _resetSuggestionEngineForTests();
});

function mkCtx(args: string[], opts: { config?: { saved: Array<[string, unknown]> } } = {}): SlashCommandContext & { _lines: string[]; _errs: string[] } {
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
    } as unknown as SlashCommandContext['display'],
    registry: {} as unknown as SlashCommandContext['registry'],
    config: opts.config ? {
      set: (k: string, v: unknown) => { saved.push([k, v]); },
      save: async () => { /* fake */ },
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

describe('/suggestions on/off/status', () => {
  it('on flips state + prints status', async () => {
    initRuntimeToggles({ env: {} });
    const ctx = mkCtx(['on']);
    await suggestions.handler(ctx);
    expect(ctx._lines.some((l) => /Suggestions: ON/.test(l))).toBe(true);
  });

  it('off persists to config + dismisses session', async () => {
    initRuntimeToggles({ env: {} });
    const saved: Array<[string, unknown]> = [];
    const ctx = mkCtx(['off'], { config: { saved } });
    await suggestions.handler(ctx);
    expect(saved).toEqual([['runtime_toggles.suggestions', false]]);
    expect(ctx._lines.some((l) => /Suggestions: OFF/.test(l))).toBe(true);
  });

  it('status shows budget remaining + fired slots', async () => {
    initRuntimeToggles({ env: {} });
    const ctx = mkCtx(['status']);
    await suggestions.handler(ctx);
    const out = ctx._lines.join('');
    expect(out).toMatch(/Suggestions: ON/);
    expect(out).toMatch(/budget remaining: 2/);
    expect(out).toMatch(/fired this session: \(none\)/);
  });

  it('unknown subarg prints usage', async () => {
    initRuntimeToggles({ env: {} });
    const ctx = mkCtx(['lol']);
    await suggestions.handler(ctx);
    expect(ctx._errs.join('')).toMatch(/Usage: \/suggestions/);
  });
});
