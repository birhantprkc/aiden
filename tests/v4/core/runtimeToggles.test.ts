/**
 * v4.5 Phase 8a — runtimeToggles precedence + onChange tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildRuntimeToggles,
  _resetRuntimeTogglesForTests,
} from '../../../core/v4/runtimeToggles';

beforeEach(() => { _resetRuntimeTogglesForTests(); });

describe('runtimeToggles — precedence', () => {
  it('env value "0" wins over config and default', () => {
    const rt = buildRuntimeToggles({
      env: { AIDEN_SANDBOX: '0' },
      configRead: () => true,
    });
    expect(rt.isEnabled('sandbox')).toBe(false);
    expect(rt.snapshot().sandbox).toEqual({ value: false, source: 'env' });
  });

  it('env value present + non-zero wins as true', () => {
    const rt = buildRuntimeToggles({
      env: { AIDEN_SANDBOX: '1' },
      configRead: () => false,
    });
    expect(rt.isEnabled('sandbox')).toBe(true);
    expect(rt.snapshot().sandbox.source).toBe('env');
  });

  it('config wins over default when env unset', () => {
    const rt = buildRuntimeToggles({
      env: {},
      configRead: (key) => key === 'runtime_toggles.sandbox' ? false : undefined,
    });
    expect(rt.isEnabled('sandbox')).toBe(false);
    expect(rt.snapshot().sandbox.source).toBe('config');
    // tce + browser_depth: no env, no config → default true
    expect(rt.isEnabled('tce')).toBe(true);
    expect(rt.snapshot().tce.source).toBe('default');
  });

  it('default true when no env and no config', () => {
    const rt = buildRuntimeToggles({ env: {} });
    for (const k of ['sandbox', 'tce', 'browser_depth'] as const) {
      expect(rt.isEnabled(k)).toBe(true);
      expect(rt.snapshot()[k].source).toBe('default');
    }
  });

  it('parses config booleans + truthy strings', () => {
    const map = {
      'runtime_toggles.sandbox':       'true',
      'runtime_toggles.tce':           '0',
      'runtime_toggles.browser_depth': 'off',
    } as Record<string, string>;
    const rt = buildRuntimeToggles({ env: {}, configRead: (k) => map[k] });
    expect(rt.isEnabled('sandbox')).toBe(true);
    expect(rt.isEnabled('tce')).toBe(false);
    expect(rt.isEnabled('browser_depth')).toBe(false);
  });
});

describe('runtimeToggles — set() + onChange', () => {
  it('set() flips in-memory state immediately', async () => {
    const rt = buildRuntimeToggles({ env: {} });
    expect(rt.isEnabled('sandbox')).toBe(true);
    await rt.set('sandbox', false);
    expect(rt.isEnabled('sandbox')).toBe(false);
  });

  it('set() with persist=true calls configWriteAndSave', async () => {
    const calls: Array<[string, unknown]> = [];
    const rt = buildRuntimeToggles({
      env: {},
      configWriteAndSave: async (key, value) => { calls.push([key, value]); },
    });
    await rt.set('tce', false);
    expect(calls).toEqual([['runtime_toggles.tce', false]]);
  });

  it('set() with persist=false skips configWriteAndSave', async () => {
    const calls: Array<[string, unknown]> = [];
    const rt = buildRuntimeToggles({
      env: {},
      configWriteAndSave: async (key, value) => { calls.push([key, value]); },
    });
    await rt.set('tce', false, { persist: false });
    expect(calls).toEqual([]);
  });

  it('env override beats in-process set() (env always wins)', async () => {
    const rt = buildRuntimeToggles({ env: { AIDEN_SANDBOX: '1' } });
    await rt.set('sandbox', false);
    // env is '1' → still on regardless of override
    expect(rt.isEnabled('sandbox')).toBe(true);
  });

  it('onChange fires on set()', async () => {
    const rt = buildRuntimeToggles({ env: {} });
    let calls = 0;
    rt.onChange('sandbox', () => { calls += 1; });
    await rt.set('sandbox', false);
    await rt.set('sandbox', true);
    expect(calls).toBe(2);
  });

  it('onChange handlers for one key do not fire for another', async () => {
    const rt = buildRuntimeToggles({ env: {} });
    let sandboxHits = 0;
    let tceHits = 0;
    rt.onChange('sandbox', () => { sandboxHits += 1; });
    rt.onChange('tce', () => { tceHits += 1; });
    await rt.set('tce', false);
    expect(sandboxHits).toBe(0);
    expect(tceHits).toBe(1);
  });
});
