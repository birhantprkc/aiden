import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ToolContext } from '../../../core/v4/toolRegistry';

/**
 * Phase v4.1.2-followup-3 — computer-control tools.
 *
 * Each tool is gated on `process.platform === 'win32'`. The tests
 * cover both branches:
 *   1. The Windows path with `child_process.exec` mocked to return a
 *      shaped stdout matching the real PowerShell output (then assert
 *      the parsed/structured result + arguments forwarded to exec).
 *   2. The non-Windows refuse path (returns a structured error
 *      pointing at the issue tracker).
 *
 * The exec mock is module-level (`vi.mock('node:child_process')`) so
 * we don't have to inject a fake into every tool individually.
 */

// ── Mock node:child_process so the tools' exec calls land in our spy. ──
const execMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  // Keep real exports we don't override (spawn, etc.) so other modules
  // that share this import in a test run don't break.
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    exec: (
      cmd: string,
      opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => execMock(cmd, opts, cb),
  };
});

// Helper to make execMock yield a particular stdout.
function execReturns(stdout: string): void {
  execMock.mockImplementation((_cmd, _opts, cb) => {
    cb(null, { stdout, stderr: '' });
  });
}
function execThrows(message: string): void {
  execMock.mockImplementation((_cmd, _opts, cb) => {
    cb(new Error(message), { stdout: '', stderr: '' });
  });
}

// Tools-under-test (imported AFTER the mock).
import { screenshotTool } from '../../../tools/v4/system/screenshot';
import { osProcessListTool } from '../../../tools/v4/system/osProcessList';
import { mediaKeyTool } from '../../../tools/v4/system/mediaKey';
import { volumeSetTool } from '../../../tools/v4/system/volumeSet';
import {
  appLaunchTool,
  processNameFromApp,
} from '../../../tools/v4/system/appLaunch';
import { appCloseTool } from '../../../tools/v4/system/appClose';
import { clipboardReadTool } from '../../../tools/v4/system/clipboardRead';
import { clipboardWriteTool } from '../../../tools/v4/system/clipboardWrite';
// v4.1.4-media — three-layer media-control bundle under test.
import { mediaSessionsTool } from '../../../tools/v4/system/mediaSessions';
import { mediaTransportTool } from '../../../tools/v4/system/mediaTransport';
import { appInputTool } from '../../../tools/v4/system/appInput';

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function fakeCtx(root: string): ToolContext {
  return { cwd: root, paths: { root } as unknown } as ToolContext;
}

beforeEach(() => {
  execMock.mockReset();
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

// ── screenshot ─────────────────────────────────────────────────────────
describe('screenshotTool', () => {
  it('refuses on non-Windows with a clear error and issue-tracker hint', async () => {
    setPlatform('linux');
    const res = await screenshotTool.execute({}, fakeCtx('/tmp')) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Windows-only/);
    expect(res.error).toMatch(/issue/i);
  });

  it('saves a PNG under <paths.root>/screenshots and returns the absolute path', async () => {
    setPlatform('win32');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-ss-'));
    try {
      // PowerShell exits 0 AND writes a real file. Simulate the file
      // write since the actual PS script won't run on the test host.
      execMock.mockImplementation(async (cmd, _opts, cb) => {
        const m = String(cmd).match(/'([^']+\.png)'/);
        if (m && m[1]) await fs.writeFile(m[1], 'fakepng', 'utf8');
        cb(null, { stdout: 'ok', stderr: '' });
      });
      const res = await screenshotTool.execute({}, fakeCtx(tmp)) as {
        success: boolean; path: string; size: number; attachAs: string;
      };
      expect(res.success).toBe(true);
      expect(res.path).toContain(path.join(tmp, 'screenshots'));
      expect(res.path).toMatch(/\.png$/);
      expect(res.size).toBeGreaterThan(0);
      expect(res.attachAs).toBe('image/png');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('reports failure when PowerShell exits 0 but no file lands on disk', async () => {
    setPlatform('win32');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-ss-'));
    try {
      // Stub doesn't write — simulates an exotic-display PowerShell quirk.
      execReturns('ok');
      const res = await screenshotTool.execute({}, fakeCtx(tmp)) as {
        success: boolean; error: string;
      };
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/file not found/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ── os_process_list ───────────────────────────────────────────────────
describe('osProcessListTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await osProcessListTool.execute({}, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('parses ConvertTo-Json array output', async () => {
    setPlatform('win32');
    execReturns(JSON.stringify([
      { Name: 'claude', Id: 1234, CPU: 12.5, MemoryMB: 256.4 },
      { Name: 'spotify', Id: 5678, CPU: 2.1, MemoryMB: 480.0 },
    ]));
    const res = await osProcessListTool.execute({ name: 'cla' }, fakeCtx('/tmp')) as {
      success: boolean; count: number; processes: Array<{ Name: string }>;
    };
    expect(res.success).toBe(true);
    expect(res.count).toBe(2);
    expect(res.processes[0].Name).toBe('claude');
  });

  it('normalises single-object stdout into a one-element array', async () => {
    setPlatform('win32');
    // ConvertTo-Json emits a bare object for a single-result pipeline.
    execReturns(JSON.stringify({ Name: 'aiden', Id: 9999, CPU: 0.5, MemoryMB: 100 }));
    const res = await osProcessListTool.execute({ name: 'aiden' }, fakeCtx('/tmp')) as {
      success: boolean; count: number; processes: unknown[];
    };
    expect(res.success).toBe(true);
    expect(res.count).toBe(1);
    expect(res.processes).toHaveLength(1);
  });

  it('returns empty array (not error) when stdout is empty', async () => {
    setPlatform('win32');
    execReturns('');
    const res = await osProcessListTool.execute({ name: 'nonexistent' }, fakeCtx('/tmp')) as {
      success: boolean; count: number; processes: unknown[];
    };
    expect(res.success).toBe(true);
    expect(res.count).toBe(0);
    expect(res.processes).toEqual([]);
  });

  it('clamps limit to 200', async () => {
    setPlatform('win32');
    execReturns('[]');
    await osProcessListTool.execute({ limit: 999999 }, fakeCtx('/tmp'));
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain('-First 200');
    expect(cmd).not.toContain('-First 999999');
  });
});

// ── media_key ──────────────────────────────────────────────────────────
describe('mediaKeyTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await mediaKeyTool.execute({ action: 'play_pause' }, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('sends MEDIA_PLAY_PAUSE for action=play_pause', async () => {
    setPlatform('win32');
    execReturns('sent:play_pause');
    const res = await mediaKeyTool.execute({ action: 'play_pause' }, fakeCtx('/tmp')) as {
      success: boolean; action: string;
    };
    expect(res.success).toBe(true);
    expect(res.action).toBe('play_pause');
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain('{MEDIA_PLAY_PAUSE}');
  });

  it('rejects an unknown action', async () => {
    setPlatform('win32');
    const res = await mediaKeyTool.execute({ action: 'fast_forward' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Unknown media action/);
    // exec was never called when the gate rejects.
    expect(execMock).not.toHaveBeenCalled();
  });

  it('sends the right key for each valid action', async () => {
    setPlatform('win32');
    execReturns('ok');
    const map = {
      play_pause: '{MEDIA_PLAY_PAUSE}',
      next:       '{MEDIA_NEXT_TRACK}',
      previous:   '{MEDIA_PREV_TRACK}',
      stop:       '{MEDIA_STOP}',
    };
    for (const [action, expected] of Object.entries(map)) {
      execMock.mockClear();
      await mediaKeyTool.execute({ action }, fakeCtx('/tmp'));
      expect((execMock.mock.calls[0][0] as string)).toContain(expected);
    }
  });
});

// ── volume_set ─────────────────────────────────────────────────────────
describe('volumeSetTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await volumeSetTool.execute({ action: 'set', percent: 50 }, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('clamps percent to [0, 100] and sends scaled value', async () => {
    setPlatform('win32');
    execReturns('50');
    await volumeSetTool.execute({ action: 'set', percent: 150 }, fakeCtx('/tmp'));
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain('SetLevel([float]1.0000)');
  });

  it("rejects action='set' without numeric percent", async () => {
    setPlatform('win32');
    const res = await volumeSetTool.execute({ action: 'set' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/requires.*percent/);
  });

  it('routes mute / unmute / toggle_mute', async () => {
    setPlatform('win32');
    execReturns('muted');
    for (const action of ['mute', 'unmute', 'toggle_mute']) {
      execMock.mockClear();
      const res = await volumeSetTool.execute({ action }, fakeCtx('/tmp')) as { success: boolean };
      expect(res.success).toBe(true);
      expect(execMock).toHaveBeenCalled();
    }
  });
});

// ── processNameFromApp (v4.1.3-essentials helper) ──────────────────────
//
// The launch-verification poll calls Get-Process with a bare process
// name (no path, no .exe). This helper does that derivation; tests
// pin the contract so future refactors don't silently break the probe.

describe('processNameFromApp', () => {
  it('strips Windows backslash path components', () => {
    expect(processNameFromApp('C:\\Program Files\\Spotify\\Spotify.exe'))
      .toBe('spotify');
  });
  it('strips forward-slash path components (tolerant of cross-platform paths)', () => {
    expect(processNameFromApp('C:/Apps/notepad.exe')).toBe('notepad');
  });
  it('strips a trailing .exe (case-insensitive)', () => {
    expect(processNameFromApp('Notepad.EXE')).toBe('notepad');
    expect(processNameFromApp('chrome.exe')).toBe('chrome');
  });
  it('passes a bare name through unchanged (lowercased)', () => {
    expect(processNameFromApp('spotify')).toBe('spotify');
    expect(processNameFromApp('SPOTIFY')).toBe('spotify');
  });
  it('preserves non-.exe suffixes (e.g. notepad++)', () => {
    expect(processNameFromApp('notepad++.exe')).toBe('notepad++');
    expect(processNameFromApp('notepad++')).toBe('notepad++');
  });
});

// ── app_launch ─────────────────────────────────────────────────────────
describe('appLaunchTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await appLaunchTool.execute({ app: 'spotify' }, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('returns the parsed PID on success', async () => {
    setPlatform('win32');
    execReturns('PID=12345');
    const res = await appLaunchTool.execute({ app: 'notepad' }, fakeCtx('/tmp')) as {
      success: boolean; pid: number;
    };
    expect(res.success).toBe(true);
    expect(res.pid).toBe(12345);
  });

  it('rejects empty app argument', async () => {
    setPlatform('win32');
    const res = await appLaunchTool.execute({ app: '   ' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/required/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('passes ArgumentList through when args are supplied', async () => {
    setPlatform('win32');
    execReturns('PID=42');
    await appLaunchTool.execute(
      { app: 'chrome', args: ['--new-window', 'https://example.com'] },
      fakeCtx('/tmp'),
    );
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain('ArgumentList');
    expect(cmd).toContain('--new-window');
    expect(cmd).toContain('https://example.com');
  });

  // ── v4.1.3-essentials: Path C launch verification ────────────────────
  //
  // The PS script now emits exactly ONE of three sentinels:
  //   `PID=<n>` (optionally with `(verified via Get-Process)` suffix),
  //   `LAUNCH_FAILED=<msg>` (.NET Process.Start threw — popup-error case),
  //   `LAUNCH_UNVERIFIED=<name>` (ShellExecute returned null AND no process
  //                               named <name> appeared in 300ms).
  // These tests verify each branch maps to the correct surface-level
  // outcome — pre-fix the cmd-fallback path returned "launched" even when
  // Windows showed a "cannot find ''" popup; that lie is now impossible.

  it('verified PID via Get-Process: success + degraded + verified flag set', async () => {
    setPlatform('win32');
    execReturns('PID=12345 (verified via Get-Process)');
    const res = await appLaunchTool.execute({ app: 'spotify' }, fakeCtx('/tmp')) as {
      success: boolean; pid: number; verified: boolean;
      degraded: boolean; degradedReason: string;
    };
    expect(res.success).toBe(true);
    expect(res.pid).toBe(12345);
    expect(res.verified).toBe(true);
    // Still degraded — verified launch ≠ verified-still-running.
    expect(res.degraded).toBe(true);
    expect(res.degradedReason).toMatch(/verified via Get-Process/);
  });

  it('LAUNCH_FAILED sentinel maps to success:false with the .NET exception text', async () => {
    setPlatform('win32');
    execReturns('LAUNCH_FAILED=The system cannot find the file specified.');
    const res = await appLaunchTool.execute({ app: 'totally-fake-app' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Could not launch 'totally-fake-app'/);
    expect(res.error).toMatch(/cannot find the file/);
  });

  it('LAUNCH_UNVERIFIED sentinel maps to success:false (regression guard for the broken cmd-fallback "launched" lie)', async () => {
    setPlatform('win32');
    execReturns('LAUNCH_UNVERIFIED=spotify');
    const res = await appLaunchTool.execute({ app: 'spotify' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    // CRITICAL: pre-fix this scenario returned success:true with the
    // misleading "launched via cmd fallback" — the Windows popup error
    // was invisible to the tool. Now it surfaces honestly.
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no process named 'spotify'/);
    expect(res.error).toMatch(/300ms/);
    expect(res.error).toMatch(/Windows may have shown an error dialog/);
  });

  it('unexpected stdout (no sentinel) surfaces as success:false rather than a silent assume-success', async () => {
    setPlatform('win32');
    execReturns('Some other unexpected output');
    const res = await appLaunchTool.execute({ app: 'spotify' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unexpected stdout/);
  });
});

// ── app_close ──────────────────────────────────────────────────────────
describe('appCloseTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await appCloseTool.execute({ app: 'notepad' }, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('strips .exe suffix from the app name', async () => {
    setPlatform('win32');
    execReturns('closed:1');
    await appCloseTool.execute({ app: 'notepad.exe' }, fakeCtx('/tmp'));
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain(`-Name 'notepad'`);
    expect(cmd).not.toContain(`notepad.exe`);
  });

  it('returns the count of closed processes', async () => {
    setPlatform('win32');
    execReturns('closed:3');
    const res = await appCloseTool.execute({ app: 'chrome' }, fakeCtx('/tmp')) as {
      success: boolean; closed: number;
    };
    expect(res.success).toBe(true);
    expect(res.closed).toBe(3);
  });

  it("includes -Force when force=true", async () => {
    setPlatform('win32');
    execReturns('closed:1');
    await appCloseTool.execute({ app: 'notepad', force: true }, fakeCtx('/tmp'));
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toContain('-Force');
  });
});

// ── clipboard_read ─────────────────────────────────────────────────────
describe('clipboardReadTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await clipboardReadTool.execute({}, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('returns clipboard text and length', async () => {
    setPlatform('win32');
    execReturns('hello world\r\n');
    const res = await clipboardReadTool.execute({}, fakeCtx('/tmp')) as {
      success: boolean; text: string; length: number;
    };
    expect(res.success).toBe(true);
    // Trailing CRLF stripped (single trailing newline removed by tool).
    expect(res.text).toBe('hello world');
    expect(res.length).toBe(11);
  });

  it('preserves internal newlines (only trailing one is stripped)', async () => {
    setPlatform('win32');
    execReturns('line1\r\nline2\r\nline3\r\n');
    const res = await clipboardReadTool.execute({}, fakeCtx('/tmp')) as { text: string };
    expect(res.text).toBe('line1\r\nline2\r\nline3');
  });
});

// ── clipboard_write ────────────────────────────────────────────────────
describe('clipboardWriteTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await clipboardWriteTool.execute({ text: 'x' }, fakeCtx('/tmp')) as { success: boolean };
    expect(res.success).toBe(false);
  });

  it('rejects when `text` is not a string', async () => {
    setPlatform('win32');
    const res = await clipboardWriteTool.execute({}, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/required.*string/);
  });

  it('accepts an empty string as a valid clear-the-clipboard call', async () => {
    setPlatform('win32');
    // clipboard_write uses exec() differently — it writes via stdin
    // to a child process. The mock simulates success by calling back
    // with null.
    execMock.mockImplementation((_cmd, _opts, cb) => {
      cb(null, { stdout: '', stderr: '' });
      // Return a fake ChildProcess shape with stdin.write/end.
      return {
        stdin: { write: () => {}, end: () => {} },
      } as unknown as ReturnType<typeof execMock>;
    });
    const res = await clipboardWriteTool.execute({ text: '' }, fakeCtx('/tmp')) as {
      success: boolean; length: number;
    };
    expect(res.success).toBe(true);
    expect(res.length).toBe(0);
  });

  it('reports length on success for a real string', async () => {
    setPlatform('win32');
    execMock.mockImplementation((_cmd, _opts, cb) => {
      cb(null, { stdout: '', stderr: '' });
      return { stdin: { write: () => {}, end: () => {} } } as unknown as ReturnType<typeof execMock>;
    });
    const res = await clipboardWriteTool.execute(
      { text: 'hello, multi-line\nworld' },
      fakeCtx('/tmp'),
    ) as { success: boolean; length: number };
    expect(res.success).toBe(true);
    expect(res.length).toBe('hello, multi-line\nworld'.length);
  });
});

// ── error-path coverage shared across the family ───────────────────────
describe('error propagation', () => {
  it('os_process_list surfaces PowerShell errors as success:false', async () => {
    setPlatform('win32');
    execThrows('Get-Process : Cannot find a process with the name "nope".');
    const res = await osProcessListTool.execute({ name: 'nope' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Cannot find/);
  });

  it('media_key surfaces SendKeys errors as success:false', async () => {
    setPlatform('win32');
    execThrows('SendKeys not available');
    const res = await mediaKeyTool.execute({ action: 'next' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/SendKeys/);
  });
});

// ── media_sessions (v4.1.4-media — GSMTC enumerator) ───────────────────
describe('mediaSessionsTool', () => {
  it('refuses on non-Windows with a clear error', async () => {
    setPlatform('linux');
    const res = await mediaSessionsTool.execute({}, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Windows-only/);
  });

  // ── v4.1.3-essentials: capability card attached to non-Windows refuse ──
  it('non-Windows refuse attaches a capability card with platform-specific alternatives', async () => {
    setPlatform('linux');
    const res = await mediaSessionsTool.execute({}, fakeCtx('/tmp')) as {
      success:         boolean;
      error:           string;
      requires:        string[];
      capabilityCard: {
        title:          string;
        canStill:       string[];
        cannotReliably: string[];
        fix:            string;
      };
    };
    expect(res.requires).toEqual(['Windows']);
    expect(res.capabilityCard).toBeTruthy();
    expect(res.capabilityCard.title).toMatch(/media_sessions/);
    expect(res.capabilityCard.title).toMatch(/Windows/);
    // Tool supplied tailored alternatives, not the generic fallback.
    const canStillJoined = res.capabilityCard.canStill.join(' ');
    expect(canStillJoined).toMatch(/playerctl|now_playing|os_process_list/);
    // Fix points at the obvious remediation.
    expect(res.capabilityCard.fix).toMatch(/Windows|MPRIS/);
  });

  it('empty session list — PS prints "[]" — returns count:0 and empty array', async () => {
    setPlatform('win32');
    execReturns('[]');
    const res = await mediaSessionsTool.execute({}, fakeCtx('/tmp')) as {
      success: boolean; sessions: unknown[]; count: number;
    };
    expect(res.success).toBe(true);
    expect(res.count).toBe(0);
    expect(res.sessions).toEqual([]);
  });

  it('truly empty stdout (whitespace only) also routes to count:0', async () => {
    setPlatform('win32');
    execReturns('   \n   ');
    const res = await mediaSessionsTool.execute({}, fakeCtx('/tmp')) as {
      success: boolean; sessions: unknown[]; count: number;
    };
    expect(res.success).toBe(true);
    expect(res.count).toBe(0);
  });

  it('single session — PS emits object, not array — is normalized to one-element array', async () => {
    setPlatform('win32');
    execReturns(JSON.stringify({
      appUserModelId: 'Spotify.exe',
      isCurrent:      true,
      playbackStatus: 'Playing',
      title:          'Yesterday',
      artist:         'The Beatles',
      album:          'Help!',
    }));
    const res = await mediaSessionsTool.execute({}, fakeCtx('/tmp')) as {
      success: boolean;
      sessions: Array<{ friendlyApp: string; isCurrent: boolean; appUserModelId: string }>;
      count: number;
    };
    expect(res.success).toBe(true);
    expect(res.count).toBe(1);
    expect(res.sessions[0].appUserModelId).toBe('Spotify.exe');
    // friendlyAppName maps "spotify" → "Spotify".
    expect(res.sessions[0].friendlyApp).toBe('Spotify');
    expect(res.sessions[0].isCurrent).toBe(true);
  });

  it('multi-session array — preserves order, marks the current one', async () => {
    setPlatform('win32');
    execReturns(JSON.stringify([
      { appUserModelId: 'Spotify.exe', isCurrent: false, playbackStatus: 'Paused' },
      { appUserModelId: 'msedge.exe',  isCurrent: true,  playbackStatus: 'Playing', title: 'YouTube tab' },
    ]));
    const res = await mediaSessionsTool.execute({}, fakeCtx('/tmp')) as {
      success: boolean;
      sessions: Array<{ friendlyApp: string; isCurrent: boolean }>;
      count: number;
    };
    expect(res.count).toBe(2);
    expect(res.sessions[0].friendlyApp).toBe('Spotify');
    expect(res.sessions[0].isCurrent).toBe(false);
    expect(res.sessions[1].friendlyApp).toBe('Microsoft Edge');
    expect(res.sessions[1].isCurrent).toBe(true);
  });

  it('surfaces PowerShell errors as success:false', async () => {
    setPlatform('win32');
    execThrows('Unable to load Windows.Media.Control');
    const res = await mediaSessionsTool.execute({}, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Windows\.Media\.Control/);
  });
});

// ── media_transport (v4.1.4-media — verified GSMTC controller) ─────────
describe('mediaTransportTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await mediaTransportTool.execute({ action: 'pause' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Windows-only/);
  });

  it('non-Windows refuse attaches a capability card naming layer-1 / layer-3b alternatives', async () => {
    setPlatform('linux');
    const res = await mediaTransportTool.execute({ action: 'pause' }, fakeCtx('/tmp')) as {
      requires: string[];
      capabilityCard: { title: string; canStill: string[]; cannotReliably: string[]; fix: string };
    };
    expect(res.requires).toEqual(['Windows']);
    const canStillJoined = res.capabilityCard.canStill.join(' ');
    // Layer 1 (Spotify Web API), layer 3b (CDP / browser_*), and
    // platform-native shell utilities all surface as alternatives.
    expect(canStillJoined).toMatch(/Spotify Web API/);
    expect(canStillJoined).toMatch(/Chrome DevTools|browser_/);
    expect(canStillJoined).toMatch(/playerctl|osascript|shell_exec/);
  });

  it('rejects an unknown action without invoking PowerShell', async () => {
    setPlatform('win32');
    const res = await mediaTransportTool.execute({ action: 'launch_nukes' }, fakeCtx('/tmp')) as {
      success: boolean; error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Unknown action/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('matched=true + result=Success returns success without degraded flag (OS-confirmed)', async () => {
    setPlatform('win32');
    execReturns(JSON.stringify({
      matched:        true,
      result:         'Success',
      appUserModelId: 'Spotify.exe',
    }));
    const res = await mediaTransportTool.execute(
      { action: 'pause', target: 'spotify' },
      fakeCtx('/tmp'),
    ) as { success: boolean; action: string; appUserModelId: string; degraded?: boolean };
    expect(res.success).toBe(true);
    expect(res.action).toBe('pause');
    expect(res.appUserModelId).toBe('Spotify.exe');
    // CRITICAL: NOT degraded — this is the whole point of the slice.
    // mediaKey's blind keystroke surfaces degraded:true; mediaTransport
    // has GSMTC's enum result and reports honestly.
    expect(res.degraded).toBeUndefined();
  });

  it('matched=true + result=Failed surfaces a specific GSMTC failure', async () => {
    setPlatform('win32');
    execReturns(JSON.stringify({
      matched:        true,
      result:         'Failed',
      appUserModelId: 'Spotify.exe',
    }));
    const res = await mediaTransportTool.execute(
      { action: 'next', target: 'spotify' },
      fakeCtx('/tmp'),
    ) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/GSMTC next returned Failed/);
    expect(res.error).toMatch(/Spotify\.exe/);
  });

  it('matched=false with a target tells the model to call media_sessions', async () => {
    setPlatform('win32');
    execReturns(JSON.stringify({ matched: false, result: 'NoSession', appUserModelId: null }));
    const res = await mediaTransportTool.execute(
      { action: 'pause', target: 'nonexistent-app' },
      fakeCtx('/tmp'),
    ) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/No media session matched target/);
    expect(res.error).toMatch(/media_sessions/);
  });

  it('matched=false without a target points at opening a media app', async () => {
    setPlatform('win32');
    execReturns(JSON.stringify({ matched: false, result: 'NoSession', appUserModelId: null }));
    const res = await mediaTransportTool.execute(
      { action: 'toggle' },
      fakeCtx('/tmp'),
    ) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/No active media session/);
  });

  it('empty PowerShell stdout reports an honest "empty output" error', async () => {
    setPlatform('win32');
    execReturns('');
    const res = await mediaTransportTool.execute(
      { action: 'pause' },
      fakeCtx('/tmp'),
    ) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/empty output/);
  });

  it('escapes single-quotes in target so PS script literal stays well-formed', async () => {
    setPlatform('win32');
    execReturns(JSON.stringify({ matched: false, result: 'NoSession', appUserModelId: null }));
    await mediaTransportTool.execute(
      { action: 'play', target: "It's a kind of magic" },
      fakeCtx('/tmp'),
    );
    const cmd = String(execMock.mock.calls[0][0]);
    // Single quote doubled per PowerShell escape rules.
    expect(cmd).toContain("It''s a kind of magic");
  });
});

// ── app_input (v4.1.4-media — focus + SendKeys fallback) ───────────────
describe('appInputTool', () => {
  it('refuses on non-Windows', async () => {
    setPlatform('linux');
    const res = await appInputTool.execute(
      { app: 'chrome', keys: '{SPACE}' },
      fakeCtx('/tmp'),
    ) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Windows-only/);
  });

  it('non-Windows refuse attaches a capability card pointing at xdotool / osascript / playwright', async () => {
    setPlatform('linux');
    const res = await appInputTool.execute(
      { app: 'chrome', keys: '{SPACE}' },
      fakeCtx('/tmp'),
    ) as {
      requires: string[];
      capabilityCard: { title: string; canStill: string[]; fix: string };
    };
    expect(res.requires).toEqual(['Windows']);
    const canStillJoined = res.capabilityCard.canStill.join(' ');
    expect(canStillJoined).toMatch(/browser_|Playwright/);
    expect(canStillJoined).toMatch(/xdotool|osascript/);
  });

  it('rejects empty app without invoking PowerShell', async () => {
    setPlatform('win32');
    const res = await appInputTool.execute(
      { app: '   ', keys: '{SPACE}' },
      fakeCtx('/tmp'),
    ) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/`app` is required/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('rejects empty keys without invoking PowerShell', async () => {
    setPlatform('win32');
    const res = await appInputTool.execute(
      { app: 'chrome', keys: '' },
      fakeCtx('/tmp'),
    ) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/`keys` is required/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('activated=true success path: degraded=true with permissive reason', async () => {
    setPlatform('win32');
    execReturns(JSON.stringify({ activated: true }));
    const res = await appInputTool.execute(
      { app: 'Spotify', keys: '{SPACE}' },
      fakeCtx('/tmp'),
    ) as {
      success: boolean; app: string; activated: boolean;
      degraded?: boolean; degradedReason?: string;
    };
    expect(res.success).toBe(true);
    expect(res.activated).toBe(true);
    // SendKeys can't verify receipt — every success path is degraded.
    expect(res.degraded).toBe(true);
    expect(res.degradedReason).toMatch(/activation reported success/);
    expect(res.degradedReason).toContain('Spotify');
  });

  it('activated=false success path: degraded=true with the more dire reason', async () => {
    setPlatform('win32');
    execReturns(JSON.stringify({ activated: false }));
    const res = await appInputTool.execute(
      { app: 'NotepadXX', keys: 'hi' },
      fakeCtx('/tmp'),
    ) as {
      success: boolean; activated: boolean;
      degraded?: boolean; degradedReason?: string;
    };
    expect(res.success).toBe(true);
    expect(res.activated).toBe(false);
    expect(res.degraded).toBe(true);
    expect(res.degradedReason).toMatch(/activation reported failure/);
    expect(res.degradedReason).toMatch(/receipt unlikely/);
  });

  it('non-JSON stdout (malformed PS output) still resolves success with activated=false', async () => {
    setPlatform('win32');
    execReturns('garbage not-json output');
    const res = await appInputTool.execute(
      { app: 'chrome', keys: '{SPACE}' },
      fakeCtx('/tmp'),
    ) as { success: boolean; activated: boolean; degraded?: boolean };
    expect(res.success).toBe(true);
    expect(res.activated).toBe(false);
    expect(res.degraded).toBe(true);
  });

  it('surfaces PowerShell errors as success:false', async () => {
    setPlatform('win32');
    execThrows('Add-Type : Could not load assembly Microsoft.VisualBasic');
    const res = await appInputTool.execute(
      { app: 'chrome', keys: '{SPACE}' },
      fakeCtx('/tmp'),
    ) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Microsoft\.VisualBasic/);
  });

  it('escapes single-quotes in both app and keys', async () => {
    setPlatform('win32');
    execReturns(JSON.stringify({ activated: true }));
    await appInputTool.execute(
      { app: "It's running", keys: "Hello 'world'" },
      fakeCtx('/tmp'),
    );
    const cmd = String(execMock.mock.calls[0][0]);
    expect(cmd).toContain("It''s running");
    expect(cmd).toContain("Hello ''world''");
  });
});
