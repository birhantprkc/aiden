/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/install/wslDetect.ts — v4.9.0 Slice 2a.
 *
 * Detect whether Aiden is running inside WSL. WSL users targeting a
 * Windows-host MCP client (Claude Desktop / Cursor for Windows) need
 * a `wsl.exe -d <distro> -- aiden mcp serve` command in the JSON
 * entry, NOT a Linux path.
 *
 * Detection signals (any match → WSL):
 *   1. `process.env.WSL_DISTRO_NAME` is set
 *   2. `process.env.WSL_INTEROP` is set
 *   3. `/proc/version` content contains "microsoft" or "WSL"
 */

import { readFileSync } from 'node:fs';

export interface WslInfo {
  inWsl:  boolean;
  /** Distro name (e.g. `Ubuntu-22.04`) — usable as `wsl.exe -d <distro>`. */
  distro: string | null;
}

export function detectWsl(
  opts: { env?: NodeJS.ProcessEnv; readFile?: (p: string) => string } = {},
): WslInfo {
  const env = opts.env ?? process.env;
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  if (typeof env.WSL_DISTRO_NAME === 'string' && env.WSL_DISTRO_NAME.length > 0) {
    return { inWsl: true, distro: env.WSL_DISTRO_NAME };
  }
  if (typeof env.WSL_INTEROP === 'string' && env.WSL_INTEROP.length > 0) {
    return { inWsl: true, distro: env.WSL_DISTRO_NAME ?? null };
  }
  try {
    const content = readFile('/proc/version').toLowerCase();
    if (content.includes('microsoft') || content.includes('wsl')) {
      return { inWsl: true, distro: env.WSL_DISTRO_NAME ?? null };
    }
  } catch {
    /* /proc/version unreadable — not on Linux, definitely not WSL */
  }
  return { inWsl: false, distro: null };
}

/**
 * Build the `command` + `args` shape for the Aiden entry given the
 * detected environment + target. When targeting a Windows host from
 * within WSL, wrap the call in `wsl.exe -d <distro> -- aiden mcp serve`
 * so the host-side Claude Desktop launches `aiden` via the WSL
 * interop layer.
 */
export function buildAidenEntry(opts: {
  wsl?:    WslInfo;
  target?: 'host' | 'native';
} = {}): { command: string; args: string[] } {
  const wsl = opts.wsl ?? detectWsl();
  if (wsl.inWsl && opts.target === 'host') {
    const distro = wsl.distro ?? 'default';
    return {
      command: 'wsl.exe',
      args:    ['-d', distro, '--', 'aiden', 'mcp', 'serve'],
    };
  }
  return { command: 'aiden', args: ['mcp', 'serve'] };
}
