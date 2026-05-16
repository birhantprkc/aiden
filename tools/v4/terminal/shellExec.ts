/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/terminal/shellExec.ts — `shell_exec` wrapper.
 *
 * Routes a shell command to one of three backends:
 *   - local backend  (status quo: PowerShell on Windows, bash on POSIX)
 *   - docker single-shot backend (status quo for explicit
 *     `ctx.terminalBackend='docker'` with AIDEN_SANDBOX=0)
 *   - docker session backend (v4.4 Phase 3: long-lived container reuse
 *     with hardening + resource limits when AIDEN_SANDBOX=1)
 *
 * Backend selection precedence:
 *   1. Per-call override `ctx.terminalBackend` wins. When that's
 *      `'docker'` AND AIDEN_SANDBOX is enabled, the session-backed
 *      `dockerSessionExec` is used (reuse + hardening). When
 *      `'docker'` AND AIDEN_SANDBOX is disabled, the legacy
 *      single-shot `dockerBackendExecute` runs (tests rely on this).
 *   2. No override + AIDEN_SANDBOX=1 → docker session backend.
 *   3. No override + AIDEN_SANDBOX=0 → local (current behavior).
 *
 * Phase 9's approval engine still gates this tool the same way. The
 * tool stays `riskTier: 'dangerous'` — sandbox isolation does not
 * promote a shell command's tier; it only constrains the blast radius.
 *
 * Status: PHASE 8 → v4.4 Phase 3.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { localBackendExecute } from '../backends/local';
import { dockerBackendExecute } from '../backends/docker';
import {
  dockerSessionExec,
} from '../../../core/v4/dockerSession';
import { getSandboxConfig } from '../../../core/v4/sandboxConfig';

export const shellExecTool: ToolHandler = {
  schema: {
    name: 'shell_exec',
    description:
      'Execute a shell command. PowerShell on Windows, bash elsewhere. Use `cwd` to change the working dir; `timeoutMs` to bound runtime (default 30000).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute.' },
        cwd: { type: 'string', description: 'Working directory (optional).' },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in ms (default 30000).',
        },
        captureOutput: {
          type: 'boolean',
          description: 'Capture stdout/stderr (default true).',
        },
      },
      required: ['command'],
    },
  },
  category: 'execute',
  mutates: true,
  toolset: 'terminal',
  riskTier: 'dangerous',   // v4.4 Phase 1 — arbitrary shell command
  // v4.4 Phase 4 — dry-run preview.
  buildPreview(args, ctx) {
    const command = String(args.command ?? args.cmd ?? '').trim();
    const cwd = typeof args.cwd === 'string' ? args.cwd : ctx.cwd;
    const config = getSandboxConfig();
    const userOverride = ctx.terminalBackend;
    const effective: 'local' | 'docker' =
      userOverride ?? (config.enabled ? config.defaultBackend : 'local');
    // Lightweight risk hints — same patterns ApprovalEngine uses
    // in smart mode. Kept inline to avoid pulling moat/ into the
    // tool layer.
    const risks: string[] = [];
    if (/\brm\s+-rf?\b/.test(command))                  risks.push('rm -rf');
    if (/sudo\b/.test(command))                         risks.push('sudo');
    if (/\bcurl\s.+\|\s*(sh|bash)/.test(command))       risks.push('curl|sh');
    if (/\bwget\s.+\|\s*(sh|bash)/.test(command))       risks.push('wget|sh');
    if (/\bdd\s+if=/.test(command))                     risks.push('dd');
    if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) risks.push('fork bomb');
    if (/format\s+[a-zA-Z]:/i.test(command))            risks.push('format');
    return {
      tool: 'shell_exec',
      args,
      riskTier: 'dangerous',
      sideEffects: [{ type: 'shell_command', command, cwd, backend: effective }],
      detectedRisks: risks,
      summary: `Would run \`${command.length > 80 ? command.slice(0, 80) + '…' : command}\` via ${effective} backend in ${cwd}`,
    };
  },
  async execute(args, ctx) {
    const command = String(args.command ?? args.cmd ?? '').trim();
    if (!command) return { success: false, error: 'No command provided' };

    const shellArgs = {
      command,
      cwd: typeof args.cwd === 'string' ? args.cwd : ctx.cwd,
      timeoutMs:
        typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      captureOutput:
        typeof args.captureOutput === 'boolean'
          ? args.captureOutput
          : true,
    };

    const cb = ctx.log ? { log: ctx.log } : {};

    // v4.4 Phase 3 — effective backend selection.
    const config       = getSandboxConfig();
    const userOverride = ctx.terminalBackend;
    const effective: 'local' | 'docker' =
      userOverride ?? (config.enabled ? config.defaultBackend : 'local');

    let result;
    if (effective === 'docker') {
      if (config.enabled) {
        // Long-lived session container + hardening flags.
        result = await dockerSessionExec(
          {
            ...shellArgs,
            sessionId: ctx.sessionId,
            image:     ctx.dockerImage,
          },
          cb,
        );
      } else {
        // Status-quo single-shot docker path (AIDEN_SANDBOX=0 +
        // explicit ctx.terminalBackend='docker'). No reuse, no
        // hardening — kept for backward compatibility.
        result = await dockerBackendExecute(
          shellArgs,
          { image: ctx.dockerImage },
          cb,
        );
      }
    } else {
      result = await localBackendExecute(shellArgs, cb);
    }

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      backend: result.backend,
    };
  },
};
