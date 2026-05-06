import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';

import { checkNpxAvailable } from '../../../cli/v4/doctor';

/**
 * Phase 20.2 — npx detection regression test.
 *
 * The bug: probeBinary used `shell: false`, which on Windows blocks
 * resolution of `npx.cmd` (and every other npm shim). The user could run
 * `npx tsx ...` from PowerShell but /doctor reported "npx not found."
 *
 * Fix: `shell: true` on win32. Test asserts that the spawnImpl receives
 * the correct shell option for the current platform AND that an exit-0
 * fake spawn produces a passing result.
 */
function spyingSpawn(
  exitCode: number,
  stdout = '8.19.2',
  capture: { call?: { bin: string; args: string[]; opts: any } } = {},
): typeof import('node:child_process').spawn {
  const fn = ((bin: string, args: string[], opts: any): unknown => {
    capture.call = { bin, args, opts };
    const ee = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    setImmediate(() => {
      if (stdout) ee.stdout.emit('data', Buffer.from(stdout));
      ee.emit('exit', exitCode);
    });
    return ee;
  }) as never;
  return fn;
}

describe('Phase 20.2 — /doctor npx detection', () => {
  it('1. checkNpxAvailable passes when spawn returns exit code 0, with shell flag matching platform', async () => {
    const capture: { call?: { bin: string; args: string[]; opts: any } } = {};
    const spawnImpl = spyingSpawn(0, '8.19.2', capture);
    const r = await checkNpxAvailable({ spawnImpl, timeoutMs: 1000 });
    expect(r.passed).toBe(true);
    expect(r.message).toContain('8.19.2');
    expect(capture.call?.bin).toBe('npx');
    expect(capture.call?.args).toEqual(['--version']);
    // Windows: shell must be true (so .cmd shims resolve via cmd.exe pathext).
    // POSIX: shell stays false (bare names resolve via execvp directly).
    const expectedShell = process.platform === 'win32';
    expect(capture.call?.opts.shell).toBe(expectedShell);
  });
});
