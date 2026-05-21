/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/install/healthCheck.ts — v4.9.0 Slice 2a.
 *
 * Spawn `aiden mcp serve --health-check` (or whatever command the
 * caller writes into the third-party config) as a subprocess and
 * parse the JSON status line from stdout. Used by `init` after a
 * successful write to surface "tools exposed: N, version: X" as
 * immediate confirmation that the wired entry actually launches.
 */

import { spawn } from 'node:child_process';

export interface HealthResult {
  ok:      boolean;
  status?: 'ok' | 'error';
  tools?:  number;
  version?: string;
  /** Combined stderr / parse-error text when ok is false. */
  error?:  string;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function runHealthCheck(opts: {
  command:  string;
  args:     string[];
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}): Promise<HealthResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn   = opts.spawnImpl ?? spawn;
  return new Promise<HealthResult>((resolve) => {
    let child;
    try {
      // Append --health-check so the spawned `aiden mcp serve`
      // emits a single JSON line + exits cleanly instead of
      // running the stdio MCP loop.
      child = spawnFn(opts.command, [...opts.args, '--health-check'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, error: `Could not spawn ${opts.command}: ${(err as Error).message}` });
      return;
    }
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuf += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBuf += chunk.toString();
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Spawn failed: ${err.message}` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: `Health check timed out after ${timeoutMs}ms` });
        return;
      }
      try {
        const trimmed = stdoutBuf.trim();
        const line = trimmed.split('\n').find((l) => l.startsWith('{')) ?? trimmed;
        const parsed = JSON.parse(line) as { status?: string; tools?: number; version?: string };
        if (parsed.status === 'ok') {
          resolve({ ok: true, status: 'ok', tools: parsed.tools, version: parsed.version });
        } else {
          resolve({ ok: false, error: `status=${parsed.status ?? '<missing>'}` });
        }
      } catch (err) {
        resolve({
          ok: false,
          error: `Could not parse health-check output: ${(err as Error).message}. stderr: ${stderrBuf.trim().slice(0, 200)}`,
        });
      }
    });
  });
}
