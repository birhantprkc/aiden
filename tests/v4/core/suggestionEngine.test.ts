/**
 * v4.5 Phase 8b — suggestion engine classifier + budget tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildSuggestionEngine,
  _resetSuggestionEngineForTests,
} from '../../../core/v4/suggestionEngine';
import {
  buildRuntimeToggles,
  _resetRuntimeTogglesForTests,
} from '../../../core/v4/runtimeToggles';

let prev: Record<string, string | undefined>;

beforeEach(() => {
  _resetSuggestionEngineForTests();
  _resetRuntimeTogglesForTests();
  prev = {
    AIDEN_DAEMON: process.env.AIDEN_DAEMON,
  };
  delete process.env.AIDEN_DAEMON;
});
afterEach(() => {
  for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k];
    else                       process.env[k] = prev[k];
  }
});

/**
 * Build engine with a runtime-toggles stub. All toggles default
 * OFF so suggestions fire (the engine only suggests when the
 * relevant subsystem is OFF — see canFire()).
 */
function mkEngine(opts: { budget?: number; toggleOverrides?: Record<string, boolean> } = {}) {
  const toggles = opts.toggleOverrides ?? {};
  const rt = buildRuntimeToggles({
    env: {
      // Force OFF for every subsystem unless override says otherwise.
      AIDEN_SANDBOX:       toggles.sandbox       === true ? '1' : '0',
      AIDEN_TCE:           toggles.tce           === true ? '1' : '0',
      AIDEN_BROWSER_DEPTH: toggles.browser_depth === true ? '1' : '0',
      AIDEN_SUGGESTIONS:   toggles.suggestions   === false ? '0' : '1',
    },
  });
  return buildSuggestionEngine({
    budgetPerSession: opts.budget,
    runtimeTogglesGetter: () => rt,
  });
}

describe('classifySandbox — shell + file_*', () => {
  it('shell_exec with rm -rf classifies as sandbox slot', () => {
    const e = mkEngine();
    const tip = e.checkToolCall({ name: 'shell_exec', arguments: { command: 'rm -rf /tmp/foo' } });
    expect(tip?.slot).toBe('sandbox');
    expect(tip?.message).toMatch(/💡 tip.*\/sandbox on/);
  });

  it('safe shell_exec (ls / cat) does not fire sandbox slot', () => {
    const e = mkEngine();
    expect(e.checkToolCall({ name: 'shell_exec', arguments: { command: 'ls -la' } })).toBeNull();
    expect(e.checkToolCall({ name: 'shell_exec', arguments: { command: 'cat README.md' } })).toBeNull();
  });

  it('file_write to /etc fires sandbox slot', () => {
    const e = mkEngine();
    const tip = e.checkToolCall({ name: 'file_write', arguments: { path: '/etc/hosts', content: '' } });
    expect(tip?.slot).toBe('sandbox');
  });

  it('file_write to user home does NOT fire sandbox slot', () => {
    const e = mkEngine();
    expect(e.checkToolCall({ name: 'file_write', arguments: { path: '/home/user/notes.md' } })).toBeNull();
  });

  it('sandbox slot suppressed when sandbox toggle is ON (no help needed)', () => {
    const e = mkEngine({ toggleOverrides: { sandbox: true } });
    expect(e.checkToolCall({ name: 'shell_exec', arguments: { command: 'rm -rf /tmp/x' } })).toBeNull();
  });
});

describe('classifyBrowserDepth', () => {
  it('any browser_* tool fires the slot when toggle is off', () => {
    const e = mkEngine();
    const tip = e.checkToolCall({ name: 'browser_navigate', arguments: { url: 'https://example.com' } });
    expect(tip?.slot).toBe('browser_depth');
  });

  it('non-browser tool does not fire browser_depth slot', () => {
    const e = mkEngine();
    expect(e.checkToolCall({ name: 'fetch_url', arguments: { url: 'https://example.com' } })).toBeNull();
  });
});

describe('classifySchedulingIntent — daemon slot', () => {
  it('"every day at 9am" fires daemon_scheduling', () => {
    const e = mkEngine();
    const tip = e.checkInitialMessage('Send me a market summary every day at 9am.');
    expect(tip?.slot).toBe('daemon_scheduling');
    expect(tip?.message).toMatch(/aiden cron add|aiden trigger add/);
  });

  it('"watch this folder" fires daemon_scheduling', () => {
    const e = mkEngine();
    expect(e.checkInitialMessage('watch this folder and ping me')?.slot).toBe('daemon_scheduling');
  });

  it('"when an email arrives from finance" fires daemon_scheduling', () => {
    const e = mkEngine();
    expect(e.checkInitialMessage('when an email arrives from finance, do X')?.slot).toBe('daemon_scheduling');
  });

  it('regular task message does not fire daemon slot', () => {
    const e = mkEngine();
    expect(e.checkInitialMessage('What is the capital of France?')).toBeNull();
  });

  it('daemon slot suppressed when AIDEN_DAEMON=1', () => {
    process.env.AIDEN_DAEMON = '1';
    const e = mkEngine();
    expect(e.checkInitialMessage('every day at 9am')).toBeNull();
  });
});

describe('budget + dismissal', () => {
  it('default budget = 2 per session global', () => {
    const e = mkEngine();
    // First fire: sandbox.
    const a = e.checkToolCall({ name: 'shell_exec', arguments: { command: 'rm -rf /tmp/x' } });
    expect(a).not.toBeNull();
    e.recordFired(a!.slot);
    // Second fire: browser.
    const b = e.checkToolCall({ name: 'browser_navigate', arguments: { url: 'x' } });
    expect(b).not.toBeNull();
    e.recordFired(b!.slot);
    // Third should be suppressed (budget exhausted). Use scheduling
    // intent which would otherwise fire.
    expect(e.checkInitialMessage('every day at 9am')).toBeNull();
  });

  it('each slot fires at most once per session', () => {
    const e = mkEngine();
    const a = e.checkToolCall({ name: 'shell_exec', arguments: { command: 'rm -rf /tmp/x' } });
    e.recordFired(a!.slot);
    // Second sandbox-classified call returns null even though budget left.
    expect(e.checkToolCall({ name: 'shell_exec', arguments: { command: 'dd if=/dev/zero of=/tmp/y' } })).toBeNull();
  });

  it('dismissAll silences all subsequent suggestions', () => {
    const e = mkEngine();
    e.dismissAll();
    expect(e.checkToolCall({ name: 'shell_exec', arguments: { command: 'rm -rf /' } })).toBeNull();
    expect(e.checkInitialMessage('every day at 9am')).toBeNull();
  });

  it('snapshot reports fired slots + budget remaining', () => {
    const e = mkEngine();
    expect(e.snapshot()).toEqual({
      firedSlots: [], dismissedSession: false, permanentlyOff: false, budgetRemaining: 2,
    });
    const tip = e.checkToolCall({ name: 'shell_exec', arguments: { command: 'rm -rf /tmp/x' } });
    e.recordFired(tip!.slot);
    const s = e.snapshot();
    expect(s.firedSlots).toEqual(['sandbox']);
    expect(s.budgetRemaining).toBe(1);
  });

  it('permanent opt-out (suggestions toggle OFF) silences', () => {
    const e = mkEngine({ toggleOverrides: { suggestions: false } });
    expect(e.checkToolCall({ name: 'shell_exec', arguments: { command: 'rm -rf /tmp/x' } })).toBeNull();
    expect(e.checkInitialMessage('every day at 9am')).toBeNull();
    expect(e.snapshot().permanentlyOff).toBe(true);
  });

  it('budget override on construction respected', () => {
    const e = mkEngine({ budget: 1 });
    expect(e.snapshot().budgetRemaining).toBe(1);
    const a = e.checkToolCall({ name: 'shell_exec', arguments: { command: 'rm -rf /tmp/x' } });
    e.recordFired(a!.slot);
    // Budget exhausted after 1.
    expect(e.checkToolCall({ name: 'browser_navigate', arguments: { url: 'x' } })).toBeNull();
  });
});
