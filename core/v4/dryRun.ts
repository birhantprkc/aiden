/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/dryRun.ts — v4.4 Phase 4: dry-run preview infrastructure.
 *
 * AIDEN_DRYRUN=1 makes every `mutates: true` tool emit a preview of
 * what it would do instead of doing it. Read-only tools are
 * unaffected — the HOC passes them through unchanged.
 *
 * Two consumers wire into this module:
 *   1. tools/v4/index.ts — wraps every registered handler in
 *      withDryRun(...) so AIDEN_DRYRUN=1 short-circuits `execute`
 *      to a preview before any side-effect runs.
 *   2. core/v4/toolRegistry.ts (executeOne) — for dangerous-tier
 *      tools, calls handler.buildPreview before forwarding to
 *      ApprovalEngine so the approval prompt can show the user
 *      exactly what they're being asked to allow.
 *
 * Design choices (v4.4 Phase 4 audit):
 *   - HOC pattern (Q-P4-1 (a)) — uniform envelope across 27 tools.
 *   - buildPreview is an OPTIONAL method on ToolHandler
 *     (Q-P4-2 (a)) — tools without one are passed through with a
 *     generic "would execute" envelope.
 *   - Browser/unpredictable tools surface intent only
 *     (Q-P4-3 (a)).
 *   - aiden_self_update returns a `refuse` side-effect
 *     (Q-P4-4 (a)).
 *   - Dangerous-tier auto-preview reaches the user via approval
 *     prompt only, never as a duplicate field on a successful
 *     execution result (Q-P4-5 (a)).
 *
 * Gated by `SandboxConfig.dryRun` (AIDEN_DRYRUN=1 strict). Phase 6
 * does NOT flip this default — dry-run stays opt-in by design.
 */

import type { ToolHandler, ToolContext } from './toolRegistry';
import { getSandboxConfig } from './sandboxConfig';

// ── Side-effect taxonomy ────────────────────────────────────────────────────

export type SideEffect =
  | { type: 'create_file';    path: string; bytes: number; preview?: string }
  | { type: 'overwrite_file'; path: string; prev_bytes?: number; new_bytes: number; preview?: string }
  | { type: 'delete_file';    path: string; exists: boolean; recursive?: boolean }
  | { type: 'patch_file';     path: string; matches: number; bytes_delta?: number }
  | { type: 'copy_path';      from: string; to: string; src_exists: boolean }
  | { type: 'move_path';      from: string; to: string; src_exists: boolean }
  | { type: 'shell_command';  command: string; cwd: string; backend: 'local' | 'docker' }
  | { type: 'memory_write';   op: 'add' | 'replace' | 'remove'; bullet?: string; pattern?: string }
  | { type: 'browser_action'; action: string; target?: string; url?: string }
  | { type: 'process_kill';   pid: number; signal?: string }
  | { type: 'process_spawn';  command: string; args?: string[] }
  | { type: 'app_control';    action: string; target?: string }
  | { type: 'media_control';  action: string; value?: number }
  | { type: 'clipboard_write'; bytes: number; preview?: string }
  | { type: 'skill_write';    op: string; name?: string }
  | { type: 'volume_set';     level: number }
  | { type: 'session_distill'; session_id: string }
  | { type: 'refuse';         reason: string };

// ── Preview envelope ────────────────────────────────────────────────────────

export interface DryRunPreview {
  success:      true;
  dryRun:       true;
  wouldExecute: WouldExecute;
}

export interface WouldExecute {
  tool:          string;
  args:          Record<string, unknown>;
  riskTier:      'safe' | 'caution' | 'dangerous';
  sideEffects:   SideEffect[];
  detectedRisks: string[];
  summary:       string;
}

/**
 * Per-tool preview producer. Tools provide this method on their
 * `ToolHandler`. MUST be pure — no disk writes, no shell, no
 * network. Read-only stat/exists checks are OK to enrich the
 * preview.
 */
export type BuildPreviewFn = (
  args: Record<string, unknown>,
  ctx:  ToolContext,
) => Promise<WouldExecute> | WouldExecute;

// ── HOC ─────────────────────────────────────────────────────────────────────

/**
 * Wrap a tool handler so its `execute` short-circuits to a preview
 * when AIDEN_DRYRUN=1. Read-only tools (`mutates: false`) are
 * returned unchanged — dry-run is meaningless for them.
 *
 * Tools without a `buildPreview` method get a generic preview that
 * just echoes their args. We never block on missing previews; the
 * coverage sentinel test catches the omission at gate time.
 */
export function withDryRun(handler: ToolHandler): ToolHandler {
  if (!handler.mutates) return handler;
  const innerExecute = handler.execute.bind(handler);
  const wrappedExecute = async (
    args: Record<string, unknown>,
    ctx:  ToolContext,
  ): Promise<unknown> => {
    const config = getSandboxConfig();
    if (!config.dryRun) {
      return innerExecute(args, ctx);
    }
    const would = handler.buildPreview
      ? await handler.buildPreview(args, ctx)
      : genericPreview(handler, args);
    const out: DryRunPreview = {
      success:      true,
      dryRun:       true,
      wouldExecute: would,
    };
    return out;
  };
  return {
    ...handler,
    execute: wrappedExecute,
  };
}

/**
 * Fallback preview for a tool that doesn't define `buildPreview`.
 * Surfaces the call shape so the user at least sees what would
 * have run. The coverage sentinel ensures we don't ship any
 * mutating tool without a real preview, but the safety net keeps
 * runtime well-behaved even if a plugin tool slips through.
 */
export function genericPreview(
  handler: ToolHandler,
  args:    Record<string, unknown>,
): WouldExecute {
  return {
    tool:          handler.schema.name,
    args,
    riskTier:      handler.riskTier ?? (handler.mutates ? 'caution' : 'safe'),
    sideEffects:   [],
    detectedRisks: [],
    summary:       `${handler.schema.name} would execute (no detailed preview registered)`,
  };
}

// ── Helpers for tool authors ────────────────────────────────────────────────

/** Truncate a string for inline preview display. */
export function truncatePreview(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… (${s.length - max} more chars)`;
}

/**
 * Compose a `WouldExecute` for a tool that wants the boilerplate
 * filled in. Tool's buildPreview can call this and add side-effects.
 */
export function makeWouldExecute(opts: {
  handler:       ToolHandler;
  args:          Record<string, unknown>;
  sideEffects:   SideEffect[];
  summary:       string;
  detectedRisks?: string[];
}): WouldExecute {
  return {
    tool:          opts.handler.schema.name,
    args:          opts.args,
    riskTier:      opts.handler.riskTier ?? (opts.handler.mutates ? 'caution' : 'safe'),
    sideEffects:   opts.sideEffects,
    detectedRisks: opts.detectedRisks ?? [],
    summary:       opts.summary,
  };
}
