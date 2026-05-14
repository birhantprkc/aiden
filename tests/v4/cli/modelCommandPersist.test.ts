import { describe, it, expect, vi } from 'vitest';
import { model } from '../../../cli/v4/commands/model';
import type { SlashCommandContext } from '../../../cli/v4/commandRegistry';

/**
 * v4.1.3-prebump regression guard: the in-REPL `/model` slash command
 * must persist the user's selection to config.yaml so subsequent boots
 * honour it. Before this fix `/model` only updated the live session —
 * a stale wizard-era persisted choice would silently snap back on the
 * NEXT boot (Case 3 in providerBootSelector). Users perceived /model
 * as "session-only", which matched neither docs nor the parallel
 * `aiden model` CLI subcommand which always persisted.
 *
 * These tests assert the persistence wiring (not the resolver / picker
 * behavior — those have their own coverage). Build a minimal ctx with
 * spy-instrumented session + config; verify both writes + save() fire.
 */

interface MockConfig {
  set: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  getValue: () => undefined;
}

function makeMockCtx(opts: {
  rawArgs?:    string;
  setProvider?: ReturnType<typeof vi.fn>;
  /**
   * Distinguish "default mock" (key absent) from "explicit undefined"
   * (caller wants to simulate ctx.config missing). The `?:` shorthand
   * collapses both into one nullable; we need an explicit sentinel so
   * `config: undefined` reaches the handler verbatim.
   */
  config?:     MockConfig | undefined;
  noConfig?:   boolean;
}): SlashCommandContext {
  const setProvider = opts.setProvider ?? vi.fn().mockResolvedValue(undefined);
  const config: MockConfig | undefined = opts.noConfig
    ? undefined
    : opts.config ?? {
        set:      vi.fn(),
        save:     vi.fn().mockResolvedValue(undefined),
        getValue: () => undefined,
      };

  const displayCalls: Array<{ kind: string; args: unknown[] }> = [];
  const display = {
    write: vi.fn(),
    dim: vi.fn(),
    warn: (...args: unknown[]) => { displayCalls.push({ kind: 'warn', args }); },
    success: (...args: unknown[]) => { displayCalls.push({ kind: 'success', args }); },
    printError: (...args: unknown[]) => { displayCalls.push({ kind: 'error', args }); },
  } as unknown as SlashCommandContext['display'];
  // @ts-expect-error attach for assertions
  display.__calls = displayCalls;

  return {
    args:        opts.rawArgs ? opts.rawArgs.split(/\s+/) : [],
    rawArgs:     opts.rawArgs ?? '',
    display,
    registry:    {} as unknown as SlashCommandContext['registry'],
    resolver:    {} as unknown as SlashCommandContext['resolver'],
    session:     { setProvider } as unknown as SlashCommandContext['session'],
    config:      config as unknown as SlashCommandContext['config'],
  } as SlashCommandContext;
}

describe('/model slash command — persistence (v4.1.3-prebump)', () => {
  it('persists the selection to config.yaml after a successful switch', async () => {
    const setProvider = vi.fn().mockResolvedValue(undefined);
    const cfg: MockConfig = {
      set:  vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      getValue: () => undefined,
    };
    const ctx = makeMockCtx({
      rawArgs: 'anthropic:claude-opus-4-7',
      setProvider,
      config: cfg,
    });

    await model.handler(ctx);

    // Live-session switch happened.
    expect(setProvider).toHaveBeenCalledWith('anthropic', 'claude-opus-4-7');
    // Persisted to config.yaml with the v3-compatible nested key.
    expect(cfg.set).toHaveBeenCalledWith('model.provider', 'anthropic');
    expect(cfg.set).toHaveBeenCalledWith('model.modelId',  'claude-opus-4-7');
    expect(cfg.save).toHaveBeenCalled();

    // Success message should mention persistence so the user knows
    // it'll stick across reboots.
    // @ts-expect-error __calls is our test-only attachment
    const successCall = ctx.display.__calls.find((c) => c.kind === 'success');
    expect(successCall).toBeTruthy();
    expect(String(successCall.args[0])).toContain('saved to config.yaml');
  });

  it('falls back to session-only when ctx.config is missing (test harness path)', async () => {
    const setProvider = vi.fn().mockResolvedValue(undefined);
    const ctx = makeMockCtx({
      rawArgs: 'anthropic:claude-opus-4-7',
      setProvider,
      noConfig: true,
    });

    await model.handler(ctx);

    expect(setProvider).toHaveBeenCalledWith('anthropic', 'claude-opus-4-7');
    // Success message should be honest about not persisting.
    // @ts-expect-error __calls is our test-only attachment
    const successCall = ctx.display.__calls.find((c) => c.kind === 'success');
    expect(String(successCall.args[0])).toContain('session only');
    expect(String(successCall.args[0])).toContain('not persisted');
  });

  it('warns but still switches when config.save() throws', async () => {
    const setProvider = vi.fn().mockResolvedValue(undefined);
    const cfg: MockConfig = {
      set:  vi.fn(),
      save: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
      getValue: () => undefined,
    };
    const ctx = makeMockCtx({
      rawArgs: 'anthropic:claude-opus-4-7',
      setProvider,
      config: cfg,
    });

    await model.handler(ctx);

    // Live switch still happened — persistence failure must not block.
    expect(setProvider).toHaveBeenCalled();
    // Warning surfaced the EACCES.
    // @ts-expect-error __calls is our test-only attachment
    const warnCall = ctx.display.__calls.find((c) => c.kind === 'warn');
    expect(warnCall).toBeTruthy();
    expect(String(warnCall.args[0])).toMatch(/EACCES|permission denied/i);
    // Success message reflects the session-only state honestly.
    // @ts-expect-error __calls is our test-only attachment
    const successCall = ctx.display.__calls.find((c) => c.kind === 'success');
    expect(String(successCall.args[0])).toContain('session only');
  });

  it('does NOT persist when session.setProvider throws (failed switch)', async () => {
    const setProvider = vi.fn().mockRejectedValue(new Error('Provider not authed'));
    const cfg: MockConfig = {
      set:  vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      getValue: () => undefined,
    };
    const ctx = makeMockCtx({
      rawArgs: 'anthropic:claude-opus-4-7',
      setProvider,
      config: cfg,
    });

    await model.handler(ctx);

    // Switch attempted but failed.
    expect(setProvider).toHaveBeenCalled();
    // Critical: we must NOT have written a non-working provider to
    // config.yaml. Persistence is gated on successful in-memory switch.
    expect(cfg.set).not.toHaveBeenCalled();
    expect(cfg.save).not.toHaveBeenCalled();
  });
});
