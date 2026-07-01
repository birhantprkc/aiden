/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/util/spawnCommand.ts — v4.9.2 SLICE 1.
 *
 * Cross-platform spawn helper that survives the Node 18.20+ / 20+
 * Windows EINVAL trap on `.cmd` / `.bat` shims. Two surfaces consume it:
 *   - core/v4/update/executeInstall.ts  (spawns `npm install -g …`)
 *   - core/v4/mcp/transport.ts          (spawns user-configured MCP servers,
 *                                        typically `npx -y <server>`)
 *
 * Both previously called `spawn(cmd, args, { shell: false })` directly,
 * which throws EINVAL on Windows when `cmd` resolves to `.cmd` / `.bat`.
 * The naive fix — `shell: true` — would silently permit argument
 * injection through MCP server config (user-supplied command line),
 * so we route Windows shims through `cmd.exe /d /s /c <quoted>` with
 * `windowsVerbatimArguments: true` and manual cmd-meta escaping.
 *
 * Returns the raw ChildProcess (not a callback abstraction): both
 * consumers need the full duplex surface (stdin write, stdout/stderr
 * stream, exit + error events, SIGTERM → SIGKILL escalation). The
 * helper's value is resolving the EINVAL trap, not abstracting I/O.
 */

import { spawn as defaultSpawn, execSync as defaultExecSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export interface SpawnCommandOptions {
  stdio?:    SpawnOptions['stdio'];
  env?:      NodeJS.ProcessEnv;
  cwd?:      string;
  /**
   * POSIX-only: spawn the child as its own process-group leader so the
   * whole tree (e.g. `npx` → `node`) can be killed via the group. Ignored
   * on Windows (where `killProcessTree` uses `taskkill /T` instead).
   */
  detached?: boolean;
  /** Override platform — test seam. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Override `child_process.spawn` — test seam. */
  spawnImpl?: typeof defaultSpawn;
}

export interface KillProcessTreeOptions {
  /** Override platform — test seam. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * Override `child_process.execSync` (for the Windows taskkill path) — test
   * seam. v4.12 PM.1: the Windows tree-kill runs `taskkill` SYNCHRONOUSLY (was
   * async `spawn`) so it enumerates + reaps the tree while the root is alive,
   * before the `child.kill()` fallback fires.
   */
  execSyncImpl?: typeof defaultExecSync;
  /** Override `process.kill` (for the POSIX group-kill path) — test seam. */
  killImpl?: (pid: number, signal: NodeJS.Signals | number) => void;
}

/**
 * Kill a child process AND its descendants. `child.kill()` signals only the
 * direct child; for shim chains that re-spawn (npx → node, or Windows
 * `cmd.exe` → node) that orphans the grandchild. This walks the whole tree:
 *
 *   - Windows: `taskkill /pid <pid> /t [/f]` — `/t` includes descendants,
 *     `/f` forces (used for SIGKILL; SIGTERM stays graceful).
 *   - POSIX: signal the process GROUP (`-pid`) — requires the child was
 *     spawned `detached: true` so its pid is the group leader. Falls back to
 *     a direct signal if the group send fails (e.g. not detached / gone).
 *
 * Best-effort + non-throwing: a process that's already dead is a no-op.
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  opts: KillProcessTreeOptions = {},
): void {
  const platform = opts.platform ?? process.platform;
  const pid = child.pid;

  if (pid != null && platform === 'win32') {
    // ★ v4.12 PM.1 — SYNCHRONOUS `taskkill /t` reaps the whole tree INCLUDING
    // the root. On Windows we deliberately do NOT fall through to `child.kill`:
    // `child.kill` is TerminateProcess on the root, and firing it during a
    // GRACEFUL pass (`taskkill /t` without `/f`) kills the root before the
    // console descendants exit — they ignore the graceful request, get
    // reparented, and ORPHAN (the Firefox lesson, live: graceful never reaps
    // them and the later force pass targets a now-dead root PID). Letting
    // `taskkill /t` own the tree keeps the root alive through the graceful
    // window so the caller's grace→force escalation can `/f` the intact tree.
    //   - `/f`   → force  (SIGKILL)
    //   - no `/f`→ graceful request (SIGTERM); caller escalates to `/f` on grace.
    const execSync = opts.execSyncImpl ?? defaultExecSync;
    const force = signal === 'SIGKILL' ? ' /f' : '';
    try {
      execSync(`taskkill /pid ${pid} /t${force}`, { stdio: 'ignore', timeout: 5000, windowsHide: true });
      return;   // taskkill owns the Windows tree — do not also child.kill the root
    } catch {
      // taskkill missing / failed — fall through to the child.kill best-effort.
    }
  } else if (pid != null) {
    const kill = opts.killImpl ?? ((p, s) => process.kill(p, s));
    try {
      kill(-pid, signal);        // negative pid → whole process group
    } catch { /* not detached / already gone — direct kill below still runs */ }
  }

  // Fallback / POSIX belt-and-suspenders: signal the direct child. On POSIX
  // this backstops a failed group send; it's also the only path when pid is
  // absent (a test fake) or when the Windows taskkill itself threw.
  try {
    child.kill(signal);
  } catch { /* already dead */ }
}

export interface CreationTimeOptions {
  /** Override platform — test seam. Defaults to `process.platform`. */
  platform?:   NodeJS.Platform;
  /** Override `child_process.execSync` — test seam. */
  execSyncImpl?: typeof defaultExecSync;
}

/**
 * v4.12 PM.1 — best-effort OS/kernel process CREATION-TIME (epoch ms) for a pid.
 *
 * ★ PID is not identity — PID reuse can recycle a stale PID onto an unrelated
 * process, so verify identity before signalling. PID + creation-time IS the
 * practical identity. This captures the re-queryable kernel
 * start-time at spawn so a later recovery pass (PM.3) can verify a recovered pid
 * still belongs to the same process before signalling it — `Date.now()` at spawn
 * can't be re-derived from a bare pid, the kernel start-time can.
 *
 *   - Windows: `Get-Process -Id <pid>` → `.StartTime` → Unix ms.
 *   - POSIX:   `ps -o lstart= -p <pid>` → parse the absolute start timestamp.
 *
 * Best-effort + non-throwing: returns `null` when the query fails or the process
 * is already gone (a very short-lived spawn). PM.1 stores it as a foundation;
 * identity-check enforcement is PM.3.
 */
export function getProcessCreationTime(
  pid: number,
  opts: CreationTimeOptions = {},
): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = opts.platform ?? process.platform;
  const execSync = opts.execSyncImpl ?? defaultExecSync;
  try {
    if (platform === 'win32') {
      // Emit StartTime as a UTC ISO-8601 string and parse in JS. (An earlier
      // `[DateTimeOffset](…).ToUnixTimeMilliseconds()` form failed: PowerShell's
      // cast binds looser than the method call, so ToUnixTimeMilliseconds was
      // invoked on System.DateTime → MethodNotFound. ISO round-trips cleanly.)
      const out = execSync(
        `powershell -NoProfile -NonInteractive -Command ` +
          `"(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')"`,
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      );
      const ms = Date.parse(String(out).trim());
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    const out = execSync(`ps -o lstart= -p ${pid}`, {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = Date.parse(String(out).trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;   // process gone, query failed, or tool missing — foundation stays undefined
  }
}

export interface SpawnCommandResult {
  /** The ChildProcess — consumers attach handlers / write stdin themselves. */
  child:        ChildProcess;
  /** Argv0 actually passed to spawn() ('cmd.exe' on Win for shims, else cmd). */
  resolvedCmd:  string;
  /** Argv actually passed to spawn() (post-cmd.exe-wrapping if applied). */
  resolvedArgs: readonly string[];
  /** True iff we wrapped through cmd.exe /d /s /c. */
  viaCmdExe:    boolean;
}

export interface ResolvedCommand {
  /** Absolute path to the resolved binary (or input verbatim if already absolute). */
  path:   string;
  /** True iff the resolved file is a .cmd or .bat shim (Windows). */
  isShim: boolean;
}

/**
 * Resolve a bare command name to an absolute disk path via PATH lookup.
 * On Windows tries PATHEXT order (.cmd, .exe, .bat, .ps1). If `command`
 * is already absolute or contains a path separator, returns it verbatim
 * (still detects shim suffix). Returns null when no match — caller can
 * still spawn the bare name and let node:child_process emit ENOENT.
 *
 * Implemented in pure Node (no `where` subprocess — that would face
 * the same spawn problem).
 */
export function resolveCommand(
  command: string,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): ResolvedCommand | null {
  const platform = opts.platform ?? process.platform;
  const env      = opts.env      ?? process.env;
  const isWin    = platform === 'win32';

  // Already absolute or has a separator → trust the caller, just detect suffix.
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    if (!existsSync(command)) return null;
    return { path: command, isShim: isWin && /\.(cmd|bat)$/i.test(command) };
  }

  const pathDirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const pathExts = isWin
    ? (env.PATHEXT ?? '.CMD;.EXE;.BAT;.COM').split(';').filter(Boolean)
    : [''];

  for (const dir of pathDirs) {
    for (const ext of pathExts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return { path: candidate, isShim: isWin && /\.(cmd|bat)$/i.test(candidate) };
        }
      } catch { /* permissions / ENOENT — keep walking */ }
    }
  }
  return null;
}

/**
 * Escape an argv element for cmd.exe /c invocation. Wraps in double
 * quotes if the value contains whitespace or any cmd metachar (& | <
 * > ( ) @ ^ "), doubling any embedded quotes. Used together with
 * `windowsVerbatimArguments: true` so Node passes our quoted string
 * straight through to cmd.exe without its own (broken-for-.cmd)
 * quoting heuristics.
 *
 * Reference: cross-spawn / npm-cli use the same pattern; Node 20+
 * refuses to do this for us when spawning .cmd files because the
 * heuristics were the source of CVE-2024-27980.
 */
export function escapeCmdArg(s: string): string {
  if (s.length === 0) return '""';
  // Conservative: any whitespace OR cmd metachar triggers quoting.
  if (!/[\s&|<>()@^"]/.test(s)) return s;
  // Double internal quotes (cmd.exe convention) and wrap.
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Cross-platform spawn. See file header for the why.
 *
 *   - Unix              → spawn(cmd, args, { shell:false, ...opts })
 *   - Win + .cmd/.bat   → spawn('cmd.exe', ['/d','/s','/c', quoted], {
 *                            shell:false,
 *                            windowsVerbatimArguments: true, ...opts })
 *   - Win + .exe / abs  → spawn(cmd, args, { shell:false, ...opts })
 *   - Win + bare name   → resolveCommand() picks; bucket by suffix.
 *
 * Never throws synchronously for "not found" — emits 'error' on the
 * returned ChildProcess like plain spawn() does. May throw synchronously
 * for the same reasons spawn() itself does (e.g. invalid argv types).
 */
export function spawnCommand(
  command: string,
  args:    readonly string[],
  opts:    SpawnCommandOptions = {},
): SpawnCommandResult {
  const spawn    = opts.spawnImpl ?? defaultSpawn;
  const platform = opts.platform  ?? process.platform;
  const isWin    = platform === 'win32';

  const baseOpts: SpawnOptions = {
    stdio: opts.stdio ?? ['pipe', 'pipe', 'pipe'],
    env:   opts.env,
    cwd:   opts.cwd,
    shell: false,
    // POSIX: own process group so killProcessTree can signal the whole tree
    // (npx → node). Ignored on Windows (taskkill /T walks the tree by PID).
    detached: opts.detached === true && !isWin,
  };

  if (!isWin) {
    const child = spawn(command, args as string[], baseOpts);
    return { child, resolvedCmd: command, resolvedArgs: args, viaCmdExe: false };
  }

  // Windows: detect shim suffix.
  const resolved = resolveCommand(command, { platform, env: opts.env });
  const isShim   = resolved
    ? resolved.isShim
    : /\.(cmd|bat)$/i.test(command);   // unresolved but caller passed .cmd explicitly

  if (!isShim) {
    const child = spawn(command, args as string[], baseOpts);
    return { child, resolvedCmd: command, resolvedArgs: args, viaCmdExe: false };
  }

  // Wrap through cmd.exe /d /s /c. Pass resolved path if we have it so
  // we don't re-walk PATH; otherwise let cmd.exe resolve the bare name.
  //
  // cmd.exe /s rule: it strips a single pair of outer quotes from the
  // command line and parses the remainder. We therefore wrap the entire
  // escaped argv sequence in an OUTER quote pair on top of each
  // individual arg's escapeCmdArg quoting. Otherwise a command path
  // containing whitespace (e.g. "C:\Program Files\nodejs\npm.CMD")
  // gets its inner quotes stripped, breaking on the first space.
  const target = resolved?.path ?? command;
  const line   = '"' + [target, ...args].map(escapeCmdArg).join(' ') + '"';
  const cmdArgs = ['/d', '/s', '/c', line];
  const child = spawn('cmd.exe', cmdArgs, {
    ...baseOpts,
    windowsVerbatimArguments: true,
  });
  return { child, resolvedCmd: 'cmd.exe', resolvedArgs: cmdArgs, viaCmdExe: true };
}
