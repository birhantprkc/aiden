/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/sandbox.ts — v4.5 Phase 8a; v4.12 SH.1 honest relabel.
 *
 * `/sandbox on|off|status` — flip the file-access GUARDRAILS (filesystem
 * allow/deny for file_* tools + docker session backend + dryRun preflight).
 *
 * ★ SH.1 honesty: these file guardrails are DEFENSE-IN-DEPTH for the file_*
 * tools — `shell_exec` does NOT consult them, so under the local backend they
 * are NOT containment (a shell command can reach any path). Real process
 * containment exists only under the Docker backend. `/sandbox status` prints
 * the honest ExecutionPolicy view (floor / ceiling / router).
 */

import type { SlashCommand } from '../commandRegistry';
import { flip, printStatus, parseSubcommand } from './_runtimeToggleHelpers';
import { getSandboxConfig } from '../../../core/v4/sandboxConfig';
import { describeExecutionPolicy, summarizeExecutionPolicy } from '../../../core/v4/executionPolicy';

const NOT_CONTAINMENT =
  'Note: these are file-tool GUARDRAILS (defense-in-depth), not containment — a shell command can still reach the filesystem. Real containment needs the Docker backend.';

export const sandbox: SlashCommand = {
  name: 'sandbox',
  description: 'Toggle file guardrails (file_* defense-in-depth, NOT shell containment).',
  category: 'system',
  icon: '🛡',
  handler: async (ctx) => {
    const sub = parseSubcommand(ctx.args[0]);
    if (sub === 'on')  { await flip('sandbox', true,  ctx); ctx.display.dim(NOT_CONTAINMENT); return {}; }
    if (sub === 'off') { await flip('sandbox', false, ctx); ctx.display.dim(NOT_CONTAINMENT); return {}; }
    if (sub === 'status') {
      printStatus('sandbox', ctx);
      // ★ SH.1 — the honest unified policy view.
      const approvalMode = ctx.config?.getValue<'manual' | 'smart' | 'off'>('agent.approval_mode', 'smart') ?? 'smart';
      const policy = describeExecutionPolicy({ sandbox: getSandboxConfig(), approvalMode, ssrfEnabled: true });
      ctx.display.info(`Policy: ${summarizeExecutionPolicy(policy)}`);
      for (const note of policy.notes) ctx.display.dim(`  • ${note}`);
      return {};
    }
    ctx.display.printError('Usage: /sandbox on|off|status');
    return {};
  },
};
