/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/_psHelpers.ts — Phase v4.1.2-followup-3.
 *
 * Shared utilities for the computer-control tool family. Each tool
 * (screenshot / os_process_list / media_key / volume_set / app_launch /
 * app_close / clipboard_read / clipboard_write) gates on `win32` and
 * shells out to PowerShell. The gate + exec boilerplate is identical
 * across all eight tools — extracted here so the per-tool files stay
 * focused on the one PowerShell snippet that matters.
 */

import { exec, type ExecOptions } from 'node:child_process';
import { promisify } from 'node:util';

export const execAsync = promisify(exec);

/**
 * Standard "not supported on this platform" error payload. Surfaces a
 * link the user can file an issue against rather than pretending the
 * call quietly no-op'd.
 *
 * v4.1.3-essentials: now also returns a structured `capabilityCard`
 * payload (per ToolCallResult.capabilityCard contract). The REPL
 * renders the card as a bordered block above the bare-error fallback,
 * giving non-Windows users a clear "here's what you can still do"
 * surface instead of a one-line "platform unsupported" wall.
 *
 * The `canStill` / `cannotReliably` lists are passed by the caller so
 * each tool can be specific (e.g. `app_input` mentions Chrome DevTools
 * Protocol as a non-Windows alternative; `media_transport` points at
 * `media_key` or a Spotify Web API skill instead). Falls back to a
 * generic "use shell_exec for platform commands" hint when caller
 * doesn't supply alternatives.
 */
export function windowsOnlyError(
  toolName: string,
  alternatives?: {
    canStill?:       string[];
    cannotReliably?: string[];
    fix?:            string;
  },
): {
  success:         false;
  error:           string;
  requires:        string[];
  capabilityCard:  {
    title:          string;
    canStill:       string[];
    cannotReliably: string[];
    fix:            string;
  };
} {
  const canStill = alternatives?.canStill ?? [
    'Use `shell_exec` to run platform-native commands directly',
    'Use `os_process_list` to inspect what\'s running',
  ];
  const cannotReliably = alternatives?.cannotReliably ?? [
    `Call \`${toolName}\` until cross-platform support lands`,
  ];
  const fix = alternatives?.fix
    ?? `Run Aiden on Windows for full \`${toolName}\` support, or file an ` +
       `issue at github.com/taracodlabs/aiden if your platform is a priority.`;
  return {
    success: false,
    error:
      `Tool '${toolName}' is Windows-only. macOS/Linux ` +
      `support tracked at github.com/taracodlabs/aiden — please file an ` +
      `issue if needed. (Detected platform: ${process.platform})`,
    requires:       ['Windows'],
    capabilityCard: {
      title:          `${toolName} requires Windows`,
      canStill,
      cannotReliably,
      fix,
    },
  };
}

/**
 * Run a PowerShell snippet and return stdout. Defaults to a 15-second
 * timeout — caller passes a different one when a slower operation
 * (screenshot, app launch) is expected.
 *
 * Single source of truth for the `shell: 'powershell.exe'` invocation
 * shape so future powershell-CLI / `pwsh` migration is one-line.
 */
export async function runPowerShell(
  script:  string,
  options: { timeoutMs?: number; maxBufferMb?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const opts: ExecOptions = {
    shell:     'powershell.exe',
    timeout:   options.timeoutMs ?? 15_000,
    maxBuffer: (options.maxBufferMb ?? 4) * 1024 * 1024,
  };
  return await execAsync(script, opts) as { stdout: string; stderr: string };
}

export const isWindows = (): boolean => process.platform === 'win32';

/**
 * v4.1.4-media: PowerShell 5.1 preamble that bridges WinRT
 * `IAsyncOperation<T>` into a .NET `Task<T>` via
 * `System.WindowsRuntimeSystemExtensions.AsTask`.
 *
 * Why: every WinRT call surface we touch — `GlobalSystemMediaTransport-
 * ControlsSessionManager.RequestAsync()`, `Session.TryGetMediaPropertiesAsync()`,
 * `Session.TryPlayAsync()`, etc. — returns `IAsyncOperation<T>`. PS5.1
 * (the shell we target — it ships on every stock Win10/11 install) cannot
 * call `.GetAwaiter().GetResult()` on those because WinRT awaiters aren't
 * recognized as TPL-compatible. The reflection dance below grabs the
 * single-arg overload of `AsTask`, specializes it to `T`, and invokes —
 * yielding a `Task<T>` we can `.Wait()` on.
 *
 * Three callers consume this string:
 *   - `core/tools/nowPlaying.ts`         (read GSMTC properties)
 *   - `tools/v4/system/mediaSessions.ts` (enumerate GSMTC sessions)
 *   - `tools/v4/system/mediaTransport.ts` (play/pause/skip on a target)
 *
 * Returned as a literal string — caller composes it into a larger
 * PS script. Pure (no side effects, no PowerShell exec). No leading/
 * trailing whitespace so callers can interpolate without surprises.
 */
export function winRtAwaitPreamble(): string {
  return `Add-Type -AssemblyName System.Runtime.WindowsRuntime
function Await($WinRtTask, $ResultType) {
    $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
    })[0]
    $m = $m.MakeGenericMethod($ResultType)
    $t = $m.Invoke($null, @($WinRtTask))
    $t.Wait(-1) | Out-Null
    $t.Result
}`;
}
