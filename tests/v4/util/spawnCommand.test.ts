/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.2 SLICE 1 — spawnCommand unit coverage (mocked spawn).
 *
 * Verifies the cmd.exe wrapping decision tree and the cmd-meta escaper.
 * Real-spawn coverage lives in spawnCommand.integration.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { escapeCmdArg, spawnCommand, killProcessTree, getProcessCreationTime } from '../../../core/v4/util/spawnCommand';

function fakeSpawn() {
  return vi.fn((_cmd: string, _args: readonly string[], _opts: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter;
      kill: (_s?: string) => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin  = new EventEmitter();
    child.kill = () => true;
    return child;
  });
}

describe('escapeCmdArg', () => {
  it('leaves plain alphanumerics unquoted', () => {
    expect(escapeCmdArg('foo')).toBe('foo');
    expect(escapeCmdArg('aiden-runtime')).toBe('aiden-runtime');
    expect(escapeCmdArg('4.9.2')).toBe('4.9.2');
  });
  it('quotes anything containing whitespace', () => {
    expect(escapeCmdArg('hello world')).toBe('"hello world"');
  });
  it('quotes cmd metachars (& | < > ( ) @ ^ ")', () => {
    expect(escapeCmdArg('a&b')).toBe('"a&b"');
    expect(escapeCmdArg('a|b')).toBe('"a|b"');
    expect(escapeCmdArg('a>b')).toBe('"a>b"');
    expect(escapeCmdArg('a^b')).toBe('"a^b"');
    expect(escapeCmdArg('a@b')).toBe('"a@b"');
  });
  it('doubles embedded quotes', () => {
    expect(escapeCmdArg('say "hi"')).toBe('"say ""hi"""');
  });
  it('quotes empty string explicitly', () => {
    expect(escapeCmdArg('')).toBe('""');
  });
});

describe('spawnCommand — Unix (linux/darwin)', () => {
  it('spawns directly with shell:false, no cmd.exe wrapping', () => {
    const spawnImpl = fakeSpawn();
    const r = spawnCommand('npm', ['install', '-g', 'aiden-runtime@latest'], {
      spawnImpl: spawnImpl as unknown as Parameters<typeof spawnCommand>[2]['spawnImpl'],
      platform:  'linux',
    });
    expect(r.viaCmdExe).toBe(false);
    expect(r.resolvedCmd).toBe('npm');
    expect(spawnImpl).toHaveBeenCalledWith('npm', ['install', '-g', 'aiden-runtime@latest'],
      expect.objectContaining({ shell: false }));
  });

  it('respects custom stdio + cwd + env on Unix path', () => {
    const spawnImpl = fakeSpawn();
    spawnCommand('node', ['-v'], {
      spawnImpl: spawnImpl as unknown as Parameters<typeof spawnCommand>[2]['spawnImpl'],
      platform:  'darwin',
      stdio:     ['ignore', 'pipe', 'pipe'],
      cwd:       '/tmp',
      env:       { FOO: 'bar' },
    });
    expect(spawnImpl).toHaveBeenCalledWith('node', ['-v'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe'], cwd: '/tmp', env: { FOO: 'bar' }, shell: false,
      }));
  });
});

describe('spawnCommand — Windows', () => {
  it('wraps a .cmd file via cmd.exe /d /s /c with escaped args', () => {
    const spawnImpl = fakeSpawn();
    // Use absolute .cmd path so PATH walking isn't required for the
    // shim-detection branch — keeps the unit test hermetic.
    const r = spawnCommand('C:\\Program Files\\nodejs\\npm.cmd',
      ['install', '-g', 'aiden-runtime@latest'], {
        spawnImpl: spawnImpl as unknown as Parameters<typeof spawnCommand>[2]['spawnImpl'],
        platform:  'win32',
      });
    expect(r.viaCmdExe).toBe(true);
    expect(r.resolvedCmd).toBe('cmd.exe');
    expect(r.resolvedArgs[0]).toBe('/d');
    expect(r.resolvedArgs[1]).toBe('/s');
    expect(r.resolvedArgs[2]).toBe('/c');
    // The line should quote the npm.cmd path (whitespace) and pass args.
    // Also wrapped in an OUTER quote pair that cmd.exe /s will strip —
    // critical for paths containing spaces (see helper comment).
    const line = r.resolvedArgs[3] as string;
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    expect(line).toContain('"C:\\Program Files\\nodejs\\npm.cmd"');
    expect(line).toContain('install');
    expect(line).toContain('-g');
    expect(line).toContain('aiden-runtime@latest');
    expect(spawnImpl).toHaveBeenCalledWith('cmd.exe', expect.any(Array),
      expect.objectContaining({
        shell: false, windowsVerbatimArguments: true,
      }));
  });

  it('does NOT wrap an .exe — spawns directly with shell:false', () => {
    const spawnImpl = fakeSpawn();
    const r = spawnCommand('C:\\Windows\\System32\\where.exe', ['npm'], {
      spawnImpl: spawnImpl as unknown as Parameters<typeof spawnCommand>[2]['spawnImpl'],
      platform:  'win32',
    });
    expect(r.viaCmdExe).toBe(false);
    expect(r.resolvedCmd).toBe('C:\\Windows\\System32\\where.exe');
    expect(spawnImpl).toHaveBeenCalledWith('C:\\Windows\\System32\\where.exe', ['npm'],
      expect.objectContaining({ shell: false }));
    // Critical: no windowsVerbatimArguments on .exe path — let Node quote.
    expect(spawnImpl.mock.calls[0]?.[2]).not.toHaveProperty('windowsVerbatimArguments', true);
  });

  it('wraps bare ".cmd" suffix names even when PATH lookup fails', () => {
    const spawnImpl = fakeSpawn();
    // No PATH walking match → falls through to suffix sniff. .cmd → wrap.
    const r = spawnCommand('nonexistent-tool.cmd', ['--help'], {
      spawnImpl: spawnImpl as unknown as Parameters<typeof spawnCommand>[2]['spawnImpl'],
      platform:  'win32',
      env:       { PATH: '' },
    });
    expect(r.viaCmdExe).toBe(true);
    expect(r.resolvedCmd).toBe('cmd.exe');
  });

  it('escapes a path-with-spaces server arg (MCP injection guard)', () => {
    const spawnImpl = fakeSpawn();
    const r = spawnCommand('C:\\nodejs\\npx.cmd',
      ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\My Files\\notes'], {
        spawnImpl: spawnImpl as unknown as Parameters<typeof spawnCommand>[2]['spawnImpl'],
        platform:  'win32',
      });
    expect(r.viaCmdExe).toBe(true);
    // The "C:\My Files\notes" arg MUST be quoted; without proper escaping
    // cmd.exe would split on the space and the MCP server would see a
    // truncated path. This is the integrity guarantee the helper provides.
    expect(r.resolvedArgs[3]).toContain('"C:\\My Files\\notes"');
  });
});

describe('killProcessTree — v4.12 PM.1 (sync taskkill before child.kill)', () => {
  function fakeChild(pid: number | null = 4242) {
    const calls: string[] = [];
    const child = { pid, kill: vi.fn((s?: string) => { calls.push(`kill:${s}`); return true; }) };
    return { child, calls };
  }

  it('★ Windows: runs a SYNCHRONOUS `taskkill /pid <pid> /t` and does NOT child.kill (taskkill owns the tree incl. root)', () => {
    const execSyncImpl = vi.fn(() => '') as any;
    const { child, calls } = fakeChild(1234);
    killProcessTree(child as any, 'SIGTERM', { platform: 'win32', execSyncImpl });
    expect(execSyncImpl).toHaveBeenCalledTimes(1);
    expect(String(execSyncImpl.mock.calls[0][0])).toBe('taskkill /pid 1234 /t');   // graceful: no /f
    // ★ the fix: on Windows child.kill is NOT fired — firing it would kill the
    // root during the graceful pass and orphan console descendants.
    expect(calls).toEqual([]);
  });

  it('Windows SIGKILL adds /f (force tree-kill), still no child.kill', () => {
    const execSyncImpl = vi.fn(() => '') as any;
    const { child, calls } = fakeChild(999);
    killProcessTree(child as any, 'SIGKILL', { platform: 'win32', execSyncImpl });
    expect(String(execSyncImpl.mock.calls[0][0])).toBe('taskkill /pid 999 /t /f');
    expect(calls).toEqual([]);
  });

  it('Windows: a throwing taskkill does not prevent the child.kill fallback', () => {
    const execSyncImpl = vi.fn(() => { throw new Error('not found'); }) as any;
    const { child, calls } = fakeChild(1);
    expect(() => killProcessTree(child as any, 'SIGKILL', { platform: 'win32', execSyncImpl })).not.toThrow();
    expect(calls).toContain('kill:SIGKILL');   // belt-and-suspenders still fires
  });

  it('POSIX: signals the process GROUP (-pid), then the direct child', () => {
    const killed: Array<[number, string | number]> = [];
    const killImpl = (p: number, s: NodeJS.Signals | number) => { killed.push([p, s]); };
    const { child, calls } = fakeChild(555);
    killProcessTree(child as any, 'SIGTERM', { platform: 'linux', killImpl });
    expect(killed).toEqual([[-555, 'SIGTERM']]);   // negative pid → group
    expect(calls).toContain('kill:SIGTERM');
  });
});

describe('getProcessCreationTime — v4.12 PM.1', () => {
  it('Windows: parses ISO StartTime → epoch ms', () => {
    const execSyncImpl = vi.fn(() => '2026-07-01T08:09:18.1447871Z\n') as any;
    const ms = getProcessCreationTime(1234, { platform: 'win32', execSyncImpl });
    expect(ms).toBe(Date.parse('2026-07-01T08:09:18.1447871Z'));
    expect(String(execSyncImpl.mock.calls[0][0])).toContain('Get-Process -Id 1234');
    expect(String(execSyncImpl.mock.calls[0][0])).toContain("ToString('o')");
  });

  it('best-effort: a throwing query → null (never throws)', () => {
    const execSyncImpl = vi.fn(() => { throw new Error('no such process'); }) as any;
    expect(getProcessCreationTime(1234, { platform: 'win32', execSyncImpl })).toBeNull();
  });

  it('rejects a non-positive pid without querying', () => {
    const execSyncImpl = vi.fn(() => '') as any;
    expect(getProcessCreationTime(-1, { platform: 'win32', execSyncImpl })).toBeNull();
    expect(execSyncImpl).not.toHaveBeenCalled();
  });
});
