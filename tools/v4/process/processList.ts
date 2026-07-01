/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/process/processList.ts — `process_list` wrapper.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { scrubString } from '../../../core/v4/logger/redact';

export const processListTool: ToolHandler = {
  schema: {
    name: 'process_list',
    description:
      'List background processes started by `process_spawn`. Shows id, pid, status, command, and exit code.',
    inputSchema: { type: 'object', properties: {} },
  },
  category: 'read',
  mutates: false,
  toolset: 'process',
  riskTier: 'safe',   // v4.4 Phase 1
  async execute(_args, ctx) {
    if (!ctx.processes) {
      return { success: false, error: 'process registry not configured' };
    }
    // ★ PM.1 — secret-redact the command before it reaches the model. A spawned
    // command can carry credentials (e.g. `curl -H "Authorization: Bearer …"`);
    // reuse the B5.1 scrubString patterns (Bearer / sk- / labelled secrets)
    // rather than hand-rolling. Do NOT wire a secret-leaking list.
    const handles = ctx.processes.list().map((h) => ({
      ...h,
      command: scrubString(h.command),
    }));
    return { success: true, count: handles.length, processes: handles };
  },
};
