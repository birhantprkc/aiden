/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/loopTrace.ts — Phase v4.1.5+ Path A.
 *
 * Env-var-gated per-turn audit log for diagnosing tool-call loops
 * (the user-reported "30+ skill_view calls in 0ms each" failure mode
 * from v4.1.5 visual smoke). Default OFF — adds zero overhead when
 * `AIDEN_DEBUG_LOOP !== '1'`.
 *
 * When enabled, captures:
 *   - Full tool-call sequence (name, args, timing) for the turn
 *   - Assembled system prompt at turn start
 *   - MEMORY.md + USER.md content hashes (sha256, first 12 hex)
 *   - Recent skills list (last 10 `skill_view` calls)
 *   - Conversation history snapshot (last 5 turns)
 *
 * Auto-writes to `<paths.logsDir>/loop-trace-{ISO-timestamp}.json` at
 * turn end IF the turn triggered loop detection (10+ tool calls OR
 * 5+ consecutive same-name). Quiet otherwise — non-loop turns don't
 * spam the logs directory.
 *
 * A/B harness reproduction lesson: the original 30+ loop the user
 * observed could not be reproduced with a fresh `[system, user]`
 * history (see `scripts/smoke-prompt-bias-ab.ts` results). The loop
 * is either stochastic gpt-5.5 behaviour, history-poisoning from
 * prior turns, or MEMORY/USER context-specific. This logger captures
 * the EXACT context next time the loop happens in live use so we
 * can A/B against the real failure case.
 *
 * Pure module — no Display dependency, no event-emitter, no side
 * effects beyond the gated file write. Safe to import from anywhere.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AidenPaths } from './paths';
import type { Message } from '../../providers/v4/types';

// ── Public types ────────────────────────────────────────────────────────────

/**
 * A single captured tool call. `args` is JSON-stringified at capture
 * time (with a 200-char cap) so the trace stays small. `durationMs`
 * is the wall-clock from `before` → `after` for that call.
 */
export interface CapturedToolCall {
  name:        string;
  argsPreview: string;     // JSON.stringify, capped 200 chars
  durationMs:  number;
  ts:          string;     // ISO timestamp
}

/** Final shape of a loop-trace JSON file. */
export interface LoopTraceSnapshot {
  schemaVersion:   1;
  capturedAt:      string;                 // ISO
  reason:          'tool_count' | 'consecutive_same' | 'normal_end_post_threshold';
  toolCallCount:   number;
  maxConsecSame:   number;
  consecSameName:  string | null;
  toolSequence:    CapturedToolCall[];
  systemPrompt:    string;                 // assembled prompt at turn start
  memoryMdHash:    string | null;          // sha256 first 12 hex, null if missing
  userMdHash:      string | null;
  recentSkills:    string[];               // last 10 skill_view targets (this turn)
  historyTail:     Array<{ role: string; contentPreview: string }>;
  envHints: {
    provider: string;
    model:    string;
  };
}

/**
 * Options for constructing a tracer. All optional — the tracer
 * defaults to disabled when `AIDEN_DEBUG_LOOP !== '1'`.
 */
export interface LoopTracerOptions {
  paths:      AidenPaths;
  providerId: string;
  modelId:    string;
  /**
   * Override the env-var gate. Default: read
   * `process.env.AIDEN_DEBUG_LOOP === '1'` at construct time.
   */
  enabled?:   boolean;
  /** Threshold for emitting a trace at turn end. Default 10. */
  toolCountThreshold?: number;
  /** Threshold for "loop" detection (consecutive same name). Default 5. */
  consecSameThreshold?: number;
  /**
   * Override for the loop-warning display callback. Receives a single
   * one-line hint when consec-same crosses the WARN threshold (8 by
   * default). chatSession wires this to `display.dim()` so the user
   * sees the warning without needing to tail the log file.
   */
  onLoopWarning?: (line: string) => void;
  /** Threshold for emitting the live warning. Default 8. */
  warnConsecThreshold?: number;
}

// ── Tracer ──────────────────────────────────────────────────────────────────

const ARGS_CAP    = 200;
const HISTORY_TAIL_DEPTH = 5;
const RECENT_SKILLS_MAX  = 10;

/**
 * Tracks tool calls for one turn. Construct fresh per turn (the
 * counters and recent-skills list are turn-scoped). Idempotent
 * `finalize()` — multiple calls produce one file at most.
 */
export class LoopTracer {
  private readonly opts: Required<LoopTracerOptions>;
  private readonly enabled: boolean;
  private systemPrompt = '';
  private history:     Message[] = [];
  private toolStart:   Map<string, number> = new Map();
  private sequence:    CapturedToolCall[] = [];
  private lastName:    string | null = null;
  private consecSame:  number = 0;
  private maxConsec:   number = 0;
  private warnFired:   boolean = false;
  private finalized:   boolean = false;
  private recentSkills: string[] = [];

  constructor(rawOpts: LoopTracerOptions) {
    this.enabled = rawOpts.enabled ?? (process.env.AIDEN_DEBUG_LOOP === '1');
    this.opts = {
      paths:                rawOpts.paths,
      providerId:           rawOpts.providerId,
      modelId:              rawOpts.modelId,
      enabled:              this.enabled,
      toolCountThreshold:   rawOpts.toolCountThreshold   ?? 10,
      consecSameThreshold:  rawOpts.consecSameThreshold  ?? 5,
      warnConsecThreshold:  rawOpts.warnConsecThreshold  ?? 8,
      onLoopWarning:        rawOpts.onLoopWarning        ?? (() => {/* no-op */}),
    };
  }

  isEnabled(): boolean { return this.enabled; }

  /**
   * Set the assembled system prompt for this turn. Called once at turn
   * start (before any tool calls). Stored verbatim; no truncation.
   */
  setSystemPrompt(prompt: string): void {
    if (!this.enabled) return;
    this.systemPrompt = prompt;
  }

  /**
   * Set the turn's conversation history snapshot. The tracer keeps
   * only the last `HISTORY_TAIL_DEPTH` messages on finalize.
   */
  setHistory(messages: Message[]): void {
    if (!this.enabled) return;
    this.history = messages;
  }

  /**
   * Record the start of a tool call. Pair with `endTool(id, name)` to
   * capture the duration. Caller must pass a stable `id` (the tool
   * call request id) so before/after pairs find each other.
   */
  startTool(id: string, _name: string): void {
    if (!this.enabled) return;
    this.toolStart.set(id, Date.now());
  }

  /**
   * Record the end of a tool call. Computes duration from the matching
   * `startTool` call. Updates consec-same counter; fires the live
   * warning when threshold crosses.
   */
  endTool(id: string, name: string, args: unknown): void {
    if (!this.enabled) return;
    const start = this.toolStart.get(id);
    this.toolStart.delete(id);
    const durationMs = start === undefined ? 0 : (Date.now() - start);

    let argsPreview: string;
    try { argsPreview = JSON.stringify(args ?? {}); }
    catch { argsPreview = String(args); }
    if (argsPreview.length > ARGS_CAP) argsPreview = `${argsPreview.slice(0, ARGS_CAP - 1)}…`;

    this.sequence.push({
      name, argsPreview, durationMs,
      ts: new Date().toISOString(),
    });

    // Consec-same accounting.
    if (name === this.lastName) {
      this.consecSame += 1;
    } else {
      this.consecSame = 1;
      this.lastName = name;
    }
    if (this.consecSame > this.maxConsec) this.maxConsec = this.consecSame;

    // Skill-view tracking (separate from sequence for quick reference).
    if (name === 'skill_view' || name === 'lookup_tool_schema') {
      const tk = (args as { name?: string; toolName?: string } | undefined);
      const target = tk?.name ?? tk?.toolName ?? '(unknown)';
      this.recentSkills.push(target);
      if (this.recentSkills.length > RECENT_SKILLS_MAX) {
        this.recentSkills = this.recentSkills.slice(-RECENT_SKILLS_MAX);
      }
    }

    // Live warning at the loud threshold.
    if (!this.warnFired && this.consecSame >= this.opts.warnConsecThreshold) {
      this.warnFired = true;
      try {
        this.opts.onLoopWarning(
          `[loop] same tool '${name}' called ${this.consecSame}× — Ctrl+C to interrupt`,
        );
      } catch { /* defensive */ }
    }
  }

  /**
   * Compute whether a snapshot would be written if `finalize()` ran
   * now. Useful for tests + the live warning path. Pure read.
   */
  shouldEmit(): boolean {
    if (!this.enabled) return false;
    return (
      this.sequence.length >= this.opts.toolCountThreshold ||
      this.maxConsec       >= this.opts.consecSameThreshold
    );
  }

  /**
   * Write the trace to disk if thresholds tripped. Idempotent —
   * subsequent calls are no-ops. Returns the snapshot path or `null`
   * if nothing was written.
   */
  async finalize(): Promise<string | null> {
    if (this.finalized) return null;
    this.finalized = true;
    if (!this.enabled) return null;
    if (!this.shouldEmit()) return null;

    const snapshot = await this.buildSnapshot();
    const ts = snapshot.capturedAt.replace(/[:.]/g, '-');
    const filename = `loop-trace-${ts}.json`;
    const filePath = path.join(this.opts.paths.logsDir, filename);

    try {
      await fs.mkdir(this.opts.paths.logsDir, { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
      return filePath;
    } catch {
      // Diagnostic logging must never break the turn. Silently swallow
      // write failures — power user with AIDEN_DEBUG_LOOP=1 will notice
      // missing files and can re-run with stricter perms if needed.
      return null;
    }
  }

  /** Test-accessor: synchronous read of the current consec-same state. */
  getMaxConsecutive(): number { return this.maxConsec; }
  /** Test-accessor: tool call count so far. */
  getToolCount(): number { return this.sequence.length; }

  // ── Internals ────────────────────────────────────────────────────────────

  private async buildSnapshot(): Promise<LoopTraceSnapshot> {
    const reason: LoopTraceSnapshot['reason'] =
      this.maxConsec >= this.opts.consecSameThreshold
        ? (this.sequence.length >= this.opts.toolCountThreshold
            ? 'consecutive_same'
            : 'consecutive_same')
        : 'tool_count';

    const memoryMdHash = await hashFileFirst12(this.opts.paths.memoryMd);
    const userMdHash   = await hashFileFirst12(this.opts.paths.userMd);

    const historyTail = this.history.slice(-HISTORY_TAIL_DEPTH).map((m) => ({
      role:           m.role,
      contentPreview: trunc(typeof m.content === 'string' ? m.content : JSON.stringify(m.content), 300),
    }));

    return {
      schemaVersion:   1,
      capturedAt:      new Date().toISOString(),
      reason,
      toolCallCount:   this.sequence.length,
      maxConsecSame:   this.maxConsec,
      consecSameName:  this.maxConsec >= 2 ? this.lastName : null,
      toolSequence:    this.sequence,
      systemPrompt:    this.systemPrompt,
      memoryMdHash,
      userMdHash,
      recentSkills:    this.recentSkills,
      historyTail,
      envHints: {
        provider: this.opts.providerId,
        model:    this.opts.modelId,
      },
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read a file and return the sha256 hash, first 12 hex chars.
 * Returns `null` if the file is missing or unreadable. Pure-async.
 * 12 hex is enough collision resistance for context-fingerprinting
 * without bloating the trace file with full 64-char hashes.
 */
async function hashFileFirst12(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return hash.slice(0, 12);
  } catch {
    return null;
  }
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
