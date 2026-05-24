/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/toolCallInvariant.ts — v4.9.4 SLICE 1.
 *
 * The tool-call/tool-result protocol invariant required by the OpenAI /
 * ChatGPT-Plus / Anthropic / Codex Responses message wire formats:
 *
 *   For every assistant message with toolCalls[],
 *   every tool_call.id MUST be answered by a later `tool` role message
 *   carrying the same toolCallId, before the next provider request.
 *
 * Aiden previously violated this in two known dispatch sites
 * (aidenAgent runTurnLoop's surfaceDecision break + abort-signal break)
 * which left orphan tool_call_ids in persisted history. Resuming such
 * a history triggered 400 from the provider:
 *
 *   Provider chatgpt-plus request failed (400):
 *   No tool output found for function call call_<id>.
 *
 * This module exposes three primitives:
 *   - assertNoUnansweredToolCalls(messages)        — preflight gate
 *   - synthesizeBlockedToolResult(call, reason)    — fill primitive
 *   - fillRemainingAsBlocked(buf, calls, idx, ..)  — batch helper
 *
 * Plus the OrphanToolCallError class thrown by the preflight.
 *
 * Provider-agnostic — each adapter translates Aiden's internal Message
 * type into its native wire shape. Assertions run against the internal
 * Message shape itself.
 */

import type { Message, ToolCallRequest } from '../../providers/v4/types';

// ── Suppression reasons ──────────────────────────────────────────────

/**
 * Reasons a tool call may be suppressed without execution. Closed union
 * for now — extend when v4.10 lands new guards (rate-limit, cost-budget,
 * hook-deny). Each new reason should map to one and only one suppression
 * site; the synthetic result content surfaces the reason verbatim so log
 * readers and the LLM can disambiguate.
 */
export type SuppressReason =
  | 'tool_loop_surface'    // TurnState recovery controller surfaced
  | 'cancelled';           // abort signal fired (Ctrl+C, /quit, programmatic)

export interface SynthesizeOpts {
  /**
   * 'interrupted' → "This call was interrupted before execution."
   *                  (the call we were ABOUT to dispatch when the
   *                  abort signal fired — mid-flight feel)
   * 'skipped'     → "This call was skipped because the turn was cancelled."
   *                  (calls never reached after a guard fired — never-began feel)
   * Defaults to 'skipped' — matches the more common case (surface guard
   * fires after one call has dispatched; remaining calls are skipped,
   * not interrupted).
   */
  variant?: 'interrupted' | 'skipped';
}

// ── Error class ──────────────────────────────────────────────────────

/**
 * Thrown by assertNoUnansweredToolCalls. Subclassed from Error so
 * triage code can:
 *
 *   try { ... } catch (e) {
 *     if (e instanceof OrphanToolCallError) { ... }
 *   }
 *
 * Production code MUST NOT catch this. If it fires, a guard upstream
 * is leaking orphan tool_call_ids and we want the failure loud at the
 * site that introduced the leak.
 */
export class OrphanToolCallError extends Error {
  readonly orphans: ReadonlyArray<{ toolCallId: string; toolName: string }>;
  constructor(orphans: ReadonlyArray<{ toolCallId: string; toolName: string }>) {
    const ids = orphans.map((o) => `${o.toolName}#${o.toolCallId}`).join(', ');
    super(
      `Tool-call/result protocol violated: ${orphans.length} unanswered tool_call_id(s) [${ids}]. ` +
      `Some guard in the dispatch loop emitted an assistant message with tool_calls[] ` +
      `but did not push a matching {role:'tool', toolCallId} for every id. ` +
      `Find the guard and add a synthesizeBlockedToolResult() call before its break/continue.`,
    );
    this.name = 'OrphanToolCallError';
    this.orphans = orphans;
  }
}

// ── Preflight assertion ──────────────────────────────────────────────

/**
 * Walk the messages once. For each assistant message at index i, scan
 * messages[i+1..] for `{ role: 'tool', toolCallId }` entries matching
 * each toolCalls[].id. Orphans (unmatched ids) accumulate; a single
 * Error is thrown listing all of them so a single debugging session
 * sees the full damage (better than throw-on-first).
 *
 * Pure. No IO, no clock. Cost is O(N*M) where N = total messages and
 * M = avg tool-calls-per-assistant-turn; trivial for any realistic
 * session (low hundreds of messages, low tens of tool calls per turn).
 *
 * Called from AidenAgent.callProvider() as the single boundary preflight
 * — every provider adapter receives messages[] through that one funnel.
 */
export function assertNoUnansweredToolCalls(messages: ReadonlyArray<Message>): void {
  // Collect all tool-result ids first (single pass) so we can resolve
  // each assistant's tool_calls in O(1) against a Set.
  const answeredIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool') answeredIds.add(m.toolCallId);
  }
  // Now walk assistants and collect orphans.
  const orphans: Array<{ toolCallId: string; toolName: string }> = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      if (!answeredIds.has(tc.id)) {
        orphans.push({ toolCallId: tc.id, toolName: tc.name });
      }
    }
  }
  if (orphans.length > 0) throw new OrphanToolCallError(orphans);
}

// ── Synthesis primitives ─────────────────────────────────────────────

/**
 * Build a tool-role message whose content is a JSON-stringified failure
 * object the LLM can parse:
 *
 *   { ok: false, blocked: true, reason: <code>, message: <human> }
 *
 * Same shape regardless of which guard fired so the LLM sees a uniform
 * signal. Internal Aiden Message type — providers/v4 adapters handle
 * wire-shape translation per their native protocol.
 */
export function synthesizeBlockedToolResult(
  call:   ToolCallRequest,
  reason: SuppressReason,
  opts:   SynthesizeOpts = {},
): Message {
  const variant = opts.variant ?? 'skipped';
  const humanMessage = variant === 'interrupted'
    ? `This call was interrupted before execution. (reason: ${reason})`
    : `This call was skipped because the turn was cancelled. (reason: ${reason})`;
  // tool_loop_surface variant is always 'skipped' semantically (we
  // already executed the call before the surface decision fired, so
  // the SKIPPED calls are the remainder). But we still let the caller
  // override if a future site has a different shape.
  const content = JSON.stringify({
    ok:      false,
    blocked: true,
    reason,
    message: humanMessage,
  });
  return {
    role:       'tool',
    toolCallId: call.id,
    content,
  };
}

/**
 * Push synthetic blocked-tool-result messages for every unprocessed
 * call from `startIdx` (inclusive) onward. Mutates `buf` in place
 * (matches the existing turnToolMessages accumulator pattern in
 * aidenAgent.ts; pure-returning would force a spread at every call
 * site).
 *
 * Exported because v4.10 guards (rate-limit, cost-budget, hook-deny)
 * will want the same shape.
 */
export function fillRemainingAsBlocked(
  buf:       Message[],
  toolCalls: ReadonlyArray<ToolCallRequest>,
  startIdx:  number,
  reason:    SuppressReason,
  variant:   'interrupted' | 'skipped' = 'skipped',
): void {
  for (let i = startIdx; i < toolCalls.length; i++) {
    buf.push(synthesizeBlockedToolResult(toolCalls[i], reason, { variant }));
  }
}
