/**
 * tests/v4/mcp/install/wslDetect.test.ts — v4.9.0 Slice 2a.
 */
import { describe, it, expect } from 'vitest';
import { detectWsl, buildAidenEntry } from '../../../../core/v4/mcp/install/wslDetect';

describe('detectWsl — Slice 2a', () => {
  it('returns inWsl: true when WSL_DISTRO_NAME is set', () => {
    const r = detectWsl({
      env: { WSL_DISTRO_NAME: 'Ubuntu-22.04' },
      readFile: () => { throw new Error('should not read /proc/version'); },
    });
    expect(r.inWsl).toBe(true);
    expect(r.distro).toBe('Ubuntu-22.04');
  });

  it('returns inWsl: true when /proc/version contains "microsoft"', () => {
    const r = detectWsl({
      env: {},
      readFile: () => 'Linux version 5.15.90.1-microsoft-standard-WSL2',
    });
    expect(r.inWsl).toBe(true);
  });

  it('returns inWsl: false on plain Linux', () => {
    const r = detectWsl({
      env: {},
      readFile: () => 'Linux version 6.5.0-15-generic',
    });
    expect(r.inWsl).toBe(false);
  });

  it('returns inWsl: false when /proc/version unreadable + no env', () => {
    const r = detectWsl({
      env: {},
      readFile: () => { throw new Error('ENOENT'); },
    });
    expect(r.inWsl).toBe(false);
  });
});

describe('buildAidenEntry — Slice 2a', () => {
  it('returns canonical aiden entry outside WSL', () => {
    const e = buildAidenEntry({ wsl: { inWsl: false, distro: null } });
    expect(e.command).toBe('aiden');
    expect(e.args).toEqual(['mcp', 'serve']);
  });

  it('wraps in wsl.exe when targeting Windows host from WSL', () => {
    const e = buildAidenEntry({
      wsl:    { inWsl: true, distro: 'Ubuntu-22.04' },
      target: 'host',
    });
    expect(e.command).toBe('wsl.exe');
    expect(e.args).toEqual(['-d', 'Ubuntu-22.04', '--', 'aiden', 'mcp', 'serve']);
  });

  it('uses "default" distro when WSL distro is unknown', () => {
    const e = buildAidenEntry({
      wsl:    { inWsl: true, distro: null },
      target: 'host',
    });
    expect(e.args[1]).toBe('default');
  });
});
